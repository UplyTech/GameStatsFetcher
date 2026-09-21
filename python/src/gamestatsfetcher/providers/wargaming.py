"""Wargaming.net Public API and the Hi-Rez Studios API.

Two publishers left over from the first-party set, sharing this module because
neither is large enough to justify its own and both have one memorable quirk:

* **Wargaming** answers a *failure* with HTTP 200 and
  ``{"status": "error", ...}``, so the envelope has to be unwrapped by hand.
  The host encodes both the game and the region: ``api.worldoftanks.eu`` and
  ``api.worldofwarships.asia`` are the same API with different data behind it.
* **Hi-Rez** signs every call with an MD5 of ``devId + method + authKey +
  timestamp`` and needs an open session that lapses after 15 minutes. MD5 here
  is their protocol, not a security choice of this package: the signature
  identifies the caller and protects nothing.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any

from ..constants import TTL
from ..errors import AuthenticationError, NotFoundError, ParseError, ValidationError
from ..http import RequestSpec
from ..runtime import Runtime
from .base import ProviderClient

__all__ = ["WargamingProvider", "HiRezProvider"]


# ---------------------------------------------------------------------------
# Wargaming
# ---------------------------------------------------------------------------

#: Region to top-level domain. ``na`` is ``.com``, which is the one people miss.
_REGION_TLD = {"eu": "eu", "na": "com", "asia": "asia"}


class WargamingProvider(ProviderClient):
    """World of Tanks and World of Warships."""

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("wargaming", runtime)

    def auth_query_name(self) -> str:
        return "application_id"

    def host(self, game: str, region: str) -> str:
        """Build the host for a game and region."""
        tld = _REGION_TLD.get(region.lower())
        if not tld:
            raise ValidationError(
                f'unknown Wargaming region "{region}". '
                f"Expected one of: {', '.join(_REGION_TLD)}"
            )
        return f"https://api.{game}.{tld}"

    @staticmethod
    def _prefix(game: str) -> str:
        """The API path prefix, which is not the host's game name."""
        return "/wot" if game == "worldoftanks" else "/wows"

    def _unwrap(self, envelope: Any, what: str) -> Any:
        """Unwrap the envelope, turning a 200-with-error into a real error."""
        if not envelope:
            raise NotFoundError(self.id, what)
        if envelope.get("status") == "error":
            message = str((envelope.get("error") or {}).get("message", "unknown error"))
            if "NOT_FOUND" in message or "INVALID" in message:
                raise NotFoundError(self.id, f"{what} ({message})")
            raise ParseError(self.id, message)
        if envelope.get("data") is None:
            raise ParseError(self.id, "response had no data")
        return envelope["data"]

    async def _call(self, game: str, region: str, path: str, query: dict[str, Any]) -> Any:
        return await self.get(
            f"{self.host(game, region)}{self._prefix(game)}{path}", query=query
        )

    async def search_accounts(
        self, game: str, region: str, search: str, limit: int = 10
    ) -> list[dict[str, Any]]:
        """Search accounts by nickname. Prefix search, so it powers autocomplete."""
        title_id = "world-of-tanks" if game == "worldoftanks" else "world-of-warships"

        async def fetch() -> list[dict[str, Any]]:
            envelope = await self._call(
                game, region, "/account/list/", {"search": search, "limit": limit}
            )
            return list(self._unwrap(envelope, f'accounts matching "{search}"'))

        return await self.cached(
            [game, region, "search", search.lower(), limit],
            "resolvePlayer",
            title_id,
            TTL["resolvePlayer"],
            fetch,
        )

    async def find_account(self, game: str, region: str, nickname: str) -> dict[str, Any]:
        """The exact account for a nickname, or a :class:`NotFoundError`."""
        matches = await self.search_accounts(game, region, nickname, 10)
        for account in matches:
            if str(account.get("nickname", "")).lower() == nickname.lower():
                return account
        raise NotFoundError(self.id, f'account "{nickname}" on {region}')

    async def get_account_info(
        self, game: str, region: str, account_id: str | int
    ) -> dict[str, Any]:
        """Full account info including career statistics."""
        title_id = "world-of-tanks" if game == "worldoftanks" else "world-of-warships"

        async def fetch() -> dict[str, Any]:
            envelope = await self._call(
                game,
                region,
                "/account/info/",
                {"account_id": account_id, "extra": "statistics.random"},
            )
            data = self._unwrap(envelope, f"account {account_id}")
            account = data.get(str(account_id))
            # A hidden profile is `null` under its own id rather than an error.
            if not account:
                raise NotFoundError(self.id, f"account {account_id}", title_id)
            return dict(account)

        return await self.cached(
            [game, region, "info", account_id],
            "getPlayerStats",
            title_id,
            TTL["playerStats"],
            fetch,
        )

    async def get_vehicle_stats(
        self, game: str, region: str, account_id: str | int
    ) -> list[dict[str, Any]]:
        """Per-vehicle statistics. Large, so it is fetched only when asked for."""
        path = "/tanks/stats/" if game == "worldoftanks" else "/ships/stats/"
        envelope = await self._call(game, region, path, {"account_id": account_id})
        data = self._unwrap(envelope, f"vehicle stats for {account_id}")
        return self.rows(data.get(str(account_id)) or [])

    async def get_clan_info(
        self, game: str, region: str, clan_id: str | int
    ) -> dict[str, Any] | None:
        envelope = await self._call(game, region, "/clans/info/", {"clan_id": clan_id})
        data = self._unwrap(envelope, f"clan {clan_id}")
        return self.as_object(data.get(str(clan_id)), f"clan {clan_id}")

    async def get_vehicle_encyclopedia(self, game: str, region: str) -> dict[str, Any]:
        """The vehicle encyclopaedia, for turning ids into names."""
        title_id = "world-of-tanks" if game == "worldoftanks" else "world-of-warships"
        path = "/encyclopedia/vehicles/" if game == "worldoftanks" else "/encyclopedia/ships/"

        async def fetch() -> dict[str, Any]:
            envelope = await self._call(
                game, region, path, {"fields": "name,tier,type,nation"}
            )
            return dict(self._unwrap(envelope, "vehicle encyclopedia"))

        return await self.cached(
            [game, region, "encyclopedia"],
            "getMetadata",
            title_id,
            TTL["metadata"],
            fetch,
        )


# ---------------------------------------------------------------------------
# Hi-Rez
# ---------------------------------------------------------------------------

_GAME_HOSTS = {
    "smite": "https://api.smitegame.com/smiteapi.svc",
    "paladins": "https://api.paladins.com/paladinsapi.svc",
}


class HiRezProvider(ProviderClient):
    """SMITE and Paladins.

    Sessions are memoised for 12 minutes - short of the 15-minute expiry, so a
    request never goes out with a session that lapsed while it was queued.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("hirez", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        """Hi-Rez signs the URL itself, so the generic authoriser adds nothing.

        Overridden rather than left to raise, because ``authorize`` runs for
        every request and the signing happens in :meth:`_call`, where the method
        name is known.
        """
        return spec

    @staticmethod
    def _timestamp() -> str:
        """``yyyyMMddHHmmss`` in UTC, the only format accepted."""
        return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

    @staticmethod
    def _signature(dev_id: str, method: str, auth_key: str, timestamp: str) -> str:
        return hashlib.md5(  # noqa: S324 - Hi-Rez's protocol, not a security choice
            f"{dev_id}{method}{auth_key}{timestamp}".encode()
        ).hexdigest()

    async def _session(self, game: str) -> str:
        """Open a session, or reuse the one from the last twelve minutes."""
        dev_id, auth_key = self.require_key_parts(2, "devId:authKey")

        async def fetch() -> str:
            timestamp = self._timestamp()
            signature = self._signature(dev_id, "createsession", auth_key, timestamp)
            url = f"{_GAME_HOSTS[game]}/createsessionJson/{dev_id}/{signature}/{timestamp}"
            response = await self.runtime.http.send(self.id, url, RequestSpec())
            session = (response or {}).get("session_id")
            if not session:
                message = (response or {}).get("ret_msg", "no session_id returned")
                raise AuthenticationError(self.id, f"createsession failed: {message}")
            return str(session)

        return await self.memo(f"session:{game}", 12 * 60 * 1_000, fetch)

    async def _call(self, game: str, method: str, params: list[Any] | None = None) -> Any:
        """Call one method.

        The path is ``/{method}Json/{devId}/{signature}/{session}/{timestamp}/{...}``
        and the parameter order is fixed per method, which is why callers pass an
        ordered list rather than a mapping.
        """
        from urllib.parse import quote

        dev_id, auth_key = self.require_key_parts(2, "devId:authKey")
        session = await self._session(game)
        timestamp = self._timestamp()
        signature = self._signature(dev_id, method, auth_key, timestamp)
        suffix = (
            "/" + "/".join(quote(str(param), safe="") for param in params) if params else ""
        )
        url = (
            f"{_GAME_HOSTS[game]}/{method}Json/{dev_id}/{signature}"
            f"/{session}/{timestamp}{suffix}"
        )
        return await self.runtime.http.send(self.id, url, RequestSpec())

    async def get_data_used(self, game: str) -> list[dict[str, Any]]:
        """Whether the API is up, and how many calls today's key has left."""
        return self.rows(await self._call(game, "getdataused") or [])

    async def get_player(self, game: str, player: str) -> dict[str, Any]:
        """Player by in-game name or by player id."""
        title_id = "smite" if game == "smite" else "paladins"

        async def fetch() -> dict[str, Any]:
            rows = await self._call(game, "getplayer", [player])
            if not rows:
                raise NotFoundError(self.id, f'player "{player}"', title_id)
            return dict(rows[0])

        return await self.cached(
            [game, "player", player.lower()], "getPlayer", title_id, TTL["player"], fetch
        )

    async def get_player_id_by_name(self, game: str, name: str) -> list[dict[str, Any]]:
        """Resolve a name to player ids across platforms.

        A console player and a PC player can share a name, so this returns every
        match and the caller picks - guessing would silently show the wrong
        person.
        """
        return self.rows(await self._call(game, "getplayeridbyname", [name]) or [])

    async def get_match_history(self, game: str, player_id: str) -> list[dict[str, Any]]:
        """Recent matches. Hi-Rez returns roughly the last 50."""
        title_id = "smite" if game == "smite" else "paladins"

        async def fetch() -> list[dict[str, Any]]:
            return self.rows(await self._call(game, "getmatchhistory", [player_id]) or [])

        return await self.cached(
            [game, "history", player_id],
            "getMatchHistory",
            title_id,
            TTL["matchHistory"],
            fetch,
        )

    async def get_match_details(self, game: str, match_id: str) -> list[dict[str, Any]]:
        """Full detail for one match."""
        title_id = "smite" if game == "smite" else "paladins"

        async def fetch() -> list[dict[str, Any]]:
            rows = await self._call(game, "getmatchdetails", [match_id])
            if not rows:
                raise NotFoundError(self.id, f"match {match_id}", title_id)
            return list(rows)

        return await self.cached(
            [game, "match", match_id], "getMatch", title_id, TTL["match"], fetch
        )

    async def get_player_character_ranks(
        self, game: str, player_id: str
    ) -> list[dict[str, Any]]:
        """Per-god or per-champion career statistics."""
        method = "getgodranks" if game == "smite" else "getchampionranks"
        return self.rows(await self._call(game, method, [player_id]) or [])

    async def get_characters(self, game: str) -> list[dict[str, Any]]:
        """The god or champion list, for turning ids into names."""
        title_id = "smite" if game == "smite" else "paladins"
        method = "getgods" if game == "smite" else "getchampions"

        async def fetch() -> list[dict[str, Any]]:
            return self.rows(await self._call(game, method, [1]) or [])

        return await self.cached(
            [game, "characters"], "getMetadata", title_id, TTL["metadata"], fetch
        )

    async def get_league_leaderboard(
        self, game: str, queue_id: int, tier: int, season: int
    ) -> list[dict[str, Any]]:
        """The ranked leaderboard for a queue and tier."""
        return self.rows(
            await self._call(game, "getleagueleaderboard", [queue_id, tier, season]) or []
        )

    async def get_match_ids_by_queue(
        self, game: str, queue_id: int, date: str, hour: str
    ) -> list[dict[str, Any]]:
        """Matches played in a queue - the esports spectator feed."""
        return self.rows(
            await self._call(game, "getmatchidsbyqueue", [queue_id, date, hour]) or []
        )
