"""The strategy titles' community ladders.

StarCraft II, Warcraft III, the Age of Empires games, Company of Heroes 3 and
Heroes of the Storm all have a competitive scene organised around a community
ladder rather than a publisher one. In three of these cases the community ladder
*is* the competitive game: W3Champions is where Warcraft III is played, and
SC2Pulse is the only place a player's accounts across four regions appear as one
person.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from ..constants import TTL
from ..errors import NotFoundError
from ..http import RequestSpec
from ..runtime import Runtime
from .base import ProviderClient

__all__ = [
    "Sc2PulseProvider",
    "W3ChampionsProvider",
    "RelicProvider",
    "Aoe4WorldProvider",
    "HeroesProfileProvider",
]


class Sc2PulseProvider(ProviderClient):
    """SC2Pulse.

    Blizzard's SC2 API is per-region and keyed on opaque profile ids. SC2Pulse
    indexes all four regions and groups the accounts a person actually plays on,
    which is why it is listed before ``blizzard`` for this title.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("sc2pulse", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    async def search_characters(self, term: str) -> list[dict[str, Any]]:
        """Search characters by BattleTag or name."""

        async def fetch() -> list[dict[str, Any]]:
            results = await self.get(
                "/character/search", query={"term": term}, null_on_404=True
            )
            if not results:
                raise NotFoundError(self.id, f'SC2 player "{term}"', "starcraft-2")
            return list(results)

        return await self.cached(
            ["search", term.lower()],
            "resolvePlayer",
            "starcraft-2",
            TTL["resolvePlayer"],
            fetch,
        )

    async def get_character_summary(
        self, character_id: str | int, depth_days: int = 120
    ) -> list[dict[str, Any]]:
        """Current ladder standing per race and queue for one character."""

        async def fetch() -> list[dict[str, Any]]:
            summary = await self.get(
                f"/character/{character_id}/summary/1v1/{depth_days}", null_on_404=True
            )
            return self.rows(summary or [])

        return await self.cached(
            ["summary", character_id, depth_days],
            "getRank",
            "starcraft-2",
            TTL["rank"],
            fetch,
        )

    async def get_character_matches(self, character_id: str | int) -> list[dict[str, Any]]:
        """Recent matches for a character."""

        async def fetch() -> list[dict[str, Any]]:
            matches = await self.get(
                f"/character/{character_id}/matches",
                query={"type": "_1V1"},
                null_on_404=True,
            )
            return self.rows(matches or [])

        return await self.cached(
            ["matches", character_id],
            "getMatchHistory",
            "starcraft-2",
            TTL["matchHistory"],
            fetch,
        )

    async def get_linked_accounts(self, character_id: str | int) -> list[dict[str, Any]]:
        """Every account this person plays on, across regions."""
        linked = await self.get(f"/character/{character_id}/common", null_on_404=True)
        return self.rows(linked or [])


class W3ChampionsProvider(ProviderClient):
    """W3Champions - the Warcraft III competitive ladder.

    Player ids are BattleTags with the hash intact, URL-encoded. The ``gateway``
    parameter (10 = Europe, 20 = America, 30 = Asia) decides which ladder is
    being asked about.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("w3champions", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    async def get_player(self, battle_tag: str) -> dict[str, Any]:
        """Player profile with per-race statistics."""

        async def fetch() -> dict[str, Any]:
            player = await self.get(f"/players/{quote(battle_tag, safe='')}", null_on_404=True)
            if not player:
                raise NotFoundError(self.id, f"BattleTag {battle_tag}", "warcraft-3")
            return dict(player)

        return await self.cached(
            ["player", battle_tag.lower()],
            "getPlayer",
            "warcraft-3",
            TTL["player"],
            fetch,
        )

    async def get_player_stats(
        self, battle_tag: str, season: int | None = None
    ) -> list[dict[str, Any]]:
        """Per-season, per-race statistics."""
        stats = await self.get(
            f"/players/{quote(battle_tag, safe='')}/game-mode-stats",
            query={"gateWay": 20, "season": season},
            null_on_404=True,
        )
        return self.rows(stats or [])

    async def get_matches(
        self,
        battle_tag: str,
        *,
        offset: int = 0,
        limit: int = 20,
        season: int | None = None,
    ) -> list[dict[str, Any]]:
        """Recent matches."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                "/matches/search",
                query={
                    "playerId": battle_tag,
                    "offset": offset,
                    "pageSize": min(limit, 100),
                    "season": season,
                },
                null_on_404=True,
            )
            return self.rows((response or {}).get("matches") or [])

        return await self.cached(
            ["matches", battle_tag.lower(), offset, limit],
            "getMatchHistory",
            "warcraft-3",
            TTL["matchHistory"],
            fetch,
        )

    async def get_ladder(
        self, game_mode: int = 1, *, gateway: int = 20, season: int | None = None
    ) -> list[dict[str, Any]]:
        """The ladder for a game mode and season."""

        async def fetch() -> list[dict[str, Any]]:
            ladder = await self.get(
                "/ladder",
                query={"gameMode": game_mode, "gateWay": gateway, "season": season},
                null_on_404=True,
            )
            return self.rows(ladder or [])

        return await self.cached(
            ["ladder", game_mode, gateway, season or 0],
            "getLeaderboard",
            "warcraft-3",
            TTL["leaderboard"],
            fetch,
        )


class RelicProvider(ProviderClient):
    """Relic Community API - Age of Empires II DE, Age of Empires IV and CoH 3.

    One schema, three games, keyed by a ``title`` parameter. The oddity is that
    leaderboard lookups take a JSON-encoded array as a query parameter, and a
    player is found by *searching the ladder* rather than by an id endpoint.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("relic", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    @staticmethod
    def title_param(title_id: str) -> str:
        """The ``title`` value each game answers to."""
        return {
            "age-of-empires-2": "age2",
            "age-of-empires-4": "age4",
            "company-of-heroes-3": "coh3",
        }.get(title_id, "age4")

    async def find_player(
        self, title_id: str, *, name: str | None = None, steam_id: str | None = None
    ) -> dict[str, Any]:
        """Find a player on a ladder by name or Steam id."""
        title = self.title_param(title_id)
        alias = f"/steam/{steam_id}" if steam_id else name

        async def fetch() -> dict[str, Any]:
            response = await self.get(
                "/leaderboards/getPersonalStat",
                query={"title": title, "profile_names": json.dumps([alias])},
                null_on_404=True,
            )
            groups = (response or {}).get("statGroups") or []
            if not groups:
                raise NotFoundError(self.id, f'player "{alias}"', title_id)
            return dict(groups[0])

        return await self.cached(
            [title, "find", alias or "-"],
            "resolvePlayer",
            title_id,
            TTL["resolvePlayer"],
            fetch,
        )

    async def get_personal_stats(
        self, title_id: str, profile_ids: list[str | int]
    ) -> dict[str, Any]:
        """Ladder standings and per-mode ratings for a player."""
        title = self.title_param(title_id)

        async def fetch() -> dict[str, Any]:
            response = await self.get(
                "/leaderboards/getPersonalStat",
                query={
                    "title": title,
                    "profile_ids": json.dumps([str(pid) for pid in profile_ids]),
                },
                null_on_404=True,
            )
            return dict(response or {})

        return await self.cached(
            [title, "stats", ",".join(str(pid) for pid in profile_ids)],
            "getPlayerStats",
            title_id,
            TTL["playerStats"],
            fetch,
        )

    async def get_recent_matches(
        self, title_id: str, profile_ids: list[str | int]
    ) -> list[dict[str, Any]]:
        """Recent match history for a player."""
        response = await self.get(
            "/leaderboards/getRecentMatchHistory",
            query={
                "title": self.title_param(title_id),
                "profile_ids": json.dumps([str(pid) for pid in profile_ids]),
            },
            null_on_404=True,
        )
        return self.rows((response or {}).get("matchHistoryStats") or [])

    async def get_leaderboard(
        self, title_id: str, leaderboard_id: int, *, start: int = 1, count: int = 100
    ) -> list[dict[str, Any]]:
        """A page of a leaderboard."""
        response = await self.get(
            "/leaderboards/getleaderboard2",
            query={
                "title": self.title_param(title_id),
                "leaderboard_id": leaderboard_id,
                "start": start,
                "count": min(count, 200),
                "sortBy": 1,
            },
            null_on_404=True,
        )
        return self.rows((response or {}).get("leaderboardStats") or [])


class Aoe4WorldProvider(ProviderClient):
    """AoE4World.

    Friendlier than the raw Relic endpoints and adds civilisation breakdowns and
    per-patch trends, so it is Age of Empires IV's preferred provider. It asks
    for a descriptive User-Agent, which the runtime supplies.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("aoe4world", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    async def search_players(self, query: str) -> list[dict[str, Any]]:
        """Search players by name."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                "/players/search", query={"query": query}, null_on_404=True
            )
            players = self.rows((response or {}).get("players") or [])
            if not players:
                raise NotFoundError(self.id, f'AoE4 player "{query}"', "age-of-empires-4")
            return players

        return await self.cached(
            ["search", query.lower()],
            "resolvePlayer",
            "age-of-empires-4",
            TTL["resolvePlayer"],
            fetch,
        )

    async def get_player(self, profile_id: str | int) -> dict[str, Any]:
        """Full profile with per-mode ratings."""

        async def fetch() -> dict[str, Any]:
            player = await self.get(f"/players/{profile_id}", null_on_404=True)
            if not player:
                raise NotFoundError(self.id, f"AoE4 profile {profile_id}", "age-of-empires-4")
            return dict(player)

        return await self.cached(
            ["player", profile_id],
            "getPlayer",
            "age-of-empires-4",
            TTL["player"],
            fetch,
        )

    async def get_games(
        self,
        profile_id: str | int,
        *,
        limit: int = 20,
        page: int = 1,
        leaderboard: str | None = None,
    ) -> list[dict[str, Any]]:
        """Recent games."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                f"/players/{profile_id}/games",
                query={
                    "limit": min(limit, 50),
                    "page": page,
                    "leaderboard": leaderboard,
                },
                null_on_404=True,
            )
            return self.rows((response or {}).get("games") or [])

        return await self.cached(
            ["games", profile_id, page, leaderboard or "-"],
            "getMatchHistory",
            "age-of-empires-4",
            TTL["matchHistory"],
            fetch,
        )

    async def get_game(self, game_id: str) -> dict[str, Any]:
        """One game in full."""

        async def fetch() -> dict[str, Any]:
            game = await self.get(f"/games/{game_id}", null_on_404=True)
            if not game:
                raise NotFoundError(self.id, f"AoE4 game {game_id}", "age-of-empires-4")
            return dict(game)

        return await self.cached(
            ["game", game_id], "getMatch", "age-of-empires-4", TTL["match"], fetch
        )

    async def get_leaderboard(
        self, leaderboard: str = "rm_solo", *, page: int = 1, query: str | None = None
    ) -> list[dict[str, Any]]:
        """A leaderboard page - ``rm_solo``, ``qm_1v1``, ``rm_team`` and so on."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                f"/leaderboards/{leaderboard}",
                query={"page": page, "query": query},
                null_on_404=True,
            )
            return self.rows((response or {}).get("players") or [])

        return await self.cached(
            ["leaderboard", leaderboard, page],
            "getLeaderboard",
            "age-of-empires-4",
            TTL["leaderboard"],
            fetch,
        )


class HeroesProfileProvider(ProviderClient):
    """Heroes Profile - Heroes of the Storm.

    Blizzard never shipped a HotS profile API, and the game is in maintenance
    mode, so this replay-derived database is all there is. Like Ballchasing, it
    only knows the games somebody uploaded.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("heroesprofile", runtime)

    def auth_query_name(self) -> str:
        return "api_token"

    async def get_player(self, battle_tag: str, region: int = 1) -> dict[str, Any]:
        """Career profile by BattleTag."""

        async def fetch() -> dict[str, Any]:
            player = await self.get(
                "/Player",
                query={"battletag": battle_tag, "region": region},
                null_on_404=True,
            )
            if not player:
                raise NotFoundError(self.id, f"BattleTag {battle_tag}", "heroes-of-the-storm")
            return dict(player)

        return await self.cached(
            ["player", battle_tag.lower(), region],
            "getPlayer",
            "heroes-of-the-storm",
            TTL["player"],
            fetch,
        )

    async def get_hero_stats(self, battle_tag: str, region: int = 1) -> dict[str, Any]:
        """Per-hero career statistics."""
        stats = await self.get(
            "/Player/Hero/All",
            query={"battletag": battle_tag, "region": region},
            null_on_404=True,
        )
        return dict(stats or {})

    async def get_matches(self, battle_tag: str, region: int = 1) -> list[dict[str, Any]]:
        """Recent matches."""

        async def fetch() -> list[dict[str, Any]]:
            matches = await self.get(
                "/Player/MMR",
                query={"battletag": battle_tag, "region": region},
                null_on_404=True,
            )
            return self.rows(matches or [])

        return await self.cached(
            ["matches", battle_tag.lower(), region],
            "getMatchHistory",
            "heroes-of-the-storm",
            TTL["matchHistory"],
            fetch,
        )
