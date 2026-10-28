"""Rocket League.

The most assembled title in the package, because Psyonix publishes nothing at
all. Three sources, each answering a different question:

* **Tracker** knows the ladder, which is the only place an MMR exists.
* **Ballchasing** knows uploaded replays - complete for players who upload, empty
  for everyone else. That distinction is surfaced rather than hidden: an empty
  history here means "nothing was uploaded", not "no games played".
* **Octane.gg** knows the professional circuit, through the esports layer.
"""

from __future__ import annotations

from typing import Any

from .. import providers
from ..errors import ValidationError
from ..identity import to_steam_id64
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

__all__ = ["RocketLeagueClient"]

#: Playlist ids, as Rocket League numbers them.
_PLAYLISTS = {
    "10": "Ranked Duel 1v1",
    "11": "Ranked Doubles 2v2",
    "13": "Ranked Standard 3v3",
    "27": "Hoops",
    "28": "Rumble",
    "29": "Dropshot",
    "30": "Snow Day",
}


class RocketLeagueClient(TitleClient):
    @staticmethod
    def _ballchasing_id(ref: PlayerRef) -> str | None:
        """Ballchasing's ``platform:id`` form."""
        return {
            "steam": f"steam:{ref.id}",
            "epic": f"epic:{ref.id}",
            "xbox": f"xbox:{ref.id}",
            "playstation": f"ps4:{ref.id}",
        }.get(ref.platform or "")

    @staticmethod
    def _tracker_platform(ref: PlayerRef) -> str:
        return {
            "steam": "steam",
            "xbox": "xbl",
            "playstation": "psn",
        }.get(ref.platform or "", "epic")

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)

        if parsed.steam_id:
            return self.ref(
                provider_id="tracker",
                id=to_steam_id64(parsed.steam_id),
                display_name=as_str(parsed.name),
                platform="steam",
            )
        name = str(parsed.name or parsed.epic_id or "")
        if not name:
            raise ValidationError("Rocket League needs a name, Steam id or Epic id")
        return self.ref(
            provider_id="tracker",
            id=name,
            display_name=name,
            platform=parsed.platform or "epic",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        profile = await providers.tracker(self.runtime).get_profile(
            self.title.id, self._tracker_platform(ref), ref.id
        )
        info = profile.get("platformInfo") or {}
        return PlayerProfile(
            ref=ref,
            display_name=str(info.get("platformUserHandle") or ref.id),
            avatar_url=as_str(info.get("avatarUrl")),
            country=as_str((profile.get("userInfo") or {}).get("countryCode")),
            raw=profile,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        tracker = providers.tracker(self.runtime)
        profile = await tracker.get_profile(self.title.id, self._tracker_platform(ref), ref.id)
        stats = tracker.flatten_stats(tracker.segment(profile, "overview"))

        modes: dict[str, ModeStats] = {}
        for segment in profile.get("segments") or []:
            if segment.get("type") != "playlist":
                continue
            attributes = segment.get("attributes") or {}
            metadata = segment.get("metadata") or {}
            key = str(attributes.get("playlistId") or metadata.get("name") or "unknown")
            flat = tracker.flatten_stats(segment)
            modes[key] = mode_stats(
                id=key,
                label=_PLAYLISTS.get(key, str(metadata.get("name") or key)),
                wins=as_int(flat.get("matchesWon")),
                losses=as_int(flat.get("matchesLost")),
                matches_played=as_int(flat.get("matchesPlayed")),
                extra={
                    "mmr": as_int(flat.get("rating")),
                    "tier": as_int(flat.get("tier")),
                    "division": as_int(flat.get("division")),
                },
            )

        return player_stats(
            ref=ref,
            wins=as_int(stats.get("wins")),
            matches_played=as_int(stats.get("matchesPlayed")),
            time_played_seconds=as_int(stats.get("timePlayed")),
            modes=modes,
            raw=profile,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        """One rank per playlist - Rocket League ranks each separately."""
        self.require("getRank")
        ref = await self._resolved(query)
        tracker = providers.tracker(self.runtime)
        profile = await tracker.get_profile(self.title.id, self._tracker_platform(ref), ref.id)

        ranks: list[RankInfo] = []
        for segment in profile.get("segments") or []:
            if segment.get("type") != "playlist":
                continue
            stats = segment.get("stats") or {}
            rating = stats.get("rating") or {}
            playlist_id = str((segment.get("attributes") or {}).get("playlistId") or "")
            percentile = rating.get("percentile")
            ranks.append(
                RankInfo(
                    ref=ref,
                    queue=_PLAYLISTS.get(
                        playlist_id,
                        str((segment.get("metadata") or {}).get("name") or playlist_id),
                    ),
                    tier=as_str(((stats.get("tier") or {}).get("metadata") or {}).get("name")),
                    division=as_str(
                        ((stats.get("division") or {}).get("metadata") or {}).get("name")
                    ),
                    rating=num(rating.get("value")),
                    position=as_int(rating.get("rank")),
                    percentile_permille=(
                        round(percentile * 10) if percentile is not None else None
                    ),
                    wins=as_int((stats.get("matchesWon") or {}).get("value")),
                    losses=as_int((stats.get("matchesLost") or {}).get("value")),
                    raw=segment,
                )
            )
        return ranks

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        """Uploaded replays.

        Ballchasing sees only what somebody chose to upload, so this is a partial
        record by construction - and the honest one, because no complete record
        exists anywhere.
        """
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        player_id = self._ballchasing_id(ref)

        replays = await providers.ballchasing(self.runtime).list_replays(
            player_id=player_id,
            player_name=None if player_id else (ref.display_name or ref.id),
            count=self.limit(opts.limit),
            playlist=opts.mode,
        )

        summaries = []
        for replay in replays:
            blue = as_int((replay.get("blue") or {}).get("goals")) or 0
            orange = as_int((replay.get("orange") or {}).get("goals")) or 0
            summaries.append(
                MatchSummary(
                    match_id=str(replay.get("id") or ""),
                    title_id=self.title.id,
                    mode=as_str(replay.get("playlist_name") or replay.get("playlist_id")),
                    map=as_str(replay.get("map_name") or replay.get("map_code")),
                    started_at=ts(replay.get("date")),
                    duration_seconds=as_int(replay.get("duration")),
                    # Which side the queried player was on is not on the list row,
                    # so the summary reports the scoreline and leaves the verdict
                    # to get_match.
                    result=MatchResult.UNKNOWN,
                    player_stats=participant_stats(
                        extra={"blueGoals": blue, "orangeGoals": orange}
                    ),
                    raw=replay,
                )
            )
        return summaries

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        self.require("getMatch")
        replay = await providers.ballchasing(self.runtime).get_replay(match_id)

        participants = [
            _rl_participant(player, side)
            for side in ("blue", "orange")
            for player in as_list((replay.get(side) or {}).get("players"))
        ]

        blue = as_int((replay.get("blue") or {}).get("goals"))
        orange = as_int((replay.get("orange") or {}).get("goals"))
        mine = _rl_find(participants, context)

        result = MatchResult.UNKNOWN
        if mine and blue is not None and orange is not None:
            result = match_result(
                blue > orange if mine.team_id == "blue" else orange > blue,
                blue == orange,
            )

        return MatchDetail(
            match_id=match_id,
            title_id=self.title.id,
            mode=as_str(replay.get("playlist_name") or replay.get("playlist_id")),
            map=as_str(replay.get("map_name") or replay.get("map_code")),
            started_at=ts(replay.get("date")),
            duration_seconds=as_int(replay.get("duration")),
            result=result,
            player_stats=mine.stats if mine else None,
            teams=tuple(
                MatchTeam(
                    id=side,
                    name="Blue" if side == "blue" else "Orange",
                    won=((goals > other) if goals is not None and other is not None else None),
                    score=goals,
                )
                for side, goals, other in (
                    ("blue", blue, orange),
                    ("orange", orange, blue),
                )
            ),
            participants=tuple(participants),
            raw=replay,
        )

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        rows = await providers.tracker(self.runtime).get_leaderboard(
            self.title.id,
            opts.queue or "Rating",
            take=self.limit(opts.limit, 50),
            skip=opts.offset or 0,
        )
        return [
            LeaderboardEntry(
                position=as_int(row.get("rank")) or index + 1,
                player_id=as_str((row.get("owner") or {}).get("id")),
                display_name=as_str(
                    ((row.get("owner") or {}).get("metadata") or {}).get("platformUserHandle")
                ),
                rating=num(row.get("value")),
                raw=row,
            )
            for index, row in enumerate(rows)
        ]


def _rl_participant(player: dict[str, Any], side: str) -> MatchParticipant:
    core = ((player.get("stats") or {}).get("core")) or {}
    return MatchParticipant(
        player_id=str((player.get("id") or {}).get("id") or player.get("name") or ""),
        display_name=as_str(player.get("name")),
        team_id=side,
        character=as_str(player.get("car_name")),
        stats=participant_stats(
            score=as_int(core.get("score")),
            extra={
                "goals": as_int(core.get("goals")),
                "assists": as_int(core.get("assists")),
                "saves": as_int(core.get("saves")),
                "shots": as_int(core.get("shots")),
                "mvp": 1 if player.get("mvp") is True else 0,
                "shootingPercentage": num(core.get("shooting_percentage")),
            },
        ),
        raw=player,
    )


def _rl_find(
    participants: list[MatchParticipant], context: PlayerRef | None
) -> MatchParticipant | None:
    if not context:
        return None
    wanted = (context.display_name or context.id).lower()
    return next(
        (one for one in participants if (one.display_name or "").lower() == wanted),
        None,
    )
