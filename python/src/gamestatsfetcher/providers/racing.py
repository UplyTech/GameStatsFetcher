"""Sim racing and the fighting-game ladder.

iRacing and Trackmania are the two racing titles with a real API. Brawlhalla is
here because it is the one fighting game whose publisher ships a player API -
every other title in that genre is start.gg brackets and nothing else.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import inspect
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

from ..constants import TTL
from ..errors import AuthenticationError, NotFoundError, ValidationError
from ..http import RequestSpec
from ..runtime import Runtime
from .base import ProviderClient

__all__ = [
    "IRACING_AUTHORIZE_URL",
    "IRACING_DATA_SCOPE",
    "IRACING_TOKEN_URL",
    "BrawlhallaProvider",
    "IRacingAuthorization",
    "IRacingProvider",
    "IRacingTokens",
    "TrackmaniaProvider",
    "create_pkce_pair",
    "mask_client_secret",
]


#: iRacing's OAuth server. Documented at https://oauth.iracing.com/oauth2/book/.
IRACING_AUTHORIZE_URL = "https://oauth.iracing.com/oauth2/authorize"
IRACING_TOKEN_URL = "https://oauth.iracing.com/oauth2/token"

#: The scope the Data API needs.
IRACING_DATA_SCOPE = "iracing.auth"

#: Renew an access token this long before iRacing says it lapses, so a token
#: cannot expire between the check and the request that carries it.
_EXPIRY_MARGIN_MS = 30_000


@dataclass(frozen=True)
class IRacingTokens:
    """What iRacing's token endpoint hands back.

    Refresh tokens are single use: every refresh returns a new one and the old
    one stops working. An application that keeps tokens across restarts must
    store the newest one - register a listener with
    :meth:`IRacingProvider.on_tokens` to be told when it changes.
    """

    access_token: str
    expires_in: int
    refresh_token: str | None = None
    refresh_token_expires_in: int | None = None
    scope: str | None = None


@dataclass(frozen=True)
class IRacingAuthorization:
    """One started authorization: where to send the user, and what to keep.

    ``code_verifier`` and ``state`` must survive until the redirect comes back,
    server-side in the session, not in anything the browser can read.
    """

    url: str
    code_verifier: str
    state: str


def create_pkce_pair() -> tuple[str, str]:
    """A PKCE ``(code_verifier, code_challenge)`` pair using ``S256``.

    The verifier is 64 random bytes in base64url (86 characters, inside the
    43-128 that RFC 7636 allows). The challenge is the unpadded base64url
    SHA-256 of it.
    """
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return verifier, challenge


def mask_client_secret(client_secret: str, client_id: str) -> str:
    """The masked form iRacing's token endpoint expects for a client secret.

    iRacing asks for ``base64(sha256(secret + lowercase(trim(client_id))))`` so
    that the plain secret never shows up in a request log. Only confidential
    clients have a secret; a public client using PKCE never calls this.
    """
    normalized_id = client_id.strip().lower()
    digest = hashlib.sha256(f"{client_secret}{normalized_id}".encode()).digest()
    return base64.b64encode(digest).decode("ascii")


def _as_seconds(value: Any, default: int) -> int:
    try:
        return max(int(value), 0)
    except (TypeError, ValueError):
        return default


def _as_optional_seconds(value: Any) -> int | None:
    return None if value is None else _as_seconds(value, 0)


def _as_text(value: Any) -> str | None:
    return str(value) if isinstance(value, str) and value else None


TokenListener = Callable[[IRacingTokens], Awaitable[None] | None]


class IRacingProvider(ProviderClient):
    """iRacing Data API, authenticated with OAuth 2.0.

    iRacing retired the old ``/auth`` login (email plus a hashed password) with
    the 2026 Season 1 release on 9 December 2025. This provider uses the OAuth
    Authorization Code flow with PKCE instead and never sees a password:

    1. ``api_keys["iracing"]`` is the client id iRacing issued, or
       ``clientId:clientSecret`` for a confidential client.
    2. :meth:`authorization_url` starts the flow, :meth:`exchange_code` finishes
       it. An application that already holds a refresh token passes it to
       :meth:`use_tokens` instead.
    3. Access tokens last about ten minutes and are renewed from the refresh
       token on demand. The refresh token rotates on every renewal, and
       :meth:`on_tokens` reports each new one.

    Data endpoints still answer ``{"link": "..."}`` with the payload behind a
    pre-signed S3 URL, so every call is two round trips.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("iracing", runtime)
        self._access_token: str | None = None
        self._access_expires_at = 0.0
        self._refresh_token: str | None = None
        self._listeners: list[TokenListener] = []
        self._lock = asyncio.Lock()

    # -----------------------------------------------------------------------
    # OAuth flow
    # -----------------------------------------------------------------------

    def _client(self) -> tuple[str, str | None]:
        """The client id, and the secret when this is a confidential client."""
        client_id, _, client_secret = self.require_key().partition(":")
        if not client_id:
            raise ValidationError(
                'api_keys.iracing must be "clientId" or "clientId:clientSecret"'
            )
        return client_id, client_secret or None

    def authorization_url(
        self,
        redirect_uri: str,
        *,
        state: str | None = None,
        scope: str = IRACING_DATA_SCOPE,
    ) -> IRacingAuthorization:
        """Start the Authorization Code flow.

        Send the user to ``url``. iRacing redirects back to ``redirect_uri``
        with ``code`` and ``state``; check that the state matches, then pass the
        code and the ``code_verifier`` to :meth:`exchange_code`. The redirect
        URI must be registered with iRacing and match exactly.
        """
        client_id, _ = self._client()
        verifier, challenge = create_pkce_pair()
        chosen_state = state or secrets.token_urlsafe(24)
        query = urlencode(
            {
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "state": chosen_state,
                "scope": scope,
            }
        )
        return IRacingAuthorization(
            url=f"{IRACING_AUTHORIZE_URL}?{query}",
            code_verifier=verifier,
            state=chosen_state,
        )

    async def exchange_code(
        self, code: str, redirect_uri: str, code_verifier: str
    ) -> IRacingTokens:
        """Finish the flow: trade the authorization code for tokens."""
        async with self._lock:
            return await self._token_request(
                {
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": redirect_uri,
                    "code_verifier": code_verifier,
                }
            )

    def use_tokens(
        self,
        refresh_token: str,
        *,
        access_token: str | None = None,
        expires_in: int | None = None,
    ) -> None:
        """Resume with tokens stored from an earlier session.

        Without ``access_token`` the first request renews one from the refresh
        token. ``expires_in`` counts from now.
        """
        self._refresh_token = refresh_token
        self._access_token = access_token
        self._access_expires_at = (
            self._now() + expires_in * 1_000 - _EXPIRY_MARGIN_MS
            if access_token and expires_in
            else 0.0
        )

    def on_tokens(self, listener: TokenListener) -> None:
        """Be told about every new token pair, to persist the rotated refresh token."""
        self._listeners.append(listener)

    async def refresh(self) -> IRacingTokens:
        """Renew the access token now, whether or not it has expired."""
        async with self._lock:
            return await self._refresh_locked()

    @staticmethod
    def _now() -> float:
        return time.monotonic() * 1_000

    async def _refresh_locked(self) -> IRacingTokens:
        if not self._refresh_token:
            raise AuthenticationError(
                self.id,
                "no iRacing token yet - run the OAuth flow (authorization_url, "
                "exchange_code) or pass a stored refresh token to use_tokens()",
            )
        return await self._token_request(
            {"grant_type": "refresh_token", "refresh_token": self._refresh_token}
        )

    async def _token_request(self, form: dict[str, str]) -> IRacingTokens:
        """POST to the token endpoint and keep what comes back."""
        client_id, client_secret = self._client()
        fields = {**form, "client_id": client_id}
        if client_secret:
            fields["client_secret"] = mask_client_secret(client_secret, client_id)
        response = await self.runtime.http.send(
            self.id,
            IRACING_TOKEN_URL,
            RequestSpec(
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                body=urlencode(fields),
            ),
        )
        if not isinstance(response, dict) or not response.get("access_token"):
            raise AuthenticationError(self.id, "token endpoint returned no access_token")

        expires_in = _as_seconds(response.get("expires_in"), 600)
        tokens = IRacingTokens(
            access_token=str(response["access_token"]),
            expires_in=expires_in,
            refresh_token=_as_text(response.get("refresh_token")) or self._refresh_token,
            refresh_token_expires_in=_as_optional_seconds(
                response.get("refresh_token_expires_in")
            ),
            scope=_as_text(response.get("scope")),
        )
        self._access_token = tokens.access_token
        self._access_expires_at = self._now() + expires_in * 1_000 - _EXPIRY_MARGIN_MS
        self._refresh_token = tokens.refresh_token
        for listener in self._listeners:
            outcome = listener(tokens)
            if inspect.isawaitable(outcome):
                await outcome
        return tokens

    async def _bearer(self) -> str:
        """A current access token, renewed if it has lapsed.

        Under the lock, because refresh tokens are single use: two requests
        renewing at once would spend the same token twice, and iRacing would
        refuse the second.
        """
        async with self._lock:
            if self._access_token and self._now() < self._access_expires_at:
                return self._access_token
            return (await self._refresh_locked()).access_token

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        self._client()  # a missing key is MissingCredentialError, before any call
        token = await self._bearer()
        return spec.merged(headers={"Authorization": f"Bearer {token}", **spec.headers})

    async def _data(self, path: str, query: dict[str, Any] | None = None) -> Any:
        """Call a data endpoint and follow the S3 link it returns.

        Some endpoints answer with the payload directly and some with a link;
        both shapes are handled so callers see one behaviour.
        """
        first = await self.get(path, query=query or {})
        if isinstance(first, dict) and isinstance(first.get("link"), str):
            # The S3 link is pre-signed and must not carry the bearer token.
            return await self.runtime.http.send(self.id, first["link"], RequestSpec())
        return first

    async def search_drivers(self, search_term: str) -> list[dict[str, Any]]:
        """Look drivers up by name."""

        async def fetch() -> list[dict[str, Any]]:
            drivers = await self._data("/data/lookup/drivers", {"search_term": search_term})
            if not drivers:
                raise NotFoundError(self.id, f'iRacing driver "{search_term}"', "iracing")
            return list(drivers)

        return await self.cached(
            ["search", search_term.lower()],
            "resolvePlayer",
            "iracing",
            TTL["resolvePlayer"],
            fetch,
        )

    async def get_member(self, customer_id: str | int) -> dict[str, Any]:
        """A member's profile."""

        async def fetch() -> dict[str, Any]:
            response = await self._data(
                "/data/member/get", {"cust_ids": customer_id, "include_licenses": True}
            )
            members = (response or {}).get("members") or []
            if not members:
                raise NotFoundError(self.id, f"iRacing member {customer_id}", "iracing")
            return dict(members[0])

        return await self.cached(
            ["member", customer_id], "getPlayer", "iracing", TTL["player"], fetch
        )

    async def get_career_stats(self, customer_id: str | int) -> list[dict[str, Any]]:
        """Career statistics, one row per category."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self._data("/data/stats/member_career", {"cust_id": customer_id})
            return self.rows((response or {}).get("stats") or [])

        return await self.cached(
            ["career", customer_id],
            "getPlayerStats",
            "iracing",
            TTL["playerStats"],
            fetch,
        )

    async def get_recent_races(self, customer_id: str | int) -> list[dict[str, Any]]:
        """Recent races."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self._data(
                "/data/stats/member_recent_races", {"cust_id": customer_id}
            )
            return self.rows((response or {}).get("races") or [])

        return await self.cached(
            ["recent", customer_id],
            "getMatchHistory",
            "iracing",
            TTL["matchHistory"],
            fetch,
        )

    async def get_result(self, subsession_id: str | int) -> dict[str, Any]:
        """Full results for one subsession."""

        async def fetch() -> dict[str, Any]:
            result = await self._data("/data/results/get", {"subsession_id": subsession_id})
            if not result:
                raise NotFoundError(self.id, f"subsession {subsession_id}", "iracing")
            return dict(result)

        return await self.cached(
            ["result", subsession_id], "getMatch", "iracing", TTL["match"], fetch
        )

    async def get_season_standings(
        self, season_id: int, car_class_id: int | None = None
    ) -> dict[str, Any]:
        """A season standings page."""
        response = await self._data(
            "/data/stats/season_driver_standings",
            {"season_id": season_id, "car_class_id": car_class_id},
        )
        return dict(response or {})


class TrackmaniaProvider(ProviderClient):
    """trackmania.io.

    Wraps Nadeo's own live services in something usable. It requires a
    User-Agent naming the application and a contact address, and will refuse
    requests without one - the runtime's ``user_agent`` option exists partly for
    this provider.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("trackmania-io", runtime)

    def auth_header_name(self) -> str:
        return "Authorization"

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        """The key is optional for the public endpoints."""
        key = self.runtime.api_keys.get("trackmania")
        if not key:
            return spec
        return spec.merged(headers={"Authorization": key, **spec.headers})

    async def search_players(self, query: str) -> list[dict[str, Any]]:
        """Search players by name."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                "/players/find", query={"search": query}, null_on_404=True
            )
            players = self.rows((response or {}).get("players") or [])
            if not players:
                raise NotFoundError(self.id, f'Trackmania player "{query}"', "trackmania")
            return players

        return await self.cached(
            ["search", query.lower()],
            "resolvePlayer",
            "trackmania",
            TTL["resolvePlayer"],
            fetch,
        )

    async def get_player(self, account_id: str) -> dict[str, Any]:
        """A player's profile, including their Trackmaster rank."""

        async def fetch() -> dict[str, Any]:
            player = await self.get(f"/player/{account_id}", null_on_404=True)
            if not player:
                raise NotFoundError(self.id, f"Trackmania account {account_id}", "trackmania")
            return dict(player)

        return await self.cached(
            ["player", account_id], "getPlayer", "trackmania", TTL["player"], fetch
        )

    async def get_player_matches(self, account_id: str, page: int = 0) -> list[dict[str, Any]]:
        """Recent matchmaking games."""
        response = await self.get(f"/player/{account_id}/matches/2/{page}", null_on_404=True)
        return self.rows((response or {}).get("matches") or [])

    async def get_matchmaking_leaderboard(self, page: int = 0) -> list[dict[str, Any]]:
        """The Trackmaster matchmaking ladder."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(f"/matchmaking/2/{page}", null_on_404=True)
            return self.rows((response or {}).get("ranks") or [])

        return await self.cached(
            ["mm-leaderboard", page],
            "getLeaderboard",
            "trackmania",
            TTL["leaderboard"],
            fetch,
        )

    async def get_map_leaderboard(self, map_uid: str, page: int = 0) -> list[dict[str, Any]]:
        """The Campaign or Track of the Day leaderboard for one map."""
        response = await self.get(
            f"/leaderboard/map/{map_uid}",
            query={"offset": page * 100, "length": 100},
            null_on_404=True,
        )
        return self.rows((response or {}).get("tops") or [])

    async def get_track_of_the_day(self, month: int = 0) -> dict[str, Any] | None:
        """Track of the Day for a month."""
        return await self.get_object(f"/totd/{month}", null_on_404=True)


class BrawlhallaProvider(ProviderClient):
    """Brawlhalla API.

    The one fighting game in this package with a first-party player API. Ids are
    ``brawlhalla_id``, resolvable from a Steam id or by searching the ranked
    ladder.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("brawlhalla", runtime)

    def auth_query_name(self) -> str:
        return "api_key"

    async def get_id_by_steam_id(self, steam_id: str) -> dict[str, Any]:
        """Steam id to Brawlhalla id."""

        async def fetch() -> dict[str, Any]:
            found = await self.get("/search", query={"steamid": steam_id}, null_on_404=True)
            if not found or not found.get("brawlhalla_id"):
                raise NotFoundError(
                    self.id, f"Brawlhalla account for {steam_id}", "brawlhalla"
                )
            return {
                "brawlhalla_id": found["brawlhalla_id"],
                "name": found.get("name") or "",
            }

        return await self.cached(
            ["steam", steam_id],
            "resolvePlayer",
            "brawlhalla",
            TTL["resolvePlayer"],
            fetch,
        )

    async def get_stats(self, brawlhalla_id: str | int) -> dict[str, Any]:
        """Lifetime statistics, including per-legend numbers."""

        async def fetch() -> dict[str, Any]:
            stats = await self.get(f"/player/{brawlhalla_id}/stats", null_on_404=True)
            if not stats:
                raise NotFoundError(
                    self.id, f"Brawlhalla player {brawlhalla_id}", "brawlhalla"
                )
            return dict(stats)

        return await self.cached(
            ["stats", brawlhalla_id],
            "getPlayerStats",
            "brawlhalla",
            TTL["playerStats"],
            fetch,
        )

    async def get_ranked(self, brawlhalla_id: str | int) -> dict[str, Any] | None:
        """Current season ranked standing, 1v1 and 2v2."""

        async def fetch() -> dict[str, Any] | None:
            return await self.get_object(f"/player/{brawlhalla_id}/ranked", null_on_404=True)

        return await self.cached(
            ["ranked", brawlhalla_id], "getRank", "brawlhalla", TTL["rank"], fetch
        )

    async def get_rankings(
        self,
        bracket: str = "1v1",
        region: str = "all",
        page: int = 1,
        name: str | None = None,
    ) -> list[dict[str, Any]]:
        """A page of the ranked ladder."""

        async def fetch() -> list[dict[str, Any]]:
            rows = await self.get(
                f"/rankings/{bracket}/{region}/{page}",
                query={"name": name},
                null_on_404=True,
            )
            return self.rows(rows or [])

        return await self.cached(
            ["rankings", bracket, region, page, name or "-"],
            "getLeaderboard",
            "brawlhalla",
            TTL["leaderboard"],
            fetch,
        )

    async def get_legends(self) -> list[dict[str, Any]]:
        """The legend roster."""

        async def fetch() -> list[dict[str, Any]]:
            return self.rows(await self.get("/legend/all", null_on_404=True) or [])

        return await self.cached(
            ["legends"], "getMetadata", "brawlhalla", TTL["metadata"], fetch
        )
