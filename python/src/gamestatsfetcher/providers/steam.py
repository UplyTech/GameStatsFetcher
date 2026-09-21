"""Steam Web API.

Serves CS2, Dota 2, Team Fortress 2, Rust, War Thunder, Naraka and Dead by
Daylight - every Steam title whose stats are exposed through ``ISteamUserStats``.

Two things about this API shape everything below:

1. **A private profile is not an error.** ``GetUserStatsForGame`` answers 500 or
   an empty object rather than 403, so private profiles have to be detected from
   ``communityvisibilitystate`` on the summary and turned into a
   :class:`PrivateProfileError` by hand.
2. **Stats are a flat name/value list.** Valve ships no schema for what the names
   mean, so the per-title clients map the ones they care about and the rest
   survive in ``raw``.
"""

from __future__ import annotations

from typing import Any

from ..constants import TTL
from ..errors import NotFoundError, PrivateProfileError
from ..identity import to_steam_id64
from ..normalize import as_int
from ..runtime import Runtime
from .base import ProviderClient

__all__ = ["SteamProvider"]

#: 3 means public. Anything else means the stats endpoints will be empty.
_PUBLIC = 3


class SteamProvider(ProviderClient):
    def __init__(self, runtime: Runtime) -> None:
        super().__init__("steam", runtime)

    def auth_query_name(self) -> str:
        return "key"

    async def get_player_summaries(self, steam_ids: list[str]) -> list[dict[str, Any]]:
        """Profile summaries for up to 100 ids in one call."""
        if not steam_ids:
            return []
        ids = [to_steam_id64(steam_id) for steam_id in steam_ids]
        response = await self.get(
            "/ISteamUser/GetPlayerSummaries/v2/", query={"steamids": ",".join(ids)}
        )
        return list((response or {}).get("response", {}).get("players", []))

    async def get_player_summary(self, steam_id: str, title_id: str) -> dict[str, Any]:
        """One profile summary, or a :class:`NotFoundError`."""
        identifier = to_steam_id64(steam_id)

        async def fetch() -> dict[str, Any]:
            players = await self.get_player_summaries([identifier])
            if not players:
                raise NotFoundError(self.id, f"Steam profile {identifier}", title_id)
            return players[0]

        return await self.cached(
            [identifier, "summary"], "player", title_id, TTL["player"], fetch
        )

    @staticmethod
    def is_public(summary: dict[str, Any]) -> bool:
        """True when the profile is set to public."""
        return summary.get("communityvisibilitystate") == _PUBLIC

    async def resolve_vanity_url(self, vanity: str, title_id: str) -> str:
        """Turn a vanity URL segment into a SteamID64.

        ``steamcommunity.com/id/gaben`` becomes ``76561197960287930``. A full URL
        is accepted too, because that is what users paste.
        """
        segment = vanity.rsplit("steamcommunity.com/id/", 1)[-1].rstrip("/")

        async def fetch() -> str:
            response = await self.get(
                "/ISteamUser/ResolveVanityURL/v1/", query={"vanityurl": segment}
            )
            payload = (response or {}).get("response", {})
            if payload.get("success") != 1 or not payload.get("steamid"):
                raise NotFoundError(self.id, f'vanity URL "{segment}"', title_id)
            return str(payload["steamid"])

        return await self.cached(
            ["vanity", segment.lower()],
            "resolvePlayer",
            title_id,
            TTL["resolvePlayer"],
            fetch,
        )

    async def get_user_stats_for_game(
        self, steam_id: str, app_id: int, title_id: str
    ) -> dict[str, Any]:
        """Per-game stats and achievements.

        Raises :class:`PrivateProfileError` when the profile is closed, which
        needs the summary call first - Valve does not say so on this endpoint.
        """
        identifier = to_steam_id64(steam_id)

        async def fetch() -> dict[str, Any]:
            response = await self.get(
                "/ISteamUserStats/GetUserStatsForGame/v2/",
                query={"appid": app_id, "steamid": identifier},
                null_on_404=True,
            )
            stats = (response or {}).get("playerstats")
            if not stats or (not stats.get("stats") and not stats.get("achievements")):
                summary = await self.get_player_summary(identifier, title_id)
                if not self.is_public(summary):
                    raise PrivateProfileError(self.id, identifier, title_id)
                raise NotFoundError(
                    self.id, f"stats for {identifier} in app {app_id}", title_id
                )
            return dict(stats)

        return await self.cached(
            [identifier, "stats", app_id],
            "getPlayerStats",
            title_id,
            TTL["playerStats"],
            fetch,
        )

    async def get_stat_map(
        self, steam_id: str, app_id: int, title_id: str
    ) -> dict[str, float]:
        """Stats as a name-keyed map, which is how every caller wants them."""
        stats = await self.get_user_stats_for_game(steam_id, app_id, title_id)
        return {entry["name"]: entry["value"] for entry in stats.get("stats", [])}

    async def get_player_achievements(
        self, steam_id: str, app_id: int, title_id: str
    ) -> list[dict[str, Any]]:
        """Achievements for one app, with display names from the game schema."""
        identifier = to_steam_id64(steam_id)

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                "/ISteamUserStats/GetPlayerAchievements/v1/",
                query={"appid": app_id, "steamid": identifier, "l": "english"},
                null_on_404=True,
            )
            return list((response or {}).get("playerstats", {}).get("achievements", []))

        return await self.cached(
            [identifier, "achievements", app_id],
            "getPlayerStats",
            title_id,
            TTL["playerStats"],
            fetch,
        )

    async def get_owned_games(self, steam_id: str, title_id: str) -> list[dict[str, Any]]:
        """Owned games with playtime. Needs a public game-details setting."""
        identifier = to_steam_id64(steam_id)

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                "/IPlayerService/GetOwnedGames/v1/",
                query={
                    "steamid": identifier,
                    "include_appinfo": True,
                    "include_played_free_games": True,
                },
            )
            return list((response or {}).get("response", {}).get("games", []))

        return await self.cached([identifier, "owned"], "getPlayer", title_id, 600, fetch)

    async def get_recently_played_games(
        self, steam_id: str, title_id: str
    ) -> list[dict[str, Any]]:
        """Playtime over the last two weeks."""
        identifier = to_steam_id64(steam_id)

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                "/IPlayerService/GetRecentlyPlayedGames/v1/", query={"steamid": identifier}
            )
            return list((response or {}).get("response", {}).get("games", []))

        return await self.cached([identifier, "recent"], "getPlayer", title_id, 300, fetch)

    async def get_friend_list(self, steam_id: str, title_id: str) -> list[dict[str, Any]]:
        """Friends list. Empty when the friends list is private."""
        identifier = to_steam_id64(steam_id)

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                "/ISteamUser/GetFriendList/v1/",
                query={"steamid": identifier, "relationship": "friend"},
                null_on_404=True,
            )
            return list((response or {}).get("friendslist", {}).get("friends", []))

        return await self.cached([identifier, "friends"], "getPlayer", title_id, 600, fetch)

    async def get_current_player_count(self, app_id: int) -> int | None:
        """Current concurrent players for an app."""
        response = await self.get(
            "/ISteamUserStats/GetNumberOfCurrentPlayers/v1/", query={"appid": app_id}
        )
        return as_int((response or {}).get("response", {}).get("player_count"))

    async def get_dota_match_history(
        self,
        account_id: str,
        *,
        limit: int = 20,
        hero_id: int | None = None,
        start_at_match_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Valve's own Dota 2 match history.

        Thin next to OpenDota, but authoritative and available without a third
        party, so it stays as the fallback.
        """
        response = await self.get(
            "/IDOTA2Match_570/GetMatchHistory/v1/",
            query={
                "account_id": account_id,
                "matches_requested": limit,
                "hero_id": hero_id,
                "start_at_match_id": start_at_match_id,
            },
        )
        return list((response or {}).get("result", {}).get("matches", []))

    async def get_dota_match_details(self, match_id: str) -> dict[str, Any] | None:
        """Full Dota 2 match detail from Valve."""
        response = await self.get(
            "/IDOTA2Match_570/GetMatchDetails/v1/", query={"match_id": match_id}
        )
        return (response or {}).get("result")

    async def get_dota_heroes(self) -> list[dict[str, Any]]:
        """The Dota 2 hero list, for turning hero ids into names."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                "/IEconDOTA2_570/GetHeroes/v1/", query={"language": "en_us"}
            )
            return list((response or {}).get("result", {}).get("heroes", []))

        return await self.cached(
            ["dota", "heroes"], "getMetadata", "dota2", TTL["metadata"], fetch
        )
