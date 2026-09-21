"""FACEIT Data API and the Tracker Network API.

The two providers that supply the competitive layer several titles have and
their publishers do not expose.

* **FACEIT** is not a supplement for CS2 - Valve publishes no matchmaking rank
  at all, so "what rank is this player" and "FACEIT level" are the same question
  in practice. One schema covers CS2, Dota 2, VALORANT, League of Legends,
  Rocket League and Apex Legends; only the ``game`` parameter changes.
* **Tracker** is the reason Rainbow Six Siege, Call of Duty and Battlefield
  appear in this package at all. Its schema is uniform - a profile is a list of
  ``segments``, each with a ``stats`` map - so one flattener serves every title.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ..constants import TTL
from ..errors import NotFoundError, PrivateProfileError
from ..runtime import Runtime
from .base import ProviderClient

__all__ = ["FaceitProvider", "TrackerProvider", "FACEIT_GAME_IDS", "TRACKER_GAME_IDS"]

#: This package's title ids mapped onto FACEIT's game ids.
FACEIT_GAME_IDS = {
    "cs2": "cs2",
    "dota2": "dota2",
    "valorant": "valorant",
    "league-of-legends": "lol_EUW",
    "rocket-league": "rocket_league",
    "apex-legends": "apex",
}

#: This package's title ids mapped onto Tracker's route segments.
TRACKER_GAME_IDS = {
    "apex-legends": "apex",
    "cs2": "csgo",
    "valorant": "valorant",
    "rainbow-six-siege": "r6siege",
    "call-of-duty": "warzone",
    "battlefield": "bf2042",
    "halo-infinite": "halo-infinite",
    "splitgate": "splitgate",
    "rocket-league": "rocket-league",
    "fortnite": "fortnite",
}


class FaceitProvider(ProviderClient):
    def __init__(self, runtime: Runtime) -> None:
        super().__init__("faceit", runtime)

    @staticmethod
    def game_id(title_id: str) -> str:
        """Translate a title id into the game parameter FACEIT expects."""
        return FACEIT_GAME_IDS.get(title_id, title_id)

    async def get_player_by_nickname(self, nickname: str, title_id: str) -> dict[str, Any]:
        """Look a player up by FACEIT nickname."""

        async def fetch() -> dict[str, Any]:
            player = await self.get("/players", query={"nickname": nickname}, null_on_404=True)
            if not player or not player.get("player_id"):
                raise NotFoundError(self.id, f'FACEIT player "{nickname}"', title_id)
            return dict(player)

        return await self.cached(
            ["nickname", nickname.lower()],
            "resolvePlayer",
            title_id,
            TTL["resolvePlayer"],
            fetch,
        )

    async def get_player_by_game_id(
        self, game_player_id: str, title_id: str
    ) -> dict[str, Any]:
        """Look a player up by their in-game id.

        For CS2 that is the SteamID64, which is what makes FACEIT usable as a
        second provider for a player already resolved through Steam.
        """
        game = self.game_id(title_id)

        async def fetch() -> dict[str, Any]:
            player = await self.get(
                "/players",
                query={"game": game, "game_player_id": game_player_id},
                null_on_404=True,
            )
            if not player or not player.get("player_id"):
                raise NotFoundError(self.id, f"FACEIT player for {game_player_id}", title_id)
            return dict(player)

        return await self.cached(
            ["game-id", game, game_player_id],
            "resolvePlayer",
            title_id,
            TTL["resolvePlayer"],
            fetch,
        )

    async def get_player(self, player_id: str, title_id: str) -> dict[str, Any]:
        """The player record for a known FACEIT id."""

        async def fetch() -> dict[str, Any]:
            player = await self.get(f"/players/{player_id}", null_on_404=True)
            if not player:
                raise NotFoundError(self.id, f"FACEIT player {player_id}", title_id)
            return dict(player)

        return await self.cached([player_id], "getPlayer", title_id, TTL["player"], fetch)

    async def get_player_stats(self, player_id: str, title_id: str) -> dict[str, Any]:
        """Lifetime and per-map statistics for one game."""
        game = self.game_id(title_id)

        async def fetch() -> dict[str, Any]:
            stats = await self.get(f"/players/{player_id}/stats/{game}", null_on_404=True)
            return dict(stats or {})

        return await self.cached(
            [player_id, "stats", game],
            "getPlayerStats",
            title_id,
            TTL["playerStats"],
            fetch,
        )

    async def get_match_history(
        self,
        player_id: str,
        title_id: str,
        *,
        limit: int = 20,
        offset: int = 0,
        from_ms: int | None = None,
        to_ms: int | None = None,
    ) -> list[dict[str, Any]]:
        """Match history, newest first."""
        game = self.game_id(title_id)

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                f"/players/{player_id}/history",
                query={
                    "game": game,
                    "limit": min(limit, 100),
                    "offset": offset,
                    # FACEIT takes seconds here, unlike the milliseconds it returns.
                    "from": from_ms // 1_000 if from_ms else None,
                    "to": to_ms // 1_000 if to_ms else None,
                },
                null_on_404=True,
            )
            return list((response or {}).get("items", []))

        return await self.cached(
            [player_id, "history", game, limit, offset],
            "getMatchHistory",
            title_id,
            TTL["matchHistory"],
            fetch,
        )

    async def get_match(self, match_id: str, title_id: str) -> dict[str, Any]:
        """One match: rosters, maps and the result."""

        async def fetch() -> dict[str, Any]:
            match = await self.get(f"/matches/{match_id}", null_on_404=True)
            if not match:
                raise NotFoundError(self.id, f"FACEIT match {match_id}", title_id)
            return dict(match)

        return await self.cached(
            [match_id, "match"], "getMatch", title_id, TTL["match"], fetch
        )

    async def get_match_stats(self, match_id: str, title_id: str) -> list[dict[str, Any]]:
        """Per-round scoreboard for a finished match."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(f"/matches/{match_id}/stats", null_on_404=True)
            return list((response or {}).get("rounds", []))

        return await self.cached(
            [match_id, "match-stats"], "getMatch", title_id, TTL["match"], fetch
        )

    async def get_rankings(
        self,
        title_id: str,
        region: str,
        *,
        country: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """The regional Elo ladder."""
        game = self.game_id(title_id)

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                f"/rankings/games/{game}/regions/{region}",
                query={
                    "country": country,
                    "limit": min(limit, 100),
                    "offset": offset,
                },
                null_on_404=True,
            )
            return list((response or {}).get("items", []))

        return await self.cached(
            ["rankings", game, region, country or "-", limit],
            "getLeaderboard",
            title_id,
            TTL["leaderboard"],
            fetch,
        )

    async def get_player_ranking(
        self, player_id: str, title_id: str, region: str
    ) -> dict[str, Any] | None:
        """Where a player sits on their regional ladder."""
        game = self.game_id(title_id)
        return await self.get_object(
            f"/rankings/games/{game}/regions/{region}/players/{player_id}",
            null_on_404=True,
        )

    async def get_championships(
        self,
        title_id: str,
        *,
        type_: str = "ongoing",
        limit: int = 20,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """Championships - FACEIT's own tournament layer."""
        response = await self.get(
            "/championships",
            query={
                "game": self.game_id(title_id),
                "type": type_,
                "limit": min(limit, 100),
                "offset": offset,
            },
            null_on_404=True,
        )
        return list((response or {}).get("items", []))


class TrackerProvider(ProviderClient):
    def __init__(self, runtime: Runtime) -> None:
        super().__init__("tracker", runtime)

    def auth_header_name(self) -> str:
        return "TRN-Api-Key"

    @staticmethod
    def game_id(title_id: str) -> str:
        return TRACKER_GAME_IDS.get(title_id, title_id)

    async def get_profile(
        self, title_id: str, platform: str, identifier: str
    ) -> dict[str, Any]:
        """A player profile.

        Tracker answers 451 for a profile the player has hidden, which is neither
        a 403 nor a 404 and would otherwise surface as an opaque HTTP error.
        """
        game = self.game_id(title_id)

        async def fetch() -> dict[str, Any]:
            from ..errors import HttpError

            try:
                response = await self.get(
                    f"/{game}/standard/profile/{platform}/{quote(identifier, safe='')}",
                    null_on_404=True,
                )
            except HttpError as error:
                if error.status_code == 451:
                    raise PrivateProfileError(self.id, identifier, title_id) from error
                raise
            data = (response or {}).get("data")
            if not data:
                raise NotFoundError(self.id, f'{title_id} profile "{identifier}"', title_id)
            return dict(data)

        return await self.cached(
            [game, platform, identifier.lower()],
            "getPlayerStats",
            title_id,
            TTL["playerStats"],
            fetch,
        )

    async def get_matches(
        self, title_id: str, platform: str, identifier: str
    ) -> list[dict[str, Any]]:
        """Recent matches, where the title supports them."""
        game = self.game_id(title_id)

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                f"/{game}/standard/matches/{platform}/{quote(identifier, safe='')}",
                null_on_404=True,
            )
            return list(((response or {}).get("data") or {}).get("matches", []))

        return await self.cached(
            [game, platform, identifier.lower(), "matches"],
            "getMatchHistory",
            title_id,
            TTL["matchHistory"],
            fetch,
        )

    async def get_leaderboard(
        self,
        title_id: str,
        board: str,
        *,
        platform: str | None = None,
        take: int = 50,
        skip: int = 0,
    ) -> list[dict[str, Any]]:
        """A leaderboard page."""
        response = await self.get(
            f"/{self.game_id(title_id)}/standard/leaderboards",
            query={
                "type": board,
                "platform": platform,
                "take": min(take, 100),
                "skip": skip,
            },
            null_on_404=True,
        )
        return list(((response or {}).get("data") or {}).get("items", []))

    @staticmethod
    def flatten_stats(segment: dict[str, Any] | None) -> dict[str, float]:
        """Flatten a segment's stats into plain numbers.

        Tracker wraps every value in an object with a display string beside it.
        Callers want the number, so this drops the presentation and keeps the
        rest available through the raw payload.
        """
        out: dict[str, float] = {}
        for key, stat in ((segment or {}).get("stats") or {}).items():
            value = stat.get("value") if isinstance(stat, dict) else None
            if isinstance(value, str):
                try:
                    value = float(value)
                except ValueError:
                    continue
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                out[key] = value
        return out

    @staticmethod
    def segment(profile: dict[str, Any], type_: str) -> dict[str, Any] | None:
        """The segment of a given type, e.g. ``overview`` or ``legend``."""
        for entry in profile.get("segments") or []:
            if entry.get("type") == type_:
                return dict(entry)
        return None
