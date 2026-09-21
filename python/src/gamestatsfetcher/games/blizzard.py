"""The Blizzard titles.

Blizzard's API coverage is uneven in a way that shows up directly in these
clients: World of Warcraft has a full profile API, StarCraft II has one that
cannot find a player by name, Overwatch has none at all, and Hearthstone has a
card database and nothing about players. Each client uses the source that
actually has the data, which for three of the six is not Blizzard.
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
    player_stats,
    total,
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

__all__ = [
    "Overwatch2Client",
    "StarCraft2Client",
    "Warcraft3Client",
    "HeroesOfTheStormClient",
    "WorldOfWarcraftClient",
    "HearthstoneClient",
]


class Overwatch2Client(TitleClient):
    """Overwatch 2, through OverFast.

    OverFast reads the official career pages, so it sees exactly what Blizzard
    publishes: career totals and per-role competitive ranks, but **no match
    history** - Blizzard has never published one. The title reflects that.
    """

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        tag = parsed.battle_tag or parsed.name
        if not tag:
            raise ValidationError("Overwatch 2 needs a BattleTag, e.g. Player#1234")
        summary = await providers.overfast(self.runtime).get_summary(tag)
        return self.ref(
            provider_id="overfast",
            id=tag,
            display_name=as_str(summary.get("username")),
            platform="battlenet",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        summary = await providers.overfast(self.runtime).get_summary(ref.id)
        return PlayerProfile(
            ref=ref,
            display_name=str(summary.get("username") or ref.id),
            level=as_int((summary.get("endorsement") or {}).get("level")),
            avatar_url=as_str(summary.get("avatar")),
            is_private=summary.get("privacy") == "private",
            raw=summary,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        stats = await providers.overfast(self.runtime).get_stats(ref.id)

        # OverFast nests as platform -> gamemode -> careerStats -> hero -> category.
        career = stats.get("career_stats") or {}
        heroes = stats.get("heroes_comparisons") or {}
        flat: dict[str, float] = {}
        for category in as_list(career.get("all-heroes")):
            for entry in as_list(category.get("stats")):
                key = as_str(entry.get("key"))
                value = num(entry.get("value"))
                if key and value is not None:
                    flat[key] = value

        modes: dict[str, ModeStats] = {}
        for entry in as_list((heroes.get("time_played") or {}).get("values")):
            hero = as_str(entry.get("hero"))
            if not hero:
                continue
            modes[hero] = mode_stats(
                id=hero,
                label=as_str(entry.get("hero_display_name")) or hero,
                extra={"timePlayedSeconds": num(entry.get("value"))},
            )

        return player_stats(
            ref=ref,
            matches_played=as_int(flat.get("games_played")),
            wins=as_int(flat.get("games_won")),
            losses=as_int(flat.get("games_lost")),
            kills=as_int(flat.get("eliminations")),
            deaths=as_int(flat.get("deaths")),
            time_played_seconds=as_int(flat.get("time_played")),
            modes=modes,
            raw=stats,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        """One rank per role - tank, damage and support are ranked separately."""
        self.require("getRank")
        ref = await self._resolved(query)
        summary = await providers.overfast(self.runtime).get_summary(ref.id)

        ranks: list[RankInfo] = []
        for platform, modes in (summary.get("competitive") or {}).items():
            if not modes:
                continue
            for role, entry in modes.items():
                if not isinstance(entry, dict):
                    continue
                division = entry.get("division")
                ranks.append(
                    RankInfo(
                        ref=ref,
                        queue=f"{platform}:{role}",
                        tier=division.capitalize() if division else None,
                        division=(
                            str(entry["tier"]) if entry.get("tier") is not None else None
                        ),
                        tier_points=as_int(entry.get("tier")),
                        raw=entry,
                    )
                )
        return ranks

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        # Blizzard publishes no Overwatch ladder, so the closest honest answer is
        # the player search - and saying so beats returning an invented ranking.
        rows = await providers.overfast(self.runtime).search_players(
            opts.queue or "", self.limit(opts.limit, 20)
        )
        return [
            LeaderboardEntry(
                position=index + 1,
                player_id=as_str(row.get("player_id")),
                display_name=as_str(row.get("name")),
                raw=row,
            )
            for index, row in enumerate(rows)
        ]

    async def get_metadata(self, kind: str | None = None) -> Any:
        self.require("getMetadata")
        overfast = providers.overfast(self.runtime)
        if kind in (None, "heroes"):
            return await overfast.get_heroes()
        if kind == "maps":
            return await overfast.get_maps()
        raise ValidationError(
            f'Overwatch metadata "{kind}" is not available - try heroes or maps'
        )


class StarCraft2Client(TitleClient):
    """StarCraft II, through SC2Pulse.

    Blizzard's own API cannot find a player by BattleTag and cannot see across
    regions. SC2Pulse does both, which is why it is the primary provider even
    though a first-party option exists.
    """

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        term = str(parsed.battle_tag or parsed.name or parsed.account_id or "")
        results = await providers.sc2pulse(self.runtime).search_characters(term)
        character = ((results[0] if results else {}).get("members") or {}).get(
            "character"
        ) or {}
        identifier = as_str(character.get("id"))
        if not identifier:
            raise NotFoundError("sc2pulse", f'SC2 player "{term}"', self.title.id)

        return self.ref(
            provider_id="sc2pulse",
            id=identifier,
            display_name=as_str(character.get("name")) or term,
            platform="battlenet",
            region=as_str(character.get("region")),
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        summary = await providers.sc2pulse(self.runtime).get_character_summary(ref.id)
        return PlayerProfile(
            ref=ref,
            display_name=ref.display_name or ref.id,
            profile_url=(f"https://sc2pulse.nephest.com/sc2/?type=character&id={ref.id}&m=1"),
            raw=summary,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        summary = await providers.sc2pulse(self.runtime).get_character_summary(ref.id)

        modes: dict[str, ModeStats] = {}
        for row in summary:
            race = as_str(row.get("race")) or "ALL"
            modes[race] = mode_stats(
                id=race,
                matches_played=as_int(row.get("games")),
                extra={
                    "mmr": as_int(row.get("ratingLast") or row.get("ratingMax")),
                    "maxMmr": as_int(row.get("ratingMax")),
                },
            )

        return player_stats(
            ref=ref,
            matches_played=total(as_int(row.get("games")) for row in summary),
            modes=modes,
            raw=summary,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        summary = await providers.sc2pulse(self.runtime).get_character_summary(ref.id)
        return [
            RankInfo(
                ref=ref,
                queue=f"1v1:{as_str(row.get('race')) or 'ALL'}",
                rating=as_int(row.get("ratingLast")),
                raw=row,
            )
            for row in summary
        ]

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        matches = await providers.sc2pulse(self.runtime).get_character_matches(ref.id)

        return [
            MatchSummary(
                match_id=str((row.get("match") or {}).get("id") or ""),
                title_id=self.title.id,
                mode=as_str((row.get("match") or {}).get("type")) or "1v1",
                map=as_str((row.get("map") or {}).get("name")),
                started_at=ts((row.get("match") or {}).get("date")),
                duration_seconds=as_int((row.get("match") or {}).get("duration")),
                result=match_result(str(row.get("decision") or "").upper() == "WIN"),
                raw=row,
            )
            for row in matches[: self.limit(opts.limit)]
        ]

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        region = opts.region or "eu"
        region_id = {"us": 1, "eu": 2, "kr": 3, "tw": 3}.get(region.lower(), 2)
        ladder = await providers.blizzard(self.runtime).get_sc2_grandmaster_ladder(
            region, region_id
        )

        entries = []
        for index, team in enumerate((ladder or {}).get("ladderTeams") or []):
            members = as_list(team.get("teamMembers"))
            first = members[0] if members else {}
            entries.append(
                LeaderboardEntry(
                    position=index + 1,
                    player_id=as_str(first.get("id")),
                    display_name=as_str(first.get("displayName")),
                    rating=as_int(team.get("mmr") or team.get("points")),
                    tier="Grandmaster",
                    wins=as_int(team.get("wins")),
                    losses=as_int(team.get("losses")),
                    raw=team,
                )
            )
        return entries[: self.limit(opts.limit, 100)]


class Warcraft3Client(TitleClient):
    """Warcraft III, through W3Champions - the ladder the game is played on."""

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        tag = str(parsed.battle_tag or parsed.name or "")
        player = await providers.w3champions(self.runtime).get_player(tag)
        return self.ref(
            provider_id="w3champions",
            id=tag,
            display_name=as_str(player.get("name")) or tag,
            platform="battlenet",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        player = await providers.w3champions(self.runtime).get_player(ref.id)
        from urllib.parse import quote

        return PlayerProfile(
            ref=ref,
            display_name=str(player.get("name") or ref.id),
            profile_url=f"https://w3champions.com/player/{quote(ref.id, safe='')}",
            country=as_str(player.get("location")),
            raw=player,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        stats = await providers.w3champions(self.runtime).get_player_stats(ref.id)

        modes: dict[str, ModeStats] = {}
        for row in stats:
            key = (
                f"{as_str(row.get('gameMode')) or '1v1'}:{as_str(row.get('race')) or 'RANDOM'}"
            )
            modes[key] = mode_stats(
                id=key,
                wins=as_int(row.get("wins")),
                losses=as_int(row.get("losses")),
                extra={
                    "mmr": as_int(row.get("mmr")),
                    "rank": as_int(row.get("rank")),
                    "league": as_int(row.get("leagueId")),
                },
            )

        return player_stats(
            ref=ref,
            wins=total(as_int(row.get("wins")) for row in stats),
            losses=total(as_int(row.get("losses")) for row in stats),
            modes=modes,
            raw=stats,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        stats = await providers.w3champions(self.runtime).get_player_stats(ref.id)
        return [
            RankInfo(
                ref=ref,
                queue=f"{as_str(row.get('gameMode')) or '1v1'}:"
                f"{as_str(row.get('race')) or 'RANDOM'}",
                tier=as_str(row.get("leagueName")),
                division=as_str(row.get("division")),
                rating=as_int(row.get("mmr")),
                position=as_int(row.get("rank")),
                wins=as_int(row.get("wins")),
                losses=as_int(row.get("losses")),
                season=as_str(row.get("season")),
                raw=row,
            )
            for row in stats
        ]

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        matches = await providers.w3champions(self.runtime).get_matches(
            ref.id, limit=self.limit(opts.limit), offset=opts.offset or 0
        )

        summaries = []
        for match in matches:
            my_team = None
            for team in as_list(match.get("teams")):
                if any(
                    str(player.get("battleTag", "")).lower() == ref.id.lower()
                    for player in as_list(team.get("players"))
                ):
                    my_team = team
                    break
            summaries.append(
                MatchSummary(
                    match_id=str(match.get("id") or ""),
                    title_id=self.title.id,
                    mode=as_str(match.get("gameMode")),
                    map=as_str(match.get("map")),
                    started_at=ts(match.get("startTime")),
                    duration_seconds=as_int(match.get("durationInSeconds")),
                    result=(
                        match_result(my_team.get("won")) if my_team else MatchResult.UNKNOWN
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
        gateway = {"eu": 20, "us": 10, "kr": 30}.get((opts.region or "eu").lower(), 20)
        ladder = await providers.w3champions(self.runtime).get_ladder(1, gateway=gateway)
        return [
            LeaderboardEntry(
                position=as_int(row.get("rankNumber")) or index + 1,
                player_id=as_str(row.get("playerId") or row.get("id")),
                display_name=as_str(row.get("player1Id") or row.get("name")),
                rating=as_int(row.get("rankingPoints") or row.get("mmr")),
                tier=as_str(row.get("leagueName")),
                wins=as_int(row.get("wins")),
                losses=as_int(row.get("losses")),
                raw=row,
            )
            for index, row in enumerate(ladder[: self.limit(opts.limit, 100)])
        ]


class HeroesOfTheStormClient(TitleClient):
    """Heroes of the Storm, through Heroes Profile - replay-derived."""

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        tag = str(parsed.battle_tag or parsed.name or "")
        await providers.heroes_profile(self.runtime).get_player(tag)
        return self.ref(
            provider_id="heroesprofile",
            id=tag,
            display_name=tag,
            platform="battlenet",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        player = await providers.heroes_profile(self.runtime).get_player(ref.id)
        return PlayerProfile(ref=ref, display_name=ref.display_name or ref.id, raw=player)

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        heroes = await providers.heroes_profile(self.runtime).get_hero_stats(ref.id)

        modes: dict[str, ModeStats] = {
            hero: mode_stats(
                id=hero,
                wins=as_int((row or {}).get("wins")),
                losses=as_int((row or {}).get("losses")),
                extra={"mmr": as_int((row or {}).get("mmr"))},
            )
            for hero, row in heroes.items()
            if isinstance(row, dict)
        }

        return player_stats(
            ref=ref,
            wins=total(mode.wins for mode in modes.values()),
            losses=total(mode.losses for mode in modes.values()),
            modes=modes,
            raw=heroes,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        mmr = await providers.heroes_profile(self.runtime).get_matches(ref.id)
        latest = mmr[0] if mmr else None
        if not latest:
            return []
        return [
            RankInfo(
                ref=ref,
                queue=as_str(latest.get("game_type")) or "ranked",
                rating=as_int(latest.get("mmr") or latest.get("player_conservative_rating")),
                raw=latest,
            )
        ]

    async def get_match_history(
        self, query: Any, options: MatchHistoryOptions | None = None
    ) -> list[MatchSummary]:
        self.require("getMatchHistory")
        opts = options or MatchHistoryOptions()
        ref = await self._resolved(query)
        matches = await providers.heroes_profile(self.runtime).get_matches(ref.id)

        return [
            MatchSummary(
                match_id=str(match.get("replayID") or match.get("replay_id") or ""),
                title_id=self.title.id,
                mode=as_str(match.get("game_type")),
                map=as_str(match.get("game_map")),
                started_at=ts(match.get("game_date")),
                duration_seconds=as_int(match.get("game_length")),
                result=match_result(as_int(match.get("winner")) == 1),
                raw=match,
            )
            for match in matches[: self.limit(opts.limit)]
        ]


class WorldOfWarcraftClient(TitleClient):
    """World of Warcraft.

    Blizzard has the character and the arena brackets; Raider.IO has the Mythic+
    score the competitive scene is organised around. Both are used, which is why
    ``get_player_stats`` merges them.
    """

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        self.require_identifier(parsed)
        name = str(parsed.name or "")
        # WoW characters are `name-realm`; realm may also arrive in extra.realm.
        character, _, realm_from_name = name.partition("-")
        realm = str(parsed.extra.get("realm") or realm_from_name or "")
        if not realm:
            raise ValidationError(
                "World of Warcraft needs a realm - pass name as "
                '"Character-Realm" or set extra={"realm": ...}'
            )
        return self.ref(
            provider_id="blizzard",
            id=f"{character}-{realm}",
            display_name=character or name,
            platform="battlenet",
            region=self.region(parsed.region, "eu"),
        )

    def _split(self, ref: PlayerRef) -> tuple[str, str, str]:
        name, _, realm = ref.id.partition("-")
        return name.lower(), realm.lower(), ref.region or "eu"

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        name, realm, region = self._split(ref)
        character = await providers.blizzard(self.runtime).get_wow_character(
            region, realm, name
        )
        return PlayerProfile(
            ref=ref,
            display_name=str(character.get("name") or ref.id),
            level=as_int(character.get("level")),
            last_seen_at=ts(character.get("last_login_timestamp")),
            clan=as_str((character.get("guild") or {}).get("name")),
            raw=character,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        name, realm, region = self._split(ref)
        try:
            raiderio = await providers.raiderio(self.runtime).get_character(
                region, realm, name
            )
        except Exception:  # noqa: BLE001 - Raider.IO is a supplement, not a source
            raiderio = {}

        seasons = as_list(raiderio.get("mythic_plus_scores_by_season"))
        scores = (seasons[0] if seasons else {}).get("scores") or {}

        return player_stats(
            ref=ref,
            modes={
                role: mode_stats(id=role, extra={"score": score})
                for role, score in scores.items()
            },
            raw=raiderio,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        """Arena and rated battleground standings."""
        self.require("getRank")
        ref = await self._resolved(query)
        name, realm, region = self._split(ref)
        blizzard = providers.blizzard(self.runtime)

        ranks: list[RankInfo] = []
        for bracket in ("2v2", "3v3", "rbg"):
            try:
                payload = await blizzard.get_wow_pvp_bracket(region, realm, name, bracket)
            except Exception:  # noqa: BLE001 - a never-played bracket answers 404
                payload = None
            if not payload:
                continue
            statistics = payload.get("season_match_statistics") or {}
            ranks.append(
                RankInfo(
                    ref=ref,
                    queue=bracket,
                    rating=as_int(payload.get("rating")),
                    wins=as_int(statistics.get("won")),
                    losses=as_int(statistics.get("lost")),
                    season=as_str((payload.get("season") or {}).get("id")),
                    raw=payload,
                )
            )
        return ranks

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        region = self.region(opts.region, "eu")
        season = int(opts.season or 37)
        board = await providers.blizzard(self.runtime).get_wow_pvp_leaderboard(
            region, season, opts.queue or "3v3"
        )

        entries = []
        for row in ((board or {}).get("entries") or [])[: self.limit(opts.limit, 100)]:
            character = row.get("character") or {}
            statistics = row.get("season_match_statistics") or {}
            entries.append(
                LeaderboardEntry(
                    position=as_int(row.get("rank")) or 0,
                    player_id=as_str(character.get("id")),
                    display_name=as_str(character.get("name")),
                    rating=as_int(row.get("rating")),
                    wins=as_int(statistics.get("won")),
                    losses=as_int(statistics.get("lost")),
                    raw=row,
                )
            )
        return entries


class HearthstoneClient(TitleClient):
    """Hearthstone.

    Metadata only. Blizzard has never published a Hearthstone player endpoint, so
    the title declares ``getMetadata`` and the esports capabilities and nothing
    else - asking it for a rank raises, which is the truthful answer.
    """

    async def get_metadata(self, kind: str | None = None) -> Any:
        self.require("getMetadata")
        blizzard = providers.blizzard(self.runtime)
        if kind == "cards":
            return await blizzard.get_hearthstone_cards("eu")
        if kind in (None, "metadata"):
            return await blizzard.get_hearthstone_metadata("eu")
        raise ValidationError(
            f'Hearthstone metadata "{kind}" is not available - try "cards" or "metadata"'
        )
