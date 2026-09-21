"""Defaults, and the reasoning behind the ones that are not obvious.

The TTL table below is the part worth reading. Cache lifetimes are not a
performance knob here, they are a correctness one: a rank cached for an hour is
a rank that is wrong for an hour, and a match history cached for a second burns
quota that most of these APIs charge for by the minute.

Every value in this module is identical to its counterpart in the TypeScript
edition, and ``shared/vectors/constants.json`` proves it.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType
from typing import Final

__all__ = [
    "VERSION",
    "DEFAULT_USER_AGENT",
    "DEFAULT_RPS",
    "DEFAULT_BURST",
    "DEFAULT_RETRY_ATTEMPTS",
    "DEFAULT_RETRY_BASE_DELAY_MS",
    "DEFAULT_RETRY_MAX_DELAY_MS",
    "DEFAULT_RETRY_ON",
    "DEFAULT_TIMEOUT_MS",
    "DEFAULT_MAX_CACHE_ENTRIES",
    "DEFAULT_TTL_SECONDS",
    "TTL",
    "MAX_PAGE_SIZE",
    "PERMILLE",
    "STEAM_APP_IDS",
    "STEAM_ID64_BASE",
]

#: Package version, mirrored into the User-Agent.
VERSION: Final = "3.2.0"

#: Sent on every request unless the caller overrides it.
DEFAULT_USER_AGENT: Final = (
    f"GameStatsFetcher/{VERSION} (+https://github.com/uplytech/game-stats-fetcher)"
)

#: Conservative enough for the strictest provider that publishes no limit.
DEFAULT_RPS: Final = 5.0
DEFAULT_BURST: Final = 10.0

DEFAULT_RETRY_ATTEMPTS: Final = 2
DEFAULT_RETRY_BASE_DELAY_MS: Final = 250
DEFAULT_RETRY_MAX_DELAY_MS: Final = 8_000

#: 408 is in the list because several of these APIs answer a cold cache with one
#: and succeed on the immediate retry.
DEFAULT_RETRY_ON: Final[tuple[int, ...]] = (408, 429, 500, 502, 503, 504)

#: A request that has not answered in 15 s is not going to.
DEFAULT_TIMEOUT_MS: Final = 15_000

#: Entries the in-memory cache holds before it evicts the least recently used.
DEFAULT_MAX_CACHE_ENTRIES: Final = 5_000

#: Used when neither the method nor the caller specifies a TTL.
DEFAULT_TTL_SECONDS: Final = 60

#: How long each kind of answer stays fresh.
#:
#: Chosen from how fast the underlying thing actually changes, not from how
#: often callers ask:
#:
#: - **Static metadata** (champion lists, map pools, card data) changes on a
#:   patch cycle. An hour is still conservative.
#: - **Profiles** change when somebody renames or levels up. Minutes.
#: - **Ranks** change every game. Short, because a Discord bot showing a stale
#:   rank right after a promotion is the complaint this package exists to avoid.
#: - **Match history** is append-only, so the TTL only has to be shorter than a
#:   match.
#: - **A finished match** never changes again, so it is cached for a day. This is
#:   the single biggest quota saver in the package.
#: - **Live esports fixtures** move constantly while an event is running.
TTL: Final[Mapping[str, int]] = MappingProxyType(
    {
        "metadata": 3_600,
        "resolvePlayer": 86_400,
        "player": 300,
        "playerStats": 180,
        "rank": 60,
        "matchHistory": 60,
        "match": 86_400,
        "leaderboard": 300,
        "esportsMatchesLive": 30,
        "esportsMatches": 300,
        "esportsTournaments": 1_800,
        "esportsTeams": 3_600,
        "esportsPlayers": 3_600,
        "standings": 600,
        "earnings": 43_200,
    }
)

#: Upper bound on ``limit``, so a caller cannot ask for a page an API refuses.
MAX_PAGE_SIZE: Final = 500

#: Permille scale, used everywhere a ratio is reported.
PERMILLE: Final = 1_000

#: Steam app ids for the titles served through the Steam Web API.
#:
#: Kept here rather than in each title module because several titles share the
#: Steam client and the ids are the only thing that differs.
STEAM_APP_IDS: Final[Mapping[str, int]] = MappingProxyType(
    {
        "cs2": 730,
        "dota2": 570,
        "team-fortress-2": 440,
        "rust": 252490,
        "rocket-league": 252950,
        "apex-legends": 1172470,
        "pubg": 578080,
        "naraka-bladepoint": 1203220,
        "war-thunder": 236390,
        "dead-by-daylight": 381210,
        "path-of-exile": 238960,
    }
)

#: The 64-bit offset between a SteamID64 and the 32-bit account id.
#:
#: Several Steam-adjacent APIs (OpenDota, Ballchasing, logs.tf, Deadlock) key on
#: the 32-bit form, so this conversion happens constantly.
STEAM_ID64_BASE: Final = 76_561_197_960_265_728
