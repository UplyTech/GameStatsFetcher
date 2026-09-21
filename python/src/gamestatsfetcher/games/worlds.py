"""The persistent-world and vehicle titles.

Guild Wars 2, Path of Exile, Albion Online, World of Tanks and World of
Warships. The competitive content here is not matchmaking - it is a PvP season, a
race ladder, a guild war or a clan campaign - so each client says plainly which
of those it is reporting.
"""

from __future__ import annotations

from typing import Any

from .. import providers
from ..errors import NotFoundError, ValidationError
from ..normalize import (
    as_int,
    as_list,
    as_str,
    match_result,
    mode_stats,
    participant_stats,
    player_stats,
    ts,
)
from ..title_client import TitleClient, as_query
from ..types import (
    LeaderboardEntry,
    LeaderboardOptions,
    MatchHistoryOptions,
    MatchSummary,
    ModeStats,
    PlayerProfile,
    PlayerQuery,
    PlayerRef,
    PlayerStats,
    RankInfo,
)

__all__ = [
    "GuildWars2Client",
    "PathOfExileClient",
    "AlbionClient",
    "WorldOfTanksClient",
    "WorldOfWarshipsClient",
]


class GuildWars2Client(TitleClient):
    """Guild Wars 2.

    Structured PvP. The API is account-scoped through the caller's own key, so
    there is no "look up another player" - ``resolve_player`` describes the
    account the configured key belongs to, and a caller asking about somebody
    else gets a clear error rather than that person's data.
    """

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        account = await providers.guild_wars_2(self.runtime).get_account()
        name = str(account.get("name") or "")
        asked = as_str(parsed.name or parsed.account_id)
        if asked and asked.lower() != name.lower():
            raise ValidationError(
                "Guild Wars 2 only exposes the account its API key belongs to "
                f'({name}), not "{asked}"'
            )
        return self.ref(
            provider_id="guild-wars-2",
            id=str(account.get("id") or name),
            display_name=name,
            platform="web",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        account = await providers.guild_wars_2(self.runtime).get_account()
        return PlayerProfile(
            ref=ref,
            display_name=str(account.get("name") or ref.id),
            created_at=ts(account.get("created")),
            last_seen_at=ts(account.get("last_modified")),
            raw=account,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        stats = await providers.guild_wars_2(self.runtime).get_pvp_stats()
        aggregate = stats.get("aggregate") or {}
        professions = stats.get("professions") or {}

        modes: dict[str, ModeStats] = {
            profession: mode_stats(
                id=profession,
                wins=as_int(row.get("wins")),
                losses=as_int(row.get("losses")),
                extra={
                    "byes": as_int(row.get("byes")),
                    "forfeits": as_int(row.get("forfeits")),
                    "desertions": as_int(row.get("desertions")),
                },
            )
            for profession, row in professions.items()
            if isinstance(row, dict)
        }

        return player_stats(
            ref=ref,
            wins=as_int(aggregate.get("wins")),
            losses=as_int(aggregate.get("losses")),
            modes=modes,
            raw=stats,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        standings = await providers.guild_wars_2(self.runtime).get_pvp_standings()

        ranks = []
        for standing in standings:
            current = standing.get("current") or {}
            ranks.append(
                RankInfo(
                    ref=ref,
                    queue=as_str(standing.get("season_id")) or "pvp",
                    tier=as_str(current.get("tier")),
                    division=as_str(current.get("division")),
                    tier_points=as_int(current.get("points")),
                    rating=as_int(current.get("rating")),
                    season=as_str(standing.get("season_id")),
                    raw=standing,
                )
            )
        return ranks

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        """The last ten PvP games, which is all the API keeps."""
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        # The games endpoint takes no id - it is scoped to the key's own account -
        # so resolving is purely the check that the caller asked about it.
        if not isinstance(query, PlayerRef):
            await self.resolve_player(as_query(query))
        games = await providers.guild_wars_2(self.runtime).get_pvp_games()

        summaries = []
        for game in games[: self.limit(opts.limit, 10)]:
            scores = game.get("scores") or {}
            started = ts(game.get("started"))
            ended = ts(game.get("ended"))
            summaries.append(
                MatchSummary(
                    match_id=str(game.get("id") or ""),
                    title_id=self.title.id,
                    mode=as_str(game.get("rating_type")) or "pvp",
                    map=as_str(game.get("map_id")),
                    started_at=started,
                    duration_seconds=(
                        round((ended - started) / 1_000)
                        if started is not None and ended is not None
                        else None
                    ),
                    result=match_result(as_str(game.get("result")) == "Victory"),
                    player_stats=participant_stats(
                        extra={
                            "profession": as_str(game.get("profession")),
                            "team": as_str(game.get("team")),
                            "redScore": as_int(scores.get("red")),
                            "blueScore": as_int(scores.get("blue")),
                            "ratingChange": as_int(game.get("rating_change")),
                        }
                    ),
                    raw=game,
                )
            )
        return summaries

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        if not opts.season:
            raise ValidationError(
                "Guild Wars 2 leaderboards are per season - pass season= with a season id"
            )
        rows = await providers.guild_wars_2(self.runtime).get_pvp_leaderboard(
            opts.season, opts.queue or "legendary", opts.region or "global"
        )
        return [
            LeaderboardEntry(
                position=as_int(row.get("rank")) or index + 1,
                player_id=as_str(row.get("id")),
                display_name=as_str(row.get("name")),
                rating=as_int((as_list(row.get("scores")) or [{}])[0].get("value")),
                raw=row,
            )
            for index, row in enumerate(rows[: self.limit(opts.limit, 100)])
        ]


class PathOfExileClient(TitleClient):
    """Path of Exile.

    Race ladders only. GGG publishes no per-character endpoint without a session
    cookie, so this title declares ``getLeaderboard`` and the esports
    capabilities and nothing else - which is the whole of the public API.
    """

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        poe = providers.path_of_exile(self.runtime)
        league = opts.season or opts.queue

        if not league:
            # Without a league the ladder is meaningless, so the current ones are
            # named in the error rather than one being picked arbitrarily.
            leagues = await poe.get_leagues()
            names = [as_str(entry.get("id")) for entry in leagues if entry.get("id")]
            raise ValidationError(
                "Path of Exile ladders are per league - pass season=. "
                f"Current leagues: {', '.join(name for name in names[:8] if name)}"
            )

        entries = await poe.get_ladder(
            league, limit=self.limit(opts.limit, 50), offset=opts.offset or 0
        )
        rows = []
        for index, entry in enumerate(entries):
            character = entry.get("character") or {}
            account = entry.get("account") or {}
            rows.append(
                LeaderboardEntry(
                    position=as_int(entry.get("rank")) or index + 1,
                    player_id=as_str(account.get("name")),
                    display_name=as_str(character.get("name")),
                    rating=as_int(character.get("level")),
                    tier=as_str(character.get("class")),
                    raw=entry,
                )
            )
        return rows

    async def get_metadata(self, kind: str | None = None) -> Any:
        self.require("getMetadata")
        if kind not in (None, "leagues"):
            raise ValidationError(
                f'Path of Exile metadata "{kind}" is not available - try "leagues"'
            )
        return await providers.path_of_exile(self.runtime).get_leagues()


class AlbionClient(TitleClient):
    """Albion Online.

    The competitive game is guild-versus-guild, so "match history" here means
    kills and deaths - the only per-event record Albion exposes for an individual.
    """

    @staticmethod
    def _server(value: str | None) -> str:
        return value or "europe"

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        region = self._server(parsed.region)
        term = str(parsed.name or parsed.account_id or "")
        results = await providers.albion(self.runtime).search(term, region)
        players = as_list(results.get("players"))
        exact = next(
            (p for p in players if str(p.get("Name", "")).lower() == term.lower()),
            players[0] if players else None,
        )
        if not exact:
            raise NotFoundError("albion", f'Albion player "{term}"', self.title.id)

        return self.ref(
            provider_id="albion",
            id=str(exact.get("Id") or ""),
            display_name=as_str(exact.get("Name")),
            region=region,
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        player = await providers.albion(self.runtime).get_player(
            ref.id, self._server(ref.region)
        )
        return PlayerProfile(
            ref=ref,
            display_name=str(player.get("Name") or ref.id),
            clan=as_str(player.get("GuildName")),
            raw=player,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        player = await providers.albion(self.runtime).get_player(
            ref.id, self._server(ref.region)
        )
        lifetime = player.get("LifetimeStatistics") or {}

        return player_stats(
            ref=ref,
            kills=as_int(player.get("KillFame")),
            deaths=as_int(player.get("DeathFame")),
            modes={
                "pve": mode_stats(
                    id="pve",
                    label="PvE",
                    extra={"fame": as_int((lifetime.get("PvE") or {}).get("Total"))},
                ),
                "gathering": mode_stats(
                    id="gathering",
                    label="Gathering",
                    extra={
                        "fame": as_int(
                            ((lifetime.get("Gathering") or {}).get("All") or {}).get("Total")
                        )
                    },
                ),
                "crafting": mode_stats(
                    id="crafting",
                    label="Crafting",
                    extra={"fame": as_int((lifetime.get("Crafting") or {}).get("Total"))},
                ),
            },
            raw=player,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        player = await providers.albion(self.runtime).get_player(
            ref.id, self._server(ref.region)
        )
        return [
            RankInfo(ref=ref, queue="fame", rating=as_int(player.get("KillFame")), raw=player)
        ]

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        kills = await providers.albion(self.runtime).get_player_kills(
            ref.id, self._server(ref.region)
        )

        return [
            MatchSummary(
                match_id=str(event.get("EventId") or ""),
                title_id=self.title.id,
                mode="pvp",
                started_at=ts(event.get("TimeStamp")),
                result=match_result(str((event.get("Killer") or {}).get("Id")) == ref.id),
                player_stats=participant_stats(
                    extra={
                        "fame": as_int(event.get("TotalVictimKillFame")),
                        "participants": len(as_list(event.get("Participants"))),
                    }
                ),
                raw=event,
            )
            for event in kills[: self.limit(opts.limit)]
        ]

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        raise NotFoundError(
            "albion",
            "Albion ladder (the game info API publishes guild rankings, not a player ladder)",
            self.title.id,
        )


class _WargamingTitleClient(TitleClient):
    """Shared behaviour for the two Wargaming titles."""

    def game(self) -> str:
        raise NotImplementedError

    @staticmethod
    def _wg_region(value: str | None) -> str:
        return value or "eu"

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        region = self._wg_region(parsed.region)
        wargaming = providers.wargaming(self.runtime)

        if parsed.account_id:
            account = await wargaming.get_account_info(
                self.game(), region, str(parsed.account_id)
            )
            return self.ref(
                provider_id="wargaming",
                id=str(account.get("account_id")),
                display_name=as_str(account.get("nickname")),
                region=region,
            )

        found = await wargaming.find_account(self.game(), region, str(parsed.name))
        return self.ref(
            provider_id="wargaming",
            id=str(found.get("account_id")),
            display_name=as_str(found.get("nickname")),
            region=region,
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        account = await providers.wargaming(self.runtime).get_account_info(
            self.game(), self._wg_region(ref.region), ref.id
        )
        clan_id = account.get("clan_id")
        return PlayerProfile(
            ref=ref,
            display_name=str(account.get("nickname") or ref.id),
            created_at=ts(account.get("created_at")),
            last_seen_at=ts(account.get("last_battle_time")),
            clan=str(clan_id) if clan_id else None,
            raw=account,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        account = await providers.wargaming(self.runtime).get_account_info(
            self.game(), self._wg_region(ref.region), ref.id
        )
        statistics = account.get("statistics") or {}
        all_stats = statistics.get("all") or {}

        modes: dict[str, ModeStats] = {
            mode: mode_stats(
                id=mode,
                matches_played=as_int(stats.get("battles")),
                wins=as_int(stats.get("wins")),
                losses=as_int(stats.get("losses")),
                kills=as_int(stats.get("frags")),
                extra={
                    "damageDealt": as_int(stats.get("damage_dealt")),
                    "survived": as_int(stats.get("survived_battles")),
                    "experience": as_int(stats.get("xp")),
                    "spotted": as_int(stats.get("spotted")),
                },
            )
            for mode, stats in statistics.items()
            if isinstance(stats, dict)
        }

        return player_stats(
            ref=ref,
            matches_played=as_int(all_stats.get("battles")),
            wins=as_int(all_stats.get("wins")),
            losses=as_int(all_stats.get("losses")),
            draws=as_int(all_stats.get("draws")),
            kills=as_int(all_stats.get("frags")),
            modes=modes,
            raw=account,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        """Wargaming's global rating - the closest thing either game has."""
        self.require("getRank")
        ref = await self._resolved(query)
        account = await providers.wargaming(self.runtime).get_account_info(
            self.game(), self._wg_region(ref.region), ref.id
        )
        all_stats = (account.get("statistics") or {}).get("all") or {}
        return [
            RankInfo(
                ref=ref,
                queue="global",
                rating=as_int(account.get("global_rating")),
                wins=as_int(all_stats.get("wins")),
                losses=as_int(all_stats.get("losses")),
                raw=account,
            )
        ]

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        raise NotFoundError(
            "wargaming",
            "player ladder (Wargaming publishes clan ratings rather than a "
            "player leaderboard)",
            self.title.id,
        )

    async def get_metadata(self, kind: str | None = None) -> Any:
        self.require("getMetadata")
        return await providers.wargaming(self.runtime).get_vehicle_encyclopedia(
            self.game(), "eu"
        )


class WorldOfTanksClient(_WargamingTitleClient):
    """World of Tanks."""

    def game(self) -> str:
        return "worldoftanks"


class WorldOfWarshipsClient(_WargamingTitleClient):
    """World of Warships."""

    def game(self) -> str:
        return "worldofwarships"
