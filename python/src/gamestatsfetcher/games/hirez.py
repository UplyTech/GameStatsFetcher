"""SMITE and Paladins.

One provider, one schema, two titles. The only real difference is the word for a
character - gods in SMITE, champions in Paladins - so the shared base below
parameterises that and nothing else.

Hi-Rez names are not unique across platforms, so ``resolve_player`` prefers an
exact PC match and otherwise takes the first result rather than guessing between
a console and a PC account with the same name.
"""

from __future__ import annotations

import asyncio
from typing import Any

from .. import providers
from ..errors import NotFoundError
from ..normalize import (
    as_int,
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
    MatchSummary,
    MatchTeam,
    ModeStats,
    PlayerProfile,
    PlayerQuery,
    PlayerRef,
    PlayerStats,
    RankInfo,
)

__all__ = ["SmiteClient", "PaladinsClient"]


class _HiRezTitleClient(TitleClient):
    def game(self) -> str:
        raise NotImplementedError

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        name = str(parsed.name or parsed.account_id or "")
        hirez = providers.hirez(self.runtime)

        # A console and a PC player can share a name. Portal 5 is PC (Hi-Rez),
        # and preferring it is the least surprising default for a stats lookup.
        candidates = await hirez.get_player_id_by_name(self.game(), name)
        chosen = next(
            (row for row in candidates if row.get("portal_id") == "5"),
            candidates[0] if candidates else None,
        )
        identifier = str((chosen or {}).get("player_id") or name)

        player = await hirez.get_player(self.game(), identifier)
        return self.ref(
            provider_id="hirez",
            id=str(player.get("Id") or identifier),
            display_name=as_str(player.get("hz_player_name") or player.get("Name")) or name,
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        player = await providers.hirez(self.runtime).get_player(self.game(), ref.id)
        return PlayerProfile(
            ref=ref,
            display_name=str(player.get("hz_player_name") or player.get("Name") or ref.id),
            level=as_int(player.get("Level")),
            created_at=ts(player.get("Created_Datetime")),
            last_seen_at=ts(player.get("Last_Login_Datetime")),
            clan=as_str(player.get("Team_Name")),
            raw=player,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        hirez = providers.hirez(self.runtime)
        # The account and the per-character ranks are two sessions' worth of
        # work at Hi-Rez's end and nothing at ours; asking for both at once
        # halves the wall-clock cost of a profile page.
        player, characters = await asyncio.gather(
            hirez.get_player(self.game(), ref.id),
            hirez.get_player_character_ranks(self.game(), ref.id),
        )

        modes: dict[str, ModeStats] = {}
        for row in characters:
            identifier = str(
                row.get("god")
                or row.get("champion")
                or row.get("god_id")
                or row.get("champion_id")
                or "unknown"
            )
            modes[identifier] = mode_stats(
                id=identifier,
                wins=as_int(row.get("Wins")),
                losses=as_int(row.get("Losses")),
                kills=as_int(row.get("Kills")),
                deaths=as_int(row.get("Deaths")),
                assists=as_int(row.get("Assists")),
                extra={
                    "rank": as_int(row.get("Rank")),
                    "worshippers": as_int(row.get("Worshippers")),
                },
            )

        return player_stats(
            ref=ref,
            wins=as_int(player.get("Wins")),
            losses=as_int(player.get("Losses")),
            modes=modes,
            raw={"player": player, "characters": characters},
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        """One rank per ranked queue: conquest, joust, duel, keyboard."""
        self.require("getRank")
        ref = await self._resolved(query)
        player = await providers.hirez(self.runtime).get_player(self.game(), ref.id)

        ranks: list[RankInfo] = []
        for queue, key in (
            ("conquest", "RankedConquest"),
            ("joust", "RankedJoust"),
            ("duel", "RankedDuel"),
            ("keyboard", "RankedKBM"),
        ):
            stats = player.get(key)
            if not stats:
                continue
            wins = as_int(stats.get("Wins")) or 0
            losses = as_int(stats.get("Losses")) or 0
            if wins + losses == 0:
                continue
            ranks.append(
                RankInfo(
                    ref=ref,
                    queue=queue,
                    tier=as_str(stats.get("Name")),
                    division=as_str(stats.get("Tier")),
                    tier_points=as_int(stats.get("Points")),
                    rating=as_int(stats.get("Points")),
                    position=as_int(stats.get("Rank")),
                    wins=wins,
                    losses=losses,
                    season=as_str(stats.get("Season")),
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
        history = await providers.hirez(self.runtime).get_match_history(self.game(), ref.id)

        summaries = []
        for match in history[: self.limit(opts.limit)]:
            minutes = as_int(match.get("Minutes"))
            summaries.append(
                MatchSummary(
                    match_id=str(match.get("Match") or ""),
                    title_id=self.title.id,
                    mode=as_str(match.get("Queue")),
                    map=as_str(match.get("Map_Game")),
                    started_at=ts(match.get("Match_Time")),
                    duration_seconds=minutes * 60 if minutes is not None else None,
                    result=match_result(as_str(match.get("Win_Status")) == "Win"),
                    player_stats=participant_stats(
                        kills=as_int(match.get("Kills")),
                        deaths=as_int(match.get("Deaths")),
                        assists=as_int(match.get("Assists")),
                        damage_dealt=as_int(match.get("Damage_Player")),
                        damage_taken=as_int(match.get("Damage_Taken")),
                        healing=as_int(match.get("Healing")),
                        extra={
                            "character": as_str(match.get("God") or match.get("Champion")),
                            "gold": as_int(match.get("Gold")),
                            "level": as_int(match.get("Level")),
                        },
                    ),
                    raw=match,
                )
            )
        return summaries

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        self.require("getMatch")
        rows = await providers.hirez(self.runtime).get_match_details(self.game(), match_id)
        first = rows[0] if rows else {}

        return MatchDetail(
            match_id=match_id,
            title_id=self.title.id,
            mode=as_str(first.get("name") or first.get("Match_Queue_Id")),
            map=as_str(first.get("Map_Game")),
            started_at=ts(first.get("Entry_Datetime")),
            duration_seconds=as_int(first.get("Match_Duration")),
            patch=as_str(first.get("Match_Version")),
            teams=tuple(
                MatchTeam(
                    id=str(team),
                    name=f"Team {team}",
                    won=as_int(first.get("Winning_TaskForce")) == team,
                )
                for team in (1, 2)
            ),
            participants=tuple(
                MatchParticipant(
                    player_id=str(row.get("playerId") or row.get("ActivePlayerId") or ""),
                    display_name=as_str(row.get("playerName") or row.get("hz_player_name")),
                    team_id=as_str(row.get("TaskForce")),
                    character=as_str(
                        row.get("Reference_Name") or row.get("God") or row.get("Champion")
                    ),
                    stats=participant_stats(
                        kills=as_int(row.get("Kills_Player")),
                        deaths=as_int(row.get("Deaths")),
                        assists=as_int(row.get("Assists")),
                        damage_dealt=as_int(row.get("Damage_Player")),
                        damage_taken=as_int(row.get("Damage_Taken")),
                        healing=as_int(row.get("Healing")),
                        extra={
                            "gold": as_int(row.get("Gold_Earned")),
                            "level": as_int(row.get("Final_Match_Level")),
                            "objectiveDamage": as_int(row.get("Damage_Structure")),
                        },
                    ),
                    raw=row,
                )
                for row in rows
            ),
            raw=rows,
        )

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        queue_id = int(opts.queue or 451)
        season = int(opts.season or 0)
        rows = await providers.hirez(self.runtime).get_league_leaderboard(
            self.game(), queue_id, 26, season
        )
        if not rows:
            raise NotFoundError(
                "hirez",
                f"leaderboard for queue {queue_id} in season {season}",
                self.title.id,
            )

        return [
            LeaderboardEntry(
                position=as_int(row.get("Rank")) or index + 1,
                player_id=as_str(row.get("player_id")),
                display_name=as_str(row.get("player_name")),
                rating=as_int(row.get("Points")),
                tier=as_str(row.get("Tier")),
                wins=as_int(row.get("Wins")),
                losses=as_int(row.get("Losses")),
                raw=row,
            )
            for index, row in enumerate(rows[: self.limit(opts.limit, 100)])
        ]

    async def get_metadata(self, kind: str | None = None) -> Any:
        self.require("getMetadata")
        return await providers.hirez(self.runtime).get_characters(self.game())


class SmiteClient(_HiRezTitleClient):
    """SMITE."""

    def game(self) -> str:
        return "smite"


class PaladinsClient(_HiRezTitleClient):
    """Paladins."""

    def game(self) -> str:
        return "paladins"
