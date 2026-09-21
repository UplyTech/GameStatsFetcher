"""Riot's titles: League of Legends, Teamfight Tactics, VALORANT and Legends of
Runeterra.

The PUUID is the unit of identity across all four, and it never changes - which
is why ``resolve_player`` is cached for a day and why a stored
:class:`PlayerRef` stays valid after a rename. The Riot ID a user types does not
have that property.
"""

from __future__ import annotations

import asyncio
from typing import Any

from .. import providers
from ..errors import NotFoundError, ValidationError
from ..identity import expand_riot_query
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
    MatchDetail,
    MatchHistoryOptions,
    MatchParticipant,
    MatchResult,
    MatchRound,
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
    "LeagueOfLegendsClient",
    "TeamfightTacticsClient",
    "ValorantClient",
    "LegendsOfRuneterraClient",
]

#: Riot's tier ladder, lowest first. Shared by League and TFT.
_TIER_ORDER = (
    "IRON",
    "BRONZE",
    "SILVER",
    "GOLD",
    "PLATINUM",
    "EMERALD",
    "DIAMOND",
    "MASTER",
    "GRANDMASTER",
    "CHALLENGER",
)


def _pretty_tier(tier: str | None) -> str | None:
    """Title case for display: ``GRANDMASTER`` becomes ``Grandmaster``."""
    if not tier:
        return None
    return tier[0] + tier[1:].lower()


def _tier_percentile(tier: str | None) -> int | None:
    """Where a tier sits on the ladder, in permille of the way to the top.

    A rough figure by construction - Riot publishes no distribution - so it is an
    ordinal position on the tier list rather than a real population percentile.
    """
    if not tier:
        return None
    try:
        index = _TIER_ORDER.index(tier.upper())
    except ValueError:
        return None
    return round((len(_TIER_ORDER) - index) / len(_TIER_ORDER) * 1_000)


class _RiotTitleClient(TitleClient):
    """Shared resolution: Riot ID or PUUID to a :class:`PlayerRef`."""

    def default_platform(self) -> str:
        return "euw1"

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        expanded = expand_riot_query(as_query(query))
        self.require_identifier(expanded)

        platform = expanded.region or self.default_platform()
        riot = providers.riot(self.runtime)

        if expanded.puuid:
            account = await riot.get_account_by_puuid(expanded.puuid, platform, self.title.id)
            name = account.get("gameName")
            return self.ref(
                provider_id="riot",
                id=str(account["puuid"]),
                display_name=(f"{name}#{account.get('tagLine') or ''}" if name else None),
                platform="riot",
                region=platform,
            )

        if not expanded.game_name or not expanded.tag_line:
            raise ValidationError(
                f"{self.title.id} needs a Riot ID - pass game_name and tag_line, "
                'or name as "Name#Tag"'
            )
        account = await riot.get_account_by_riot_id(
            expanded.game_name, expanded.tag_line, platform, self.title.id
        )
        return self.ref(
            provider_id="riot",
            id=str(account["puuid"]),
            display_name=(
                f"{account.get('gameName') or expanded.game_name}"
                f"#{account.get('tagLine') or expanded.tag_line}"
            ),
            platform="riot",
            region=platform,
        )


class LeagueOfLegendsClient(_RiotTitleClient):
    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        platform = ref.region or self.default_platform()
        riot = providers.riot(self.runtime)

        async def account_or_empty() -> dict[str, Any]:
            # A missing Riot ID is normal for an account that never set one, and
            # it must not take the whole profile down with it. The mirror of the
            # TypeScript edition's `.catch(() => null)` on the same call.
            try:
                return await riot.get_account_by_puuid(ref.id, platform, self.title.id)
            except NotFoundError:
                return {}

        # Two calls to two different hosts that need nothing from each other:
        # the summoner comes from the platform host, the Riot ID from the
        # regional cluster. One after the other they cost the sum of two round
        # trips for no reason.
        summoner, account = await asyncio.gather(
            riot.get_summoner_by_puuid(ref.id, platform),
            account_or_empty(),
        )

        name = account.get("gameName")
        return PlayerProfile(
            ref=ref,
            display_name=(
                f"{name}#{account.get('tagLine') or ''}"
                if name
                else (ref.display_name or ref.id)
            ),
            level=as_int(summoner.get("summonerLevel")),
            avatar_url=(
                "https://ddragon.leagueoflegends.com/cdn/14.1.1/img/profileicon/"
                f"{summoner.get('profileIconId')}.png"
            ),
            last_seen_at=ts(summoner.get("revisionDate")),
            raw={"summoner": summoner, "account": account},
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        """Career statistics derived from ranked entries.

        Riot publishes no lifetime totals, so wins and losses here are this
        split's ranked games. That is a real limitation of the API rather than of
        this package, and ``raw`` carries the per-queue rows so a caller can be
        precise.
        """
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        platform = ref.region or self.default_platform()
        entries = await providers.riot(self.runtime).get_league_entries(ref.id, platform)

        modes: dict[str, ModeStats] = {
            entry["queueType"]: mode_stats(
                id=entry["queueType"],
                wins=as_int(entry.get("wins")),
                losses=as_int(entry.get("losses")),
                extra={
                    "tier": entry.get("tier"),
                    "rank": entry.get("rank"),
                    "leaguePoints": entry.get("leaguePoints"),
                },
            )
            for entry in entries
        }
        solo = next((e for e in entries if e.get("queueType") == "RANKED_SOLO_5x5"), None)
        return player_stats(
            ref=ref,
            wins=as_int((solo or {}).get("wins")),
            losses=as_int((solo or {}).get("losses")),
            modes=modes,
            raw=entries,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        platform = ref.region or self.default_platform()
        entries = await providers.riot(self.runtime).get_league_entries(ref.id, platform)

        return [
            RankInfo(
                ref=ref,
                queue=str(entry.get("queueType") or "unknown"),
                tier=_pretty_tier(entry.get("tier")),
                division=as_str(entry.get("rank")),
                tier_points=as_int(entry.get("leaguePoints")),
                percentile_permille=_tier_percentile(entry.get("tier")),
                wins=as_int(entry.get("wins")),
                losses=as_int(entry.get("losses")),
                raw=entry,
            )
            for entry in entries
        ]

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        platform = ref.region or self.default_platform()
        riot = providers.riot(self.runtime)

        ids = await riot.get_match_ids(
            ref.id,
            platform,
            count=self.limit(opts.limit),
            start=opts.offset or 0,
            start_time=opts.since,
            end_time=opts.until,
            type_=opts.mode,
        )

        # Riot's list endpoint returns ids only, so every summary costs one call.
        # Sequential rather than concurrent: twenty parallel requests is exactly
        # how a development key hits its 100-per-two-minutes limit.
        summaries = []
        for match_id in ids:
            match = await riot.get_match(match_id, platform)
            summaries.append(self._to_summary(match, ref.id))
        return summaries

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        self.require("getMatch")
        platform = (context.region if context else None) or self.default_platform()
        match = await providers.riot(self.runtime).get_match(match_id, platform)
        info = match.get("info") or {}
        participants = as_list(info.get("participants"))
        teams = as_list(info.get("teams"))
        summary = self._to_summary(match, context.id if context else None)

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
            patch=as_str(info.get("gameVersion")),
            teams=tuple(
                MatchTeam(
                    id=str(team.get("teamId") or ""),
                    name="Blue" if as_int(team.get("teamId")) == 100 else "Red",
                    won=team.get("win") is True,
                    score=as_int(
                        ((team.get("objectives") or {}).get("champion") or {}).get("kills")
                    ),
                )
                for team in teams
            ),
            participants=tuple(
                MatchParticipant(
                    player_id=str(entry.get("puuid") or ""),
                    display_name=as_str(entry.get("riotIdGameName"))
                    or as_str(entry.get("summonerName")),
                    team_id=as_str(entry.get("teamId")),
                    character=as_str(entry.get("championName")),
                    stats=participant_stats(
                        kills=as_int(entry.get("kills")),
                        deaths=as_int(entry.get("deaths")),
                        assists=as_int(entry.get("assists")),
                        damage_dealt=as_int(entry.get("totalDamageDealtToChampions")),
                        damage_taken=as_int(entry.get("totalDamageTaken")),
                        healing=as_int(entry.get("totalHeal")),
                        extra={
                            "championId": as_int(entry.get("championId")),
                            "champLevel": as_int(entry.get("champLevel")),
                            "goldEarned": as_int(entry.get("goldEarned")),
                            "cs": (as_int(entry.get("totalMinionsKilled")) or 0)
                            + (as_int(entry.get("neutralMinionsKilled")) or 0),
                            "visionScore": as_int(entry.get("visionScore")),
                            "role": as_str(entry.get("teamPosition")),
                        },
                    ),
                    raw=entry,
                )
                for entry in participants
            ),
        )

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        """Ladder: the Challenger tier, which is the one Riot publishes whole."""
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        platform = opts.region or self.default_platform()
        league = await providers.riot(self.runtime).get_apex_league(
            "challenger", opts.queue or "RANKED_SOLO_5x5", platform
        )
        entries = sorted(
            (league or {}).get("entries") or [],
            key=lambda entry: entry.get("leaguePoints", 0),
            reverse=True,
        )
        return [
            LeaderboardEntry(
                position=index + 1,
                player_id=as_str(entry.get("puuid") or entry.get("summonerId")),
                rating=as_int(entry.get("leaguePoints")),
                tier="Challenger",
                wins=as_int(entry.get("wins")),
                losses=as_int(entry.get("losses")),
                raw=entry,
            )
            for index, entry in enumerate(entries[: self.limit(opts.limit, 100)])
        ]

    async def get_metadata(self, kind: str | None = None) -> Any:
        self.require("getMetadata")
        if kind not in (None, "rotation"):
            raise ValidationError(
                f'League metadata "{kind}" is not available - try "rotation"'
            )
        return await providers.riot(self.runtime).get_champion_rotation(
            self.default_platform()
        )

    def _to_summary(self, match: dict[str, Any], puuid: str | None) -> MatchSummary:
        """Turn a Match-v5 payload into a summary from one player's perspective."""
        info = match.get("info") or {}
        metadata = match.get("metadata") or {}
        participants = as_list(info.get("participants"))
        mine = (
            next((p for p in participants if p.get("puuid") == puuid), None) if puuid else None
        )

        return MatchSummary(
            match_id=str(metadata.get("matchId") or ""),
            title_id=self.title.id,
            mode=as_str(info.get("gameMode")),
            map=as_str(info.get("mapId")),
            started_at=ts(info.get("gameStartTimestamp") or info.get("gameCreation")),
            duration_seconds=as_int(info.get("gameDuration")),
            result=match_result(mine.get("win")) if mine else MatchResult.UNKNOWN,
            player_stats=(
                participant_stats(
                    kills=as_int(mine.get("kills")),
                    deaths=as_int(mine.get("deaths")),
                    assists=as_int(mine.get("assists")),
                    damage_dealt=as_int(mine.get("totalDamageDealtToChampions")),
                    damage_taken=as_int(mine.get("totalDamageTaken")),
                    healing=as_int(mine.get("totalHeal")),
                    extra={
                        "champion": as_str(mine.get("championName")),
                        "cs": (as_int(mine.get("totalMinionsKilled")) or 0)
                        + (as_int(mine.get("neutralMinionsKilled")) or 0),
                        "goldEarned": as_int(mine.get("goldEarned")),
                        "visionScore": as_int(mine.get("visionScore")),
                    },
                )
                if mine
                else None
            ),
            raw=match,
        )


class TeamfightTacticsClient(_RiotTitleClient):
    """Teamfight Tactics.

    The one title here where placement matters more than win or loss: a top-four
    finish is a win in TFT's own accounting, and that is what ``result`` reports.
    """

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        platform = ref.region or self.default_platform()
        summoner = await providers.riot(self.runtime).get_tft_summoner(ref.id, platform)
        return PlayerProfile(
            ref=ref,
            display_name=ref.display_name or ref.id,
            level=as_int(summoner.get("summonerLevel")),
            last_seen_at=ts(summoner.get("revisionDate")),
            raw=summoner,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        platform = ref.region or self.default_platform()
        entries = await providers.riot(self.runtime).get_tft_league_entries(ref.id, platform)
        ranked = next(
            (e for e in entries if e.get("queueType") == "RANKED_TFT"),
            entries[0] if entries else None,
        )

        return player_stats(
            ref=ref,
            wins=as_int((ranked or {}).get("wins")),
            losses=as_int((ranked or {}).get("losses")),
            modes={
                entry["queueType"]: mode_stats(
                    id=entry["queueType"],
                    wins=as_int(entry.get("wins")),
                    losses=as_int(entry.get("losses")),
                    extra={
                        "tier": entry.get("tier"),
                        "rank": entry.get("rank"),
                        "lp": entry.get("leaguePoints"),
                    },
                )
                for entry in entries
            },
            raw=entries,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        platform = ref.region or self.default_platform()
        entries = await providers.riot(self.runtime).get_tft_league_entries(ref.id, platform)
        return [
            RankInfo(
                ref=ref,
                queue=str(entry.get("queueType") or "unknown"),
                tier=_pretty_tier(entry.get("tier")),
                division=as_str(entry.get("rank")),
                tier_points=as_int(entry.get("leaguePoints")),
                percentile_permille=_tier_percentile(entry.get("tier")),
                wins=as_int(entry.get("wins")),
                losses=as_int(entry.get("losses")),
                raw=entry,
            )
            for entry in entries
        ]

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        platform = ref.region or self.default_platform()
        riot = providers.riot(self.runtime)
        ids = await riot.get_tft_match_ids(
            ref.id, platform, count=self.limit(opts.limit), start=opts.offset or 0
        )

        summaries = []
        for match_id in ids:
            match = await riot.get_tft_match(match_id, platform)
            summaries.append(self._to_summary(match, ref.id))
        return summaries

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        self.require("getMatch")
        platform = (context.region if context else None) or self.default_platform()
        match = await providers.riot(self.runtime).get_tft_match(match_id, platform)
        info = match.get("info") or {}
        participants = as_list(info.get("participants"))
        summary = self._to_summary(match, context.id if context else None)

        return MatchDetail(
            match_id=summary.match_id,
            title_id=summary.title_id,
            mode=summary.mode,
            started_at=summary.started_at,
            duration_seconds=summary.duration_seconds,
            result=summary.result,
            player_stats=summary.player_stats,
            raw=summary.raw,
            patch=as_str(info.get("game_version")),
            participants=tuple(
                MatchParticipant(
                    player_id=str(entry.get("puuid") or ""),
                    stats=participant_stats(
                        placement=as_int(entry.get("placement")),
                        extra={
                            "level": as_int(entry.get("level")),
                            "goldLeft": as_int(entry.get("gold_left")),
                            "playersEliminated": as_int(entry.get("players_eliminated")),
                            "damageToPlayers": as_int(entry.get("total_damage_to_players")),
                            "timeAlive": as_int(entry.get("time_eliminated")),
                        },
                    ),
                    raw=entry,
                )
                for entry in participants
            ),
        )

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        platform = opts.region or self.default_platform()
        league = await providers.riot(self.runtime).get_tft_apex_league("challenger", platform)
        entries = sorted(
            (league or {}).get("entries") or [],
            key=lambda entry: entry.get("leaguePoints", 0),
            reverse=True,
        )
        return [
            LeaderboardEntry(
                position=index + 1,
                player_id=as_str(entry.get("puuid") or entry.get("summonerId")),
                rating=as_int(entry.get("leaguePoints")),
                tier="Challenger",
                wins=as_int(entry.get("wins")),
                losses=as_int(entry.get("losses")),
                raw=entry,
            )
            for index, entry in enumerate(entries[: self.limit(opts.limit, 100)])
        ]

    def _to_summary(self, match: dict[str, Any], puuid: str | None) -> MatchSummary:
        info = match.get("info") or {}
        metadata = match.get("metadata") or {}
        participants = as_list(info.get("participants"))
        mine = (
            next((p for p in participants if p.get("puuid") == puuid), None) if puuid else None
        )
        placement = as_int((mine or {}).get("placement"))

        return MatchSummary(
            match_id=str(metadata.get("match_id") or ""),
            title_id=self.title.id,
            mode=as_str(info.get("tft_game_type")) or "standard",
            started_at=ts(info.get("game_datetime")),
            duration_seconds=as_int(info.get("game_length")),
            # In TFT a top-four finish is the win condition, not first place.
            result=(
                MatchResult.UNKNOWN
                if placement is None
                else MatchResult.WIN
                if placement <= 4
                else MatchResult.LOSS
            ),
            player_stats=(
                participant_stats(
                    placement=placement,
                    extra={
                        "level": as_int(mine.get("level")),
                        "goldLeft": as_int(mine.get("gold_left")),
                        "playersEliminated": as_int(mine.get("players_eliminated")),
                    },
                )
                if mine
                else None
            ),
            raw=match,
        )


class ValorantClient(TitleClient):
    """VALORANT.

    Riot's own VAL endpoints need an approved production key, so this client
    prefers HenrikDev when only a development key is configured. Which one
    answered is on ``PlayerRef.provider_id``, so a caller can tell.
    """

    def default_region(self) -> str:
        return "eu"

    def _use_henrik(self) -> bool:
        """True when the caller has a HenrikDev key, which is the richer path."""
        return providers.henrikdev(self.runtime).has_credentials()

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        expanded = expand_riot_query(as_query(query))
        self.require_identifier(expanded)
        region = self.region(expanded.region, self.default_region())

        if self._use_henrik():
            henrik = providers.henrikdev(self.runtime)
            account = (
                await henrik.get_account_by_puuid(expanded.puuid)
                if expanded.puuid
                else await henrik.get_account(str(expanded.game_name), str(expanded.tag_line))
            )
            return self.ref(
                provider_id="henrikdev",
                id=str(account["puuid"]),
                display_name=f"{account.get('name')}#{account.get('tag')}",
                platform="riot",
                region=str(account.get("region") or region),
            )

        riot = providers.riot(self.runtime)
        # VALORANT's shards are not Riot platform hosts, so the account lookup
        # goes through the regional cluster and the shard is carried separately.
        cluster = "americas" if region in ("na", "br", "latam") else "europe"
        if expanded.puuid:
            account = await riot.get_account_by_puuid(expanded.puuid, cluster, self.title.id)
        else:
            if not expanded.game_name or not expanded.tag_line:
                raise ValidationError('VALORANT needs a Riot ID - pass name as "Name#Tag"')
            account = await riot.get_account_by_riot_id(
                expanded.game_name, expanded.tag_line, cluster, self.title.id
            )
        name = account.get("gameName")
        return self.ref(
            provider_id="riot",
            id=str(account["puuid"]),
            display_name=f"{name}#{account.get('tagLine')}" if name else None,
            platform="riot",
            region=region,
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        if ref.provider_id != "henrikdev":
            # Riot's own API has no VALORANT profile endpoint at all; the account
            # record is everything there is.
            return PlayerProfile(
                ref=ref,
                display_name=ref.display_name or ref.id,
                raw={"note": "Riot publishes no VALORANT profile endpoint"},
            )
        account = await providers.henrikdev(self.runtime).get_account_by_puuid(ref.id)
        return PlayerProfile(
            ref=ref,
            display_name=f"{account.get('name')}#{account.get('tag')}",
            level=as_int(account.get("account_level")),
            avatar_url=as_str((account.get("card") or {}).get("small")),
            last_seen_at=ts(account.get("last_update_raw")),
            raw=account,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        """Career statistics derived from the recent matches the API returns.

        Riot exposes no VALORANT career totals, so the window is stated in
        ``raw`` and a caller cannot mistake it for a lifetime figure.
        """
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        matches = await self.get_match_history(ref, MatchHistoryOptions(limit=10))

        wins = sum(1 for match in matches if match.result is MatchResult.WIN)
        losses = sum(1 for match in matches if match.result is MatchResult.LOSS)
        return player_stats(
            ref=ref,
            matches_played=len(matches),
            wins=wins,
            losses=losses,
            kills=sum((m.player_stats.kills or 0) if m.player_stats else 0 for m in matches),
            deaths=sum((m.player_stats.deaths or 0) if m.player_stats else 0 for m in matches),
            assists=sum(
                (m.player_stats.assists or 0) if m.player_stats else 0 for m in matches
            ),
            raw={"window": "last 10 matches", "matches": [m.raw for m in matches]},
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        if ref.provider_id != "henrikdev":
            raise NotFoundError(
                "riot",
                "VALORANT rank (Riot's ranked endpoints need an approved "
                "production key - configure api_keys.henrikdev instead)",
                self.title.id,
            )
        mmr = await providers.henrikdev(self.runtime).get_mmr(
            ref.region or self.default_region(), ref.id
        )
        current = mmr.get("current_data")
        if not current:
            return []
        return [
            RankInfo(
                ref=ref,
                queue="competitive",
                tier=as_str(current.get("currenttierpatched")),
                tier_points=as_int(current.get("ranking_in_tier")),
                rating=as_int(current.get("elo")),
                raw=mmr,
            )
        ]

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        region = ref.region or self.default_region()

        if ref.provider_id == "henrikdev":
            matches = await providers.henrikdev(self.runtime).get_matches(
                region, ref.id, size=self.limit(opts.limit, 10), mode=opts.mode
            )
            return [self._from_henrik(match, ref.id) for match in matches]

        riot = providers.riot(self.runtime)
        listing = await riot.get_valorant_match_list(ref.id, region)
        summaries = []
        for entry in listing[: self.limit(opts.limit)]:
            match = await riot.get_valorant_match(entry["matchId"], region)
            summaries.append(self._from_riot(match, ref.id))
        return summaries

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        self.require("getMatch")
        region = (context.region if context else None) or self.default_region()
        raw = (
            await providers.henrikdev(self.runtime).get_match(match_id)
            if self._use_henrik()
            else await providers.riot(self.runtime).get_valorant_match(match_id, region)
        )

        # The two providers disagree about the envelope: HenrikDev nests metadata
        # and players, Riot uses matchInfo and players. Both are handled.
        metadata = raw.get("metadata") or raw.get("matchInfo") or {}
        players_node = raw.get("players")
        players = (
            players_node
            if isinstance(players_node, list)
            else as_list((players_node or {}).get("all_players"))
        )
        teams_node = raw.get("teams") or {}
        length_ms = as_int(metadata.get("game_length") or metadata.get("gameLengthMillis"))

        return MatchDetail(
            match_id=match_id,
            title_id=self.title.id,
            mode=as_str(metadata.get("mode") or metadata.get("gameMode")),
            map=as_str(metadata.get("map") or metadata.get("mapId")),
            started_at=ts(metadata.get("game_start") or metadata.get("gameStartMillis")),
            duration_seconds=None if length_ms is None else round(length_ms / 1_000),
            teams=tuple(
                MatchTeam(
                    id=team_id,
                    name=team_id,
                    won=team.get("has_won") is True,
                    score=as_int(team.get("rounds_won")),
                    rounds_won=as_int(team.get("rounds_won")),
                )
                for team_id, team in (
                    teams_node.items() if isinstance(teams_node, dict) else []
                )
            ),
            participants=tuple(
                MatchParticipant(
                    player_id=str(player.get("puuid") or ""),
                    display_name=(
                        f"{player.get('name')}#{player.get('tag') or ''}"
                        if player.get("name")
                        else None
                    ),
                    team_id=as_str(player.get("team") or player.get("teamId")),
                    character=as_str(player.get("character") or player.get("characterId")),
                    stats=participant_stats(
                        kills=_val_stat(player, "kills"),
                        deaths=_val_stat(player, "deaths"),
                        assists=_val_stat(player, "assists"),
                        score=_val_stat(player, "score"),
                        extra={
                            "headshots": _val_stat(player, "headshots"),
                            "bodyshots": _val_stat(player, "bodyshots"),
                            "legshots": _val_stat(player, "legshots"),
                            "rank": as_str(player.get("currenttier_patched")),
                        },
                    ),
                    raw=player,
                )
                for player in players
            ),
            rounds=tuple(
                MatchRound(
                    index=index,
                    winning_team_id=as_str(one_round.get("winning_team")),
                    raw=one_round,
                )
                for index, one_round in enumerate(as_list(raw.get("rounds")))
            ),
            raw=raw,
        )

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        region = self.region(opts.region, self.default_region())
        if not self._use_henrik():
            raise NotFoundError(
                "riot",
                "VALORANT leaderboard (needs an approved production key, or "
                "configure api_keys.henrikdev)",
                self.title.id,
            )
        rows = await providers.henrikdev(self.runtime).get_leaderboard(
            region,
            size=self.limit(opts.limit, 100),
            start_index=opts.offset or 0,
            season=opts.season,
        )
        return [
            LeaderboardEntry(
                position=as_int(row.get("leaderboardRank")) or index + 1,
                player_id=as_str(row.get("puuid")),
                display_name=(
                    f"{row.get('gameName')}#{row.get('tagLine') or ''}"
                    if row.get("gameName")
                    else None
                ),
                rating=as_int(row.get("rankedRating")),
                wins=as_int(row.get("numberOfWins")),
                raw=row,
            )
            for index, row in enumerate(rows)
        ]

    async def get_metadata(self, kind: str | None = None) -> Any:
        self.require("getMetadata")
        if kind not in (None, "content"):
            raise ValidationError(
                f'VALORANT metadata "{kind}" is not available - try "content"'
            )
        if self._use_henrik():
            return await providers.henrikdev(self.runtime).get_content()
        return await providers.riot(self.runtime).get_valorant_content(self.default_region())

    def _from_henrik(self, match: dict[str, Any], puuid: str) -> MatchSummary:
        metadata = match.get("metadata") or {}
        all_players = as_list((match.get("players") or {}).get("all_players"))
        mine = next((p for p in all_players if p.get("puuid") == puuid), None)
        teams = match.get("teams") or {}
        my_team = as_str((mine or {}).get("team"))
        won = teams.get(my_team.lower(), {}).get("has_won") if my_team else None
        length_ms = as_int(metadata.get("game_length"))
        stats = (mine or {}).get("stats") or {}

        return MatchSummary(
            match_id=str(metadata.get("matchid") or ""),
            title_id=self.title.id,
            mode=as_str(metadata.get("mode")),
            map=as_str(metadata.get("map")),
            started_at=ts(metadata.get("game_start")),
            duration_seconds=None if length_ms is None else round(length_ms / 1_000),
            result=MatchResult.UNKNOWN if won is None else match_result(won),
            player_stats=(
                participant_stats(
                    kills=as_int(stats.get("kills")),
                    deaths=as_int(stats.get("deaths")),
                    assists=as_int(stats.get("assists")),
                    score=as_int(stats.get("score")),
                    extra={
                        "agent": as_str(mine.get("character")),
                        "headshots": as_int(stats.get("headshots")),
                        "rank": as_str(mine.get("currenttier_patched")),
                    },
                )
                if mine
                else None
            ),
            raw=match,
        )

    def _from_riot(self, match: dict[str, Any], puuid: str) -> MatchSummary:
        info = match.get("matchInfo") or {}
        players = as_list(match.get("players"))
        mine = next((p for p in players if p.get("puuid") == puuid), None)
        teams = as_list(match.get("teams"))
        my_team = next(
            (t for t in teams if t.get("teamId") == (mine or {}).get("teamId")), None
        )
        length_ms = as_int(info.get("gameLengthMillis"))

        return MatchSummary(
            match_id=str(info.get("matchId") or ""),
            title_id=self.title.id,
            mode=as_str(info.get("queueId") or info.get("gameMode")),
            map=as_str(info.get("mapId")),
            started_at=ts(info.get("gameStartMillis")),
            duration_seconds=None if length_ms is None else round(length_ms / 1_000),
            result=(match_result(my_team.get("won")) if my_team else MatchResult.UNKNOWN),
            player_stats=(
                participant_stats(
                    kills=_val_stat(mine, "kills"),
                    deaths=_val_stat(mine, "deaths"),
                    assists=_val_stat(mine, "assists"),
                    score=_val_stat(mine, "score"),
                    extra={"agent": as_str(mine.get("characterId"))},
                )
                if mine
                else None
            ),
            raw=match,
        )


class LegendsOfRuneterraClient(_RiotTitleClient):
    """Legends of Runeterra.

    Riot's LoR API has a ladder and match ids and nothing else - no profile, no
    statistics. The title declares only what exists, so ``get_player`` is absent
    rather than returning a hollow object.
    """

    def default_platform(self) -> str:
        return "europe"

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        routing = ref.region or self.default_platform()
        board = await providers.riot(self.runtime).get_lor_leaderboard(routing)
        name = (ref.display_name or "").split("#")[0].lower()
        row = next(
            (entry for entry in board if str(entry.get("name", "")).lower() == name),
            None,
        )
        if not row:
            return []
        return [
            RankInfo(
                ref=ref,
                queue="ranked",
                tier="Master",
                tier_points=as_int(row.get("lp")),
                rating=as_int(row.get("lp")),
                position=as_int(row.get("rank")),
                raw=row,
            )
        ]

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        routing = opts.region or self.default_platform()
        board = await providers.riot(self.runtime).get_lor_leaderboard(routing)
        return [
            LeaderboardEntry(
                position=as_int(row.get("rank")) or 0,
                display_name=as_str(row.get("name")),
                rating=as_int(row.get("lp")),
                tier="Master",
                raw=row,
            )
            for row in board[: self.limit(opts.limit, 100)]
        ]


def _val_stat(player: dict[str, Any] | None, key: str) -> int | None:
    """Read a VALORANT stat that may be a number or a ``{value}`` wrapper."""
    stats = (player or {}).get("stats") or {}
    value = stats.get(key)
    if isinstance(value, dict):
        return as_int(value.get("value"))
    return as_int(value)
