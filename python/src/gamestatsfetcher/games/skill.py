"""The individual-skill titles: osu!, Beat Saber, chess and Minecraft.

These four break an assumption the rest of the package makes, and it is worth
naming: **a "match" here is not a match.** An osu! score is one play of one
beatmap; a Beat Saber score is the same; a chess game has two players and no
teams; a Hypixel game is one round of BedWars. Each client maps its unit onto
:class:`MatchSummary` in the way that reads correctly for that game, and says how
in its own docstring rather than pretending they are all alike.
"""

from __future__ import annotations

import math
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
    MatchHistoryOptions,
    MatchResult,
    MatchSummary,
    ModeStats,
    PlayerProfile,
    PlayerQuery,
    PlayerRef,
    PlayerStats,
    RankInfo,
)

__all__ = ["OsuClient", "BeatSaberClient", "ChessClient", "MinecraftClient"]

_OSU_MODES = ("osu", "taiko", "fruits", "mania")


class OsuClient(TitleClient):
    """osu!.

    A "match" is one play of one beatmap, and ``MatchSummary.result`` is ``win``
    when the play was completed rather than failed - that is the only binary
    outcome the game has.
    """

    @staticmethod
    def _mode(value: str | None) -> str:
        return value if value in _OSU_MODES else "osu"

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        user = await providers.osu(self.runtime).get_user(
            str(parsed.name or parsed.account_id or ""),
            self._mode(str(parsed.extra.get("mode") or "osu")),
        )
        return self.ref(
            provider_id="osu",
            id=str(user["id"]),
            display_name=as_str(user.get("username")),
            platform="web",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        user = await providers.osu(self.runtime).get_user(ref.id)
        statistics = user.get("statistics") or {}
        return PlayerProfile(
            ref=ref,
            display_name=str(user.get("username") or ref.id),
            level=as_int((statistics.get("level") or {}).get("current")),
            avatar_url=as_str(user.get("avatar_url")),
            profile_url=f"https://osu.ppy.sh/users/{user.get('id')}",
            created_at=ts(user.get("join_date")),
            last_seen_at=ts(user.get("last_visit")),
            country=as_str(user.get("country_code")),
            raw=user,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        osu = providers.osu(self.runtime)

        modes: dict[str, ModeStats] = {}
        for mode in _OSU_MODES:
            user = await osu.get_user(ref.id, mode)
            statistics = user.get("statistics") or {}
            if not statistics.get("play_count"):
                continue
            modes[mode] = mode_stats(
                id=mode,
                matches_played=as_int(statistics.get("play_count")),
                extra={
                    "pp": num(statistics.get("pp")),
                    "globalRank": as_int(statistics.get("global_rank")),
                    "countryRank": as_int(statistics.get("country_rank")),
                    "accuracy": num(statistics.get("hit_accuracy")),
                    "rankedScore": as_int(statistics.get("ranked_score")),
                    "maxCombo": as_int(statistics.get("maximum_combo")),
                },
            )

        standard = await osu.get_user(ref.id, "osu")
        statistics = standard.get("statistics") or {}
        return player_stats(
            ref=ref,
            matches_played=as_int(statistics.get("play_count")),
            time_played_seconds=as_int(statistics.get("play_time")),
            modes=modes,
            raw=standard,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        osu = providers.osu(self.runtime)

        ranks: list[RankInfo] = []
        for mode in _OSU_MODES:
            user = await osu.get_user(ref.id, mode)
            statistics = user.get("statistics") or {}
            if not statistics.get("global_rank"):
                continue
            ranks.append(
                RankInfo(
                    ref=ref,
                    queue=mode,
                    rating=num(statistics.get("pp")),
                    position=as_int(statistics.get("global_rank")),
                    raw=statistics,
                )
            )
        return ranks

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        scores = await providers.osu(self.runtime).get_scores(
            ref.id,
            "recent",
            limit=self.limit(opts.limit),
            offset=opts.offset or 0,
            mode=self._mode(opts.mode),
        )

        summaries = []
        for score in scores:
            beatmap = score.get("beatmap") or {}
            beatmapset = score.get("beatmapset") or {}
            label = " - ".join(
                part
                for part in (
                    as_str(beatmapset.get("artist")),
                    as_str(beatmapset.get("title")),
                    as_str(beatmap.get("version")),
                )
                if part
            )
            summaries.append(
                MatchSummary(
                    match_id=str(score.get("id") or ""),
                    title_id=self.title.id,
                    mode=as_str(score.get("mode")),
                    map=label or None,
                    started_at=ts(score.get("created_at")),
                    duration_seconds=as_int(beatmap.get("total_length")),
                    # A completed play is the only "win" osu! has.
                    result=match_result(score.get("passed") is True),
                    player_stats=participant_stats(
                        score=as_int(score.get("score")),
                        extra={
                            "pp": num(score.get("pp")),
                            "accuracy": num(score.get("accuracy")),
                            "maxCombo": as_int(score.get("max_combo")),
                            "rank": as_str(score.get("rank")),
                            "stars": num(beatmap.get("difficulty_rating")),
                        },
                    ),
                    raw=score,
                )
            )
        return summaries

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> Any:
        self.require("getMatch")
        raise ValidationError(
            "osu! scores are not addressable individually - read them from "
            f"get_match_history (asked for {match_id})"
        )

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        rows = await providers.osu(self.runtime).get_rankings(
            self._mode(opts.queue),
            country=opts.region,
            page=(opts.offset // 50 + 1) if opts.offset else 1,
        )

        entries = []
        for index, row in enumerate(rows[: self.limit(opts.limit, 50)]):
            user = row.get("user") or {}
            entries.append(
                LeaderboardEntry(
                    position=as_int(row.get("global_rank")) or index + 1,
                    player_id=as_str(user.get("id")),
                    display_name=as_str(user.get("username")),
                    rating=num(row.get("pp")),
                    country=as_str((user.get("country") or {}).get("code")),
                    raw=row,
                )
            )
        return entries


class BeatSaberClient(TitleClient):
    """Beat Saber.

    ScoreSaber first, BeatLeader as the alternative. The two ladders rank the
    same players differently because they weight maps differently - that is a
    real disagreement between two real ladders, not an error, so the provider is
    recorded on the ref and never mixed within one answer.
    """

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        identifier = str(parsed.steam_id or parsed.account_id or "")

        if identifier:
            return self.ref(provider_id="scoresaber", id=identifier, platform="steam")
        results = await providers.scoresaber(self.runtime).search_players(
            str(parsed.name or "")
        )
        first = results[0] if results else None
        if not first:
            raise NotFoundError(
                "scoresaber", f'Beat Saber player "{parsed.name}"', self.title.id
            )
        return self.ref(
            provider_id="scoresaber",
            id=str(first.get("id") or ""),
            display_name=as_str(first.get("name")),
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        player = await providers.scoresaber(self.runtime).get_player(ref.id)
        return PlayerProfile(
            ref=ref,
            display_name=str(player.get("name") or ref.id),
            avatar_url=as_str(player.get("profilePicture")),
            profile_url=f"https://scoresaber.com/u/{ref.id}",
            created_at=ts(player.get("firstSeen")),
            country=as_str(player.get("country")),
            is_private=player.get("inactive") is True,
            raw=player,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        player = await providers.scoresaber(self.runtime).get_player(ref.id)
        stats = player.get("scoreStats") or {}

        return player_stats(
            ref=ref,
            matches_played=as_int(stats.get("totalPlayCount")),
            modes={
                "ranked": mode_stats(
                    id="ranked",
                    matches_played=as_int(stats.get("rankedPlayCount")),
                    extra={
                        "pp": num(player.get("pp")),
                        "averageRankedAccuracy": num(stats.get("averageRankedAccuracy")),
                        "totalRankedScore": as_int(stats.get("totalRankedScore")),
                    },
                )
            },
            raw=player,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        player = await providers.scoresaber(self.runtime).get_player(ref.id)
        return [
            RankInfo(
                ref=ref,
                queue="global",
                rating=num(player.get("pp")),
                position=as_int(player.get("rank")),
                raw=player,
            ),
            RankInfo(
                ref=ref,
                queue="country",
                tier=as_str(player.get("country")),
                rating=num(player.get("pp")),
                position=as_int(player.get("countryRank")),
                raw=player,
            ),
        ]

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        players = await providers.scoresaber(self.runtime).get_leaderboard(
            (opts.offset // 50 + 1) if opts.offset else 1, opts.region
        )
        return [
            LeaderboardEntry(
                position=as_int(player.get("rank")) or index + 1,
                player_id=as_str(player.get("id")),
                display_name=as_str(player.get("name")),
                rating=num(player.get("pp")),
                country=as_str(player.get("country")),
                raw=player,
            )
            for index, player in enumerate(players[: self.limit(opts.limit, 50)])
        ]


class ChessClient(TitleClient):
    """Chess, across Chess.com and Lichess.

    One title, two sites, and a caller usually means a specific one - so
    ``extra={"site": "lichess"}`` selects Lichess and the default is Chess.com.
    The site is recorded on the ref so later calls stay on the same site.
    """

    @staticmethod
    def _site(query: PlayerQuery | PlayerRef) -> str:
        if isinstance(query, PlayerRef):
            return "lichess" if query.provider_id == "lichess" else "chess-com"
        site = str(query.extra.get("site") or "").lower()
        return "lichess" if site == "lichess" else "chess-com"

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        username = str(parsed.name or "")

        if self._site(parsed) == "lichess":
            user = await providers.lichess(self.runtime).get_player(username)
            return self.ref(
                provider_id="lichess",
                id=str(user.get("id") or username).lower(),
                display_name=as_str(user.get("username")) or username,
                platform="web",
            )
        player = await providers.chess_com(self.runtime).get_player(username)
        return self.ref(
            provider_id="chess-com",
            id=username.lower(),
            display_name=as_str(player.get("username")) or username,
            platform="web",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)

        if ref.provider_id == "lichess":
            user = await providers.lichess(self.runtime).get_player(ref.id)
            profile = user.get("profile") or {}
            return PlayerProfile(
                ref=ref,
                display_name=str(user.get("username") or ref.id),
                profile_url=as_str(user.get("url")) or f"https://lichess.org/@/{ref.id}",
                created_at=ts(user.get("createdAt")),
                last_seen_at=ts(user.get("seenAt")),
                country=as_str(profile.get("flag") or profile.get("country")),
                is_private=user.get("disabled") is True,
                raw=user,
            )

        player = await providers.chess_com(self.runtime).get_player(ref.id)
        country = as_str(player.get("country"))
        return PlayerProfile(
            ref=ref,
            display_name=str(player.get("username") or ref.id),
            avatar_url=as_str(player.get("avatar")),
            profile_url=as_str(player.get("url")),
            created_at=ts(player.get("joined")),
            last_seen_at=ts(player.get("last_online")),
            country=country.rsplit("/", 1)[-1] if country else None,
            raw=player,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)

        if ref.provider_id == "lichess":
            user = await providers.lichess(self.runtime).get_player(ref.id)
            perfs = user.get("perfs") or {}
            count = user.get("count") or {}
            return player_stats(
                ref=ref,
                matches_played=as_int(count.get("all")),
                wins=as_int(count.get("win")),
                losses=as_int(count.get("loss")),
                draws=as_int(count.get("draw")),
                modes={
                    identifier: mode_stats(
                        id=identifier,
                        matches_played=as_int(perf.get("games")),
                        extra={
                            "rating": as_int(perf.get("rating")),
                            "rd": as_int(perf.get("rd")),
                            "prog": as_int(perf.get("prog")),
                        },
                    )
                    for identifier, perf in perfs.items()
                    if isinstance(perf, dict)
                },
                raw=user,
            )

        stats = await providers.chess_com(self.runtime).get_stats(ref.id)
        modes: dict[str, ModeStats] = {}
        wins = losses = draws = 0
        for identifier, value in stats.items():
            if not identifier.startswith("chess_") or not isinstance(value, dict):
                continue
            record = value.get("record") or {}
            win = as_int(record.get("win")) or 0
            loss = as_int(record.get("loss")) or 0
            draw = as_int(record.get("draw")) or 0
            wins += win
            losses += loss
            draws += draw
            modes[identifier] = mode_stats(
                id=identifier,
                wins=win,
                losses=loss,
                extra={
                    "rating": as_int((value.get("last") or {}).get("rating")),
                    "bestRating": as_int((value.get("best") or {}).get("rating")),
                    "draws": draw,
                },
            )

        return player_stats(
            ref=ref, wins=wins, losses=losses, draws=draws, modes=modes, raw=stats
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)

        if ref.provider_id == "lichess":
            user = await providers.lichess(self.runtime).get_player(ref.id)
            return [
                RankInfo(
                    ref=ref,
                    queue=identifier,
                    rating=as_int(perf.get("rating")),
                    raw=perf,
                )
                for identifier, perf in (user.get("perfs") or {}).items()
                if isinstance(perf, dict) and (as_int(perf.get("games")) or 0) > 0
            ]

        stats = await providers.chess_com(self.runtime).get_stats(ref.id)
        return [
            RankInfo(
                ref=ref,
                queue=identifier,
                rating=as_int((value.get("last") or {}).get("rating")),
                wins=as_int((value.get("record") or {}).get("win")),
                losses=as_int((value.get("record") or {}).get("loss")),
                raw=value,
            )
            for identifier, value in stats.items()
            if identifier.startswith("chess_") and isinstance(value, dict)
        ]

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        limit = self.limit(opts.limit)

        if ref.provider_id == "lichess":
            games = await providers.lichess(self.runtime).get_games(ref.id, max_games=limit)
            return [_lichess_summary(game, ref.id, self.title.id) for game in games]

        games = await providers.chess_com(self.runtime).get_recent_games(ref.id, limit)
        return [_chess_com_summary(game, ref.id, self.title.id) for game in games]

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> Any:
        self.require("getMatch")
        raise ValidationError(
            "chess games are read from get_match_history rather than fetched "
            f"individually (asked for {match_id})"
        )

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        queue = opts.queue or "blitz"

        if str(opts.region or "").lower() == "lichess":
            users = await providers.lichess(self.runtime).get_top_players(
                queue, self.limit(opts.limit, 50)
            )
            return [
                LeaderboardEntry(
                    position=index + 1,
                    player_id=as_str(user.get("id")),
                    display_name=as_str(user.get("username")),
                    rating=as_int(((user.get("perfs") or {}).get(queue) or {}).get("rating")),
                    tier=as_str(user.get("title")),
                    raw=user,
                )
                for index, user in enumerate(users)
            ]

        boards = await providers.chess_com(self.runtime).get_leaderboards()
        rows = as_list(boards.get(f"live_{queue}") or boards.get(queue))
        entries = []
        for index, row in enumerate(rows[: self.limit(opts.limit, 50)]):
            country = as_str(row.get("country"))
            entries.append(
                LeaderboardEntry(
                    position=as_int(row.get("rank")) or index + 1,
                    player_id=as_str(row.get("username")),
                    display_name=as_str(row.get("username")),
                    rating=as_int(row.get("score")),
                    tier=as_str(row.get("title")),
                    wins=as_int((row.get("stats") or {}).get("win_count")),
                    losses=as_int((row.get("stats") or {}).get("loss_count")),
                    country=country.rsplit("/", 1)[-1] if country else None,
                    raw=row,
                )
            )
        return entries


def _lichess_summary(game: dict[str, Any], player_id: str, title_id: str) -> MatchSummary:
    players = game.get("players") or {}
    side = next(
        (
            colour
            for colour in ("white", "black")
            if str(((players.get(colour) or {}).get("user") or {}).get("id", "")).lower()
            == player_id
        ),
        None,
    )
    winner = as_str(game.get("winner"))
    created = as_int(game.get("createdAt"))
    last_move = as_int(game.get("lastMoveAt"))
    return MatchSummary(
        match_id=str(game.get("id") or ""),
        title_id=title_id,
        mode=as_str(game.get("perf") or game.get("speed")),
        started_at=ts(created),
        duration_seconds=(
            round((last_move - created) / 1_000) if created and last_move else None
        ),
        result=(match_result(winner == side) if winner else MatchResult.DRAW),
        player_stats=participant_stats(
            extra={
                "colour": side,
                "opening": as_str((game.get("opening") or {}).get("name")),
                "moves": as_int(game.get("turns")),
            }
        ),
        raw=game,
    )


def _chess_com_summary(game: dict[str, Any], player_id: str, title_id: str) -> MatchSummary:
    white = game.get("white") or {}
    black = game.get("black") or {}
    is_white = str(white.get("username", "")).lower() == player_id
    mine = white if is_white else black
    outcome = as_str(mine.get("result"))
    return MatchSummary(
        match_id=str(game.get("uuid") or game.get("url") or ""),
        title_id=title_id,
        mode=as_str(game.get("time_class")),
        started_at=ts(game.get("end_time")),
        result=(
            MatchResult.WIN
            if outcome == "win"
            else MatchResult.DRAW
            if outcome in ("agreed", "repetition", "stalemate", "insufficient")
            else MatchResult.LOSS
        ),
        player_stats=participant_stats(
            extra={
                "colour": "white" if is_white else "black",
                "rating": as_int(mine.get("rating")),
                "eco": as_str(game.get("eco")),
            }
        ),
        raw=game,
    )


class MinecraftClient(TitleClient):
    """Minecraft, through Hypixel.

    Competitive Minecraft means Hypixel: BedWars, SkyWars, Duels and the events
    built on them. Hypixel is keyed on UUID, so a name lookup costs one Mojang
    call first - which is cached for a day, because a UUID never changes.
    """

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        raw = str(parsed.account_id or parsed.name or "")
        # A 32-character hex string is already a UUID; anything else is a name.
        is_uuid = len(raw.replace("-", "")) == 32 and all(
            character in "0123456789abcdefABCDEF" for character in raw.replace("-", "")
        )
        resolved = (
            {"id": raw, "name": as_str(parsed.name) or raw}
            if is_uuid
            else await providers.mojang(self.runtime).get_uuid(raw)
        )

        return self.ref(
            provider_id="hypixel",
            id=resolved["id"],
            display_name=resolved["name"],
            platform="web",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        hypixel = providers.hypixel(self.runtime)
        player = await hypixel.get_player(ref.id)
        try:
            guild = await hypixel.get_guild(ref.id)
        except Exception:  # noqa: BLE001 - no guild is not a failure
            guild = None

        exp = as_int(player.get("networkExp"))
        return PlayerProfile(
            ref=ref,
            display_name=str(player.get("displayname") or ref.display_name or ref.id),
            level=int(_network_level(exp)) if exp is not None else None,
            avatar_url=f"https://crafatar.com/avatars/{ref.id}",
            profile_url=f"https://plancke.io/hypixel/player/stats/{ref.id}",
            created_at=ts(player.get("firstLogin")),
            last_seen_at=ts(player.get("lastLogin")),
            clan=as_str((guild or {}).get("name")),
            raw=player,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        player = await providers.hypixel(self.runtime).get_player(ref.id)
        stats = player.get("stats") or {}

        modes: dict[str, ModeStats] = {}

        bedwars = stats.get("Bedwars")
        if isinstance(bedwars, dict):
            experience = as_int(bedwars.get("Experience"))
            modes["bedwars"] = mode_stats(
                id="bedwars",
                label="BedWars",
                wins=as_int(bedwars.get("wins_bedwars")),
                losses=as_int(bedwars.get("losses_bedwars")),
                kills=as_int(bedwars.get("kills_bedwars")),
                deaths=as_int(bedwars.get("deaths_bedwars")),
                extra={
                    "finalKills": as_int(bedwars.get("final_kills_bedwars")),
                    "finalDeaths": as_int(bedwars.get("final_deaths_bedwars")),
                    "bedsBroken": as_int(bedwars.get("beds_broken_bedwars")),
                    "stars": experience // 5000 if experience is not None else None,
                },
            )

        skywars = stats.get("SkyWars")
        if isinstance(skywars, dict):
            modes["skywars"] = mode_stats(
                id="skywars",
                label="SkyWars",
                wins=as_int(skywars.get("wins")),
                losses=as_int(skywars.get("losses")),
                kills=as_int(skywars.get("kills")),
                deaths=as_int(skywars.get("deaths")),
                extra={"level": as_str(skywars.get("levelFormatted"))},
            )

        duels = stats.get("Duels")
        if isinstance(duels, dict):
            modes["duels"] = mode_stats(
                id="duels",
                label="Duels",
                wins=as_int(duels.get("wins")),
                losses=as_int(duels.get("losses")),
                kills=as_int(duels.get("kills")),
                deaths=as_int(duels.get("deaths")),
                extra={"bestWinstreak": as_int(duels.get("best_overall_winstreak"))},
            )

        return player_stats(
            ref=ref,
            wins=_sum_modes(modes, "wins"),
            losses=_sum_modes(modes, "losses"),
            kills=_sum_modes(modes, "kills"),
            deaths=_sum_modes(modes, "deaths"),
            modes=modes,
            raw=player,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        """Hypixel's network level, the closest thing it has to a rank."""
        self.require("getRank")
        ref = await self._resolved(query)
        player = await providers.hypixel(self.runtime).get_player(ref.id)
        exp = as_int(player.get("networkExp"))
        if exp is None:
            return []
        return [
            RankInfo(
                ref=ref,
                queue="network",
                tier=as_str(player.get("newPackageRank") or player.get("rank")),
                tier_points=int(_network_level(exp)),
                rating=exp,
                raw=player,
            )
        ]

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        boards = await providers.hypixel(self.runtime).get_leaderboards()
        game = (opts.queue or "BEDWARS").upper()
        board = (as_list(boards.get(game)) or [{}])[0]
        leaders = as_list(board.get("leaders"))

        return [
            LeaderboardEntry(
                position=index + 1,
                player_id=str(uuid),
                raw={"uuid": uuid, "board": board.get("title")},
            )
            for index, uuid in enumerate(leaders[: self.limit(opts.limit, 100)])
        ]


def _network_level(exp: int) -> float:
    """Hypixel's network level from raw experience.

    The formula is Hypixel's own and is documented on their API site; it is
    reproduced rather than approximated so the number matches what a player sees
    in game.
    """
    return math.floor((math.sqrt(exp * 2 + 30_625) / 50 - 2.5) * 100) / 100


def _sum_modes(modes: dict[str, ModeStats], field: str) -> int | None:
    """Fold one field across the mode breakdown, or ``None`` when none had it."""
    running = 0
    seen = False
    for mode in modes.values():
        value = getattr(mode, field)
        if isinstance(value, int):
            running += value
            seen = True
    return running if seen else None
