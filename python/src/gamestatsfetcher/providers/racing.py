"""Sim racing and the fighting-game ladder.

iRacing and Trackmania are the two racing titles with a real API. Brawlhalla is
here because it is the one fighting game whose publisher ships a player API -
every other title in that genre is start.gg brackets and nothing else.
"""

from __future__ import annotations

import base64
import hashlib
import json as jsonlib
from typing import Any

from ..constants import TTL
from ..errors import AuthenticationError, NotFoundError
from ..http import RequestSpec
from ..runtime import Runtime
from .base import ProviderClient

__all__ = ["IRacingProvider", "TrackmaniaProvider", "BrawlhallaProvider"]


class IRacingProvider(ProviderClient):
    """iRacing Data API.

    Three things make this the most awkward provider in the package, and all
    three are handled here so no caller has to know about them:

    1. **The password must be pre-hashed.** iRacing wants
       ``base64(sha256(password + lowercase(email)))``, not the password.
    2. **Auth is a cookie.** ``/auth`` sets one, and every later call needs it.
    3. **Responses are S3 links.** A data endpoint answers ``{"link": "..."}``
       and the payload is behind it, so every call is two round trips.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("iracing", runtime)

    @staticmethod
    def _encode_password(email: str, password: str) -> str:
        """The hash iRacing expects in place of the password."""
        digest = hashlib.sha256((password + email.lower()).encode("utf-8")).digest()
        return base64.b64encode(digest).decode("ascii")

    async def _session_cookie(self) -> str:
        """Authenticate and hold the session cookie."""
        email, password = self.require_key_parts(2, "email:password")

        async def fetch() -> str:
            response = await self.runtime.transport.request(
                "POST",
                f"{self.descriptor.base_url}/auth",
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": self.runtime.user_agent,
                },
                # json.dumps rather than string formatting: an email or a
                # base64 password containing a quote would otherwise produce a
                # body the server rejects as malformed.
                body=jsonlib.dumps(
                    {
                        "email": email,
                        "password": self._encode_password(email, password),
                    }
                ),
                timeout_ms=self.runtime.timeout_ms,
            )
            if not 200 <= response.status < 300:
                raise AuthenticationError(self.id, f"auth returned {response.status}")
            raw = response.header("set-cookie")
            if not raw:
                raise AuthenticationError(self.id, "auth succeeded but set no session cookie")
            # Keep only the name=value pairs; the attributes are not sent back.
            return "; ".join(part.split(";")[0] for part in raw.split(", ") if "=" in part)

        return await self.memo("cookie", 30 * 60 * 1_000, fetch)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        cookie = await self._session_cookie()
        return spec.merged(headers={"Cookie": cookie, **spec.headers})

    async def _data(self, path: str, query: dict[str, Any] | None = None) -> Any:
        """Call a data endpoint and follow the S3 link it returns.

        Some endpoints answer with the payload directly and some with a link;
        both shapes are handled so callers see one behaviour.
        """
        first = await self.get(path, query=query or {})
        if isinstance(first, dict) and isinstance(first.get("link"), str):
            # The S3 link is pre-signed and must not carry the session cookie.
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
