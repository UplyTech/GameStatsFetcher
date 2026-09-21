"""Rocket League's two data sources.

Psyonix publishes no API of any kind, so this title is assembled from what the
community keeps:

* **Ballchasing** holds uploaded replays. Complete for anyone who uploads,
  invisible for anyone who does not - a limitation worth surfacing to a user
  rather than presenting an empty history as "no games played".
* **Octane.gg** is the reference database for the professional circuit: every
  RLCS game, roster and event since 2016.

Ladder rank comes from Tracker, which lives in :mod:`.faceit`.
"""

from __future__ import annotations

from typing import Any

from ..constants import TTL
from ..errors import NotFoundError
from ..http import RequestSpec
from ..runtime import Runtime
from .base import ProviderClient

__all__ = ["BallchasingProvider", "OctaneProvider"]


class BallchasingProvider(ProviderClient):
    """Ballchasing.com.

    The token goes in a bare ``Authorization`` header - not ``Bearer`` - which is
    a frequent cause of a puzzling 401.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("ballchasing", runtime)

    def auth_header_name(self) -> str:
        return "Authorization"

    async def ping(self) -> dict[str, Any] | None:
        """Check the token and the account it belongs to."""
        return await self.get_object("/", null_on_404=True)

    async def list_replays(
        self,
        *,
        player_id: str | None = None,
        player_name: str | None = None,
        playlist: str | None = None,
        season: str | None = None,
        count: int = 20,
        after: str | None = None,
        sort_by: str = "replay-date",
    ) -> list[dict[str, Any]]:
        """Replays involving a player.

        ``player_id`` is ``steam:76561198...``, ``epic:...``, ``xbox:...`` or
        ``ps4:...``.
        """

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                "/replays",
                query={
                    "player-id": player_id,
                    "player-name": player_name,
                    "playlist": playlist,
                    "season": season,
                    "count": min(count, 200),
                    "after": after,
                    "sort-by": sort_by,
                },
                null_on_404=True,
            )
            return self.rows((response or {}).get("list") or [])

        return await self.cached(
            ["replays", player_id or player_name or "-", count, playlist or "-"],
            "getMatchHistory",
            "rocket-league",
            TTL["matchHistory"],
            fetch,
        )

    async def get_replay(self, replay_id: str) -> dict[str, Any]:
        """One replay, with the full per-player breakdown."""

        async def fetch() -> dict[str, Any]:
            replay = await self.get(f"/replays/{replay_id}", null_on_404=True)
            if not replay:
                raise NotFoundError(self.id, f"replay {replay_id}", "rocket-league")
            return dict(replay)

        return await self.cached(
            ["replay", replay_id], "getMatch", "rocket-league", TTL["match"], fetch
        )

    async def get_maps(self) -> dict[str, str]:
        """Maps, for turning internal names into readable ones."""

        async def fetch() -> dict[str, str]:
            return dict(await self.get("/maps", null_on_404=True) or {})

        return await self.cached(
            ["maps"], "getMetadata", "rocket-league", TTL["metadata"], fetch
        )


class OctaneProvider(ProviderClient):
    """Octane.gg - the Rocket League esports database.

    No key and no published quota, so the registry limits it conservatively. It
    covers events, matches, games and player statistics for the professional
    circuit; it knows nothing about ladder play.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("octane", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    async def get_events(
        self,
        *,
        tier: str | None = None,
        region: str | None = None,
        after: str | None = None,
        before: str | None = None,
        page: int = 1,
        per_page: int = 50,
    ) -> list[dict[str, Any]]:
        """Events, newest first."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                "/events",
                query={
                    "tier": tier,
                    "region": region,
                    "after": after,
                    "before": before,
                    "page": page,
                    "perPage": min(per_page, 500),
                },
                null_on_404=True,
            )
            return self.rows((response or {}).get("events") or [])

        return await self.cached(
            ["events", tier or "-", region or "-", page],
            "getEsportsTournaments",
            "rocket-league",
            TTL["esportsTournaments"],
            fetch,
        )

    async def get_matches(
        self,
        *,
        event: str | None = None,
        team: str | None = None,
        player: str | None = None,
        after: str | None = None,
        before: str | None = None,
        page: int = 1,
        per_page: int = 50,
    ) -> list[dict[str, Any]]:
        """Professional matches."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                "/matches",
                query={
                    "event": event,
                    "team": team,
                    "player": player,
                    "after": after,
                    "before": before,
                    "page": page,
                    "perPage": min(per_page, 500),
                },
                null_on_404=True,
            )
            return self.rows((response or {}).get("matches") or [])

        return await self.cached(
            ["matches", event or "-", team or "-", page],
            "getEsportsMatches",
            "rocket-league",
            TTL["esportsMatches"],
            fetch,
        )

    async def get_teams(self, name: str | None = None) -> list[dict[str, Any]]:
        """Professional teams."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                "/teams", query={"name": name, "perPage": 500}, null_on_404=True
            )
            return self.rows((response or {}).get("teams") or [])

        return await self.cached(
            ["teams", name or "-"],
            "getEsportsTeams",
            "rocket-league",
            TTL["esportsTeams"],
            fetch,
        )

    async def get_players(self, tag: str | None = None) -> list[dict[str, Any]]:
        """Professional players."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                "/players", query={"tag": tag, "perPage": 500}, null_on_404=True
            )
            return self.rows((response or {}).get("players") or [])

        return await self.cached(
            ["players", tag or "-"],
            "getEsportsPlayers",
            "rocket-league",
            TTL["esportsPlayers"],
            fetch,
        )

    async def get_match(self, match_id: str) -> dict[str, Any]:
        """One professional match, with games and per-player statistics."""

        async def fetch() -> dict[str, Any]:
            match = await self.get(f"/matches/{match_id}", null_on_404=True)
            if not match:
                raise NotFoundError(self.id, f"Octane match {match_id}", "rocket-league")
            return dict(match)

        return await self.cached(
            ["match", match_id], "getMatch", "rocket-league", TTL["match"], fetch
        )

    async def get_player_stats(
        self,
        *,
        player: str | None = None,
        event: str | None = None,
        after: str | None = None,
        before: str | None = None,
    ) -> list[dict[str, Any]]:
        """Aggregate player statistics across events."""
        response = await self.get(
            "/stats/players",
            query={"player": player, "event": event, "after": after, "before": before},
            null_on_404=True,
        )
        return self.rows((response or {}).get("players") or [])
