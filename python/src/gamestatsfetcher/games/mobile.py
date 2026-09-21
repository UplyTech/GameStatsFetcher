"""The Supercell titles: Clash Royale, Clash of Clans and Brawl Stars.

All three are keyed on a player tag rather than a name, which changes what
``resolve_player`` means here: there is nothing to search, so resolution is a
validation of the tag plus one lookup to confirm it exists.

Two of the three keep a battle log of roughly the last 25 games and nothing
older. That is a hard limit of the API, and it is why ``limit`` above 25 is
clamped rather than paged.
"""

from __future__ import annotations

from typing import Any

from .. import providers
from ..errors import NotFoundError, ValidationError
from ..identity import normalise_supercell_tag
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
    MatchSummary,
    MatchTeam,
    ModeStats,
    PlayerProfile,
    PlayerQuery,
    PlayerRef,
    PlayerStats,
    RankInfo,
)

__all__ = ["ClashRoyaleClient", "ClashOfClansClient", "BrawlStarsClient"]


class _SupercellTitleClient(TitleClient):
    """Shared: resolve and validate a Supercell player tag."""

    provider_id = ""

    async def _fetch_player(self, tag: str) -> dict[str, Any]:
        raise NotImplementedError

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        tag = normalise_supercell_tag(str(parsed.player_tag or parsed.name or ""))
        player = await self._fetch_player(tag)
        return self.ref(
            provider_id=self.provider_id,
            id=tag,
            display_name=as_str(player.get("name")) or tag,
            platform="android",
        )


class ClashRoyaleClient(_SupercellTitleClient):
    provider_id = "supercell-clash-royale"

    async def _fetch_player(self, tag: str) -> dict[str, Any]:
        return await providers.clash_royale(self.runtime).get_player(tag)

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        player = await self._fetch_player(ref.id)
        return PlayerProfile(
            ref=ref,
            display_name=str(player.get("name") or ref.id),
            level=as_int(player.get("expLevel")),
            clan=as_str((player.get("clan") or {}).get("name")),
            raw=player,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        player = await self._fetch_player(ref.id)

        battles = as_int(player.get("battleCount"))
        wins = as_int(player.get("wins"))
        losses = as_int(player.get("losses"))
        return player_stats(
            ref=ref,
            matches_played=battles,
            wins=wins,
            losses=losses,
            draws=(
                battles - wins - losses
                if battles is not None and wins is not None and losses is not None
                else None
            ),
            modes={
                "ladder": mode_stats(
                    id="ladder",
                    label="Trophy Road",
                    extra={
                        "trophies": as_int(player.get("trophies")),
                        "bestTrophies": as_int(player.get("bestTrophies")),
                        "threeCrownWins": as_int(player.get("threeCrownWins")),
                    },
                )
            },
            raw=player,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        player = await self._fetch_player(ref.id)
        league = player.get("leagueStatistics") or {}
        return [
            RankInfo(
                ref=ref,
                queue="trophies",
                tier=as_str((player.get("arena") or {}).get("name")),
                tier_points=as_int(player.get("trophies")),
                rating=as_int(player.get("trophies")),
                wins=as_int(player.get("wins")),
                losses=as_int(player.get("losses")),
                season=as_str((league.get("currentSeason") or {}).get("id")),
                raw=player,
            )
        ]

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        log = await providers.clash_royale(self.runtime).get_battle_log(ref.id)

        summaries = []
        for battle in log[: self.limit(opts.limit, 25)]:
            team = (as_list(battle.get("team")) or [{}])[0]
            opponent = (as_list(battle.get("opponent")) or [{}])[0]
            team_crowns = as_int(team.get("crowns")) or 0
            opponent_crowns = as_int(opponent.get("crowns")) or 0
            summaries.append(
                MatchSummary(
                    match_id=f"{as_str(battle.get('battleTime')) or ''}:"
                    f"{as_str(team.get('tag')) or ''}",
                    title_id=self.title.id,
                    mode=as_str(
                        (battle.get("gameMode") or {}).get("name") or battle.get("type")
                    ),
                    map=as_str((battle.get("arena") or {}).get("name")),
                    started_at=ts(battle.get("battleTime")),
                    result=match_result(
                        team_crowns > opponent_crowns, team_crowns == opponent_crowns
                    ),
                    player_stats=participant_stats(
                        score=team_crowns,
                        extra={
                            "crowns": team_crowns,
                            "opponentCrowns": opponent_crowns,
                            "trophyChange": as_int(team.get("trophyChange")),
                        },
                    ),
                    raw=battle,
                )
            )
        return summaries

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        """Clash Royale has no addressable match ids.

        A battle is identified only by its timestamp inside the log, so the detail
        is looked up there rather than fetched - and if it has aged out of the
        25-entry log, it is genuinely gone.
        """
        self.require("getMatch")
        if context is None:
            raise ValidationError(
                "Clash Royale battles are only addressable inside a player's log "
                "- pass the PlayerRef as the second argument"
            )
        log = await providers.clash_royale(self.runtime).get_battle_log(context.id)
        battle = next(
            (
                entry
                for entry in log
                if match_id.startswith(str(entry.get("battleTime") or ""))
            ),
            None,
        )
        if battle is None:
            raise NotFoundError(
                "supercell-clash-royale",
                f"battle {match_id} (Supercell keeps only the last 25)",
                self.title.id,
            )

        sides = (
            ("team", as_list(battle.get("team"))),
            ("opponent", as_list(battle.get("opponent"))),
        )
        return MatchDetail(
            match_id=match_id,
            title_id=self.title.id,
            mode=as_str((battle.get("gameMode") or {}).get("name")),
            map=as_str((battle.get("arena") or {}).get("name")),
            started_at=ts(battle.get("battleTime")),
            teams=tuple(
                MatchTeam(
                    id=side,
                    name=side,
                    score=as_int((players[0] if players else {}).get("crowns")),
                    rounds_won=as_int((players[0] if players else {}).get("crowns")),
                )
                for side, players in sides
            ),
            participants=tuple(
                MatchParticipant(
                    player_id=str(player.get("tag") or ""),
                    display_name=as_str(player.get("name")),
                    team_id=side,
                    stats=participant_stats(
                        score=as_int(player.get("crowns")),
                        extra={
                            "startingTrophies": as_int(player.get("startingTrophies")),
                            "trophyChange": as_int(player.get("trophyChange")),
                            "elixirLeaked": as_int(player.get("elixirLeaked")),
                        },
                    ),
                    raw=player,
                )
                for side, players in sides
                for player in players
            ),
            raw=battle,
        )

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        rows = await providers.clash_royale(self.runtime).get_player_rankings(
            opts.region or "global", self.limit(opts.limit, 100)
        )
        return [
            LeaderboardEntry(
                position=as_int(row.get("rank")) or index + 1,
                player_id=as_str(row.get("tag")),
                display_name=as_str(row.get("name")),
                rating=as_int(row.get("trophies") or row.get("eloRating")),
                raw=row,
            )
            for index, row in enumerate(rows)
        ]

    async def get_metadata(self, kind: str | None = None) -> Any:
        self.require("getMetadata")
        if kind not in (None, "cards"):
            raise ValidationError(
                f'Clash Royale metadata "{kind}" is not available - try "cards"'
            )
        return await providers.clash_royale(self.runtime).get_cards()


class ClashOfClansClient(_SupercellTitleClient):
    """Clash of Clans.

    No per-player match record exists - the game's unit of competition is the
    clan war, which lives on the clan endpoints. The title declares no
    ``getMatchHistory`` for that reason.
    """

    provider_id = "supercell-clash-of-clans"

    async def _fetch_player(self, tag: str) -> dict[str, Any]:
        return await providers.clash_of_clans(self.runtime).get_player(tag)

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        player = await self._fetch_player(ref.id)
        return PlayerProfile(
            ref=ref,
            display_name=str(player.get("name") or ref.id),
            level=as_int(player.get("expLevel")),
            clan=as_str((player.get("clan") or {}).get("name")),
            raw=player,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        player = await self._fetch_player(ref.id)

        return player_stats(
            ref=ref,
            wins=as_int(player.get("attackWins")),
            modes={
                "home": mode_stats(
                    id="home",
                    label="Home Village",
                    extra={
                        "trophies": as_int(player.get("trophies")),
                        "bestTrophies": as_int(player.get("bestTrophies")),
                        "townHallLevel": as_int(player.get("townHallLevel")),
                        "attackWins": as_int(player.get("attackWins")),
                        "defenseWins": as_int(player.get("defenseWins")),
                        "warStars": as_int(player.get("warStars")),
                    },
                ),
                "builder": mode_stats(
                    id="builder",
                    label="Builder Base",
                    extra={
                        "trophies": as_int(player.get("builderBaseTrophies")),
                        "bestTrophies": as_int(player.get("bestBuilderBaseTrophies")),
                        "hallLevel": as_int(player.get("builderHallLevel")),
                    },
                ),
            },
            raw=player,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        player = await self._fetch_player(ref.id)
        return [
            RankInfo(
                ref=ref,
                queue="home",
                tier=as_str((player.get("league") or {}).get("name")),
                tier_points=as_int(player.get("trophies")),
                rating=as_int(player.get("trophies")),
                wins=as_int(player.get("attackWins")),
                raw=player,
            )
        ]

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        rows = await providers.clash_of_clans(self.runtime).get_player_rankings(
            opts.region or "global", self.limit(opts.limit, 100)
        )
        return [
            LeaderboardEntry(
                position=as_int(row.get("rank")) or index + 1,
                player_id=as_str(row.get("tag")),
                display_name=as_str(row.get("name")),
                rating=as_int(row.get("trophies")),
                tier=as_str((row.get("league") or {}).get("name")),
                wins=as_int(row.get("attackWins")),
                raw=row,
            )
            for index, row in enumerate(rows)
        ]


class BrawlStarsClient(_SupercellTitleClient):
    provider_id = "supercell-brawl-stars"

    async def _fetch_player(self, tag: str) -> dict[str, Any]:
        return await providers.brawl_stars(self.runtime).get_player(tag)

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        player = await self._fetch_player(ref.id)
        return PlayerProfile(
            ref=ref,
            display_name=str(player.get("name") or ref.id),
            level=as_int(player.get("expLevel")),
            clan=as_str((player.get("club") or {}).get("name")),
            raw=player,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        player = await self._fetch_player(ref.id)

        modes: dict[str, ModeStats] = {}
        for brawler in as_list(player.get("brawlers")):
            identifier = str(brawler.get("name") or brawler.get("id") or "unknown")
            modes[identifier] = mode_stats(
                id=identifier,
                label=as_str(brawler.get("name")) or identifier,
                extra={
                    "power": as_int(brawler.get("power")),
                    "rank": as_int(brawler.get("rank")),
                    "trophies": as_int(brawler.get("trophies")),
                    "highestTrophies": as_int(brawler.get("highestTrophies")),
                },
            )

        return player_stats(
            ref=ref,
            wins=(
                (as_int(player.get("3vs3Victories")) or 0)
                + (as_int(player.get("soloVictories")) or 0)
                + (as_int(player.get("duoVictories")) or 0)
            ),
            modes=modes,
            raw=player,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        player = await self._fetch_player(ref.id)
        return [
            RankInfo(
                ref=ref,
                queue="trophies",
                tier_points=as_int(player.get("trophies")),
                rating=as_int(player.get("trophies")),
                wins=as_int(player.get("3vs3Victories")),
                raw=player,
            )
        ]

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        log = await providers.brawl_stars(self.runtime).get_battle_log(ref.id)

        summaries = []
        for entry in log[: self.limit(opts.limit, 25)]:
            battle = entry.get("battle") or {}
            event = entry.get("event") or {}
            outcome = as_str(battle.get("result"))
            summaries.append(
                MatchSummary(
                    match_id=f"{as_str(entry.get('battleTime')) or ''}:"
                    f"{as_str(event.get('id')) or ''}",
                    title_id=self.title.id,
                    mode=as_str(battle.get("mode") or event.get("mode")),
                    map=as_str(event.get("map")),
                    started_at=ts(entry.get("battleTime")),
                    duration_seconds=as_int(battle.get("duration")),
                    result={
                        "victory": MatchResult.WIN,
                        "defeat": MatchResult.LOSS,
                        "draw": MatchResult.DRAW,
                    }.get(outcome or "", MatchResult.UNKNOWN),
                    player_stats=participant_stats(
                        placement=as_int(battle.get("rank")),
                        extra={
                            "trophyChange": as_int(battle.get("trophyChange")),
                            "starPlayer": as_str((battle.get("starPlayer") or {}).get("tag")),
                        },
                    ),
                    raw=entry,
                )
            )
        return summaries

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        self.require("getMatch")
        if context is None:
            raise ValidationError(
                "Brawl Stars battles are only addressable inside a player's log "
                "- pass the PlayerRef as the second argument"
            )
        log = await providers.brawl_stars(self.runtime).get_battle_log(context.id)
        entry = next(
            (row for row in log if match_id.startswith(str(row.get("battleTime") or ""))),
            None,
        )
        if entry is None:
            raise NotFoundError(
                "supercell-brawl-stars",
                f"battle {match_id} (Supercell keeps only the most recent battles)",
                self.title.id,
            )

        battle = entry.get("battle") or {}
        event = entry.get("event") or {}
        teams = as_list(battle.get("teams"))

        return MatchDetail(
            match_id=match_id,
            title_id=self.title.id,
            mode=as_str(battle.get("mode") or event.get("mode")),
            map=as_str(event.get("map")),
            started_at=ts(entry.get("battleTime")),
            duration_seconds=as_int(battle.get("duration")),
            teams=tuple(
                MatchTeam(id=str(index), name=f"Team {index + 1}")
                for index in range(len(teams))
            ),
            participants=tuple(
                MatchParticipant(
                    player_id=str(player.get("tag") or ""),
                    display_name=as_str(player.get("name")),
                    team_id=str(index),
                    character=as_str((player.get("brawler") or {}).get("name")),
                    stats=participant_stats(
                        extra={
                            "power": as_int((player.get("brawler") or {}).get("power")),
                            "trophies": as_int((player.get("brawler") or {}).get("trophies")),
                        },
                    ),
                    raw=player,
                )
                for index, team in enumerate(teams)
                for player in as_list(team)
            ),
            raw=entry,
        )

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        rows = await providers.brawl_stars(self.runtime).get_player_rankings(
            opts.region or "global", self.limit(opts.limit, 100)
        )
        return [
            LeaderboardEntry(
                position=as_int(row.get("rank")) or index + 1,
                player_id=as_str(row.get("tag")),
                display_name=as_str(row.get("name")),
                rating=as_int(row.get("trophies")),
                raw=row,
            )
            for index, row in enumerate(rows)
        ]

    async def get_metadata(self, kind: str | None = None) -> Any:
        self.require("getMetadata")
        brawl_stars = providers.brawl_stars(self.runtime)
        if kind in (None, "brawlers"):
            return await brawl_stars.get_brawlers()
        if kind == "events":
            return await brawl_stars.get_event_rotation()
        raise ValidationError(
            f'Brawl Stars metadata "{kind}" is not available - try brawlers or events'
        )
