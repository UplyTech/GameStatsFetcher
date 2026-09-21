"""The community APIs behind the shooters whose publishers ship none.

Overwatch 2, Apex Legends, Fortnite, Halo Infinite, The Finals, Marvel Rivals
and Deadlock all have an active competitive scene and no first-party player
endpoint. Each provider below is the established substitute for one of them, and
each has its own idea of what a player identifier is - which is most of what
these classes exist to absorb.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ..constants import TTL
from ..errors import NotFoundError, PrivateProfileError
from ..http import RequestSpec
from ..identity import to_battle_tag_path, to_steam_account_id
from ..runtime import Runtime
from .base import ProviderClient

__all__ = [
    "OverFastProvider",
    "ApexProvider",
    "FortniteProvider",
    "HaloProvider",
    "TheFinalsProvider",
    "MarvelRivalsProvider",
    "DeadlockProvider",
]


class OverFastProvider(ProviderClient):
    """OverFast - Overwatch 2.

    Reads the official career pages, so it sees exactly what Blizzard publishes.
    Two consequences: a private career profile yields empty statistics rather
    than an error, and BattleTags are written with a dash (``Player-1234``)
    because a hash cannot appear in a URL path.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("overfast", runtime)

    async def get_summary(self, battle_tag: str) -> dict[str, Any]:
        """Name, endorsement level, and the competitive ranks per role."""
        path = to_battle_tag_path(battle_tag)

        async def fetch() -> dict[str, Any]:
            summary = await self.get(
                f"/players/{quote(path, safe='')}/summary", null_on_404=True
            )
            if not summary:
                raise NotFoundError(self.id, f"BattleTag {battle_tag}", "overwatch-2")
            return dict(summary)

        return await self.cached(
            [path, "summary"], "getPlayer", "overwatch-2", TTL["player"], fetch
        )

    async def get_stats(
        self, battle_tag: str, *, platform: str = "pc", gamemode: str = "competitive"
    ) -> dict[str, Any]:
        """Career statistics for one platform and game mode.

        A private profile answers 200 with empty stats, which is turned into a
        :class:`PrivateProfileError` here so callers can tell the difference from
        a player who has simply not played.
        """
        path = to_battle_tag_path(battle_tag)

        async def fetch() -> dict[str, Any]:
            stats = await self.get(
                f"/players/{quote(path, safe='')}/stats",
                query={"platform": platform, "gamemode": gamemode},
                null_on_404=True,
            )
            if not stats:
                summary = await self.get_summary(battle_tag)
                if summary.get("privacy") == "private":
                    raise PrivateProfileError(self.id, battle_tag, "overwatch-2")
                raise NotFoundError(self.id, f"stats for {battle_tag}", "overwatch-2")
            return dict(stats)

        return await self.cached(
            [path, "stats", platform, gamemode],
            "getPlayerStats",
            "overwatch-2",
            TTL["playerStats"],
            fetch,
        )

    async def search_players(self, name: str, limit: int = 20) -> list[dict[str, Any]]:
        """Search for players by name prefix."""
        response = await self.get(
            "/players", query={"name": name, "limit": limit}, null_on_404=True
        )
        return self.rows((response or {}).get("results") or [])

    async def get_heroes(self) -> list[dict[str, Any]]:
        """Hero roster, for turning ability keys into readable names."""

        async def fetch() -> list[dict[str, Any]]:
            return self.rows(await self.get("/heroes", null_on_404=True) or [])

        return await self.cached(
            ["heroes"], "getMetadata", "overwatch-2", TTL["metadata"], fetch
        )

    async def get_maps(self) -> list[dict[str, Any]]:
        """Current map pool."""

        async def fetch() -> list[dict[str, Any]]:
            return self.rows(await self.get("/maps", null_on_404=True) or [])

        return await self.cached(
            ["maps"], "getMetadata", "overwatch-2", TTL["metadata"], fetch
        )


class ApexProvider(ProviderClient):
    """ApexLegendsAPI (mozambiquehe.re).

    Player names are not unique across platforms, so every lookup needs a
    platform alongside the name. ``PC`` here means Origin/EA, not Steam.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("apex-legends-api", runtime)

    def auth_query_name(self) -> str:
        return "auth"

    async def get_player(self, name: str, platform: str = "PC") -> dict[str, Any]:
        """Full player bridge: rank, legend stats and current status."""

        async def fetch() -> dict[str, Any]:
            response = await self.get(
                "/bridge", query={"player": name, "platform": platform}, null_on_404=True
            )
            if not response or "Error" in response:
                raise NotFoundError(
                    self.id, f'Apex player "{name}" on {platform}', "apex-legends"
                )
            return dict(response)

        return await self.cached(
            [platform, name.lower()],
            "getPlayerStats",
            "apex-legends",
            TTL["playerStats"],
            fetch,
        )

    async def get_player_by_uid(self, uid: str, platform: str = "PC") -> dict[str, Any]:
        """The same, by EA account id, which is stable when a name is not."""
        response = await self.get(
            "/bridge", query={"uid": uid, "platform": platform}, null_on_404=True
        )
        if not response or "Error" in response:
            raise NotFoundError(self.id, f"Apex uid {uid}", "apex-legends")
        return dict(response)

    async def get_map_rotation(self) -> dict[str, Any] | None:
        """The current and upcoming map rotation."""
        return await self.get_object("/maprotation", query={"version": 2}, null_on_404=True)

    async def get_predator_cutoff(self) -> dict[str, Any] | None:
        """Predator and Master cutoffs, as close to a ladder as Apex gets."""
        return await self.get_object("/predator", null_on_404=True)


class FortniteProvider(ProviderClient):
    """Fortnite-API.com.

    Stats need a key; the cosmetics and map endpoints do not. A player who has
    turned off public stats in-game returns 403 whatever key you hold, which is
    an in-game setting rather than an API problem.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("fortnite-api", runtime)

    def auth_header_name(self) -> str:
        return "Authorization"

    async def get_stats_by_name(
        self,
        name: str,
        *,
        account_type: str = "epic",
        time_window: str = "lifetime",
    ) -> dict[str, Any]:
        """Career statistics by display name."""

        async def fetch() -> dict[str, Any]:
            response = await self.get(
                "/v2/stats/br/v2",
                query={
                    "name": name,
                    "accountType": account_type,
                    "timeWindow": time_window,
                    "image": "none",
                },
                null_on_404=True,
            )
            data = (response or {}).get("data")
            if not data:
                raise NotFoundError(self.id, f'Fortnite player "{name}"', "fortnite")
            return dict(data)

        return await self.cached(
            ["stats", name.lower(), account_type, time_window],
            "getPlayerStats",
            "fortnite",
            TTL["playerStats"],
            fetch,
        )

    async def get_stats_by_id(
        self, account_id: str, time_window: str = "lifetime"
    ) -> dict[str, Any]:
        """The same by Epic account id."""
        response = await self.get(
            "/v2/stats/br/v2",
            query={"accountId": account_id, "timeWindow": time_window, "image": "none"},
            null_on_404=True,
        )
        data = (response or {}).get("data")
        if not data:
            raise NotFoundError(self.id, f"Fortnite account {account_id}", "fortnite")
        return dict(data)

    async def get_cosmetics(self) -> dict[str, Any] | None:
        """The full cosmetic catalogue. No key required."""

        async def fetch() -> dict[str, Any] | None:
            response = await self.get("/v2/cosmetics/br")
            return (response or {}).get("data")

        return await self.cached(
            ["cosmetics"], "getMetadata", "fortnite", TTL["metadata"], fetch
        )

    async def get_playlists(self) -> list[dict[str, Any]]:
        """Current playlists, which is how a caller learns what modes exist."""
        response = await self.get("/v1/playlists")
        return self.rows((response or {}).get("data") or [])


class HaloProvider(ProviderClient):
    """HaloDotAPI - Halo Infinite. Keyed on gamertag."""

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("halodotapi", runtime)

    async def get_service_record(self, gamertag: str) -> dict[str, Any]:
        """Multiplayer service record: the career totals."""

        async def fetch() -> dict[str, Any]:
            response = await self.get(
                f"/stats/players/{quote(gamertag, safe='')}/service-record/global",
                null_on_404=True,
            )
            data = (response or {}).get("data")
            if not data:
                raise NotFoundError(self.id, f'gamertag "{gamertag}"', "halo-infinite")
            return dict(data)

        return await self.cached(
            ["service-record", gamertag.lower()],
            "getPlayerStats",
            "halo-infinite",
            TTL["playerStats"],
            fetch,
        )

    async def get_csr(self, gamertag: str) -> list[dict[str, Any]]:
        """Competitive CSR, per playlist."""
        response = await self.get(
            f"/stats/players/{quote(gamertag, safe='')}/csrs",
            query={"season": "current"},
            null_on_404=True,
        )
        return self.rows((response or {}).get("data") or [])

    async def get_matches(
        self, gamertag: str, *, limit: int = 25, offset: int = 0
    ) -> list[dict[str, Any]]:
        """Recent matches."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                f"/stats/players/{quote(gamertag, safe='')}/matches",
                query={"limit": limit, "offset": offset},
                null_on_404=True,
            )
            return self.rows((response or {}).get("data") or [])

        return await self.cached(
            ["matches", gamertag.lower(), limit, offset],
            "getMatchHistory",
            "halo-infinite",
            TTL["matchHistory"],
            fetch,
        )

    async def get_match(self, match_id: str) -> dict[str, Any]:
        """One match, with the full scoreboard."""

        async def fetch() -> dict[str, Any]:
            response = await self.get(f"/stats/matches/{match_id}", null_on_404=True)
            data = (response or {}).get("data")
            if not data:
                raise NotFoundError(self.id, f"Halo match {match_id}", "halo-infinite")
            return dict(data)

        return await self.cached(
            ["match", match_id], "getMatch", "halo-infinite", TTL["match"], fetch
        )


class TheFinalsProvider(ProviderClient):
    """The Finals leaderboard API.

    Leaderboard-shaped rather than player-shaped: there is no "get player"
    endpoint, only "search this season's ladder". That is why the title declares
    ``getRank`` and ``getLeaderboard`` but not ``getMatchHistory`` - the data does
    not exist to serve one.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("the-finals-api", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    async def search(
        self, name: str, season: str = "s5", platform: str = "crossplay"
    ) -> list[dict[str, Any]]:
        """Search a season's ladder."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                f"/leaderboard/{season}/{platform}", query={"name": name}, null_on_404=True
            )
            return self.rows((response or {}).get("data") or [])

        return await self.cached(
            ["search", season, platform, name.lower()],
            "getLeaderboard",
            "the-finals",
            TTL["leaderboard"],
            fetch,
        )

    async def get_player(
        self, name: str, season: str = "s5", platform: str = "crossplay"
    ) -> dict[str, Any]:
        """The exact ladder row for a name, or a :class:`NotFoundError`."""
        rows = await self.search(name, season, platform)
        lowered = name.lower()
        for row in rows:
            if lowered in (
                str(row.get("name", "")).lower(),
                str(row.get("steamName", "")).lower(),
            ):
                return dict(row)
        if rows:
            return dict(rows[0])
        raise NotFoundError(self.id, f'The Finals player "{name}"', "the-finals")

    async def get_leaderboard(
        self, season: str = "s5", platform: str = "crossplay"
    ) -> list[dict[str, Any]]:
        """A page of the ladder."""
        response = await self.get(f"/leaderboard/{season}/{platform}", null_on_404=True)
        return self.rows((response or {}).get("data") or [])


class MarvelRivalsProvider(ProviderClient):
    """marvelrivalsapi.com.

    Data appears only once an account has been indexed at least once, so a brand
    new player can legitimately 404 for a while. The message says so rather than
    implying the name was wrong.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("marvel-rivals", runtime)

    def auth_header_name(self) -> str:
        return "x-api-key"

    async def get_player(self, name_or_uid: str) -> dict[str, Any]:
        async def fetch() -> dict[str, Any]:
            player = await self.get(f"/player/{quote(name_or_uid, safe='')}", null_on_404=True)
            if not player:
                raise NotFoundError(
                    self.id,
                    f'Marvel Rivals player "{name_or_uid}" '
                    "(new accounts appear only after their first index)",
                    "marvel-rivals",
                )
            return dict(player)

        return await self.cached(
            ["player", name_or_uid.lower()],
            "getPlayer",
            "marvel-rivals",
            TTL["player"],
            fetch,
        )

    async def get_match_history(self, uid: str, limit: int = 20) -> list[dict[str, Any]]:
        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                f"/player/{uid}/match-history", query={"limit": limit}, null_on_404=True
            )
            return self.rows((response or {}).get("match_history") or [])

        return await self.cached(
            ["matches", uid, limit],
            "getMatchHistory",
            "marvel-rivals",
            TTL["matchHistory"],
            fetch,
        )

    async def get_match(self, match_id: str) -> dict[str, Any]:
        async def fetch() -> dict[str, Any]:
            match = await self.get(f"/match/{match_id}", null_on_404=True)
            if not match:
                raise NotFoundError(self.id, f"match {match_id}", "marvel-rivals")
            return dict(match)

        return await self.cached(
            ["match", match_id], "getMatch", "marvel-rivals", TTL["match"], fetch
        )

    async def get_leaderboard(self, hero_id: str) -> list[dict[str, Any]]:
        response = await self.get(f"/heroes/leaderboard/{hero_id}", null_on_404=True)
        return self.rows((response or {}).get("players") or [])

    async def get_heroes(self) -> list[dict[str, Any]]:
        async def fetch() -> list[dict[str, Any]]:
            return self.rows(await self.get("/heroes", null_on_404=True) or [])

        return await self.cached(
            ["heroes"], "getMetadata", "marvel-rivals", TTL["metadata"], fetch
        )


class DeadlockProvider(ProviderClient):
    """deadlock-api.com.

    Keyed on the 32-bit Steam account id, like Dota 2. The game is still in
    closed testing, so the schema moves - which is exactly why the normalised
    layer above keeps the raw payload attached.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("deadlock-api", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    async def get_player_card(self, steam_or_account_id: str) -> dict[str, Any]:
        account_id = to_steam_account_id(steam_or_account_id)

        async def fetch() -> dict[str, Any]:
            card = await self.get(f"/players/{account_id}/card", null_on_404=True)
            if not card:
                raise NotFoundError(self.id, f"Deadlock account {account_id}", "deadlock")
            return dict(card)

        return await self.cached(
            ["card", account_id], "getPlayer", "deadlock", TTL["player"], fetch
        )

    async def get_match_history(self, steam_or_account_id: str) -> list[dict[str, Any]]:
        account_id = to_steam_account_id(steam_or_account_id)

        async def fetch() -> list[dict[str, Any]]:
            history = await self.get(f"/players/{account_id}/match-history", null_on_404=True)
            return self.rows(history or [])

        return await self.cached(
            ["history", account_id],
            "getMatchHistory",
            "deadlock",
            TTL["matchHistory"],
            fetch,
        )

    async def get_match(self, match_id: str) -> dict[str, Any]:
        async def fetch() -> dict[str, Any]:
            match = await self.get(f"/matches/{match_id}/metadata", null_on_404=True)
            if not match:
                raise NotFoundError(self.id, f"Deadlock match {match_id}", "deadlock")
            return dict(match)

        return await self.cached(
            ["match", match_id], "getMatch", "deadlock", TTL["match"], fetch
        )

    async def get_leaderboard(self, region: str = "Europe") -> list[dict[str, Any]]:
        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(f"/leaderboard/{region}", null_on_404=True)
            return self.rows((response or {}).get("entries") or [])

        return await self.cached(
            ["leaderboard", region],
            "getLeaderboard",
            "deadlock",
            TTL["leaderboard"],
            fetch,
        )

    async def get_heroes(self) -> list[dict[str, Any]]:
        async def fetch() -> list[dict[str, Any]]:
            return self.rows(
                await self.get("https://assets.deadlock-api.com/v2/heroes", null_on_404=True)
                or []
            )

        return await self.cached(["heroes"], "getMetadata", "deadlock", TTL["metadata"], fetch)
