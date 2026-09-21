"""The Relic-published strategy titles: Age of Empires II DE, Age of Empires IV
and Company of Heroes 3.

All three answer to the Relic Community API, which has one property worth
knowing: **a player is found by searching a ladder, not by an id endpoint.**
There is no "get player" - you ask a leaderboard about a name and get back a stat
group. That shapes ``resolve_player`` here.

Age of Empires IV additionally has AoE4World, which is friendlier and adds
civilisation breakdowns, so it is preferred for that title.
"""

from __future__ import annotations

from typing import Any

from .. import providers
from ..errors import NotFoundError
from ..normalize import (
    as_int,
    as_list,
    as_str,
    match_result,
    mode_stats,
    participant_stats,
    player_stats,
    total,
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
    "AgeOfEmpires2Client",
    "AgeOfEmpires4Client",
    "CompanyOfHeroes3Client",
    "RelicTitleClient",
]


class RelicTitleClient(TitleClient):
    """Shared Relic behaviour for the titles that have no better provider."""

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        group = await providers.relic(self.runtime).find_player(
            self.title.id,
            name=str(parsed.name) if parsed.name else None,
            steam_id=str(parsed.steam_id) if parsed.steam_id else None,
        )
        members = as_list(group.get("members"))
        member = members[0] if members else {}

        return self.ref(
            provider_id="relic",
            id=str(member.get("profile_id") or group.get("id") or ""),
            display_name=as_str(member.get("alias")),
            platform="steam",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        response = await providers.relic(self.runtime).get_personal_stats(
            self.title.id, [ref.id]
        )
        groups = as_list(response.get("statGroups"))
        members = as_list((groups[0] if groups else {}).get("members"))
        member = members[0] if members else {}

        return PlayerProfile(
            ref=ref,
            display_name=str(member.get("alias") or ref.id),
            level=as_int(member.get("level")),
            country=as_str(member.get("country")),
            raw=response,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        response = await providers.relic(self.runtime).get_personal_stats(
            self.title.id, [ref.id]
        )
        rows = as_list(response.get("leaderboardStats"))

        modes: dict[str, ModeStats] = {
            str(row.get("leaderboard_id") or "unknown"): mode_stats(
                id=str(row.get("leaderboard_id") or "unknown"),
                wins=as_int(row.get("wins")),
                losses=as_int(row.get("losses")),
                extra={
                    "rating": as_int(row.get("rating")),
                    "rank": as_int(row.get("rank")),
                    "streak": as_int(row.get("streak")),
                    "highestRating": as_int(row.get("highestrating")),
                },
            )
            for row in rows
        }

        return player_stats(
            ref=ref,
            wins=total(as_int(row.get("wins")) for row in rows),
            losses=total(as_int(row.get("losses")) for row in rows),
            modes=modes,
            raw=response,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        response = await providers.relic(self.runtime).get_personal_stats(
            self.title.id, [ref.id]
        )
        return [
            RankInfo(
                ref=ref,
                queue=str(row.get("leaderboard_id") or "unknown"),
                rating=as_int(row.get("rating")),
                position=as_int(row.get("rank")),
                wins=as_int(row.get("wins")),
                losses=as_int(row.get("losses")),
                raw=row,
            )
            for row in as_list(response.get("leaderboardStats"))
        ]

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        matches = await providers.relic(self.runtime).get_recent_matches(
            self.title.id, [ref.id]
        )

        summaries = []
        for match in matches[: self.limit(opts.limit)]:
            members = as_list(match.get("matchhistorymember"))
            mine = next((m for m in members if str(m.get("profile_id")) == ref.id), None)
            start = as_int(match.get("startgametime"))
            end = as_int(match.get("completiontime"))
            summaries.append(
                MatchSummary(
                    match_id=str(match.get("id") or ""),
                    title_id=self.title.id,
                    mode=as_str(match.get("matchtype_id")),
                    map=as_str(match.get("mapname")),
                    started_at=ts(start),
                    duration_seconds=(
                        end - start if start is not None and end is not None else None
                    ),
                    # Relic encodes the outcome as 1 for a win and 0 for a loss.
                    result=(
                        match_result(as_int(mine.get("outcome")) == 1)
                        if mine
                        else MatchResult.UNKNOWN
                    ),
                    player_stats=(
                        participant_stats(
                            extra={
                                "civilization": as_int(mine.get("civilization_id")),
                                "oldRating": as_int(mine.get("oldrating")),
                                "newRating": as_int(mine.get("newrating")),
                            }
                        )
                        if mine
                        else None
                    ),
                    raw=match,
                )
            )
        return summaries

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        rows = await providers.relic(self.runtime).get_leaderboard(
            self.title.id,
            int(opts.queue or 3),
            count=self.limit(opts.limit, 100),
            start=(opts.offset or 0) + 1,
        )
        return [
            LeaderboardEntry(
                position=as_int(row.get("rank")) or index + 1,
                player_id=as_str(row.get("statgroup_id")),
                rating=as_int(row.get("rating")),
                wins=as_int(row.get("wins")),
                losses=as_int(row.get("losses")),
                raw=row,
            )
            for index, row in enumerate(rows)
        ]


class AgeOfEmpires2Client(RelicTitleClient):
    """Age of Empires II: Definitive Edition."""


class CompanyOfHeroes3Client(RelicTitleClient):
    """Company of Heroes 3."""


class AgeOfEmpires4Client(TitleClient):
    """Age of Empires IV.

    AoE4World rather than the raw Relic endpoints: same underlying data, but with
    civilisation breakdowns, readable leaderboard names and a real player search.
    """

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        term = str(parsed.name or parsed.steam_id or parsed.account_id or "")
        players = await providers.aoe4world(self.runtime).search_players(term)
        exact = next(
            (p for p in players if str(p.get("name", "")).lower() == term.lower()),
            players[0] if players else None,
        )
        if not exact:
            raise NotFoundError("aoe4world", f'AoE4 player "{term}"', self.title.id)

        return self.ref(
            provider_id="aoe4world",
            id=str(exact.get("profile_id") or ""),
            display_name=as_str(exact.get("name")),
            platform="steam",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        player = await providers.aoe4world(self.runtime).get_player(ref.id)
        return PlayerProfile(
            ref=ref,
            display_name=str(player.get("name") or ref.id),
            avatar_url=as_str((player.get("avatars") or {}).get("medium")),
            profile_url=f"https://aoe4world.com/players/{ref.id}",
            last_seen_at=ts(player.get("last_game_at")),
            country=as_str(player.get("country")),
            raw=player,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        player = await providers.aoe4world(self.runtime).get_player(ref.id)
        raw_modes = player.get("modes") or {}

        modes: dict[str, ModeStats] = {
            identifier: mode_stats(
                id=identifier,
                matches_played=as_int(data.get("games_count")),
                wins=as_int(data.get("wins_count")),
                losses=as_int(data.get("losses_count")),
                extra={
                    "rating": as_int(data.get("rating")),
                    "maxRating": as_int(data.get("max_rating")),
                    "rank": as_int(data.get("rank")),
                    "streak": as_int(data.get("streak")),
                },
            )
            for identifier, data in raw_modes.items()
            if isinstance(data, dict)
        }

        return player_stats(
            ref=ref,
            matches_played=total(mode.matches_played for mode in modes.values()),
            wins=total(mode.wins for mode in modes.values()),
            losses=total(mode.losses for mode in modes.values()),
            modes=modes,
            raw=player,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        player = await providers.aoe4world(self.runtime).get_player(ref.id)
        return [
            RankInfo(
                ref=ref,
                queue=queue,
                tier=as_str(data.get("rank_level")),
                rating=as_int(data.get("rating")),
                position=as_int(data.get("rank")),
                wins=as_int(data.get("wins_count")),
                losses=as_int(data.get("losses_count")),
                season=as_str(data.get("season")),
                raw=data,
            )
            for queue, data in (player.get("modes") or {}).items()
            if isinstance(data, dict)
        ]

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        games = await providers.aoe4world(self.runtime).get_games(
            ref.id, limit=self.limit(opts.limit), leaderboard=opts.mode
        )

        summaries = []
        for game in games:
            mine = None
            for team in as_list(game.get("teams")):
                for entry in as_list(team):
                    player = entry.get("player") or entry
                    if str(player.get("profile_id")) == ref.id:
                        mine = player
                        break
                if mine:
                    break
            outcome = as_str((mine or {}).get("result"))
            summaries.append(
                MatchSummary(
                    match_id=str(game.get("game_id") or ""),
                    title_id=self.title.id,
                    mode=as_str(game.get("leaderboard") or game.get("kind")),
                    map=as_str(game.get("map")),
                    started_at=ts(game.get("started_at")),
                    duration_seconds=as_int(game.get("duration")),
                    result=(
                        match_result(outcome == "win", outcome == "draw")
                        if mine
                        else MatchResult.UNKNOWN
                    ),
                    player_stats=(
                        participant_stats(
                            extra={
                                "civilization": as_str(mine.get("civilization")),
                                "rating": as_int(mine.get("rating")),
                                "ratingDiff": as_int(mine.get("rating_diff")),
                            }
                        )
                        if mine
                        else None
                    ),
                    raw=game,
                )
            )
        return summaries

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        self.require("getMatch")
        game = await providers.aoe4world(self.runtime).get_game(match_id)
        teams = as_list(game.get("teams"))

        return MatchDetail(
            match_id=match_id,
            title_id=self.title.id,
            mode=as_str(game.get("leaderboard") or game.get("kind")),
            map=as_str(game.get("map")),
            started_at=ts(game.get("started_at")),
            duration_seconds=as_int(game.get("duration")),
            patch=as_str(game.get("patch")),
            teams=tuple(
                MatchTeam(
                    id=str(index),
                    name=f"Team {index + 1}",
                    won=(
                        as_str(
                            (
                                (as_list(team)[0] if as_list(team) else {}).get("player")
                                or (as_list(team)[0] if as_list(team) else {})
                            ).get("result")
                        )
                        == "win"
                    ),
                )
                for index, team in enumerate(teams)
            ),
            participants=tuple(
                MatchParticipant(
                    player_id=str((entry.get("player") or entry).get("profile_id") or ""),
                    display_name=as_str((entry.get("player") or entry).get("name")),
                    team_id=str(index),
                    character=as_str((entry.get("player") or entry).get("civilization")),
                    stats=participant_stats(
                        extra={
                            "rating": as_int((entry.get("player") or entry).get("rating")),
                            "ratingDiff": as_int(
                                (entry.get("player") or entry).get("rating_diff")
                            ),
                            "result": as_str((entry.get("player") or entry).get("result")),
                        }
                    ),
                    raw=entry,
                )
                for index, team in enumerate(teams)
                for entry in as_list(team)
            ),
            raw=game,
        )

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        players = await providers.aoe4world(self.runtime).get_leaderboard(
            opts.queue or "rm_solo",
            page=(opts.offset // 50 + 1) if opts.offset else 1,
        )
        return [
            LeaderboardEntry(
                position=as_int(player.get("rank")) or index + 1,
                player_id=as_str(player.get("profile_id")),
                display_name=as_str(player.get("name")),
                rating=as_int(player.get("rating")),
                tier=as_str(player.get("rank_level")),
                wins=as_int(player.get("wins_count")),
                losses=as_int(player.get("losses_count")),
                country=as_str(player.get("country")),
                raw=player,
            )
            for index, player in enumerate(players[: self.limit(opts.limit, 100)])
        ]
