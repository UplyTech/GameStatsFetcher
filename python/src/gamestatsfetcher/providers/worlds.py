"""The persistent-world titles and the odds and ends.

Minecraft (through Hypixel), Guild Wars 2, Path of Exile, Albion Online, World
of Warcraft's Mythic+ ladder and competitive Team Fortress 2. What they have in
common is that "a match" means something different in each - a BedWars game, a
PvP season, a race ladder, a GvG - so the title clients above them do more
mapping than usual.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ..constants import TTL
from ..errors import NotFoundError
from ..http import RequestSpec
from ..identity import dash_uuid, to_steam_id64, undash_uuid
from ..runtime import Runtime
from .base import ProviderClient

__all__ = [
    "MojangProvider",
    "HypixelProvider",
    "GuildWars2Provider",
    "PathOfExileProvider",
    "AlbionProvider",
    "RaiderIoProvider",
    "LogsTfProvider",
]


class MojangProvider(ProviderClient):
    """Mojang account API.

    Used for exactly one thing: turning a Minecraft name into the UUID Hypixel is
    keyed on. Kept as its own provider so its rate limit is accounted for
    separately - it is stricter than Hypixel's.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("mojang", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    async def get_uuid(self, username: str) -> dict[str, str]:
        """Name to UUID, dashed."""

        async def fetch() -> dict[str, str]:
            profile = await self.get(
                f"/users/profiles/minecraft/{quote(username, safe='')}", null_on_404=True
            )
            if not profile or not profile.get("id"):
                raise NotFoundError(self.id, f'Minecraft account "{username}"', "minecraft")
            return {
                "id": dash_uuid(str(profile["id"])),
                "name": str(profile.get("name") or username),
            }

        return await self.cached(
            ["uuid", username.lower()],
            "resolvePlayer",
            "minecraft",
            TTL["resolvePlayer"],
            fetch,
        )


class HypixelProvider(ProviderClient):
    """Hypixel API.

    The competitive Minecraft server: BedWars, SkyWars, Duels and the rest.
    Keyed strictly on UUID, so a name lookup always costs a Mojang call first -
    which is why the resolved UUID is cached for a day.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("hypixel", runtime)

    def auth_header_name(self) -> str:
        return "API-Key"

    async def get_player(self, uuid: str) -> dict[str, Any]:
        """The full player payload. Large - one object per game mode ever played."""
        identifier = undash_uuid(uuid)

        async def fetch() -> dict[str, Any]:
            response = await self.get("/player", query={"uuid": identifier}, null_on_404=True)
            # Hypixel answers `{success: true, player: null}` for an account that
            # has never joined the server, which is not a bad UUID.
            player = (response or {}).get("player")
            if not player:
                raise NotFoundError(
                    self.id, f"Hypixel player {uuid} (never joined?)", "minecraft"
                )
            return dict(player)

        return await self.cached(
            ["player", identifier], "getPlayer", "minecraft", TTL["player"], fetch
        )

    async def get_guild(self, uuid: str) -> dict[str, Any] | None:
        """Guild membership, the closest thing to a team here."""
        response = await self.get(
            "/guild", query={"player": undash_uuid(uuid)}, null_on_404=True
        )
        return (response or {}).get("guild")

    async def get_recent_games(self, uuid: str) -> list[dict[str, Any]]:
        """Recent games, which Hypixel keeps for about three days."""
        identifier = undash_uuid(uuid)

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                "/recentgames", query={"uuid": identifier}, null_on_404=True
            )
            return self.rows((response or {}).get("games") or [])

        return await self.cached(
            ["recent", identifier],
            "getMatchHistory",
            "minecraft",
            TTL["matchHistory"],
            fetch,
        )

    async def get_leaderboards(self) -> dict[str, Any]:
        """Server-wide leaderboards, all games in one payload."""

        async def fetch() -> dict[str, Any]:
            response = await self.get("/leaderboards", null_on_404=True)
            return dict((response or {}).get("leaderboards") or {})

        return await self.cached(
            ["leaderboards"], "getLeaderboard", "minecraft", TTL["leaderboard"], fetch
        )


class GuildWars2Provider(ProviderClient):
    """Guild Wars 2 API.

    The public half of this API needs no key, but every endpoint *this* package
    uses is account-scoped - ``/account`` and the ``/pvp/*`` family - and needs a
    token carrying the ``pvp`` scope, which the player generates themselves.

    So the key is required here, and required loudly: sending the request
    unauthenticated would spend a round trip to be told 401, and the caller would
    see "unauthorised" rather than the name of the option they forgot to set.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("guild-wars-2", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        token = self.require_key("guild-wars-2")
        return spec.merged(headers={"Authorization": f"Bearer {token}", **spec.headers})

    async def get_account(self) -> dict[str, Any]:
        """The account the token belongs to."""
        account = await self.get("/account", null_on_404=True)
        if not account:
            raise NotFoundError(self.id, "GW2 account", "guild-wars-2")
        return dict(account)

    async def get_pvp_stats(self) -> dict[str, Any]:
        """Structured PvP career statistics."""

        async def fetch() -> dict[str, Any]:
            return dict(await self.get("/pvp/stats", null_on_404=True) or {})

        return await self.cached(
            ["pvp", "stats"],
            "getPlayerStats",
            "guild-wars-2",
            TTL["playerStats"],
            fetch,
        )

    async def get_pvp_games(self) -> list[dict[str, Any]]:
        """Recent PvP games - the API keeps the last ten."""
        games = await self.get("/pvp/games", query={"ids": "all"}, null_on_404=True)
        return self.rows(games or [])

    async def get_pvp_standings(self) -> list[dict[str, Any]]:
        """PvP standings across seasons."""
        standings = await self.get("/pvp/standings", null_on_404=True)
        return self.rows(standings or [])

    async def get_pvp_leaderboard(
        self, season_id: str, board: str = "legendary", region: str = "global"
    ) -> list[dict[str, Any]]:
        """A season leaderboard."""
        entries = await self.get(
            f"/pvp/seasons/{season_id}/leaderboards/{board}/{region}", null_on_404=True
        )
        return self.rows(entries or [])


class PathOfExileProvider(ProviderClient):
    """Path of Exile.

    Race ladders only - GGG publishes no per-character API without a session
    cookie. The one hard requirement is a descriptive User-Agent; a generic one
    is refused rather than throttled.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("path-of-exile", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    async def get_ladder(
        self, league: str, *, limit: int = 50, offset: int = 0
    ) -> list[dict[str, Any]]:
        """A league ladder page."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                f"/ladders/{quote(league, safe='')}",
                query={"limit": min(limit, 200), "offset": offset},
                null_on_404=True,
            )
            return self.rows((response or {}).get("entries") or [])

        return await self.cached(
            ["ladder", league, offset],
            "getLeaderboard",
            "path-of-exile",
            TTL["leaderboard"],
            fetch,
        )

    async def get_leagues(self) -> list[dict[str, Any]]:
        """Current leagues, so a caller can find the race that is running."""

        async def fetch() -> list[dict[str, Any]]:
            leagues = await self.get(
                "/leagues", query={"type": "main", "realm": "pc"}, null_on_404=True
            )
            return self.rows(leagues or [])

        return await self.cached(
            ["leagues"], "getMetadata", "path-of-exile", TTL["metadata"], fetch
        )


class AlbionProvider(ProviderClient):
    """Albion Online.

    Separate hosts per server, and the competitive content - Crystal League, GvG
    - lives in the guild endpoints rather than the player ones.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("albion", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    @staticmethod
    def host(region: str) -> str:
        """Region host. Albion runs three fully separate worlds."""
        lowered = region.lower()
        if lowered in ("americas", "west"):
            return "https://gameinfo.albiononline.com/api/gameinfo"
        if lowered in ("asia", "east"):
            return "https://gameinfo-sgp.albiononline.com/api/gameinfo"
        return "https://gameinfo-ams.albiononline.com/api/gameinfo"

    async def search(self, query: str, region: str = "europe") -> dict[str, Any]:
        """Search players and guilds by name."""

        async def fetch() -> dict[str, Any]:
            response = await self.get(
                f"{self.host(region)}/search", query={"q": query}, null_on_404=True
            )
            return dict(response or {})

        return await self.cached(
            ["search", region, query.lower()],
            "resolvePlayer",
            "albion-online",
            TTL["resolvePlayer"],
            fetch,
        )

    async def get_player(self, player_id: str, region: str = "europe") -> dict[str, Any]:
        """A player's PvE and PvP fame."""

        async def fetch() -> dict[str, Any]:
            player = await self.get(
                f"{self.host(region)}/players/{player_id}", null_on_404=True
            )
            if not player:
                raise NotFoundError(self.id, f"Albion player {player_id}", "albion-online")
            return dict(player)

        return await self.cached(
            ["player", region, player_id],
            "getPlayer",
            "albion-online",
            TTL["player"],
            fetch,
        )

    async def get_player_kills(
        self, player_id: str, region: str = "europe"
    ) -> list[dict[str, Any]]:
        """Kills and deaths, which is Albion's match history."""
        kills = await self.get(
            f"{self.host(region)}/players/{player_id}/kills", null_on_404=True
        )
        return self.rows(kills or [])

    async def get_guild(self, guild_id: str, region: str = "europe") -> dict[str, Any] | None:
        """Guild record, including the Crystal League standing."""
        return await self.get_object(
            f"{self.host(region)}/guilds/{guild_id}", null_on_404=True
        )


class RaiderIoProvider(ProviderClient):
    """Raider.IO - World of Warcraft Mythic+ and raid rankings.

    Blizzard's own API has the character but not the score, and the score is what
    the competitive scene is organised around.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("raiderio", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    async def get_character(
        self,
        region: str,
        realm: str,
        name: str,
        fields: list[str] | None = None,
    ) -> dict[str, Any]:
        """A character profile with the requested fields attached."""
        wanted = fields or ["mythic_plus_scores_by_season:current", "gear"]

        async def fetch() -> dict[str, Any]:
            character = await self.get(
                "/characters/profile",
                query={
                    "region": region,
                    "realm": realm,
                    "name": name,
                    "fields": ",".join(wanted),
                },
                null_on_404=True,
            )
            if not character:
                raise NotFoundError(
                    self.id, f"WoW character {name}-{realm}", "world-of-warcraft"
                )
            return dict(character)

        return await self.cached(
            ["character", region, realm, name.lower()],
            "getPlayerStats",
            "world-of-warcraft",
            TTL["playerStats"],
            fetch,
        )

    async def get_mythic_plus_runs(
        self, region: str, realm: str, name: str
    ) -> list[dict[str, Any]]:
        """Mythic+ runs a character has completed."""
        response = await self.get(
            "/characters/profile",
            query={
                "region": region,
                "realm": realm,
                "name": name,
                "fields": "mythic_plus_recent_runs",
            },
            null_on_404=True,
        )
        return self.rows((response or {}).get("mythic_plus_recent_runs") or [])

    async def get_mythic_plus_rankings(
        self, season: str, region: str, dungeon: str = "all", page: int = 0
    ) -> list[dict[str, Any]]:
        """The Mythic+ leaderboard for a dungeon and season."""
        response = await self.get(
            "/mythic-plus/runs",
            query={"season": season, "region": region, "dungeon": dungeon, "page": page},
            null_on_404=True,
        )
        return self.rows((response or {}).get("rankings") or [])


class LogsTfProvider(ProviderClient):
    """logs.tf - competitive Team Fortress 2.

    A log archive rather than a stats API: every serious TF2 match is uploaded
    here, and this is the only structured record the game has.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("logstf", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    async def get_player_logs(
        self, steam_id: str, *, limit: int = 20, offset: int = 0
    ) -> list[dict[str, Any]]:
        """Logs a player appears in, newest first. Keyed on SteamID64."""
        identifier = to_steam_id64(steam_id)

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                "/log",
                query={
                    "player": identifier,
                    "limit": min(limit, 100),
                    "offset": offset,
                },
                null_on_404=True,
            )
            return self.rows((response or {}).get("logs") or [])

        return await self.cached(
            ["logs", identifier, limit, offset],
            "getMatchHistory",
            "team-fortress-2",
            TTL["matchHistory"],
            fetch,
        )

    async def get_log(self, log_id: str) -> dict[str, Any]:
        """One log in full: every class, every weapon, every heal."""

        async def fetch() -> dict[str, Any]:
            log = await self.get(f"/log/{log_id}", null_on_404=True)
            if not log:
                raise NotFoundError(self.id, f"logs.tf log {log_id}", "team-fortress-2")
            return dict(log)

        return await self.cached(
            ["log", log_id], "getMatch", "team-fortress-2", TTL["match"], fetch
        )
