"""iRacing, Trackmania and Brawlhalla.

Two sim-racing titles and the one fighting game whose publisher ships a player
API. Racing breaks the win/loss model the rest of the package assumes: a race has
forty entrants and one winner, so ``result`` is ``win`` only for a first place
and ``MatchParticipantStats.placement`` is the number that actually matters.
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
    ModeStats,
    PlayerProfile,
    PlayerQuery,
    PlayerRef,
    PlayerStats,
    RankInfo,
)

__all__ = ["IRacingClient", "TrackmaniaClient", "BrawlhallaClient"]


class IRacingClient(TitleClient):
    """iRacing.

    The categories - oval, road, dirt oval, dirt road - each carry their own
    iRating and Safety Rating, and a driver can be strong in one and new to
    another. So ``get_rank`` returns one entry per category rather than a single
    number that would be meaningless.
    """

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        iracing = providers.iracing(self.runtime)

        if parsed.account_id:
            member = await iracing.get_member(str(parsed.account_id))
            return self.ref(
                provider_id="iracing",
                id=str(member.get("cust_id") or parsed.account_id),
                display_name=as_str(member.get("display_name")),
                platform="web",
            )

        term = str(parsed.name or "")
        drivers = await iracing.search_drivers(term)
        exact = next(
            (
                driver
                for driver in drivers
                if str(driver.get("display_name", "")).lower() == term.lower()
            ),
            drivers[0] if drivers else None,
        )
        if not exact:
            raise NotFoundError("iracing", f'driver "{term}"', self.title.id)

        return self.ref(
            provider_id="iracing",
            id=str(exact.get("cust_id") or ""),
            display_name=as_str(exact.get("display_name")),
            platform="web",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        member = await providers.iracing(self.runtime).get_member(ref.id)
        return PlayerProfile(
            ref=ref,
            display_name=str(member.get("display_name") or ref.id),
            profile_url=(
                f"https://members.iracing.com/membersite/member/CareerStats.do?custid={ref.id}"
            ),
            created_at=ts(member.get("member_since")),
            last_seen_at=ts(member.get("last_login")),
            country=as_str(member.get("club_name")),
            clan=as_str(member.get("club_name")),
            raw=member,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        career = await providers.iracing(self.runtime).get_career_stats(ref.id)

        modes: dict[str, ModeStats] = {}
        for row in career:
            identifier = as_str(row.get("category")) or "unknown"
            starts = as_int(row.get("starts"))
            wins = as_int(row.get("wins"))
            modes[identifier] = mode_stats(
                id=identifier,
                matches_played=starts,
                wins=wins,
                losses=(starts - wins if starts is not None and wins is not None else None),
                extra={
                    "top5": as_int(row.get("top5")),
                    "poles": as_int(row.get("poles")),
                    "avgStartPosition": num(row.get("avg_start_position")),
                    "avgFinishPosition": num(row.get("avg_finish_position")),
                    "lapsLed": as_int(row.get("laps_led")),
                    "incidentsPerRace": num(row.get("avg_incidents")),
                },
            )

        overall = next(
            (row for row in career if as_str(row.get("category")) == "Overall"),
            career[0] if career else {},
        )
        return player_stats(
            ref=ref,
            matches_played=as_int(overall.get("starts")),
            wins=as_int(overall.get("wins")),
            modes=modes,
            raw=career,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        member = await providers.iracing(self.runtime).get_member(ref.id)

        ranks = []
        for licence in as_list(member.get("licenses")):
            safety = num(licence.get("safety_rating"))
            ranks.append(
                RankInfo(
                    ref=ref,
                    queue=as_str(licence.get("category")) or "unknown",
                    # The licence class - Rookie through Pro - is the tier a
                    # driver names.
                    tier=as_str(licence.get("group_name")),
                    division=as_str(licence.get("safety_rating")),
                    tier_points=round(safety * 100) if safety is not None else None,
                    rating=as_int(licence.get("irating")),
                    raw=licence,
                )
            )
        return ranks

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        races = await providers.iracing(self.runtime).get_recent_races(ref.id)

        summaries = []
        for race in races[: self.limit(opts.limit)]:
            finish = as_int(race.get("finish_position"))
            summaries.append(
                MatchSummary(
                    match_id=str(race.get("subsession_id") or ""),
                    title_id=self.title.id,
                    mode=as_str(race.get("license_category") or race.get("series_name")),
                    map=as_str((race.get("track") or {}).get("track_name")),
                    started_at=ts(race.get("session_start_time")),
                    # A race is a win only for a first place; everything else is
                    # a finish.
                    result=match_result(finish in (0, 1)),
                    player_stats=participant_stats(
                        # iRacing counts positions from zero, which reads wrong
                        # to everyone.
                        placement=finish + 1 if finish is not None else None,
                        extra={
                            "startPosition": as_int(race.get("start_position")),
                            "incidents": as_int(race.get("incidents")),
                            "strengthOfField": as_int(race.get("strength_of_field")),
                            "oldIrating": as_int(race.get("oldi_rating")),
                            "newIrating": as_int(race.get("newi_rating")),
                            "points": as_int(race.get("points")),
                        },
                    ),
                    raw=race,
                )
            )
        return summaries

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        self.require("getMatch")
        result = await providers.iracing(self.runtime).get_result(match_id)
        sessions = as_list(result.get("session_results"))
        race = next(
            (
                session
                for session in sessions
                if as_str(session.get("simsession_type_name")) == "Race"
            ),
            sessions[0] if sessions else {},
        )

        return MatchDetail(
            match_id=match_id,
            title_id=self.title.id,
            mode=as_str(result.get("license_category")),
            map=as_str((result.get("track") or {}).get("track_name")),
            started_at=ts(result.get("start_time")),
            duration_seconds=as_int(result.get("event_average_lap")),
            participants=tuple(
                MatchParticipant(
                    player_id=str(row.get("cust_id") or ""),
                    display_name=as_str(row.get("display_name")),
                    character=as_str(row.get("car_name")),
                    stats=participant_stats(
                        placement=(as_int(row.get("finish_position")) or 0) + 1,
                        extra={
                            "startPosition": (as_int(row.get("starting_position")) or 0) + 1,
                            "lapsComplete": as_int(row.get("laps_complete")),
                            "lapsLed": as_int(row.get("laps_led")),
                            "incidents": as_int(row.get("incidents")),
                            "bestLapTime": as_int(row.get("best_lap_time")),
                            "oldIrating": as_int(row.get("oldi_rating")),
                            "newIrating": as_int(row.get("newi_rating")),
                        },
                    ),
                    raw=row,
                )
                for row in as_list(race.get("results"))
            ),
            raw=result,
        )

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        raise ValidationError(
            "iRacing standings are per season and car class - use "
            "providers.iracing(runtime).get_season_standings() with the season id"
        )


class TrackmaniaClient(TitleClient):
    """Trackmania.

    Two competitive systems: matchmaking (the Trackmaster ladder) and the
    Campaign/Track of the Day leaderboards. ``get_rank`` reports the former;
    ``get_leaderboard`` reports it too, because a per-map board needs a map and
    belongs on the provider rather than in the canonical surface.
    """

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)

        if parsed.account_id:
            return self.ref(
                provider_id="trackmania-io",
                id=str(parsed.account_id),
                display_name=as_str(parsed.name),
                platform="ubisoft",
            )

        players = await providers.trackmania(self.runtime).search_players(str(parsed.name))
        first = players[0] if players else {}
        account = first.get("player") or first
        return self.ref(
            provider_id="trackmania-io",
            id=str(account.get("id") or account.get("accountid") or ""),
            display_name=as_str(account.get("name")),
            platform="ubisoft",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        player = await providers.trackmania(self.runtime).get_player(ref.id)
        zone = ((player.get("trophies") or {}).get("zone") or {}).get("name")
        return PlayerProfile(
            ref=ref,
            display_name=str(player.get("displayname") or player.get("name") or ref.id),
            profile_url=f"https://trackmania.io/#/player/{ref.id}",
            country=as_str(zone),
            clan=as_str((player.get("club") or {}).get("name")),
            raw=player,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        player = await providers.trackmania(self.runtime).get_player(ref.id)

        modes: dict[str, ModeStats] = {}
        for entry in as_list(player.get("matchmaking")):
            identifier = as_str(entry.get("typename")) or str(
                entry.get("typeid") or "matchmaking"
            )
            division = entry.get("division") or {}
            modes[identifier] = mode_stats(
                id=identifier,
                extra={
                    "rank": as_int(entry.get("rank")),
                    "score": as_int(entry.get("score")),
                    "division": as_int(division.get("position")),
                    "divisionName": as_str(division.get("rule")),
                },
            )

        return player_stats(ref=ref, modes=modes, raw=player)

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        player = await providers.trackmania(self.runtime).get_player(ref.id)

        return [
            RankInfo(
                ref=ref,
                queue=as_str(entry.get("typename")) or "matchmaking",
                tier=as_str((entry.get("division") or {}).get("rule")),
                division=as_str((entry.get("division") or {}).get("position")),
                tier_points=as_int(entry.get("score")),
                rating=as_int(entry.get("score")),
                position=as_int(entry.get("rank")),
                raw=entry,
            )
            for entry in as_list(player.get("matchmaking"))
        ]

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        page = (opts.offset // 100) if opts.offset else 0
        ranks = await providers.trackmania(self.runtime).get_matchmaking_leaderboard(page)

        return [
            LeaderboardEntry(
                position=as_int(entry.get("rank")) or index + 1,
                player_id=as_str(entry.get("accountid")),
                display_name=as_str((entry.get("player") or {}).get("name")),
                rating=as_int(entry.get("score")),
                tier=as_str((entry.get("division") or {}).get("rule")),
                raw=entry,
            )
            for index, entry in enumerate(ranks[: self.limit(opts.limit, 100)])
        ]


class BrawlhallaClient(TitleClient):
    """Brawlhalla.

    The exception among fighting games: Blue Mammoth publishes a real player API,
    so this title has ranks and career statistics where Tekken and Street Fighter
    have only brackets.
    """

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        brawlhalla = providers.brawlhalla(self.runtime)

        if parsed.steam_id:
            found = await brawlhalla.get_id_by_steam_id(str(parsed.steam_id))
            return self.ref(
                provider_id="brawlhalla",
                id=str(found["brawlhalla_id"]),
                display_name=as_str(found.get("name")),
                platform="steam",
            )
        if parsed.account_id:
            return self.ref(
                provider_id="brawlhalla",
                id=str(parsed.account_id),
                display_name=as_str(parsed.name),
            )

        # Brawlhalla has no name search outside the ranked ladder, so a name-only
        # lookup walks the first pages of the ladder rather than failing.
        name = str(parsed.name or "")
        for page in range(1, 4):
            rows = await brawlhalla.get_rankings("1v1", "all", page, name)
            match = next(
                (row for row in rows if str(row.get("name", "")).lower() == name.lower()),
                None,
            )
            if match:
                return self.ref(
                    provider_id="brawlhalla",
                    id=str(match.get("brawlhalla_id") or ""),
                    display_name=as_str(match.get("name")),
                )
        raise NotFoundError(
            "brawlhalla",
            f'player "{name}" (only ranked players are searchable by name - '
            "pass a Steam id otherwise)",
            self.title.id,
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        stats = await providers.brawlhalla(self.runtime).get_stats(ref.id)
        return PlayerProfile(
            ref=ref,
            display_name=str(stats.get("name") or ref.id),
            level=as_int(stats.get("level")),
            clan=as_str((stats.get("clan") or {}).get("clan_name")),
            raw=stats,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        stats = await providers.brawlhalla(self.runtime).get_stats(ref.id)

        modes: dict[str, ModeStats] = {}
        for legend in as_list(stats.get("legends")):
            identifier = as_str(legend.get("legend_name_key")) or str(
                legend.get("legend_id") or "unknown"
            )
            games = as_int(legend.get("games"))
            wins = as_int(legend.get("wins"))
            modes[identifier] = mode_stats(
                id=identifier,
                matches_played=games,
                wins=wins,
                losses=(games - wins if games is not None and wins is not None else None),
                kills=as_int(legend.get("kos")),
                deaths=as_int(legend.get("falls")),
                extra={
                    "damageDealt": as_int(legend.get("damagedealt")),
                    "damageTaken": as_int(legend.get("damagetaken")),
                    "matchTime": as_int(legend.get("matchtime")),
                },
            )

        games = as_int(stats.get("games"))
        wins = as_int(stats.get("wins"))
        return player_stats(
            ref=ref,
            matches_played=games,
            wins=wins,
            losses=(games - wins) if games is not None and wins is not None else None,
            modes=modes,
            raw=stats,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        ranked = await providers.brawlhalla(self.runtime).get_ranked(ref.id)
        if not ranked:
            return []

        games = as_int(ranked.get("games"))
        wins = as_int(ranked.get("wins"))
        rows = [
            RankInfo(
                ref=ref,
                queue="1v1",
                tier=as_str(ranked.get("tier")),
                tier_points=as_int(ranked.get("rating")),
                rating=as_int(ranked.get("rating")),
                wins=wins,
                losses=(games - wins if games is not None and wins is not None else None),
                raw=ranked,
            )
        ]

        for team in as_list(ranked.get("2v2")):
            team_games = as_int(team.get("games"))
            team_wins = as_int(team.get("wins"))
            rows.append(
                RankInfo(
                    ref=ref,
                    queue=f"2v2:{as_str(team.get('teamname')) or 'team'}",
                    tier=as_str(team.get("tier")),
                    tier_points=as_int(team.get("rating")),
                    rating=as_int(team.get("rating")),
                    wins=team_wins,
                    losses=(
                        team_games - team_wins
                        if team_games is not None and team_wins is not None
                        else None
                    ),
                    raw=team,
                )
            )
        return rows

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        bracket = "2v2" if opts.queue == "2v2" else "1v1"
        rows = await providers.brawlhalla(self.runtime).get_rankings(
            bracket,
            opts.region or "all",
            (opts.offset // 50 + 1) if opts.offset else 1,
        )

        entries = []
        for index, row in enumerate(rows[: self.limit(opts.limit, 50)]):
            games = as_int(row.get("games"))
            wins = as_int(row.get("wins"))
            entries.append(
                LeaderboardEntry(
                    position=as_int(row.get("rank")) or index + 1,
                    player_id=as_str(row.get("brawlhalla_id")),
                    display_name=as_str(row.get("name")),
                    rating=as_int(row.get("rating")),
                    tier=as_str(row.get("tier")),
                    wins=wins,
                    losses=(games - wins if games is not None and wins is not None else None),
                    country=as_str(row.get("region")),
                    raw=row,
                )
            )
        return entries

    async def get_metadata(self, kind: str | None = None) -> Any:
        self.require("getMetadata")
        return await providers.brawlhalla(self.runtime).get_legends()
