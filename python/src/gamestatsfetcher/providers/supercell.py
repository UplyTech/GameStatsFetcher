"""Supercell's three APIs: Clash Royale, Clash of Clans and Brawl Stars.

They share a schema, a tag format and one operational trap worth stating
plainly, because it is the single most common support question about them:

    **Supercell tokens are bound to IP addresses.** A key created on a laptop
    will answer ``403 accessDenied.invalidIp`` from a server, and the message
    does not say so clearly. If a call fails with 403 and the key is definitely
    right, the key is right and the address is wrong.

One base class, three thin subclasses - the endpoints differ but nothing else.
"""

from __future__ import annotations

from typing import Any

from ..constants import TTL
from ..errors import NotFoundError
from ..identity import encode_supercell_tag
from ..runtime import Runtime
from .base import ProviderClient

__all__ = ["ClashRoyaleProvider", "ClashOfClansProvider", "BrawlStarsProvider"]


class _SupercellProvider(ProviderClient):
    #: The title this provider serves, for cache keys and error context.
    title_id = ""

    async def get_player(self, tag: str) -> dict[str, Any]:
        """A player record. Shape differs per game, so callers narrow it."""
        encoded = encode_supercell_tag(tag)

        async def fetch() -> dict[str, Any]:
            player = await self.get(f"/players/{encoded}", null_on_404=True)
            if not player:
                raise NotFoundError(self.id, f"player {tag}", self.title_id)
            return dict(player)

        return await self.cached(
            ["player", encoded], "getPlayer", self.title_id, TTL["player"], fetch
        )

    async def get_player_rankings(
        self, location_id: str | int = "global", limit: int = 100
    ) -> list[dict[str, Any]]:
        """Rankings for a location.

        ``global`` is the worldwide board; numeric ids are countries, and
        Supercell publishes the id list at ``/locations``.
        """

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                f"/locations/{location_id}/rankings/players",
                query={"limit": limit},
                null_on_404=True,
            )
            return list((response or {}).get("items", []))

        return await self.cached(
            ["rankings", location_id, limit],
            "getLeaderboard",
            self.title_id,
            TTL["leaderboard"],
            fetch,
        )

    async def get_locations(self) -> list[dict[str, Any]]:
        """Locations, so a caller can turn "Germany" into the id a board needs."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get("/locations", query={"limit": 500})
            return list((response or {}).get("items", []))

        return await self.cached(
            ["locations"], "getMetadata", self.title_id, TTL["metadata"], fetch
        )


class ClashRoyaleProvider(_SupercellProvider):
    """Clash Royale.

    The only one of the three with a real match history: ``battlelog`` holds the
    last 25 battles, and nothing older is retrievable at all.
    """

    title_id = "clash-royale"

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("supercell-clash-royale", runtime)

    async def get_battle_log(self, tag: str) -> list[dict[str, Any]]:
        """The last 25 battles. Supercell keeps no more than that."""
        encoded = encode_supercell_tag(tag)

        async def fetch() -> list[dict[str, Any]]:
            log = await self.get(f"/players/{encoded}/battlelog", null_on_404=True)
            return self.rows(log or [])

        return await self.cached(
            ["battlelog", encoded],
            "getMatchHistory",
            self.title_id,
            TTL["matchHistory"],
            fetch,
        )

    async def get_upcoming_chests(self, tag: str) -> list[dict[str, Any]]:
        """Upcoming chests, a Clash Royale peculiarity worth exposing."""
        response = await self.get(
            f"/players/{encode_supercell_tag(tag)}/upcomingchests", null_on_404=True
        )
        return list((response or {}).get("items", []))

    async def get_clan(self, tag: str) -> dict[str, Any] | None:
        return await self.get_object(f"/clans/{encode_supercell_tag(tag)}", null_on_404=True)

    async def get_cards(self) -> list[dict[str, Any]]:
        """Cards, for turning deck ids into names."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get("/cards")
            return list((response or {}).get("items", []))

        return await self.cached(
            ["cards"], "getMetadata", self.title_id, TTL["metadata"], fetch
        )


class ClashOfClansProvider(_SupercellProvider):
    """Clash of Clans. Clan-centric, so the clan endpoints matter more here."""

    title_id = "clash-of-clans"

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("supercell-clash-of-clans", runtime)

    async def get_clan(self, tag: str) -> dict[str, Any] | None:
        return await self.get_object(f"/clans/{encode_supercell_tag(tag)}", null_on_404=True)

    async def get_current_war(self, clan_tag: str) -> dict[str, Any] | None:
        """The current clan war, the closest thing to a match record here."""
        return await self.get_object(
            f"/clans/{encode_supercell_tag(clan_tag)}/currentwar", null_on_404=True
        )

    async def get_war_log(self, clan_tag: str) -> list[dict[str, Any]]:
        """War log. Returns 403 rather than 404 when the clan keeps it private."""
        response = await self.get(
            f"/clans/{encode_supercell_tag(clan_tag)}/warlog", null_on_404=True
        )
        return list((response or {}).get("items", []))

    async def get_clan_rankings(
        self, location_id: str | int = "global", limit: int = 100
    ) -> list[dict[str, Any]]:
        response = await self.get(
            f"/locations/{location_id}/rankings/clans",
            query={"limit": limit},
            null_on_404=True,
        )
        return list((response or {}).get("items", []))


class BrawlStarsProvider(_SupercellProvider):
    """Brawl Stars. Has a battle log, like Clash Royale, and brawler-level stats."""

    title_id = "brawl-stars"

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("supercell-brawl-stars", runtime)

    async def get_battle_log(self, tag: str) -> list[dict[str, Any]]:
        """Recent battles. About 25, same as Clash Royale."""
        encoded = encode_supercell_tag(tag)

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(f"/players/{encoded}/battlelog", null_on_404=True)
            return list((response or {}).get("items", []))

        return await self.cached(
            ["battlelog", encoded],
            "getMatchHistory",
            self.title_id,
            TTL["matchHistory"],
            fetch,
        )

    async def get_club(self, tag: str) -> dict[str, Any] | None:
        return await self.get_object(f"/clubs/{encode_supercell_tag(tag)}", null_on_404=True)

    async def get_brawlers(self) -> list[dict[str, Any]]:
        """Brawler list, for turning ids into names."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get("/brawlers")
            return list((response or {}).get("items", []))

        return await self.cached(
            ["brawlers"], "getMetadata", self.title_id, TTL["metadata"], fetch
        )

    async def get_event_rotation(self) -> list[dict[str, Any]]:
        """Events currently in rotation."""
        response = await self.get("/events/rotation", null_on_404=True)
        return self.rows(response or [])
