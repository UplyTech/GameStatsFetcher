"""Wargaming.net Public API.

Wargaming answers a *failure* with HTTP 200 and ``{"status": "error", ...}``,
so the envelope has to be unwrapped by hand. The host encodes both the game and
the region: ``api.worldoftanks.eu`` and ``api.worldofwarships.asia`` are the
same API with different data behind it.
"""

from __future__ import annotations

from typing import Any

from ..constants import TTL
from ..errors import NotFoundError, ParseError, ValidationError
from ..runtime import Runtime
from .base import ProviderClient

__all__ = ["WargamingProvider"]


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
