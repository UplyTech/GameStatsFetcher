"""The long-running worlds: RuneScape, Old School RuneScape, EVE Online and Diablo III.

None of these has matchmaking, and three of the four have no esports circuit at
all. They are here for the reason the package exists: a player asks "how am I
doing", and there is a real, published, first-party API that answers.

What they have in common is that **progress is the rank**. There is no MMR to
report - there is a skill total, a security status, a paragon level - so each
client maps whatever its game counts into the same :class:`RankInfo`, and says
in ``queue`` what it actually counted.

The mirror of ``typescript/src/games/persistent.ts``, method for method.
"""

from __future__ import annotations

import asyncio
from typing import Any

from .. import providers
from ..errors import NotFoundError, ValidationError
from ..normalize import as_int, as_str, mode_stats, player_stats
from ..providers.persistent import RuneScapeGame
from ..title_client import TitleClient, as_query
from ..types import (
    LeaderboardEntry,
    LeaderboardOptions,
    ModeStats,
    PlayerProfile,
    PlayerQuery,
    PlayerRef,
    PlayerStats,
    RankInfo,
)

__all__ = [
    "OldSchoolRuneScapeClient",
    "RuneScapeClient",
    "EveOnlineClient",
    "DiabloThreeClient",
]


# ---------------------------------------------------------------------------
# RuneScape and Old School RuneScape
# ---------------------------------------------------------------------------


class _RuneScapeBase(TitleClient):
    """The shared half of the two RuneScape clients.

    One API, two games, one path segment between them - so the only thing the
    subclasses supply is which game they are.

    **A name is the identifier, and it is not stable.** Jagex has no public
    account id. The display name is the key, and a player can change it, which
    means a stored name can silently start pointing at somebody else. That is a
    property of the upstream and it is written down here rather than papered
    over: ``resolve_player`` returns the name as the id because there is nothing
    better to return.
    """

    #: Which of the two hiscore tables this client reads.
    _game: RuneScapeGame

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        name = as_str(parsed.name or parsed.account_id)
        if not name:
            raise ValidationError("RuneScape is looked up by display name; pass `name`")
        # Asking for the hiscores is the only way to find out whether the name
        # exists, so the resolve is the lookup. The provider caches it, which is
        # why calling resolve and then get_rank costs one request rather than two.
        await providers.jagex(self.runtime).get_hiscores(self._game, name)
        return self.ref(provider_id="jagex", id=name, display_name=name, platform="web")

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        entry = await providers.jagex(self.runtime).get_hiscores(self._game, ref.id)
        skills = entry.get("skills") or []
        overall = skills[0] if skills else {}
        return PlayerProfile(
            ref=ref,
            display_name=ref.display_name or ref.id,
            # The overall *level* is the closest thing the hiscores have to an
            # account level, and it is what every RuneScape player means by
            # "level".
            level=as_int(overall.get("level")),
            raw=entry,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        entry = await providers.jagex(self.runtime).get_hiscores(self._game, ref.id)

        # Every skill is a mode, and so is every activity. A boss kill count and
        # a Slayer level are not the same kind of number, so the two are kept
        # apart by an ``id`` prefix rather than merged into one namespace.
        modes: dict[str, ModeStats] = {}
        for skill in entry.get("skills") or []:
            key = f"skill:{skill.get('id')}"
            modes[key] = mode_stats(
                id=key,
                label=str(skill.get("name") or key),
                extra={
                    "level": skill.get("level"),
                    "xp": skill.get("xp"),
                    "rank": skill.get("rank"),
                },
            )
        for activity in entry.get("activities") or []:
            key = f"activity:{activity.get('id')}"
            modes[key] = mode_stats(
                id=key,
                label=str(activity.get("name") or key),
                extra={"score": activity.get("score"), "rank": activity.get("rank")},
            )

        # Skills are not matches. Reporting a made-up match count would be worse
        # than reporting none, so every match-shaped field stays None.
        return player_stats(ref=ref, modes=modes, raw=entry)

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        entry = await providers.jagex(self.runtime).get_hiscores(self._game, ref.id)

        # One rank per skill, the overall one first. A caller who wants "the"
        # rank takes the first; a caller building a skill page has the rest.
        ranks: list[RankInfo] = []
        for skill in entry.get("skills") or []:
            if skill.get("rank") is None:
                continue
            level = skill.get("level")
            ranks.append(
                RankInfo(
                    ref=ref,
                    queue=str(skill.get("name") or ""),
                    tier=None if level is None else f"Level {level}",
                    tier_points=as_int(skill.get("xp")),
                    position=as_int(skill.get("rank")),
                    raw=skill,
                )
            )
        return ranks


class OldSchoolRuneScapeClient(_RuneScapeBase):
    """Old School RuneScape."""

    _game: RuneScapeGame = "osrs"


class RuneScapeClient(_RuneScapeBase):
    """RuneScape, the modern line."""

    _game: RuneScapeGame = "rs3"


# ---------------------------------------------------------------------------
# EVE Online
# ---------------------------------------------------------------------------


class EveOnlineClient(TitleClient):
    """EVE Online.

    The public half of ESI: who a character is, who they fly for, and how far
    their security status has fallen. Everything a caller would need a login for
    - assets, wallet, skills - is out of scope, and the registry does not claim
    it.
    """

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        eve = providers.eve(self.runtime)

        # A numeric id is already the answer; a name has to be looked up. Both
        # are accepted because a caller storing ids should not have to pretend
        # to have a name.
        identifier = as_int(parsed.account_id)
        if identifier is not None and identifier > 0:
            character = await eve.get_character(identifier)
            return self.ref(
                provider_id="eve-esi",
                id=str(character["id"]),
                display_name=str(character["name"]),
                platform="web",
            )

        name = as_str(parsed.name)
        if not name:
            raise ValidationError(
                "EVE Online needs a character `name` or a numeric `account_id`"
            )
        found = await eve.resolve_character(name)
        return self.ref(
            provider_id="eve-esi",
            id=str(found["id"]),
            display_name=str(found["name"]),
            platform="web",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        eve = providers.eve(self.runtime)
        character = await eve.get_character(int(ref.id))

        # The corporation is the closest thing EVE has to a clan, and it is one
        # extra call. Alliances are looked up only when the character is in one.
        corporation = (
            await eve.get_corporation(character["corporationId"])
            if character.get("corporationId")
            else None
        )

        return PlayerProfile(
            ref=ref,
            display_name=str(character["name"]),
            avatar_url=f"https://images.evetech.net/characters/{character['id']}/portrait",
            created_at=_iso_ms(character.get("birthday")),
            clan=str(corporation["name"]) if corporation else None,
            raw={"character": character, "corporation": corporation},
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        eve = providers.eve(self.runtime)
        character = await eve.get_character(int(ref.id))

        async def corporation_or_none() -> dict[str, Any] | None:
            identifier = character.get("corporationId")
            return await eve.get_corporation(identifier) if identifier else None

        async def alliance_or_none() -> dict[str, Any] | None:
            identifier = character.get("allianceId")
            return await eve.get_alliance(identifier) if identifier else None

        # Two independent lookups that both need only the ids the character
        # record already carried. Sequentially they are two round trips deep for
        # one profile page; together they are one.
        corporation, alliance = await asyncio.gather(corporation_or_none(), alliance_or_none())
        security = character.get("securityStatus")

        return player_stats(
            ref=ref,
            modes={
                "standing": mode_stats(
                    id="standing",
                    label="Standing",
                    extra={
                        # Permille, because -4.9 and -5.0 mean different things
                        # at a gate and rounding to an integer would lose exactly
                        # that difference.
                        "securityStatusPermille": None
                        if security is None
                        else round(security * 1_000),
                        "corporation": corporation["name"] if corporation else None,
                        "corporationTicker": corporation["ticker"] if corporation else None,
                        "alliance": alliance["name"] if alliance else None,
                        "allianceTicker": alliance["ticker"] if alliance else None,
                    },
                )
            },
            raw={"character": character, "corporation": corporation, "alliance": alliance},
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        character = await providers.eve(self.runtime).get_character(int(ref.id))
        security = character.get("securityStatus")
        if security is None:
            return []
        return [
            RankInfo(
                ref=ref,
                queue="security-status",
                rating=round(security * 1_000),
                raw=character,
            )
        ]

    async def get_metadata(self, kind: str | None = "status") -> Any:
        self.require("getMetadata")
        if kind not in (None, "status"):
            raise ValidationError(f'EVE Online exposes "status"; asked for "{kind}"')
        return await providers.eve(self.runtime).get_server_status()


def _iso_ms(value: Any) -> int | None:
    """An ISO-8601 instant as epoch milliseconds, or ``None``."""
    if not isinstance(value, str) or not value:
        return None
    from datetime import datetime

    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return int(parsed.timestamp() * 1_000)


# ---------------------------------------------------------------------------
# Diablo III
# ---------------------------------------------------------------------------


class DiabloThreeClient(TitleClient):
    """Diablo III.

    A career is a list of heroes and a paragon level; the ladder is the seasonal
    Greater Rift leaderboard. Both come from Blizzard's own API, on the same
    credential as World of Warcraft and StarCraft II.

    **The leaderboard is a leaderboard of parties.** A four-player Greater Rift
    record belongs to the group that set it. The entry therefore names one of
    them and carries the rest in ``raw``, rather than being split into four rows
    that would each claim the same clear.
    """

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        self.require("resolvePlayer")
        parsed = as_query(query)
        tag = as_str(parsed.battle_tag or parsed.name)
        if not tag:
            raise ValidationError("Diablo III is looked up by BattleTag; pass `battle_tag`")
        region = self.region(parsed.region, "us")
        profile = await providers.blizzard(self.runtime).get_d3_profile(region, tag)
        return self.ref(
            provider_id="blizzard",
            id=tag.replace("#", "-"),
            display_name=as_str(profile.get("battleTag")) or tag,
            region=region,
            platform="battlenet",
        )

    async def get_player(self, query: Any) -> PlayerProfile:
        self.require("getPlayer")
        ref = await self._resolved(query)
        profile = await providers.blizzard(self.runtime).get_d3_profile(
            ref.region or "us", ref.id
        )
        last_updated = as_int(profile.get("lastUpdated"))
        return PlayerProfile(
            ref=ref,
            display_name=as_str(profile.get("battleTag")) or ref.id,
            level=as_int(profile.get("paragonLevel")),
            last_seen_at=None if last_updated is None else last_updated * 1_000,
            clan=as_str(profile.get("guildName")),
            raw=profile,
        )

    async def get_player_stats(self, query: Any) -> PlayerStats:
        self.require("getPlayerStats")
        ref = await self._resolved(query)
        profile = await providers.blizzard(self.runtime).get_d3_profile(
            ref.region or "us", ref.id
        )

        # One mode per hero. A dead hero is still a hero and is reported,
        # because hardcore deaths are the statistic Diablo players discuss.
        modes: dict[str, ModeStats] = {}
        heroes = profile.get("heroes")
        for raw in heroes if isinstance(heroes, list) else []:
            hero = raw if isinstance(raw, dict) else {}
            identifier = as_str(hero.get("id")) or str(len(modes))
            key = f"hero:{identifier}"
            modes[key] = mode_stats(
                id=key,
                label=as_str(hero.get("name")) or f"Hero {identifier}",
                extra={
                    "class": as_str(hero.get("class")),
                    "level": as_int(hero.get("level")),
                    "paragonLevel": as_int(hero.get("paragonLevel")),
                    "hardcore": "true" if hero.get("hardcore") is True else "false",
                    "seasonal": "true" if hero.get("seasonal") is True else "false",
                    "dead": "true" if hero.get("dead") is True else "false",
                },
            )

        kills = profile.get("kills")
        return player_stats(
            ref=ref,
            kills=as_int(kills.get("elites")) if isinstance(kills, dict) else None,
            modes=modes,
            raw=profile,
        )

    async def get_rank(self, query: Any) -> list[RankInfo]:
        self.require("getRank")
        ref = await self._resolved(query)
        profile = await providers.blizzard(self.runtime).get_d3_profile(
            ref.region or "us", ref.id
        )

        ranks: list[RankInfo] = []
        # Paragon is the only persistent number Diablo III has that everybody
        # compares. It is a level rather than a rating, and is reported as one.
        paragon = as_int(profile.get("paragonLevel"))
        if paragon is not None:
            ranks.append(
                RankInfo(
                    ref=ref,
                    queue="paragon",
                    tier=f"Paragon {paragon}",
                    tier_points=paragon,
                    raw=profile,
                )
            )
        seasonal = as_int(profile.get("paragonLevelSeason"))
        if seasonal is not None:
            ranks.append(
                RankInfo(
                    ref=ref,
                    queue="paragon-season",
                    tier=f"Paragon {seasonal}",
                    tier_points=seasonal,
                    season="current" if profile.get("seasonalProfiles") else None,
                    raw=profile,
                )
            )
        return ranks

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        self.require("getLeaderboard")
        opts = options or LeaderboardOptions()
        region = self.region(opts.region, "us")
        board = as_str(opts.queue) or "rift-barbarian"

        # A season has to be named. Guessing "the current one" would mean caching
        # a number that changes without warning, so the season index is asked for
        # and the highest one is used when the caller does not say.
        season = as_int(opts.season)
        if season is None:
            season = await self._current_season(region)
        if season is None:
            raise NotFoundError("blizzard", "a Diablo III season", "diablo-3")

        payload = await providers.blizzard(self.runtime).get_d3_season_leaderboard(
            region, season, board
        )
        rows = (payload or {}).get("row")
        rows = rows if isinstance(rows, list) else []

        entries: list[LeaderboardEntry] = []
        for index, raw in enumerate(rows[: self.limit(opts.limit, 50)]):
            row = raw if isinstance(raw, dict) else {}
            players = row.get("player")
            players = players if isinstance(players, list) else []
            first = players[0] if players and isinstance(players[0], dict) else {}
            data = row.get("data")
            data = data if isinstance(data, list) else []
            rift_level = next(
                (
                    entry
                    for entry in data
                    if isinstance(entry, dict) and entry.get("id") == "RiftLevel"
                ),
                {},
            )
            name = as_str(first.get("data")) or as_str(first.get("accountId"))
            entries.append(
                LeaderboardEntry(
                    position=index + 1,
                    player_id=as_str(first.get("accountId")) or name,
                    display_name=name or f"Party {index + 1}",
                    rating=as_int(rift_level.get("number")),
                    raw=row,
                )
            )
        return entries

    async def get_metadata(self, kind: str | None = "seasons") -> Any:
        self.require("getMetadata")
        if kind not in (None, "seasons"):
            raise ValidationError(f'Diablo III exposes "seasons"; asked for "{kind}"')
        return await providers.blizzard(self.runtime).get_d3_season_index("us")

    async def _current_season(self, region: str) -> int | None:
        """The highest season Blizzard lists, used when the caller names none."""
        index = await providers.blizzard(self.runtime).get_d3_season_index(region)
        current = as_int((index or {}).get("currentSeason"))
        if current is not None:
            return current
        seasons = (index or {}).get("season")
        numbers = [
            as_int(entry.get("seasonId"))
            for entry in (seasons if isinstance(seasons, list) else [])
            if isinstance(entry, dict)
        ]
        found = [value for value in numbers if value is not None]
        return max(found) if found else None
