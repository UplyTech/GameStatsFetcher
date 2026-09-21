"""The individual-skill titles: osu!, Beat Saber and chess.

These have a property none of the team titles do - a *global*, continuously
maintained ranking of every player, with no seasons and no reset. So the
leaderboard endpoints here are the primary data rather than a side feature, and
``RankInfo.position`` is meaningful in a way it rarely is elsewhere.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from ..constants import TTL
from ..errors import AuthenticationError, NotFoundError, ValidationError
from ..http import RequestSpec
from ..runtime import Runtime
from .base import ProviderClient

__all__ = [
    "OsuProvider",
    "ScoreSaberProvider",
    "BeatLeaderProvider",
    "ChessComProvider",
    "LichessProvider",
]


class OsuProvider(ProviderClient):
    """osu! API v2.

    OAuth2 client credentials, exchanged once and held for the life of the
    token. The v1 API still exists and takes a plain key, but it is deprecated
    and does not expose the ``pp`` figures that make an osu! rank meaningful.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("osu", runtime)

    async def _access_token(self) -> str:
        client_id, client_secret = self.require_key_parts(2, "clientId:clientSecret")
        # osu! wants the client id as a JSON number, and a non-numeric one is a
        # misconfiguration rather than anything the token endpoint can answer.
        # Saying so here costs one request and names the option; letting int()
        # raise would surface as a bare ValueError from four frames down.
        if not client_id.isdigit():
            raise ValidationError(
                f'api_keys.{self.descriptor.key_name} must be "clientId:clientSecret", '
                f"and the client id is the number shown on your osu! OAuth "
                f'application page - got "{client_id}"'
            )

        async def fetch() -> str:
            response = await self.runtime.http.send(
                self.id,
                "https://osu.ppy.sh/oauth/token",
                RequestSpec(
                    method="POST",
                    json={
                        "client_id": int(client_id),
                        "client_secret": client_secret,
                        "grant_type": "client_credentials",
                        "scope": "public",
                    },
                ),
            )
            token = (response or {}).get("access_token")
            if not token:
                raise AuthenticationError(self.id, "token endpoint returned no access_token")
            return str(token)

        return await self.memo("token", 23 * 3_600 * 1_000, fetch)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        token = await self._access_token()
        return spec.merged(headers={"Authorization": f"Bearer {token}", **spec.headers})

    async def get_user(self, user: str, mode: str = "osu") -> dict[str, Any]:
        """A user by name or numeric id."""

        async def fetch() -> dict[str, Any]:
            found = await self.get(
                f"/users/{quote(str(user), safe='')}/{mode}",
                query={"key": "id" if str(user).isdigit() else "username"},
                null_on_404=True,
            )
            if not found:
                raise NotFoundError(self.id, f'osu! user "{user}"', "osu")
            return dict(found)

        return await self.cached(
            [str(user).lower(), mode], "getPlayer", "osu", TTL["player"], fetch
        )

    async def get_scores(
        self,
        user_id: str | int,
        type_: str = "recent",
        *,
        mode: str = "osu",
        limit: int = 20,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """Best, recent or first-place scores."""

        async def fetch() -> list[dict[str, Any]]:
            scores = await self.get(
                f"/users/{user_id}/scores/{type_}",
                query={
                    "mode": mode,
                    "limit": min(limit, 100),
                    "offset": offset,
                    "include_fails": 1 if type_ == "recent" else None,
                },
                null_on_404=True,
            )
            return self.rows(scores or [])

        return await self.cached(
            ["scores", user_id, type_, mode, limit],
            "getMatchHistory",
            "osu",
            TTL["matchHistory"],
            fetch,
        )

    async def get_rankings(
        self,
        mode: str = "osu",
        *,
        type_: str = "performance",
        country: str | None = None,
        page: int = 1,
    ) -> list[dict[str, Any]]:
        """The global performance ranking."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                f"/rankings/{mode}/{type_}",
                query={"country": country, "page": page},
                null_on_404=True,
            )
            return self.rows((response or {}).get("ranking") or [])

        return await self.cached(
            ["rankings", mode, type_, country or "-", page],
            "getLeaderboard",
            "osu",
            TTL["leaderboard"],
            fetch,
        )

    async def get_beatmap(self, beatmap_id: str | int) -> dict[str, Any] | None:
        """One beatmap, for turning a score's map id into a name."""

        async def fetch() -> dict[str, Any] | None:
            return await self.get_object(f"/beatmaps/{beatmap_id}", null_on_404=True)

        return await self.cached(
            ["beatmap", beatmap_id], "getMetadata", "osu", TTL["metadata"], fetch
        )


class ScoreSaberProvider(ProviderClient):
    """ScoreSaber - the older of the two Beat Saber ladders."""

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("scoresaber", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    async def get_player(self, player_id: str) -> dict[str, Any]:
        """A player by their Steam or Oculus id."""

        async def fetch() -> dict[str, Any]:
            player = await self.get(f"/player/{player_id}/full", null_on_404=True)
            if not player:
                raise NotFoundError(self.id, f"ScoreSaber player {player_id}", "beat-saber")
            return dict(player)

        return await self.cached(
            ["player", player_id], "getPlayer", "beat-saber", TTL["player"], fetch
        )

    async def search_players(self, search: str) -> list[dict[str, Any]]:
        """Search by name."""
        response = await self.get(
            "/players", query={"search": search, "page": 1}, null_on_404=True
        )
        return self.rows((response or {}).get("players") or [])

    async def get_scores(
        self, player_id: str, *, sort: str = "recent", limit: int = 20, page: int = 1
    ) -> list[dict[str, Any]]:
        """A player's scores, ranked by pp or by recency."""
        response = await self.get(
            f"/player/{player_id}/scores",
            query={"sort": sort, "limit": min(limit, 100), "page": page},
            null_on_404=True,
        )
        return self.rows((response or {}).get("playerScores") or [])

    async def get_leaderboard(
        self, page: int = 1, countries: str | None = None
    ) -> list[dict[str, Any]]:
        """The global ladder."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                "/players", query={"page": page, "countries": countries}, null_on_404=True
            )
            return self.rows((response or {}).get("players") or [])

        return await self.cached(
            ["leaderboard", page, countries or "-"],
            "getLeaderboard",
            "beat-saber",
            TTL["leaderboard"],
            fetch,
        )


class BeatLeaderProvider(ProviderClient):
    """BeatLeader - the second Beat Saber ladder, with replays ScoreSaber drops."""

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("beatleader", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    async def get_player(self, player_id: str) -> dict[str, Any]:
        async def fetch() -> dict[str, Any]:
            player = await self.get(f"/player/{player_id}", null_on_404=True)
            if not player:
                raise NotFoundError(self.id, f"BeatLeader player {player_id}", "beat-saber")
            return dict(player)

        return await self.cached(
            ["player", player_id], "getPlayer", "beat-saber", TTL["player"], fetch
        )

    async def get_scores(
        self,
        player_id: str,
        *,
        sort_by: str = "date",
        order: str = "desc",
        count: int = 20,
        page: int = 1,
    ) -> list[dict[str, Any]]:
        response = await self.get(
            f"/player/{player_id}/scores",
            query={
                "sortBy": sort_by,
                "order": order,
                "count": min(count, 100),
                "page": page,
            },
            null_on_404=True,
        )
        return self.rows((response or {}).get("data") or [])

    async def get_leaderboard(self, page: int = 1, count: int = 50) -> list[dict[str, Any]]:
        response = await self.get(
            "/players",
            query={"page": page, "count": min(count, 100), "sortBy": "pp", "order": "desc"},
            null_on_404=True,
        )
        return self.rows((response or {}).get("data") or [])


class ChessComProvider(ProviderClient):
    """Chess.com Published-Data API.

    No key at all, but strict about two things: a descriptive User-Agent, and
    **serial requests**. Parallel calls get 429 immediately, which is why the
    registry limits this provider tightly rather than optimistically.

    Games are archived by month, so "recent games" means "fetch the current
    month's archive" rather than a limit-and-offset query.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("chess-com", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    async def get_player(self, username: str) -> dict[str, Any]:
        name = username.lower()

        async def fetch() -> dict[str, Any]:
            player = await self.get(f"/player/{name}", null_on_404=True)
            if not player:
                raise NotFoundError(self.id, f'Chess.com user "{username}"', "chess")
            return dict(player)

        return await self.cached(["player", name], "getPlayer", "chess", TTL["player"], fetch)

    async def get_stats(self, username: str) -> dict[str, Any]:
        """Ratings per time control, plus the puzzle and tactics records."""
        name = username.lower()

        async def fetch() -> dict[str, Any]:
            stats = await self.get(f"/player/{name}/stats", null_on_404=True)
            return dict(stats or {})

        return await self.cached(
            ["stats", name], "getPlayerStats", "chess", TTL["playerStats"], fetch
        )

    async def get_game_archives(self, username: str) -> list[str]:
        """The list of monthly archive URLs, oldest first."""
        response = await self.get(
            f"/player/{username.lower()}/games/archives", null_on_404=True
        )
        return self.rows((response or {}).get("archives") or [])

    async def get_recent_games(self, username: str, limit: int = 20) -> list[dict[str, Any]]:
        """Games from the most recent archives, newest first.

        Walks backwards through the monthly archives until it has enough, because
        a player who has not played this month would otherwise get nothing. Three
        months back is enough for any active player and bounds the request count
        for an inactive one.
        """
        name = username.lower()

        async def fetch() -> list[dict[str, Any]]:
            archives = await self.get_game_archives(name)
            games: list[dict[str, Any]] = []
            for url in reversed(archives[-3:]):
                month = await self.get(url, null_on_404=True)
                games.extend(reversed(self.rows((month or {}).get("games") or [])))
                if len(games) >= limit:
                    break
            return games[:limit]

        return await self.cached(
            ["games", name, limit], "getMatchHistory", "chess", TTL["matchHistory"], fetch
        )

    async def get_leaderboards(self) -> dict[str, Any]:
        """The site leaderboards, all categories in one payload."""

        async def fetch() -> dict[str, Any]:
            return dict(await self.get("/leaderboards", null_on_404=True) or {})

        return await self.cached(
            ["leaderboards"], "getLeaderboard", "chess", TTL["leaderboard"], fetch
        )


class LichessProvider(ProviderClient):
    """Lichess API.

    Open, and generous. The catch is NDJSON: game exports stream one JSON object
    per line rather than returning an array, so they are parsed here rather than
    handed to a JSON decoder.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("lichess", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        """The token is optional, so a missing one is not an error."""
        token = self.runtime.api_keys.get("lichess")
        if not token:
            return spec
        return spec.merged(headers={"Authorization": f"Bearer {token}", **spec.headers})

    async def get_player(self, username: str) -> dict[str, Any]:
        name = username.lower()

        async def fetch() -> dict[str, Any]:
            user = await self.get(f"/user/{name}", null_on_404=True)
            if not user:
                raise NotFoundError(self.id, f'Lichess user "{username}"', "chess")
            return dict(user)

        return await self.cached(["user", name], "getPlayer", "chess", TTL["player"], fetch)

    async def get_games(
        self,
        username: str,
        *,
        max_games: int = 20,
        rated: bool | None = None,
        perf_type: str | None = None,
    ) -> list[dict[str, Any]]:
        """Recent games.

        Requested as NDJSON and split by line - the array form of this endpoint
        does not exist, and asking for JSON returns PGN text instead.
        """
        name = username.lower()

        async def fetch() -> list[dict[str, Any]]:
            body = await self.get(
                f"/games/user/{name}",
                query={
                    "max": min(max_games, 300),
                    "rated": rated,
                    "perfType": perf_type,
                    "opening": True,
                },
                headers={"Accept": "application/x-ndjson"},
                parse="text",
                null_on_404=True,
            )
            if not body:
                return []
            return [json.loads(line) for line in body.splitlines() if line.strip()]

        return await self.cached(
            ["games", name, max_games, perf_type or "-"],
            "getMatchHistory",
            "chess",
            TTL["matchHistory"],
            fetch,
        )

    async def get_top_players(
        self, perf_type: str = "blitz", count: int = 50
    ) -> list[dict[str, Any]]:
        """The top players for one time control."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                f"/player/top/{min(count, 200)}/{perf_type}", null_on_404=True
            )
            return self.rows((response or {}).get("users") or [])

        return await self.cached(
            ["top", perf_type, count], "getLeaderboard", "chess", TTL["leaderboard"], fetch
        )

    async def get_rating_history(self, username: str) -> list[dict[str, Any]]:
        """Rating history per time control, one point per day played."""
        history = await self.get(f"/user/{username.lower()}/rating-history", null_on_404=True)
        return self.rows(history or [])
