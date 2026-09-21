"""Valve's titles: Counter-Strike 2, Dota 2, Team Fortress 2 and Deadlock.

What they share is Steam identity; what they do not share is anything else. CS2
has career totals and no rank, Dota 2 has both through a third party, TF2 has
neither and a log archive instead. So each client decides for itself which
provider answers which question - that decision is the value this layer adds
over calling the APIs directly.
"""

from __future__ import annotations

import asyncio
from typing import Any

from .. import providers
from ..constants import STEAM_APP_IDS
from ..errors import NotFoundError, ValidationError
from ..identity import is_steam_id64, to_steam_account_id, to_steam_id64
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
from ..providers.dota import dota_rank_name
from ..title_client import TitleClient
from ..types import (
    LeaderboardEntry,
    LeaderboardOptions,
    MatchDetail,
    MatchHistoryOptions,
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
    "CS2Client",
    "Dota2Client",
    "TeamFortress2Client",
    "DeadlockClient",
    "SteamStatsClient",
]


class CS2Client(TitleClient):
    """Counter-Strike 2.

    Steam holds the account and the career totals. FACEIT holds everything
    competitive - **Valve publishes no matchmaking rank at all**, so when a
    caller asks CS2 for a rank, FACEIT level and Elo are the honest answer and
    this client says so through ``RankInfo.queue``.
    """

    app_id = STEAM_APP_IDS["cs2"]

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        """Accepts a SteamID64, a legacy Steam id, or a vanity URL."""
        self.require("resolvePlayer")
        from ..title_client import as_query

        parsed = as_query(query)
        self.require_identifier(parsed)
        steam = providers.steam(self.runtime)

        if parsed.steam_id:
            steam_id = to_steam_id64(parsed.steam_id)
        else:
            name = str(parsed.name)
            # A 17-digit "name" is a Steam id somebody pasted into the wrong field.
            steam_id = (
                name
                if is_steam_id64(name)
                else await steam.resolve_vanity_url(name, self.title.id)
            )

        summary = await steam.get_player_summary(steam_id, self.title.id)
        return self.ref(
            provider_id="steam",
            id=steam_id,
            display_name=summary.get("personaname"),
            platform="steam",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        steam = providers.steam(self.runtime)
        summary = await steam.get_player_summary(ref.id, self.title.id)

        return PlayerProfile(
            ref=ref,
            display_name=str(summary.get("personaname") or ref.id),
            avatar_url=as_str(summary.get("avatarfull")),
            profile_url=as_str(summary.get("profileurl")),
            created_at=ts(summary.get("timecreated")),
            last_seen_at=ts(summary.get("lastlogoff")),
            country=as_str(summary.get("loccountrycode")),
            clan=as_str(summary.get("primaryclanid")),
            is_private=not steam.is_public(summary),
            raw=summary,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        """Career totals from the Steam stat list.

        The stat names are Valve's, unchanged since CS:GO. Per-map performance is
        exposed as modes, because that is the breakdown players actually look at.
        """
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        stats = await providers.steam(self.runtime).get_stat_map(
            ref.id, self.app_id, self.title.id
        )

        modes: dict[str, ModeStats] = {}
        for key, value in stats.items():
            if not key.startswith("total_wins_map_"):
                continue
            map_name = key[len("total_wins_map_") :]
            modes[map_name] = mode_stats(
                id=map_name,
                label=map_name.split("_", 1)[-1],
                wins=as_int(value),
                extra={"rounds": stats.get(f"total_rounds_map_{map_name}")},
            )

        played = as_int(stats.get("total_matches_played"))
        won = as_int(stats.get("total_matches_won"))
        return player_stats(
            ref=ref,
            matches_played=played,
            wins=won,
            # Steam reports played and won, never lost. Deriving it is safe only
            # when both halves are present; one of them absent means unknown,
            # not zero.
            losses=played - won if played is not None and won is not None else None,
            kills=as_int(stats.get("total_kills")),
            deaths=as_int(stats.get("total_deaths")),
            time_played_seconds=as_int(stats.get("total_time_played")),
            modes=modes,
            raw=stats,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        """FACEIT level and Elo.

        Returns an empty list rather than raising when the player has no FACEIT
        account: that is a fact about the player, not a failure of the call.
        """
        self.require("getRank")
        ref = await self._resolved(query)
        try:
            player = await providers.faceit(self.runtime).get_player_by_game_id(
                ref.id, self.title.id
            )
        except NotFoundError:
            return []

        games = player.get("games") or {}
        game = games.get("cs2") or games.get("csgo")
        if not game:
            return []
        level = game.get("skill_level")
        return [
            RankInfo(
                ref=ref,
                queue="faceit",
                tier=game.get("skill_level_label") or (f"Level {level}" if level else None),
                tier_points=as_int(level),
                rating=as_int(game.get("faceit_elo")),
                raw=player,
            )
        ]

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        """FACEIT match history - Valve keeps no retrievable matchmaking record."""
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        faceit = providers.faceit(self.runtime)
        player = await faceit.get_player_by_game_id(ref.id, self.title.id)
        history = await faceit.get_match_history(
            player["player_id"],
            self.title.id,
            limit=self.limit(opts.limit),
            offset=opts.offset or 0,
            from_ms=opts.since,
            to_ms=opts.until,
        )

        summaries: list[MatchSummary] = []
        for entry in history:
            winner = (entry.get("results") or {}).get("winner")
            player_team = None
            for team_id, team in (entry.get("teams") or {}).items():
                if any(
                    member.get("player_id") == player["player_id"]
                    for member in (team.get("players") or [])
                ):
                    player_team = team_id
                    break
            started = entry.get("started_at")
            finished = entry.get("finished_at")
            summaries.append(
                MatchSummary(
                    match_id=str(entry.get("match_id") or ""),
                    title_id=self.title.id,
                    mode=as_str(entry.get("competition_type")),
                    started_at=ts(started),
                    duration_seconds=(
                        int(finished) - int(started) if finished and started else None
                    ),
                    result=(
                        match_result(winner == player_team)
                        if winner and player_team
                        else MatchResult.UNKNOWN
                    ),
                    raw=entry,
                )
            )
        return summaries

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        self.require("getMatch")
        faceit = providers.faceit(self.runtime)
        match = await faceit.get_match(match_id, self.title.id)
        rounds = await faceit.get_match_stats(match_id, self.title.id)

        results = match.get("results") or {}
        teams = [
            MatchTeam(
                id=team_id,
                name=as_str(team.get("name")),
                won=results.get("winner") == team_id,
                score=as_int((results.get("score") or {}).get(team_id)),
            )
            for team_id, team in (match.get("teams") or {}).items()
        ]

        participants = []
        for one_round in rounds:
            for team in as_list(one_round.get("teams")):
                for player in as_list(team.get("players")):
                    stats = player.get("player_stats") or {}
                    participants.append(
                        _participant(
                            player_id=str(player.get("player_id") or ""),
                            display_name=as_str(player.get("nickname")),
                            team_id=as_str(team.get("team_id")),
                            stats=participant_stats(
                                kills=as_int(stats.get("Kills")),
                                deaths=as_int(stats.get("Deaths")),
                                assists=as_int(stats.get("Assists")),
                                extra={
                                    "headshots": as_int(stats.get("Headshots")),
                                    "mvps": as_int(stats.get("MVPs")),
                                    "adr": stats.get("ADR") or stats.get("K/R Ratio"),
                                    "kdRatio": stats.get("K/D Ratio"),
                                },
                            ),
                            raw=player,
                        )
                    )

        first = rounds[0] if rounds else {}
        round_stats = first.get("round_stats") or {}
        started = match.get("started_at")
        finished = match.get("finished_at")

        return MatchDetail(
            match_id=match_id,
            title_id=self.title.id,
            mode=as_str(match.get("competition_type")),
            map=as_str(round_stats.get("Map")),
            started_at=ts(started),
            duration_seconds=(int(finished) - int(started) if finished and started else None),
            teams=tuple(teams),
            participants=tuple(participants),
            raw={"match": match, "rounds": rounds},
        )

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        """The FACEIT regional ladder."""
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        rows = await providers.faceit(self.runtime).get_rankings(
            self.title.id,
            opts.region or "EU",
            limit=self.limit(opts.limit, 50),
            offset=opts.offset or 0,
        )
        return [
            LeaderboardEntry(
                position=as_int(row.get("position")) or (opts.offset or 0) + index + 1,
                player_id=as_str(row.get("player_id")),
                display_name=as_str(row.get("nickname")),
                rating=as_int(row.get("faceit_elo")),
                tier=(
                    f"Level {row['game_skill_level']}" if row.get("game_skill_level") else None
                ),
                country=as_str(row.get("country")),
                raw=row,
            )
            for index, row in enumerate(rows)
        ]


class Dota2Client(TitleClient):
    """Dota 2.

    OpenDota is the primary source. Valve's own match API is reachable through
    ``providers.steam()`` and is used only when a caller forces it, because it
    does not carry the parsed data that makes a Dota match worth reading.
    """

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        from ..title_client import as_query

        parsed = as_query(query)
        self.require_identifier(parsed)

        raw = parsed.steam_id or parsed.account_id or parsed.name
        if raw is None:
            raise ValidationError("Dota 2 needs a Steam id or account id")
        account_id = to_steam_account_id(str(raw))
        player = await providers.opendota(self.runtime).get_player(account_id)

        return self.ref(
            provider_id="opendota",
            id=account_id,
            display_name=(player.get("profile") or {}).get("personaname"),
            platform="steam",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        player = await providers.opendota(self.runtime).get_player(ref.id)
        profile = player.get("profile") or {}

        return PlayerProfile(
            ref=ref,
            display_name=str(profile.get("personaname") or "unknown"),
            avatar_url=as_str(profile.get("avatarfull")),
            profile_url=as_str(profile.get("profileurl")),
            last_seen_at=ts(profile.get("last_login")),
            country=as_str(profile.get("loccountrycode")),
            # OpenDota reports the profile but not whether Steam hides the details.
            is_private=False,
            raw=player,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        opendota = providers.opendota(self.runtime)

        # Three independent OpenDota endpoints. Sequentially they are three
        # round trips deep; together they are one.
        win_loss, heroes, totals = await asyncio.gather(
            opendota.get_win_loss(ref.id),
            opendota.get_hero_performance(ref.id),
            opendota.get_totals(ref.id),
        )

        by_field = {row.get("field"): row for row in totals}
        modes: dict[str, ModeStats] = {}
        # Twenty is enough for a profile card and keeps the payload sane; the
        # full list is in `raw`.
        for hero in heroes[:20]:
            hero_id = str(hero.get("hero_id"))
            games = as_int(hero.get("games")) or 0
            wins = as_int(hero.get("win")) or 0
            modes[hero_id] = mode_stats(
                id=hero_id,
                label=f"hero-{hero_id}",
                matches_played=games,
                wins=wins,
                losses=games - wins,
            )

        return player_stats(
            ref=ref,
            wins=as_int(win_loss.get("win")),
            losses=as_int(win_loss.get("lose")),
            kills=as_int((by_field.get("kills") or {}).get("sum")),
            deaths=as_int((by_field.get("deaths") or {}).get("sum")),
            assists=as_int((by_field.get("assists") or {}).get("sum")),
            time_played_seconds=as_int((by_field.get("duration") or {}).get("sum")),
            modes=modes,
            raw={"winLoss": win_loss, "heroes": heroes, "totals": totals},
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        """Medal, star and - for the top 1000 - the leaderboard position."""
        self.require("getRank")
        ref = await self._resolved(query)
        opendota = providers.opendota(self.runtime)
        # The medal and the record are independent lookups.
        player, win_loss = await asyncio.gather(
            opendota.get_player(ref.id),
            opendota.get_win_loss(ref.id),
        )

        rank_tier = as_int(player.get("rank_tier"))
        return [
            RankInfo(
                ref=ref,
                queue="ranked",
                tier=dota_rank_name(rank_tier),
                division=str(rank_tier % 10) if rank_tier else None,
                rating=as_int(
                    (player.get("mmr_estimate") or {}).get("estimate")
                    or player.get("competitive_rank")
                ),
                position=as_int(player.get("leaderboard_rank")),
                wins=as_int(win_loss.get("win")),
                losses=as_int(win_loss.get("lose")),
                raw=player,
            )
        ]

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        matches = await providers.opendota(self.runtime).get_matches(
            ref.id, limit=self.limit(opts.limit), offset=opts.offset or 0
        )

        summaries = []
        for match in matches:
            # Slots 0-127 are Radiant, 128+ are Dire. This is the only place the
            # player's side is recorded on a history row.
            is_radiant = (as_int(match.get("player_slot")) or 0) < 128
            summaries.append(
                MatchSummary(
                    match_id=str(match.get("match_id") or ""),
                    title_id=self.title.id,
                    mode=str(match.get("game_mode")),
                    started_at=ts(match.get("start_time")),
                    duration_seconds=as_int(match.get("duration")),
                    result=match_result(match.get("radiant_win") is is_radiant),
                    player_stats=participant_stats(
                        kills=as_int(match.get("kills")),
                        deaths=as_int(match.get("deaths")),
                        assists=as_int(match.get("assists")),
                        extra={
                            "heroId": as_int(match.get("hero_id")),
                            "gpm": as_int(match.get("gold_per_min")),
                            "xpm": as_int(match.get("xp_per_min")),
                            "lastHits": as_int(match.get("last_hits")),
                            "heroDamage": as_int(match.get("hero_damage")),
                        },
                    ),
                    raw=match,
                )
            )
        return summaries

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        self.require("getMatch")
        match = await providers.opendota(self.runtime).get_match(match_id)
        players = as_list(match.get("players"))
        radiant_win = match.get("radiant_win") is True

        return MatchDetail(
            match_id=match_id,
            title_id=self.title.id,
            mode=as_str(match.get("game_mode")),
            started_at=ts(match.get("start_time")),
            duration_seconds=as_int(match.get("duration")),
            patch=as_str(match.get("patch")),
            teams=(
                MatchTeam(
                    id="radiant",
                    name=as_str(match.get("radiant_name")) or "Radiant",
                    won=radiant_win,
                    score=as_int(match.get("radiant_score")),
                ),
                MatchTeam(
                    id="dire",
                    name=as_str(match.get("dire_name")) or "Dire",
                    won=not radiant_win,
                    score=as_int(match.get("dire_score")),
                ),
            ),
            participants=tuple(
                _participant(
                    player_id=str(player.get("account_id") or "anonymous"),
                    display_name=as_str(player.get("personaname")),
                    team_id=(
                        "radiant" if (as_int(player.get("player_slot")) or 0) < 128 else "dire"
                    ),
                    character=as_str(player.get("hero_id")),
                    stats=participant_stats(
                        kills=as_int(player.get("kills")),
                        deaths=as_int(player.get("deaths")),
                        assists=as_int(player.get("assists")),
                        damage_dealt=as_int(player.get("hero_damage")),
                        healing=as_int(player.get("hero_healing")),
                        extra={
                            "gpm": as_int(player.get("gold_per_min")),
                            "xpm": as_int(player.get("xp_per_min")),
                            "lastHits": as_int(player.get("last_hits")),
                            "denies": as_int(player.get("denies")),
                            "netWorth": as_int(player.get("net_worth")),
                            "towerDamage": as_int(player.get("tower_damage")),
                            "level": as_int(player.get("level")),
                        },
                    ),
                    raw=player,
                )
                for player in players
            ),
            raw=match,
        )

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        """The regional Immortal leaderboard."""
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        response = await providers.opendota(self.runtime).get_leaderboard(
            opts.region or "europe"
        )
        rows = (response or {}).get("leaderboard") or []
        return [
            LeaderboardEntry(
                position=as_int(row.get("rank")) or 0,
                display_name=as_str(row.get("name")),
                tier="Immortal",
                raw=row,
            )
            for row in rows[: self.limit(opts.limit, 100)]
        ]

    async def get_metadata(self, kind: str | None = None) -> Any:
        """The hero list, for turning hero ids into names."""
        self.require("getMetadata")
        if kind not in (None, "heroes"):
            raise ValidationError(f'Dota 2 metadata "{kind}" is not available - try "heroes"')
        return await providers.opendota(self.runtime).get_heroes()


class TeamFortress2Client(TitleClient):
    """Team Fortress 2.

    Steam holds career totals, logs.tf holds the competitive record. There is no
    rank of any kind, which is why the title does not declare ``getRank`` - the
    game has never had one.
    """

    app_id = STEAM_APP_IDS["team-fortress-2"]

    _CLASSES = (
        "Scout",
        "Soldier",
        "Pyro",
        "Demoman",
        "Heavy",
        "Engineer",
        "Medic",
        "Sniper",
        "Spy",
    )

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        from ..title_client import as_query

        parsed = as_query(query)
        self.require_identifier(parsed)
        steam = providers.steam(self.runtime)
        steam_id = (
            to_steam_id64(parsed.steam_id)
            if parsed.steam_id
            else await steam.resolve_vanity_url(str(parsed.name), self.title.id)
        )
        summary = await steam.get_player_summary(steam_id, self.title.id)
        return self.ref(
            provider_id="steam",
            id=steam_id,
            display_name=summary.get("personaname"),
            platform="steam",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        steam = providers.steam(self.runtime)
        summary = await steam.get_player_summary(ref.id, self.title.id)
        return PlayerProfile(
            ref=ref,
            display_name=str(summary.get("personaname") or ref.id),
            avatar_url=as_str(summary.get("avatarfull")),
            profile_url=as_str(summary.get("profileurl")),
            created_at=ts(summary.get("timecreated")),
            last_seen_at=ts(summary.get("lastlogoff")),
            country=as_str(summary.get("loccountrycode")),
            clan=as_str(summary.get("primaryclanid")),
            is_private=not steam.is_public(summary),
            raw=summary,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        """Per-class career totals, which is how TF2 records everything."""
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        stats = await providers.steam(self.runtime).get_stat_map(
            ref.id, self.app_id, self.title.id
        )

        modes: dict[str, ModeStats] = {}
        for class_name in self._CLASSES:
            kills = stats.get(f"{class_name}.accum.iNumberOfKills")
            if kills is None:
                continue
            modes[class_name.lower()] = mode_stats(
                id=class_name.lower(),
                label=class_name,
                kills=as_int(kills),
                extra={
                    "playtime": stats.get(f"{class_name}.accum.iPlayTime"),
                    "damage": stats.get(f"{class_name}.accum.iDamageDealt"),
                    "pointsScored": stats.get(f"{class_name}.accum.iPointsScored"),
                },
            )

        return player_stats(
            ref=ref,
            kills=total(mode.kills for mode in modes.values()),
            modes=modes,
            raw=stats,
        )

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        """Competitive logs from logs.tf."""
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        logs = await providers.logstf(self.runtime).get_player_logs(
            ref.id, limit=self.limit(opts.limit), offset=opts.offset or 0
        )

        return [
            MatchSummary(
                match_id=str(log.get("id") or ""),
                title_id=self.title.id,
                mode="competitive",
                map=as_str(log.get("map")),
                started_at=ts(log.get("date")),
                # A log records both teams' scores but not which side the player
                # was on; that needs the full log, so this says "unknown".
                result=MatchResult.UNKNOWN,
                raw=log,
            )
            for log in logs
        ]

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        self.require("getMatch")
        log = await providers.logstf(self.runtime).get_log(match_id)
        teams = log.get("teams") or {}
        player_rows = log.get("players") or {}
        names = log.get("names") or {}
        info = log.get("info") or {}

        red = as_int((teams.get("Red") or {}).get("score"))
        blue = as_int((teams.get("Blue") or {}).get("score"))

        return MatchDetail(
            match_id=match_id,
            title_id=self.title.id,
            mode="competitive",
            map=as_str(info.get("map")),
            started_at=ts(info.get("date")),
            duration_seconds=as_int(info.get("total_length")),
            teams=(
                MatchTeam(
                    id="Red",
                    name="RED",
                    won=red > blue if red is not None and blue is not None else None,
                    score=red,
                    rounds_won=red,
                ),
                MatchTeam(
                    id="Blue",
                    name="BLU",
                    won=blue > red if red is not None and blue is not None else None,
                    score=blue,
                    rounds_won=blue,
                ),
            ),
            participants=tuple(
                _participant(
                    player_id=steam_id3,
                    display_name=names.get(steam_id3),
                    team_id=as_str(row.get("team")),
                    character=as_str(
                        (as_list(row.get("class_stats"))[:1] or [{}])[0].get("type")
                    ),
                    stats=participant_stats(
                        kills=as_int(row.get("kills")),
                        deaths=as_int(row.get("deaths")),
                        assists=as_int(row.get("assists")),
                        damage_dealt=as_int(row.get("dmg")),
                        damage_taken=as_int(row.get("dt")),
                        healing=as_int(row.get("hr") or row.get("heal")),
                        extra={
                            "dpm": as_int(row.get("dapm")),
                            "ubers": as_int(row.get("ubers")),
                            "drops": as_int(row.get("drops")),
                            "headshots": as_int(row.get("headshots")),
                            "backstabs": as_int(row.get("backstabs")),
                        },
                    ),
                    raw=row,
                )
                for steam_id3, row in player_rows.items()
            ),
            rounds=tuple(
                _round(index, one_round)
                for index, one_round in enumerate(as_list(log.get("rounds")))
            ),
            raw=log,
        )


class DeadlockClient(TitleClient):
    """Deadlock.

    In closed testing, so the upstream schema moves between patches. Everything
    normalised here is the part that has been stable; the rest survives in
    ``raw``, which is exactly the case the raw field was added for.
    """

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        from ..title_client import as_query

        parsed = as_query(query)
        self.require_identifier(parsed)
        raw = parsed.steam_id or parsed.account_id
        if raw is None:
            raise ValidationError("Deadlock needs a Steam id or account id")
        return self.ref(
            provider_id="deadlock-api",
            id=to_steam_account_id(str(raw)),
            platform="steam",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        card = await providers.deadlock(self.runtime).get_player_card(ref.id)
        return PlayerProfile(
            ref=ref,
            display_name=str(card.get("account_name") or ref.id),
            level=as_int(card.get("account_level")),
            raw=card,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        history = await providers.deadlock(self.runtime).get_match_history(ref.id)
        wins = sum(
            1
            for match in history
            if as_int(match.get("match_result")) == as_int(match.get("player_team"))
        )
        return player_stats(
            ref=ref,
            matches_played=len(history),
            wins=wins,
            losses=len(history) - wins,
            kills=total(as_int(match.get("player_kills")) for match in history),
            deaths=total(as_int(match.get("player_deaths")) for match in history),
            assists=total(as_int(match.get("player_assists")) for match in history),
            raw=history,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        card = await providers.deadlock(self.runtime).get_player_card(ref.id)
        rank = as_int(card.get("ranked_rank") or card.get("rank"))
        if rank is None:
            return []
        return [
            RankInfo(
                ref=ref,
                queue="ranked",
                # Deadlock encodes rank as `tier * 10 + subrank`, like Dota 2.
                tier=str(rank // 10),
                division=str(rank % 10),
                rating=rank,
                raw=card,
            )
        ]

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        history = await providers.deadlock(self.runtime).get_match_history(ref.id)

        return [
            MatchSummary(
                match_id=str(match.get("match_id") or ""),
                title_id=self.title.id,
                mode=as_str(match.get("game_mode")),
                started_at=ts(match.get("start_time")),
                duration_seconds=as_int(match.get("match_duration_s")),
                result=match_result(
                    as_int(match.get("match_result")) == as_int(match.get("player_team"))
                ),
                player_stats=participant_stats(
                    kills=as_int(match.get("player_kills")),
                    deaths=as_int(match.get("player_deaths")),
                    assists=as_int(match.get("player_assists")),
                    extra={
                        "heroId": as_int(match.get("hero_id")),
                        "netWorth": as_int(match.get("net_worth")),
                    },
                ),
                raw=match,
            )
            for match in history[: self.limit(opts.limit)]
        ]

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        self.require("getMatch")
        match = await providers.deadlock(self.runtime).get_match(match_id)
        info = match.get("match_info") or match
        players = as_list(info.get("players"))

        return MatchDetail(
            match_id=match_id,
            title_id=self.title.id,
            mode=as_str(info.get("game_mode")),
            started_at=ts(info.get("start_time")),
            duration_seconds=as_int(info.get("duration_s")),
            teams=tuple(
                MatchTeam(
                    id=str(team),
                    name="Sapphire" if team == 0 else "Amber",
                    won=as_int(info.get("winning_team")) == team,
                )
                for team in (0, 1)
            ),
            participants=tuple(
                _participant(
                    player_id=str(player.get("account_id") or ""),
                    team_id=as_str(player.get("team")),
                    character=as_str(player.get("hero_id")),
                    stats=participant_stats(
                        kills=as_int(player.get("kills")),
                        deaths=as_int(player.get("deaths")),
                        assists=as_int(player.get("assists")),
                        extra={
                            "netWorth": as_int(player.get("net_worth")),
                            "lastHits": as_int(player.get("last_hits")),
                            "denies": as_int(player.get("denies")),
                        },
                    ),
                    raw=player,
                )
                for player in players
            ),
            raw=match,
        )

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        rows = await providers.deadlock(self.runtime).get_leaderboard(opts.region or "Europe")
        return [
            LeaderboardEntry(
                position=as_int(row.get("rank")) or index + 1,
                player_id=as_str(row.get("account_id")),
                display_name=as_str(row.get("account_name")),
                rating=as_int(row.get("ranked_rank")),
                wins=as_int(row.get("wins")),
                raw=row,
            )
            for index, row in enumerate(rows[: self.limit(opts.limit, 100)])
        ]


class SteamStatsClient(TitleClient):
    """Steam-backed titles whose stats are a flat name/value list and nothing more.

    Rust, War Thunder, Naraka and Dead by Daylight all expose career totals
    through ``ISteamUserStats`` and nothing else. Rather than four near-identical
    classes, they share this one and differ only by app id.
    """

    @property
    def app_id(self) -> int:
        app_id = STEAM_APP_IDS.get(self.title.id)
        if not app_id:
            raise ValidationError(f"no Steam app id registered for {self.title.id}")
        return app_id

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        from ..title_client import as_query

        parsed = as_query(query)
        self.require_identifier(parsed)
        steam = providers.steam(self.runtime)
        steam_id = (
            to_steam_id64(parsed.steam_id)
            if parsed.steam_id
            else await steam.resolve_vanity_url(str(parsed.name), self.title.id)
        )
        summary = await steam.get_player_summary(steam_id, self.title.id)
        return self.ref(
            provider_id="steam",
            id=steam_id,
            display_name=summary.get("personaname"),
            platform="steam",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        steam = providers.steam(self.runtime)
        summary = await steam.get_player_summary(ref.id, self.title.id)
        try:
            recent = await steam.get_recently_played_games(ref.id, self.title.id)
        except Exception:  # noqa: BLE001 - a private games list is not a failure
            recent = []
        this_game = next((game for game in recent if game.get("appid") == self.app_id), None)

        return PlayerProfile(
            ref=ref,
            display_name=str(summary.get("personaname") or ref.id),
            avatar_url=as_str(summary.get("avatarfull")),
            profile_url=as_str(summary.get("profileurl")),
            created_at=ts(summary.get("timecreated")),
            last_seen_at=ts(summary.get("lastlogoff")),
            country=as_str(summary.get("loccountrycode")),
            clan=as_str(summary.get("primaryclanid")),
            is_private=not steam.is_public(summary),
            raw={"summary": summary, "recent": this_game},
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        steam = providers.steam(self.runtime)
        stats = await steam.get_stat_map(ref.id, self.app_id, self.title.id)
        try:
            owned = await steam.get_owned_games(ref.id, self.title.id)
        except Exception:  # noqa: BLE001
            owned = []
        playtime = next(
            (
                game.get("playtime_forever")
                for game in owned
                if game.get("appid") == self.app_id
            ),
            None,
        )

        # Names differ per title, so the common ones are probed and the rest kept
        # in `raw` - inventing a mapping per game would be guesswork.
        return player_stats(
            ref=ref,
            wins=as_int(stats.get("wins") or stats.get("total_wins")),
            losses=as_int(stats.get("losses") or stats.get("total_losses")),
            kills=as_int(
                stats.get("kills") or stats.get("total_kills") or stats.get("player_kills")
            ),
            deaths=as_int(stats.get("deaths") or stats.get("total_deaths")),
            time_played_seconds=playtime * 60 if playtime is not None else None,
            raw=stats,
        )


# ---------------------------------------------------------------------------
# Small builders shared by the clients above
# ---------------------------------------------------------------------------


def _participant(**fields: Any) -> Any:
    from ..types import MatchParticipant

    return MatchParticipant(**fields)


def _round(index: int, payload: dict[str, Any]) -> Any:
    from ..types import MatchRound

    return MatchRound(
        index=index,
        winning_team_id=as_str(payload.get("winner")),
        duration_seconds=as_int(payload.get("length")),
        raw=payload,
    )
