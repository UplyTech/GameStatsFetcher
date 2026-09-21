"""The canonical domain model.

Fifty-one game APIs disagree about almost everything: what a player is called,
whether a rank is a number or a string, whether a match knows who won. This
module is the one place where that stops. Every title client maps its upstream
payload onto the shapes below, and every caller reads the same shapes no matter
which title they asked about.

Two rules keep the model honest:

1. **Nothing is invented.** A field the upstream API does not provide is
   ``None``, never a plausible-looking default. A ``None`` rank means "this API
   does not tell us", and a caller can act on that; a ``0`` would be a lie.
2. **The raw payload always survives.** Normalisation loses detail by
   definition, so every normalised object carries the untouched upstream
   response in ``raw``. Callers who need the one field this package did not
   model are never blocked on a release.

Every dataclass here mirrors an interface in the TypeScript edition, field for
field. The field names are snake_case because this is Python; the JSON keys the
registries use stay camelCase, so one spelling appears in the shared data files
and the diffs stay readable.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Any

__all__ = [
    "Platform",
    "PlayerQuery",
    "PlayerRef",
    "PlayerProfile",
    "ModeStats",
    "PlayerStats",
    "RankInfo",
    "MatchResult",
    "MatchParticipantStats",
    "MatchTeam",
    "MatchParticipant",
    "MatchRound",
    "MatchSummary",
    "MatchDetail",
    "MatchHistoryOptions",
    "LeaderboardEntry",
    "LeaderboardOptions",
    "EsportsMatchStatus",
    "EsportsOpponent",
    "EsportsStream",
    "EsportsTournamentRef",
    "EsportsMatch",
    "EsportsTournament",
    "EsportsTeam",
    "EsportsPlayer",
    "EsportsStanding",
    "PrizeEarningsByTitle",
    "PrizeEarnings",
    "EsportsQueryOptions",
    "Capability",
    "Genre",
    "TitleStatus",
    "AuthKind",
    "ProviderDescriptor",
    "TitleDescriptor",
    "CacheDriver",
    "QUERY_FIELD_ALIASES",
    "RetryConfig",
    "RateLimitConfig",
    "RedisConfig",
    "CacheConfig",
]

# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------

#: Platform a player account lives on.
Platform = str

#: Broad genre, used for filtering the registry.
Genre = str

#: How current a title is on the professional circuit.
TitleStatus = str

#: How a provider authenticates. Drives key checks and error messages.
AuthKind = str

#: A method name on the canonical surface.
Capability = str

#: Where cached responses go.
CacheDriver = str

#: The registry's identifier spelling, mapped onto this edition's field names.
#:
#: ``shared/registry/titles.json`` lists identifiers as ``steamId``,
#: ``battleTag`` and so on, because it is one file read by two editions and the
#: TypeScript one names them that way. Rather than translate the registry at
#: load - which would make the two editions disagree about their own data - the
#: translation lives here, and :meth:`PlayerQuery.get` is the only place that
#: needs it.
#:
#: Callers get it for free: someone copying ``{"steamId": ...}`` out of the
#: TypeScript documentation is understood rather than silently ignored.
QUERY_FIELD_ALIASES: Mapping[str, str] = MappingProxyType(
    {
        "steamId": "steam_id",
        "gameName": "game_name",
        "tagLine": "tag_line",
        "battleTag": "battle_tag",
        "playerTag": "player_tag",
        "epicId": "epic_id",
        "ubisoftId": "ubisoft_id",
        "membershipId": "membership_id",
        "accountId": "account_id",
    }
)


@dataclass(frozen=True)
class PlayerQuery:
    """How a caller asks for a player.

    Different titles accept different things, and most accept several. The
    resolver takes whatever is present and turns it into a :class:`PlayerRef`;
    a title that cannot work with any of the supplied fields says so with an
    :class:`~gamestatsfetcher.errors.IdentifierError` rather than guessing.
    """

    #: SteamID64 as a decimal string. Steam-backed titles.
    steam_id: str | None = None
    #: Riot PUUID. Preferred for every Riot title - it never changes.
    puuid: str | None = None
    #: Riot ID game name (the part before the hash).
    game_name: str | None = None
    #: Riot ID tag line (the part after the hash), without the hash.
    tag_line: str | None = None
    #: Display name / gamertag / in-game name, for titles that search by it.
    name: str | None = None
    #: Battle.net BattleTag, e.g. ``Player#1234``.
    battle_tag: str | None = None
    #: Supercell player tag, e.g. ``#2PP``. The leading hash is optional.
    player_tag: str | None = None
    #: Epic Games account id.
    epic_id: str | None = None
    #: Ubisoft profile id.
    ubisoft_id: str | None = None
    #: Bungie membership id.
    membership_id: str | None = None
    #: Numeric account id, for APIs that use one (osu!, Wargaming, iRacing).
    account_id: str | int | None = None
    #: Platform to search on, where the API needs one.
    platform: Platform | None = None
    #: Region / shard / realm, where the API is regionalised.
    region: str | None = None
    #: Anything else the specific title client documents.
    extra: Mapping[str, Any] = field(default_factory=dict)

    def get(self, key: str) -> Any:
        """Read a field by its name, in either vocabulary.

        The registry names identifiers in the wire spelling - ``steamId``,
        ``battleTag``, ``accountId`` - because it is one JSON file read by both
        editions. This class names them the way Python does. Every piece of
        generic machinery that walks ``title.identifiers`` arrives here, so the
        translation happens once, at the seam, rather than at each call site.

        Getting this wrong is not a small bug: ``getattr(query, "steamId")`` is
        ``None``, so every Steam-backed title would reject a perfectly good
        query with :class:`~gamestatsfetcher.errors.IdentifierError`.
        """
        return getattr(self, QUERY_FIELD_ALIASES.get(key, key), None)

    def replace(self, **changes: Any) -> PlayerQuery:
        """A copy with some fields changed. The query itself is frozen."""
        from dataclasses import replace as _replace

        return _replace(self, **changes)


@dataclass(frozen=True)
class PlayerRef:
    """A resolved, canonical handle on one player of one title.

    This is what every ``resolve_player`` returns and what every other player
    method accepts. Resolving once and re-using the ref saves the lookup call
    that most of these APIs charge for.
    """

    #: The title this ref belongs to. A ref is never portable between titles.
    title_id: str
    #: The provider that resolved it.
    provider_id: str
    #: The identifier the provider's own endpoints expect.
    id: str
    #: Human-readable name at resolve time. Display only - names change.
    display_name: str | None = None
    #: Platform the account lives on, when the API distinguishes them.
    platform: Platform | None = None
    #: Region / shard the account belongs to, when the API is regionalised.
    region: str | None = None


# ---------------------------------------------------------------------------
# Player data
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PlayerProfile:
    """A player's public profile, as far as the title's API exposes one."""

    ref: PlayerRef
    display_name: str
    #: Account level / renown / summoner level. ``None`` when the title has none.
    level: int | None = None
    avatar_url: str | None = None
    #: Profile page on the provider's own site.
    profile_url: str | None = None
    #: Account creation time, epoch milliseconds.
    created_at: int | None = None
    #: Last seen / last login, epoch milliseconds.
    last_seen_at: int | None = None
    #: ISO-3166 alpha-2 country code, when public.
    country: str | None = None
    #: Clan / team / guild name, when the API exposes one.
    clan: str | None = None
    #: True when the profile is private and the numbers below will be thin.
    is_private: bool = False
    raw: Any = None


@dataclass(frozen=True)
class ModeStats:
    """Statistics for one playlist, queue, hero, agent, legend or character."""

    id: str
    label: str
    matches_played: int | None = None
    wins: int | None = None
    losses: int | None = None
    #: Win rate in permille (0..1000), computed from the numbers above.
    win_rate_permille: int | None = None
    kills: int | None = None
    deaths: int | None = None
    assists: int | None = None
    #: Whatever else the mode reports - MMR, accuracy, goals, headshot rate.
    extra: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PlayerStats:
    """Normalised career statistics.

    The fields every competitive title has - and then ``modes`` for the ones
    that split their stats by playlist, queue or character, which is most.
    """

    ref: PlayerRef
    #: Total matches with a recorded result.
    matches_played: int | None = None
    wins: int | None = None
    losses: int | None = None
    draws: int | None = None
    #: Win rate in permille (0..1000). Integer, so it cannot drift.
    win_rate_permille: int | None = None
    kills: int | None = None
    deaths: int | None = None
    assists: int | None = None
    #: K/D in permille: 1500 = 1.5.
    kd_permille: int | None = None
    #: Total time played, in seconds.
    time_played_seconds: int | None = None
    #: Per-mode / per-playlist / per-character breakdown, keyed by mode id.
    modes: Mapping[str, ModeStats] = field(default_factory=dict)
    raw: Any = None


@dataclass(frozen=True)
class RankInfo:
    """A player's competitive standing in one queue.

    Ranks are the single most inconsistent concept across game APIs: a tier name
    here, an integer MMR there, a percentile somewhere else. All three are
    modelled, and a title fills in what it actually knows.
    """

    ref: PlayerRef
    #: Queue / playlist this rank belongs to, e.g. ``RANKED_SOLO_5x5``.
    queue: str
    #: Human label, e.g. ``Diamond 2``, ``Global Elite``, ``Level 10``.
    tier: str | None = None
    #: Division within the tier, where the title has one.
    division: str | None = None
    #: Points inside the tier: LP, RR, stars.
    tier_points: int | None = None
    #: Raw skill rating, where the API exposes a number: MMR, Elo, SR.
    rating: int | float | None = None
    #: Absolute ladder position, where the title publishes one.
    position: int | None = None
    #: Top-x permille of the ladder. 5 = top 0.5 %.
    percentile_permille: int | None = None
    wins: int | None = None
    losses: int | None = None
    #: Season / act / split identifier the rank was earned in.
    season: str | None = None
    raw: Any = None


# ---------------------------------------------------------------------------
# Matches
# ---------------------------------------------------------------------------


class MatchResult(str, Enum):
    """How a match ended for the player it was fetched for."""

    WIN = "win"
    LOSS = "loss"
    DRAW = "draw"
    UNKNOWN = "unknown"

    def __str__(self) -> str:  # pragma: no cover - display only
        return self.value


@dataclass(frozen=True)
class MatchParticipantStats:
    """One player's line on a scoreboard."""

    kills: int | None = None
    deaths: int | None = None
    assists: int | None = None
    score: int | None = None
    damage_dealt: int | None = None
    damage_taken: int | None = None
    healing: int | None = None
    placement: int | None = None
    #: Title-specific numbers that do not fit above: CS, MVPs, goals, saves.
    extra: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class MatchTeam:
    id: str
    name: str | None = None
    won: bool | None = None
    score: int | None = None
    rounds_won: int | None = None


@dataclass(frozen=True)
class MatchParticipant:
    player_id: str
    display_name: str | None = None
    team_id: str | None = None
    #: Champion, agent, hero, legend, operator, car - whatever the title calls it.
    character: str | None = None
    stats: MatchParticipantStats = field(default_factory=MatchParticipantStats)
    raw: Any = None


@dataclass(frozen=True)
class MatchRound:
    index: int
    winning_team_id: str | None = None
    duration_seconds: int | None = None
    raw: Any = None


@dataclass(frozen=True)
class MatchSummary:
    """One row of a player's match history."""

    match_id: str
    title_id: str
    #: Queue / playlist / mode, in the title's own vocabulary.
    mode: str | None = None
    #: Map, arena, track or stage.
    map: str | None = None
    #: Match start, epoch milliseconds.
    started_at: int | None = None
    duration_seconds: int | None = None
    #: Result from the perspective of the queried player.
    result: MatchResult = MatchResult.UNKNOWN
    #: The queried player's row, when the history endpoint includes it.
    player_stats: MatchParticipantStats | None = None
    raw: Any = None


@dataclass(frozen=True)
class MatchDetail(MatchSummary):
    """Everything a title knows about a single match."""

    teams: Sequence[MatchTeam] = ()
    participants: Sequence[MatchParticipant] = ()
    #: Per-round or per-map detail, for titles that have rounds.
    rounds: Sequence[MatchRound] = ()
    #: Game version / patch the match was played on.
    patch: str | None = None


@dataclass(frozen=True)
class MatchHistoryOptions:
    """Options accepted by every ``get_match_history``."""

    #: How many matches to return. Clamped to what the upstream allows.
    limit: int | None = None
    #: Skip this many, for the APIs that page.
    offset: int | None = None
    #: Only matches at or after this epoch-milliseconds timestamp.
    since: int | None = None
    #: Only matches at or before this epoch-milliseconds timestamp.
    until: int | None = None
    #: Restrict to one queue / playlist, in the title's own vocabulary.
    mode: str | None = None
    #: Fetch full detail per match instead of the summary the list endpoint gives.
    hydrate: bool = False


# ---------------------------------------------------------------------------
# Leaderboards
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LeaderboardEntry:
    position: int
    player_id: str | None = None
    display_name: str | None = None
    rating: int | float | None = None
    tier: str | None = None
    wins: int | None = None
    losses: int | None = None
    country: str | None = None
    raw: Any = None


@dataclass(frozen=True)
class LeaderboardOptions:
    limit: int | None = None
    offset: int | None = None
    region: str | None = None
    platform: Platform | None = None
    #: Queue / playlist, where the title has more than one ladder.
    queue: str | None = None
    #: Season / act, where the API lets you pick a past one.
    season: str | None = None


# ---------------------------------------------------------------------------
# The esports layer
# ---------------------------------------------------------------------------


class EsportsMatchStatus(str, Enum):
    """State of a professional fixture."""

    SCHEDULED = "scheduled"
    LIVE = "live"
    FINISHED = "finished"
    POSTPONED = "postponed"
    CANCELLED = "cancelled"
    UNKNOWN = "unknown"

    def __str__(self) -> str:  # pragma: no cover - display only
        return self.value


@dataclass(frozen=True)
class EsportsOpponent:
    id: str
    name: str
    acronym: str | None = None
    logo_url: str | None = None
    score: int | None = None
    #: ``team`` for team titles, ``player`` for 1v1 titles like the fighters.
    kind: str = "team"


@dataclass(frozen=True)
class EsportsStream:
    url: str
    language: str | None = None
    official: bool = False


@dataclass(frozen=True)
class EsportsTournamentRef:
    id: str
    name: str
    slug: str | None = None


@dataclass(frozen=True)
class EsportsMatch:
    """A professional fixture: two opponents, a time, and usually a tournament."""

    id: str
    title_id: str
    name: str | None = None
    status: EsportsMatchStatus = EsportsMatchStatus.UNKNOWN
    scheduled_at: int | None = None
    started_at: int | None = None
    ended_at: int | None = None
    #: Best-of, where the format is known.
    best_of: int | None = None
    opponents: Sequence[EsportsOpponent] = ()
    winner_id: str | None = None
    tournament: EsportsTournamentRef | None = None
    streams: Sequence[EsportsStream] = ()
    provider_id: str = ""
    raw: Any = None


@dataclass(frozen=True)
class EsportsTournament:
    """A professional event: a league split, a major, a weekly online cup."""

    id: str
    name: str
    title_id: str
    slug: str | None = None
    tier: str | None = None
    begin_at: int | None = None
    end_at: int | None = None
    #: Prize pool in the smallest unit of ``prize_pool_currency``, to avoid floats.
    prize_pool_minor: int | None = None
    prize_pool_currency: str | None = None
    region: str | None = None
    online: bool | None = None
    provider_id: str = ""
    raw: Any = None


@dataclass(frozen=True)
class EsportsPlayer:
    """A professional player, as the esports providers see them."""

    id: str
    title_id: str
    nickname: str
    first_name: str | None = None
    last_name: str | None = None
    country: str | None = None
    role: str | None = None
    team_id: str | None = None
    provider_id: str = ""
    raw: Any = None


@dataclass(frozen=True)
class EsportsTeam:
    """A professional roster."""

    id: str
    title_id: str
    name: str
    acronym: str | None = None
    logo_url: str | None = None
    country: str | None = None
    players: Sequence[EsportsPlayer] = ()
    provider_id: str = ""
    raw: Any = None


@dataclass(frozen=True)
class EsportsStanding:
    """One row of a tournament standing table."""

    position: int
    team_id: str | None = None
    team_name: str | None = None
    wins: int | None = None
    losses: int | None = None
    draws: int | None = None
    points: int | None = None
    raw: Any = None


@dataclass(frozen=True)
class PrizeEarningsByTitle:
    title_id: str | None
    title_name: str
    total_usd_cents: int
    tournaments: int | None = None


@dataclass(frozen=True)
class PrizeEarnings:
    """Career prize money, from Esports Earnings."""

    player_id: str
    handle: str
    name: str | None = None
    country: str | None = None
    #: Total in USD cents. Integer, because money is never a float.
    total_usd_cents: int = 0
    by_title: Sequence[PrizeEarningsByTitle] = ()
    raw: Any = None


@dataclass(frozen=True)
class EsportsQueryOptions:
    limit: int | None = None
    page: int | None = None
    since: int | None = None
    until: int | None = None
    status: EsportsMatchStatus | None = None
    #: Force one provider instead of the title's configured preference order.
    provider: str | None = None


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProviderDescriptor:
    """One upstream API."""

    id: str
    label: str
    #: Who runs it. ``first-party`` means the game's publisher.
    kind: str
    base_url: str
    auth: AuthKind
    #: Name of the key in the ``api_keys`` mapping. ``None`` when none is needed.
    key_name: str | None
    #: Where to get a key. Printed in the error when one is missing.
    docs_url: str
    #: Sustained requests per second the provider tolerates.
    rps: float
    #: Burst the provider tolerates.
    burst: float
    #: True when the provider requires a descriptive User-Agent.
    requires_user_agent: bool = False
    #: True when the credential improves the service but is not required.
    optional_auth: bool = False
    #: Free-form note about terms, quotas or gotchas.
    notes: str | None = None


@dataclass(frozen=True)
class TitleDescriptor:
    """One esports title."""

    id: str
    name: str
    #: Alternative spellings a caller might type. Used by ``find_title``.
    aliases: Sequence[str]
    genre: Genre
    publisher: str
    release_year: int
    status: TitleStatus
    #: Providers this title can be served from, best first.
    providers: Sequence[str]
    #: What the title client supports. Anything absent raises, never returns empty.
    capabilities: Sequence[Capability]
    #: Identifier kinds ``resolve_player`` accepts, best first.
    identifiers: Sequence[str]
    #: Valid ``region`` values, when the title is regionalised.
    regions: Sequence[str]
    #: Platforms the title's API distinguishes.
    platforms: Sequence[Platform]
    #: True when the package ships a bespoke client rather than the generic one.
    dedicated_client: bool = False

    def supports(self, capability: Capability) -> bool:
        """True when the title declares this capability."""
        return capability in self.capabilities


# ---------------------------------------------------------------------------
# Client configuration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RateLimitConfig:
    #: Sustained requests per second.
    rps: float
    #: Burst capacity: the most tokens that can accumulate.
    burst: float


@dataclass(frozen=True)
class RetryConfig:
    #: Attempts after the first. ``0`` disables retrying.
    attempts: int | None = None
    #: First backoff step in milliseconds; doubles each attempt.
    base_delay_ms: int | None = None
    #: Upper bound for a single backoff wait.
    max_delay_ms: int | None = None
    #: Status codes worth retrying. Defaults to 408, 429 and the 5xx range.
    retry_on: Sequence[int] | None = None
    #: Respect a ``Retry-After`` header rather than the computed backoff.
    respect_retry_after: bool = True


@dataclass(frozen=True)
class RedisConfig:
    host: str | None = None
    port: int = 6379
    password: str | None = None
    db: int | None = None
    tls: bool = False
    #: Hand in a connected redis client instead of letting us build one.
    client: Any = None


@dataclass(frozen=True)
class CacheConfig:
    #: ``memory`` (default), ``redis`` or ``none``.
    driver: CacheDriver = "memory"
    #: Prefix on every key, so several apps can share one Redis.
    key_prefix: str = "gsf:"
    #: Default TTL in seconds when a method does not specify one.
    default_ttl_seconds: int | None = None
    #: Per-method TTL override, keyed by ``"<title_id>:<method>"`` or ``"<method>"``.
    ttl_overrides: Mapping[str, int] = field(default_factory=dict)
    #: Entries the in-memory driver keeps before evicting the least recently used.
    max_entries: int | None = None
    redis: RedisConfig | None = None
