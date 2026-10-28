"""The shooters.

Apex Legends, Fortnite, PUBG, Rainbow Six Siege, Call of Duty, Battlefield,
Splitgate, Halo Infinite, Destiny 2, The Finals and Marvel Rivals.

Four of these share one provider (Tracker), which is why
:class:`TrackerBackedClient` exists: Ubisoft, Activision, EA and 1047 all publish
nothing, and the shape of what Tracker returns is identical for all of them.
Writing that mapping four times would have been four chances to get it subtly
different.
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
    num,
    participant_stats,
    player_stats,
    total,
    ts,
)
from ..providers.blizzard import DESTINY_PLATFORMS
from ..title_client import TitleClient, as_query
from ..types import (
    LeaderboardEntry,
    LeaderboardOptions,
    MatchDetail,
    MatchHistoryOptions,
    MatchParticipant,
    MatchResult,
    MatchSummary,
    MatchTeam,
    ModeStats,
    PlayerProfile,
    PlayerQuery,
    PlayerRef,
    PlayerStats,
    RankInfo,
)

__all__ = [
    "TrackerBackedClient",
    "RainbowSixClient",
    "CallOfDutyClient",
    "BattlefieldClient",
    "SplitgateClient",
    "ApexLegendsClient",
    "FortniteClient",
    "PubgClient",
    "HaloInfiniteClient",
    "Destiny2Client",
    "TheFinalsClient",
    "MarvelRivalsClient",
]


class TrackerBackedClient(TitleClient):
    """The titles whose only source is Tracker Network.

    Tracker's schema is one ``overview`` segment of career totals plus a segment
    per legend, operator, weapon or season. Subclasses differ only in which
    segment type is interesting and what the default platform is.
    """

    def mode_segment_type(self) -> str | None:
        """Segment type holding the per-mode breakdown, when the title has one."""
        return None

    def default_platform(self) -> str:
        return "ubi"

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        identifier = str(parsed.name or parsed.ubisoft_id or parsed.account_id or "")
        platform = parsed.platform or self.default_platform()
        profile = await providers.tracker(self.runtime).get_profile(
            self.title.id, str(platform), identifier
        )
        info = profile.get("platformInfo") or {}

        return self.ref(
            provider_id="tracker",
            id=str(info.get("platformUserId") or identifier),
            display_name=as_str(info.get("platformUserHandle")) or identifier,
            platform=parsed.platform,
        )

    async def _profile(self, ref: PlayerRef) -> dict[str, Any]:
        return await providers.tracker(self.runtime).get_profile(
            self.title.id,
            ref.platform or self.default_platform(),
            ref.display_name or ref.id,
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        tracker = providers.tracker(self.runtime)
        profile = await self._profile(ref)
        stats = tracker.flatten_stats(tracker.segment(profile, "overview"))
        info = profile.get("platformInfo") or {}

        return PlayerProfile(
            ref=ref,
            display_name=str(info.get("platformUserHandle") or ref.id),
            level=as_int(stats.get("level")),
            avatar_url=as_str(info.get("avatarUrl")),
            country=as_str((profile.get("userInfo") or {}).get("countryCode")),
            raw=profile,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        tracker = providers.tracker(self.runtime)
        profile = await self._profile(ref)
        stats = tracker.flatten_stats(tracker.segment(profile, "overview"))

        modes: dict[str, ModeStats] = {}
        segment_type = self.mode_segment_type()
        if segment_type:
            for segment in profile.get("segments") or []:
                if segment.get("type") != segment_type:
                    continue
                attributes = segment.get("attributes") or {}
                metadata = segment.get("metadata") or {}
                identifier = str(attributes.get("key") or metadata.get("name") or "unknown")
                flat = tracker.flatten_stats(segment)
                modes[identifier] = mode_stats(
                    id=identifier,
                    label=str(metadata.get("name") or identifier),
                    wins=as_int(flat.get("wins")),
                    losses=as_int(flat.get("losses")),
                    kills=as_int(flat.get("kills")),
                    deaths=as_int(flat.get("deaths")),
                    extra=flat,
                )

        return player_stats(
            ref=ref,
            matches_played=as_int(stats.get("matchesPlayed") or stats.get("gamesPlayed")),
            wins=as_int(stats.get("wins") or stats.get("matchesWon")),
            losses=as_int(stats.get("losses") or stats.get("matchesLost")),
            kills=as_int(stats.get("kills")),
            deaths=as_int(stats.get("deaths")),
            assists=as_int(stats.get("assists")),
            time_played_seconds=as_int(stats.get("timePlayed")),
            modes=modes,
            raw=profile,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        tracker = providers.tracker(self.runtime)
        profile = await self._profile(ref)
        overview = tracker.segment(profile, "overview") or {}
        stats = overview.get("stats") or {}
        rank_stat = stats.get("rankScore") or stats.get("mmr") or stats.get("rank")
        if not rank_stat:
            return []

        metadata = rank_stat.get("metadata") or {}
        percentile = rank_stat.get("percentile")
        return [
            RankInfo(
                ref=ref,
                queue="ranked",
                tier=as_str(metadata.get("tierName") or metadata.get("name")),
                division=as_str(metadata.get("divisionName")),
                rating=num(rank_stat.get("value")),
                position=as_int(rank_stat.get("rank")),
                # Tracker's percentile is 0..100 with one decimal; the model
                # wants permille, so 43.7 becomes 437.
                percentile_permille=(
                    round(percentile * 10) if percentile is not None else None
                ),
                raw=overview,
            )
        ]

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        rows = await providers.tracker(self.runtime).get_leaderboard(
            self.title.id,
            opts.queue or "Ranked",
            platform=opts.platform,
            take=self.limit(opts.limit, 50),
            skip=opts.offset or 0,
        )
        return [
            LeaderboardEntry(
                position=as_int(row.get("rank")) or (opts.offset or 0) + index + 1,
                player_id=as_str((row.get("owner") or {}).get("id")),
                display_name=as_str(
                    ((row.get("owner") or {}).get("metadata") or {}).get("platformUserHandle")
                ),
                rating=num(row.get("value")),
                raw=row,
            )
            for index, row in enumerate(rows)
        ]


class RainbowSixClient(TrackerBackedClient):
    """Rainbow Six Siege. Segments are per operator."""

    def mode_segment_type(self) -> str:
        return "operator"


class CallOfDutyClient(TrackerBackedClient):
    """Call of Duty. Warzone by default - Tracker keys the modes separately."""

    def mode_segment_type(self) -> str:
        return "mode"

    def default_platform(self) -> str:
        return "battlenet"


class BattlefieldClient(TrackerBackedClient):
    """Battlefield."""

    def mode_segment_type(self) -> str:
        return "weapon"

    def default_platform(self) -> str:
        return "origin"


class SplitgateClient(TrackerBackedClient):
    """Splitgate."""

    def default_platform(self) -> str:
        return "steam"


class ApexLegendsClient(TitleClient):
    """Apex Legends.

    ApexLegendsAPI is preferred over Tracker because it carries the ranked ladder
    points, which Tracker exposes only as a tier name. Names are not unique
    across platforms, so the platform travels on the ref.
    """

    @staticmethod
    def _platform_for(value: str | None) -> str:
        return {
            "xbox": "X1",
            "playstation": "PS4",
            "nintendo": "SWITCH",
        }.get((value or "origin").lower(), "PC")

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        platform = self._platform_for(parsed.platform)
        name = str(parsed.name or "")
        apex = providers.apex(self.runtime)
        player = (
            await apex.get_player_by_uid(str(parsed.account_id), platform)
            if parsed.account_id
            else await apex.get_player(name, platform)
        )
        global_data = player.get("global") or {}

        return self.ref(
            provider_id="apex-legends-api",
            id=str(global_data.get("uid") or name),
            display_name=as_str(global_data.get("name")) or name,
            platform=parsed.platform or "origin",
        )

    async def _fetch(self, ref: PlayerRef) -> dict[str, Any]:
        platform = self._platform_for(ref.platform)
        apex = providers.apex(self.runtime)
        if ref.id.isdigit():
            return await apex.get_player_by_uid(ref.id, platform)
        return await apex.get_player(ref.display_name or ref.id, platform)

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        player = await self._fetch(ref)
        global_data = player.get("global") or {}
        return PlayerProfile(
            ref=ref,
            display_name=str(global_data.get("name") or ref.id),
            level=as_int(global_data.get("level")),
            avatar_url=as_str(global_data.get("avatar")),
            raw=player,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        player = await self._fetch(ref)
        legends = (player.get("legends") or {}).get("all") or {}
        totals = player.get("total") or {}

        modes: dict[str, ModeStats] = {}
        for legend, data in legends.items():
            trackers = as_list((data or {}).get("data"))
            if not trackers:
                continue
            extra: dict[str, Any] = {}
            for tracker in trackers:
                # Bound before use: a tracker with no key is dropped rather than
                # filed under None, which would collide every unnamed one onto
                # a single entry.
                key = as_str(tracker.get("key"))
                if key:
                    extra[key] = num(tracker.get("value"))
            modes[legend] = mode_stats(id=legend, label=legend, extra=extra)

        return player_stats(
            ref=ref,
            kills=as_int((totals.get("kills") or {}).get("value")),
            deaths=as_int((totals.get("deaths") or {}).get("value")),
            modes=modes,
            raw=player,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        player = await self._fetch(ref)
        global_data = player.get("global") or {}

        ranks: list[RankInfo] = []
        for queue, entry in (
            ("battle-royale", global_data.get("rank")),
            ("arenas", global_data.get("arena")),
        ):
            if not entry:
                continue
            ranks.append(
                RankInfo(
                    ref=ref,
                    queue=queue,
                    tier=as_str(entry.get("rankName")),
                    division=as_str(entry.get("rankDiv")),
                    tier_points=as_int(entry.get("rankScore")),
                    rating=as_int(entry.get("rankScore")),
                    position=as_int(entry.get("ladderPosPlatform")),
                    raw=entry,
                )
            )
        return ranks

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        """Predator and Master cutoffs - the closest thing Apex has to a ladder."""
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        cutoff = await providers.apex(self.runtime).get_predator_cutoff()
        ranks = (cutoff or {}).get("RP") or {}
        return [
            LeaderboardEntry(
                position=index + 1,
                display_name=platform,
                rating=as_int((entry or {}).get("val")),
                tier="Apex Predator cutoff",
                raw=entry,
            )
            for index, (platform, entry) in enumerate(
                list(ranks.items())[: self.limit(opts.limit, 10)]
            )
        ]


class FortniteClient(TitleClient):
    """Fortnite.

    A player who has hidden their stats in-game is invisible whatever key you
    hold, so a 403 here means an in-game setting rather than a bad credential.
    """

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        name = str(parsed.name or parsed.epic_id or "")
        fortnite = providers.fortnite(self.runtime)
        stats = (
            await fortnite.get_stats_by_id(str(parsed.epic_id))
            if parsed.epic_id
            else await fortnite.get_stats_by_name(name)
        )
        account = stats.get("account") or {}

        return self.ref(
            provider_id="fortnite-api",
            id=str(account.get("id") or name),
            display_name=as_str(account.get("name")) or name,
            platform=parsed.platform or "epic",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        stats = await providers.fortnite(self.runtime).get_stats_by_id(ref.id)
        account = stats.get("account") or {}
        battle_pass = stats.get("battlePass") or {}
        return PlayerProfile(
            ref=ref,
            display_name=str(account.get("name") or ref.id),
            level=as_int(battle_pass.get("level")),
            raw=stats,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        stats = await providers.fortnite(self.runtime).get_stats_by_id(ref.id)
        all_modes = (stats.get("stats") or {}).get("all") or {}
        overall = all_modes.get("overall") or {}

        modes: dict[str, ModeStats] = {}
        for mode, data in all_modes.items():
            if mode == "overall" or not data:
                continue
            matches = as_int(data.get("matches"))
            wins = as_int(data.get("wins"))
            modes[mode] = mode_stats(
                id=mode,
                matches_played=matches,
                wins=wins,
                losses=(matches - wins) if matches is not None and wins is not None else None,
                kills=as_int(data.get("kills")),
                deaths=as_int(data.get("deaths")),
                extra={
                    "top10": as_int(data.get("top10")),
                    "killsPerMatch": num(data.get("killsPerMatch")),
                    "minutesPlayed": as_int(data.get("minutesPlayed")),
                },
            )

        matches = as_int(overall.get("matches"))
        wins = as_int(overall.get("wins"))
        minutes = as_int(overall.get("minutesPlayed"))
        return player_stats(
            ref=ref,
            matches_played=matches,
            wins=wins,
            losses=(matches - wins) if matches is not None and wins is not None else None,
            kills=as_int(overall.get("kills")),
            deaths=as_int(overall.get("deaths")),
            time_played_seconds=minutes * 60 if minutes is not None else None,
            modes=modes,
            raw=stats,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        """Fortnite has no persistent rank the API exposes.

        Ranked mode exists in-game but is not published, so this returns an empty
        list rather than dressing the battle pass level up as a rank.
        """
        self.require("getRank")
        return []

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        raise NotFoundError(
            "fortnite-api",
            "Fortnite ladder (Epic publishes none; use get_esports_tournaments "
            "for competitive results)",
            self.title.id,
        )

    async def get_metadata(self, kind: str | None = None) -> Any:
        self.require("getMetadata")
        fortnite = providers.fortnite(self.runtime)
        if kind in (None, "cosmetics"):
            return await fortnite.get_cosmetics()
        if kind == "playlists":
            return await fortnite.get_playlists()
        raise ValidationError(
            f'Fortnite metadata "{kind}" is not available - try cosmetics or playlists'
        )


class PubgClient(TitleClient):
    """PUBG: Battlegrounds.

    The tightest quota of any first-party API here - ten requests a minute - so
    this client resolves once, caches hard, and never fans out over match ids
    unless asked to.
    """

    @staticmethod
    def _shard(value: str | None) -> str:
        return value or "steam"

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        shard = self._shard(parsed.region)
        pubg = providers.pubg(self.runtime)
        player = (
            await pubg.get_player_by_id(shard, str(parsed.account_id))
            if parsed.account_id
            else await pubg.get_player_by_name(shard, str(parsed.name))
        )

        return self.ref(
            provider_id="pubg",
            id=str(player["id"]),
            display_name=str((player.get("attributes") or {}).get("name")),
            region=shard,
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        player = await providers.pubg(self.runtime).get_player_by_id(
            self._shard(ref.region), ref.id
        )
        return PlayerProfile(
            ref=ref,
            display_name=str((player.get("attributes") or {}).get("name") or ref.id),
            raw=player,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        shard = self._shard(ref.region)
        by_mode = await providers.pubg(self.runtime).get_lifetime_stats(shard, ref.id)

        modes: dict[str, ModeStats] = {}
        for mode, stats in by_mode.items():
            modes[mode] = mode_stats(
                id=mode,
                matches_played=as_int(stats.get("roundsPlayed")),
                wins=as_int(stats.get("wins")),
                losses=as_int(stats.get("losses")),
                kills=as_int(stats.get("kills")),
                assists=as_int(stats.get("assists")),
                extra={
                    "top10s": as_int(stats.get("top10s")),
                    "damageDealt": as_int(round(num(stats.get("damageDealt")) or 0)),
                    "headshotKills": as_int(stats.get("headshotKills")),
                    "longestKill": as_int(round(num(stats.get("longestKill")) or 0)),
                    "timeSurvived": as_int(round(num(stats.get("timeSurvived")) or 0)),
                    "revives": as_int(stats.get("revives")),
                },
            )

        rows = list(by_mode.values())
        return player_stats(
            ref=ref,
            matches_played=total(as_int(row.get("roundsPlayed")) for row in rows),
            wins=total(as_int(row.get("wins")) for row in rows),
            losses=total(as_int(row.get("losses")) for row in rows),
            kills=total(as_int(row.get("kills")) for row in rows),
            assists=total(as_int(row.get("assists")) for row in rows),
            time_played_seconds=total(
                as_int(round(num(row.get("timeSurvived")) or 0)) for row in rows
            ),
            modes=modes,
            raw=by_mode,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        shard = self._shard(ref.region)
        pubg = providers.pubg(self.runtime)
        season_id = await pubg.get_current_season_id(shard)
        ranked = await pubg.get_ranked_stats(shard, ref.id, season_id)

        ranks: list[RankInfo] = []
        for mode, stats in ranked.items():
            tier = stats.get("currentTier") or {}
            rounds = as_int(stats.get("roundsPlayed"))
            wins = as_int(stats.get("wins"))
            ranks.append(
                RankInfo(
                    ref=ref,
                    queue=mode,
                    tier=as_str(tier.get("tier")),
                    division=as_str(tier.get("subTier")),
                    tier_points=as_int(stats.get("currentRankPoint")),
                    rating=as_int(stats.get("currentRankPoint")),
                    wins=wins,
                    losses=(
                        rounds - wins if rounds is not None and wins is not None else None
                    ),
                    season=season_id,
                    raw=stats,
                )
            )
        return ranks

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        shard = self._shard(ref.region)
        pubg = providers.pubg(self.runtime)
        player = await pubg.get_player_by_id(shard, ref.id)
        entries = as_list(
            ((player.get("relationships") or {}).get("matches") or {}).get("data")
        )[: self.limit(opts.limit, 10)]

        if not opts.hydrate:
            # The relationship list is ids only. Returning them as thin summaries
            # is the right default: hydrating ten matches costs ten of the ten
            # calls this API allows per minute.
            return [
                MatchSummary(
                    match_id=str(entry.get("id") or ""),
                    title_id=self.title.id,
                    result=MatchResult.UNKNOWN,
                    raw=entry,
                )
                for entry in entries
            ]

        summaries = []
        for entry in entries:
            match = await pubg.get_match(shard, str(entry["id"]))
            summaries.append(self._to_summary(match, ref.id))
        return summaries

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        self.require("getMatch")
        shard = self._shard(context.region if context else None)
        match = await providers.pubg(self.runtime).get_match(shard, match_id)
        summary = self._to_summary(match, context.id if context else None)
        included = match.get("included") or []
        participants = [row for row in included if row.get("type") == "participant"]
        rosters = [row for row in included if row.get("type") == "roster"]

        return MatchDetail(
            match_id=summary.match_id,
            title_id=summary.title_id,
            mode=summary.mode,
            map=summary.map,
            started_at=summary.started_at,
            duration_seconds=summary.duration_seconds,
            result=summary.result,
            player_stats=summary.player_stats,
            raw=summary.raw,
            teams=tuple(_pubg_team(roster) for roster in rosters),
            participants=tuple(_pubg_participant(row) for row in participants),
        )

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        shard = self._shard(opts.region)
        pubg = providers.pubg(self.runtime)
        season_id = opts.season or await pubg.get_current_season_id(shard)
        rows = await pubg.get_leaderboard(shard, season_id, opts.queue or "squad-fpp")

        entries = []
        for index, row in enumerate(rows[: self.limit(opts.limit, 100)]):
            attributes = row.get("attributes") or {}
            stats = attributes.get("stats") or {}
            entries.append(
                LeaderboardEntry(
                    position=as_int(attributes.get("rank")) or index + 1,
                    player_id=str(row.get("id") or ""),
                    display_name=as_str(attributes.get("name")),
                    rating=as_int(stats.get("rankPoints")),
                    wins=as_int(stats.get("wins")),
                    raw=row,
                )
            )
        return entries

    def _to_summary(self, match: dict[str, Any], account_id: str | None) -> MatchSummary:
        data = match.get("data") or {}
        attributes = data.get("attributes") or {}
        mine = None
        if account_id:
            for row in match.get("included") or []:
                if row.get("type") != "participant":
                    continue
                stats = (row.get("attributes") or {}).get("stats") or {}
                if stats.get("playerId") == account_id:
                    mine = row
                    break
        stats = ((mine or {}).get("attributes") or {}).get("stats") or {}

        return MatchSummary(
            match_id=str(data.get("id") or ""),
            title_id=self.title.id,
            mode=as_str(attributes.get("gameMode")),
            map=as_str(attributes.get("mapName")),
            started_at=ts(attributes.get("createdAt")),
            duration_seconds=as_int(attributes.get("duration")),
            # A battle royale has one winner, so "win" means first place.
            result=(
                match_result(as_int(stats.get("winPlace")) == 1)
                if mine
                else MatchResult.UNKNOWN
            ),
            player_stats=_pubg_participant_stats(stats) if mine else None,
            raw=match,
        )


def _pubg_team(roster: dict[str, Any]) -> MatchTeam:
    attributes = roster.get("attributes") or {}
    return MatchTeam(
        id=str(roster.get("id") or ""),
        won=attributes.get("won") in (True, "true"),
        score=as_int((attributes.get("stats") or {}).get("rank")),
    )


def _pubg_participant(row: dict[str, Any]) -> MatchParticipant:
    stats = (row.get("attributes") or {}).get("stats") or {}
    return MatchParticipant(
        player_id=str(stats.get("playerId") or ""),
        display_name=as_str(stats.get("name")),
        stats=_pubg_participant_stats(stats),
        raw=row,
    )


def _pubg_participant_stats(stats: dict[str, Any]) -> Any:
    return participant_stats(
        kills=as_int(stats.get("kills")),
        assists=as_int(stats.get("assists")),
        damage_dealt=as_int(round(num(stats.get("damageDealt")) or 0)),
        placement=as_int(stats.get("winPlace")),
        extra={
            "headshotKills": as_int(stats.get("headshotKills")),
            "longestKill": as_int(round(num(stats.get("longestKill")) or 0)),
            "timeSurvived": as_int(round(num(stats.get("timeSurvived")) or 0)),
            "revives": as_int(stats.get("revives")),
            "walkDistance": as_int(round(num(stats.get("walkDistance")) or 0)),
        },
    )


class HaloInfiniteClient(TitleClient):
    """Halo Infinite, through HaloDotAPI. Keyed on gamertag."""

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        gamertag = str(parsed.name or "")
        await providers.halo(self.runtime).get_service_record(gamertag)
        return self.ref(
            provider_id="halodotapi",
            id=gamertag,
            display_name=gamertag,
            platform="xbox",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        record = await providers.halo(self.runtime).get_service_record(ref.id)
        return PlayerProfile(ref=ref, display_name=ref.id, raw=record)

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        record = await providers.halo(self.runtime).get_service_record(ref.id)
        core = record.get("core") or {}
        summary = core.get("summary") or {}
        matches = record.get("matches") or {}

        return player_stats(
            ref=ref,
            matches_played=as_int(record.get("matches_played") or matches.get("total")),
            wins=as_int(matches.get("wins")),
            losses=as_int(matches.get("losses")),
            draws=as_int(matches.get("ties")),
            kills=as_int(summary.get("kills")),
            deaths=as_int(summary.get("deaths")),
            assists=as_int(summary.get("assists")),
            time_played_seconds=as_int((record.get("time_played") or {}).get("seconds")),
            raw=record,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        csrs = await providers.halo(self.runtime).get_csr(ref.id)

        ranks = []
        for entry in csrs:
            current = entry.get("response") or entry
            tier = current.get("current") or current
            ranks.append(
                RankInfo(
                    ref=ref,
                    queue=as_str(entry.get("queue") or entry.get("playlist")) or "ranked",
                    tier=as_str(tier.get("tier")),
                    division=as_str(tier.get("sub_tier")),
                    tier_points=as_int(tier.get("value")),
                    rating=as_int(tier.get("value")),
                    raw=entry,
                )
            )
        return ranks

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        matches = await providers.halo(self.runtime).get_matches(
            ref.id, limit=self.limit(opts.limit, 25), offset=opts.offset or 0
        )

        summaries = []
        for match in matches:
            details = match.get("details") or {}
            player = match.get("player") or {}
            core = ((player.get("stats") or {}).get("core")) or {}
            summary = core.get("summary") or {}
            summaries.append(
                MatchSummary(
                    match_id=str(match.get("id") or ""),
                    title_id=self.title.id,
                    mode=as_str((details.get("category") or {}).get("name")),
                    map=as_str((details.get("map") or {}).get("name")),
                    started_at=ts(match.get("played_at")),
                    duration_seconds=as_int((match.get("duration") or {}).get("seconds")),
                    result=match_result(str(player.get("outcome") or "").lower() == "win"),
                    player_stats=participant_stats(
                        kills=as_int(summary.get("kills")),
                        deaths=as_int(summary.get("deaths")),
                        assists=as_int(summary.get("assists")),
                        score=as_int(core.get("score")),
                        extra={"rank": as_int(player.get("rank"))},
                    ),
                    raw=match,
                )
            )
        return summaries

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        self.require("getMatch")
        match = await providers.halo(self.runtime).get_match(match_id)
        details = match.get("details") or {}

        return MatchDetail(
            match_id=match_id,
            title_id=self.title.id,
            mode=as_str((details.get("category") or {}).get("name")),
            map=as_str((details.get("map") or {}).get("name")),
            started_at=ts(match.get("played_at")),
            duration_seconds=as_int((match.get("duration") or {}).get("seconds")),
            teams=tuple(_halo_team(team) for team in as_list(match.get("teams"))),
            participants=tuple(
                _halo_participant(player) for player in as_list(match.get("players"))
            ),
            raw=match,
        )


def _halo_team(team: dict[str, Any]) -> MatchTeam:
    return MatchTeam(
        id=str(team.get("id") or ""),
        name=as_str((team.get("details") or {}).get("name")),
        won=str(team.get("outcome") or "").lower() == "win",
        score=as_int(team.get("score")),
        rounds_won=as_int(team.get("rounds_won")),
    )


def _halo_participant(player: dict[str, Any]) -> MatchParticipant:
    core = (player.get("stats") or {}).get("core") or {}
    summary = core.get("summary") or {}
    return MatchParticipant(
        player_id=str(player.get("id") or player.get("gamertag") or ""),
        display_name=as_str(player.get("gamertag")),
        team_id=as_str((player.get("team") or {}).get("id")),
        stats=participant_stats(
            kills=as_int(summary.get("kills")),
            deaths=as_int(summary.get("deaths")),
            assists=as_int(summary.get("assists")),
            score=as_int(core.get("score")),
        ),
        raw=player,
    )


class Destiny2Client(TitleClient):
    """Destiny 2.

    Bungie's API is complete but heavy: the profile is opt-in components, and
    activity history is per character rather than per account, so a full history
    means one call per character.
    """

    @staticmethod
    def _membership_type(platform: str | None) -> int:
        return DESTINY_PLATFORMS.get(platform or "all", DESTINY_PLATFORMS["all"])

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        bungie = providers.bungie(self.runtime)

        if parsed.membership_id:
            return self.ref(
                provider_id="bungie",
                id=str(parsed.membership_id),
                display_name=as_str(parsed.name),
                platform=parsed.platform,
                region=str(self._membership_type(parsed.platform)),
            )

        membership = await bungie.get_primary_membership(str(parsed.name))
        name = membership.get("bungieGlobalDisplayName")
        code = membership.get("bungieGlobalDisplayNameCode")
        return self.ref(
            provider_id="bungie",
            id=str(membership["membershipId"]),
            display_name=(
                f"{name}#{code}" if name and code else as_str(membership.get("displayName"))
            ),
            # The membership type is not a region, but it is the second half of
            # every Destiny id and has to travel with it.
            region=str(membership.get("membershipType")),
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        membership_type = int(ref.region or DESTINY_PLATFORMS["all"])
        profile = await providers.bungie(self.runtime).get_profile(membership_type, ref.id)
        data = (profile.get("profile") or {}).get("data") or {}

        return PlayerProfile(
            ref=ref,
            display_name=ref.display_name or ref.id,
            profile_url=(
                f"https://www.bungie.net/7/en/User/Profile/{membership_type}/{ref.id}"
            ),
            created_at=ts(data.get("dateLastPlayed")),
            last_seen_at=ts(data.get("dateLastPlayed")),
            raw=profile,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        membership_type = int(ref.region or DESTINY_PLATFORMS["all"])
        stats = await providers.bungie(self.runtime).get_account_stats(membership_type, ref.id)
        merged = (stats.get("mergedAllCharacters") or {}).get("results") or {}
        all_time = (merged.get("allPvP") or {}).get("allTime") or {}

        def value(key: str) -> int | None:
            return as_int(((all_time.get(key) or {}).get("basic") or {}).get("value"))

        entered = value("activitiesEntered")
        won = value("activitiesWon")
        return player_stats(
            ref=ref,
            matches_played=entered,
            wins=won,
            losses=(entered - won) if entered is not None and won is not None else None,
            kills=value("kills"),
            deaths=value("deaths"),
            assists=value("assists"),
            time_played_seconds=value("secondsPlayed"),
            raw=stats,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        """Destiny has no ranked ladder in the API.

        Glory and Valor exist in-game but are progression records rather than
        published ranks, so this returns an empty list instead of a guess.
        """
        self.require("getRank")
        return []

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        membership_type = int(ref.region or DESTINY_PLATFORMS["all"])
        bungie = providers.bungie(self.runtime)
        characters = await bungie.get_character_ids(membership_type, ref.id)

        summaries: list[MatchSummary] = []
        for character_id in characters:
            activities = await bungie.get_activity_history(
                membership_type,
                ref.id,
                character_id,
                count=self.limit(opts.limit, 25),
                # Mode 5 is all PvP, which is what "match history" means here.
                mode=5,
            )
            for activity in activities:
                details = activity.get("activityDetails") or {}
                values = activity.get("values") or {}

                def basic(key: str, source: dict[str, Any] = values) -> Any:
                    return ((source.get(key) or {}).get("basic") or {}).get("value")

                summaries.append(
                    MatchSummary(
                        match_id=str(details.get("instanceId") or ""),
                        title_id=self.title.id,
                        mode=as_str(details.get("mode")),
                        map=as_str(details.get("referenceId")),
                        started_at=ts(activity.get("period")),
                        duration_seconds=as_int(basic("activityDurationSeconds")),
                        result=match_result(basic("standing") == 0),
                        player_stats=participant_stats(
                            kills=as_int(basic("kills")),
                            deaths=as_int(basic("deaths")),
                            assists=as_int(basic("assists")),
                            score=as_int(basic("score")),
                        ),
                        raw=activity,
                    )
                )
        return summaries[: self.limit(opts.limit, 25)]

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        self.require("getMatch")
        report = await providers.bungie(self.runtime).get_post_game_carnage_report(match_id)
        details = report.get("activityDetails") or {}

        def basic(source: dict[str, Any], key: str) -> Any:
            return (((source.get("values") or {}).get(key) or {}).get("basic") or {}).get(
                "value"
            )

        return MatchDetail(
            match_id=match_id,
            title_id=self.title.id,
            mode=as_str(details.get("mode")),
            map=as_str(details.get("referenceId")),
            started_at=ts(report.get("period")),
            teams=tuple(
                MatchTeam(
                    id=str(team.get("teamId") or ""),
                    name=as_str(team.get("teamName")),
                    won=((team.get("standing") or {}).get("basic") or {}).get("value") == 0,
                    score=as_int(((team.get("score") or {}).get("basic") or {}).get("value")),
                )
                for team in as_list(report.get("teams"))
            ),
            participants=tuple(
                MatchParticipant(
                    player_id=str(
                        ((entry.get("player") or {}).get("destinyUserInfo") or {}).get(
                            "membershipId"
                        )
                        or ""
                    ),
                    display_name=as_str(
                        ((entry.get("player") or {}).get("destinyUserInfo") or {}).get(
                            "bungieGlobalDisplayName"
                        )
                        or ((entry.get("player") or {}).get("destinyUserInfo") or {}).get(
                            "displayName"
                        )
                    ),
                    character=as_str((entry.get("player") or {}).get("characterClass")),
                    stats=participant_stats(
                        kills=as_int(basic(entry, "kills")),
                        deaths=as_int(basic(entry, "deaths")),
                        assists=as_int(basic(entry, "assists")),
                        score=as_int(basic(entry, "score")),
                        extra={
                            "efficiency": num(basic(entry, "efficiency")),
                            "kdRatio": num(basic(entry, "killsDeathsRatio")),
                        },
                    ),
                    raw=entry,
                )
                for entry in as_list(report.get("entries"))
            ),
            raw=report,
        )

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        raise NotFoundError(
            "bungie",
            "Destiny 2 ladder (Bungie publishes no global leaderboard through the API)",
            self.title.id,
        )


class TheFinalsClient(TitleClient):
    """The Finals.

    The upstream is a leaderboard, not a player API: you find a player by
    searching a season's ladder. So ``get_rank`` and ``get_leaderboard`` are the
    whole surface, and the title declares nothing else.
    """

    @staticmethod
    def _season(value: str | None) -> str:
        return value or "s5"

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        name = str(parsed.name or parsed.steam_id or parsed.epic_id or "")
        row = await providers.the_finals(self.runtime).get_player(
            name, self._season(parsed.region)
        )
        return self.ref(
            provider_id="the-finals-api",
            id=as_str(row.get("name")) or name,
            display_name=as_str(row.get("name")) or name,
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        row = await providers.the_finals(self.runtime).get_player(ref.id)
        return PlayerProfile(
            ref=ref,
            display_name=str(row.get("name") or ref.id),
            clan=as_str(row.get("clubTag")),
            raw=row,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        row = await providers.the_finals(self.runtime).get_player(ref.id)
        return [
            RankInfo(
                ref=ref,
                queue="ranked",
                tier=as_str(row.get("league")),
                tier_points=as_int(row.get("rankScore") or row.get("fame")),
                rating=as_int(row.get("rankScore") or row.get("fame")),
                position=as_int(row.get("rank")),
                raw=row,
            )
        ]

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        rows = await providers.the_finals(self.runtime).get_leaderboard(
            self._season(opts.season)
        )
        return [
            LeaderboardEntry(
                position=as_int(row.get("rank")) or index + 1,
                player_id=as_str(row.get("name")),
                display_name=as_str(row.get("name")),
                rating=as_int(row.get("rankScore") or row.get("fame")),
                tier=as_str(row.get("league")),
                raw=row,
            )
            for index, row in enumerate(rows[: self.limit(opts.limit, 100)])
        ]


class MarvelRivalsClient(TitleClient):
    """Marvel Rivals. Recent enough that the upstream schema still moves."""

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        key = str(parsed.name or parsed.account_id or "")
        player = await providers.marvel_rivals(self.runtime).get_player(key)
        return self.ref(
            provider_id="marvel-rivals",
            id=str(player.get("uid") or key),
            display_name=as_str(player.get("name")) or key,
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        player = await providers.marvel_rivals(self.runtime).get_player(ref.id)
        info = player.get("player") or player
        return PlayerProfile(
            ref=ref,
            display_name=str(info.get("name") or ref.id),
            level=as_int(info.get("level")),
            avatar_url=as_str((info.get("icon") or {}).get("player_icon")),
            last_seen_at=ts((player.get("updates") or {}).get("last_update_request")),
            raw=player,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        player = await providers.marvel_rivals(self.runtime).get_player(ref.id)
        ranked = (player.get("overall_stats") or {}).get("ranked") or {}

        modes: dict[str, ModeStats] = {}
        for hero in as_list(player.get("heroes_ranked")):
            identifier = str(hero.get("hero_id") or hero.get("hero_name") or "unknown")
            matches = as_int(hero.get("matches"))
            wins = as_int(hero.get("wins"))
            modes[identifier] = mode_stats(
                id=identifier,
                label=as_str(hero.get("hero_name")) or identifier,
                matches_played=matches,
                wins=wins,
                losses=(matches - wins if matches is not None and wins is not None else None),
                kills=as_int(hero.get("kills")),
                deaths=as_int(hero.get("deaths")),
                assists=as_int(hero.get("assists")),
                extra={"playTime": num(hero.get("play_time"))},
            )

        matches = as_int(ranked.get("total_matches"))
        wins = as_int(ranked.get("total_wins"))
        return player_stats(
            ref=ref,
            matches_played=matches,
            wins=wins,
            losses=(matches - wins) if matches is not None and wins is not None else None,
            modes=modes,
            raw=player,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        player = await providers.marvel_rivals(self.runtime).get_player(ref.id)
        rank = ((player.get("player") or {}).get("rank")) or None
        if not rank:
            return []
        return [
            RankInfo(
                ref=ref,
                queue="ranked",
                tier=as_str(rank.get("rank")),
                tier_points=as_int(rank.get("score")),
                rating=as_int(rank.get("score")),
                raw=rank,
            )
        ]

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        matches = await providers.marvel_rivals(self.runtime).get_match_history(
            ref.id, self.limit(opts.limit)
        )

        summaries = []
        for match in matches:
            player = match.get("match_player") or {}
            hero = player.get("player_hero") or {}
            summaries.append(
                MatchSummary(
                    match_id=str(match.get("match_uid") or ""),
                    title_id=self.title.id,
                    mode=as_str(match.get("game_mode_id")),
                    map=as_str(match.get("match_map_id")),
                    started_at=ts(match.get("match_time_stamp")),
                    duration_seconds=as_int(match.get("match_play_duration")),
                    result=match_result(as_int(player.get("is_win")) == 1),
                    player_stats=participant_stats(
                        kills=as_int(hero.get("kills")),
                        deaths=as_int(hero.get("deaths")),
                        assists=as_int(hero.get("assists")),
                        extra={"hero": as_str(hero.get("hero_name"))},
                    ),
                    raw=match,
                )
            )
        return summaries

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        self.require("getMatch")
        match = await providers.marvel_rivals(self.runtime).get_match(match_id)
        details = match.get("match_details") or match

        return MatchDetail(
            match_id=match_id,
            title_id=self.title.id,
            mode=as_str(details.get("game_mode_id")),
            map=as_str(details.get("match_map_id")),
            started_at=ts(details.get("match_time_stamp")),
            duration_seconds=as_int(details.get("match_play_duration")),
            teams=tuple(MatchTeam(id=str(side), name=f"Team {side + 1}") for side in (0, 1)),
            participants=tuple(
                MatchParticipant(
                    player_id=str(player.get("player_uid") or ""),
                    display_name=as_str(player.get("nick_name")),
                    team_id=as_str(player.get("camp")),
                    character=as_str((player.get("player_hero") or {}).get("hero_name")),
                    stats=participant_stats(
                        kills=as_int(player.get("kills")),
                        deaths=as_int(player.get("deaths")),
                        assists=as_int(player.get("assists")),
                        damage_dealt=as_int(player.get("total_hero_damage")),
                        healing=as_int(player.get("total_hero_heal")),
                        damage_taken=as_int(player.get("total_damage_taken")),
                    ),
                    raw=player,
                )
                for player in as_list(details.get("match_players"))
            ),
            raw=match,
        )

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        rows = await providers.marvel_rivals(self.runtime).get_leaderboard(
            opts.queue or "1011"
        )
        return [
            LeaderboardEntry(
                position=index + 1,
                player_id=as_str(row.get("player_uid")),
                display_name=as_str(row.get("nick_name")),
                rating=as_int(row.get("score")),
                tier=as_str(row.get("rank")),
                wins=as_int(row.get("wins")),
                raw=row,
            )
            for index, row in enumerate(rows[: self.limit(opts.limit, 100)])
        ]

    async def get_metadata(self, kind: str | None = None) -> Any:
        self.require("getMetadata")
        if kind not in (None, "heroes"):
            raise ValidationError(
                f'Marvel Rivals metadata "{kind}" is not available - try "heroes"'
            )
        return await providers.marvel_rivals(self.runtime).get_heroes()
