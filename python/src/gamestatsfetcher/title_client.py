"""The base every title client extends - and, for the titles with no player API,
the whole implementation.

The shape here is what makes "one client for every esports title" true rather
than a slogan. Every title exposes the same fourteen methods. A title that cannot
serve one of them raises :class:`UnsupportedCapabilityError` naming what it *can*
do, and ``title.capabilities`` says so in advance so a caller can branch before
making the call rather than after catching it.

Why unsupported raises instead of returning empty
-------------------------------------------------

An empty list is a legitimate answer to "what matches has this player played".
If ``get_match_history`` returned one for Tekken 8 - which has no player API at
all - the caller could not tell the difference between a quiet week and a
question the title cannot answer. That distinction is worth an exception.
"""

from __future__ import annotations

import functools
from typing import Any

from .constants import MAX_PAGE_SIZE
from .errors import (
    GameStatsError,
    IdentifierError,
    ParseError,
    UnsupportedCapabilityError,
    ValidationError,
)
from .esports import EsportsLayer
from .normalize import clamp
from .runtime import Runtime
from .types import (
    QUERY_FIELD_ALIASES,
    EsportsMatch,
    EsportsPlayer,
    EsportsQueryOptions,
    EsportsStanding,
    EsportsTeam,
    EsportsTournament,
    LeaderboardEntry,
    LeaderboardOptions,
    MatchDetail,
    MatchHistoryOptions,
    MatchSummary,
    PlayerProfile,
    PlayerQuery,
    PlayerRef,
    PlayerStats,
    PrizeEarnings,
    RankInfo,
    TitleDescriptor,
)

__all__ = ["TitleClient", "as_query"]


def as_query(value: PlayerQuery | PlayerRef | dict[str, Any] | str) -> PlayerQuery:
    """Accept the several shapes a caller might reach for.

    A bare string is treated as a name, because that is what a Discord command
    hands you; a mapping is expanded into the query fields, in either spelling -
    ``steam_id`` and ``steamId`` both work, so a snippet copied out of the
    TypeScript documentation does the right thing.

    An unrecognised key is an error rather than something to ignore. Dropping it
    would leave the query empty and surface the typo three layers away, as
    "cs2 cannot resolve a player from the fields given" - which points at the
    caller's input rather than at the one character that was wrong.
    """
    if isinstance(value, PlayerQuery):
        return value
    if isinstance(value, str):
        return PlayerQuery(name=value)
    if isinstance(value, dict):
        known = set(PlayerQuery.__dataclass_fields__)
        fields: dict[str, Any] = {}
        for key, item in value.items():
            field_name = QUERY_FIELD_ALIASES.get(key, key)
            if field_name not in known:
                suggestion = _closest_field(field_name, known)
                raise ValidationError(
                    f'unknown player query field "{key}"'
                    + (f'. Did you mean "{suggestion}"?' if suggestion else "")
                )
            fields[field_name] = item
        return PlayerQuery(**fields)
    raise ValidationError(f"cannot build a PlayerQuery from {type(value).__name__}")


def _closest_field(key: str, known: set[str]) -> str | None:
    """The nearest field name, for the "did you mean" in the error above."""
    import difflib

    matches = difflib.get_close_matches(key.lower(), sorted(known), n=1, cutoff=0.6)
    return matches[0] if matches else None


#: The fourteen methods a caller can reach. Every one of them talks to an
#: upstream this package does not control, so every one of them is wrapped.
CANONICAL_METHODS = (
    "resolve_player",
    "get_player",
    "get_player_stats",
    "get_rank",
    "get_match_history",
    "get_match",
    "get_leaderboard",
    "get_metadata",
    "get_esports_matches",
    "get_esports_tournaments",
    "get_esports_teams",
    "get_esports_players",
    "get_standings",
    "get_earnings",
)

#: What a mapper raises when the payload was not the shape it was written for.
#: ``KeyError`` and ``IndexError`` for a missing field or row, ``AttributeError``
#: for ``.get`` on something that is not a mapping, ``TypeError`` for indexing or
#: iterating something that cannot be, ``ValueError`` for ``int("")`` and its
#: relatives.
_SHAPE_ERRORS = (AttributeError, IndexError, KeyError, TypeError, ValueError)


def _translating(name: str, method: Any) -> Any:
    """Wrap one method so a malformed payload leaves as a :class:`ParseError`.

    Sixty-odd title clients map several hundred upstream payloads between them,
    and each mapper is written against the shape its provider documents. When a
    provider drifts - or answers an array endpoint with ``{"error": ...}``, or is
    impersonated - the mapper meets something it was not written for, and what
    escaped before this wrapper existed was ``AttributeError: 'str' object has no
    attribute 'get'``: an exception naming neither the title nor the call, and
    not a :class:`GameStatsError`, so a caller's ``except GameStatsError`` around
    the whole library did not catch it. A crash in somebody's Discord bot, from
    a change on a server neither of us runs.

    The cost is real and worth stating: a genuine bug *inside* a mapper - a typo
    in a field name that raises ``KeyError`` - now surfaces as a ParseError too,
    which reads like the upstream's fault when it is ours. Two things keep that
    survivable. The original exception is chained (``raise ... from error``), so
    the traceback still points at the line that broke. And the suite exercises
    every mapper against a realistic payload, so a mapper that cannot map its own
    provider fails in CI rather than in production wearing a disguise.
    """

    @functools.wraps(method)
    async def wrapper(self: TitleClient, *args: Any, **kwargs: Any) -> Any:
        try:
            return await method(self, *args, **kwargs)
        except GameStatsError:
            # Everything this package raises deliberately - unsupported,
            # not found, rate limited, a validation failure - passes through
            # untouched. Only the accidents are translated.
            raise
        except _SHAPE_ERRORS as error:
            raise ParseError(
                self.title.id,
                f"{name} received data it could not map ({type(error).__name__}: {error})",
                error,
            ) from error

    wrapper.__dict__["_translated"] = True
    return wrapper


def _translate_all(cls: type) -> None:
    """Wrap whichever of the canonical methods this class actually defines."""
    for name in CANONICAL_METHODS:
        method = cls.__dict__.get(name)
        if method is None or method.__dict__.get("_translated"):
            continue
        setattr(cls, name, _translating(name, method))


class TitleClient:
    """The canonical surface, and the capability guard that keeps it honest."""

    def __init_subclass__(cls, **kwargs: Any) -> None:
        """Wrap the subclass's overrides the moment it is defined.

        Doing it here rather than asking each of the sixty title clients to
        apply a decorator is the whole point: a title added next year is
        covered by having been written, not by having remembered.
        """
        super().__init_subclass__(**kwargs)
        _translate_all(cls)

    def __init__(self, title: TitleDescriptor, runtime: Runtime) -> None:
        #: The registry entry for this title. Public - callers branch on it.
        self.title = title
        self.runtime = runtime
        self.esports = EsportsLayer(runtime, title)

    @property
    def id(self) -> str:
        """The title id, for logging and cache keys."""
        return self.title.id

    def supports(self, capability: str) -> bool:
        """Whether this title supports a method. Cheaper than catching the error."""
        return capability in self.title.capabilities

    def require(self, capability: str) -> None:
        """Raise unless the capability is declared. Called at the top of every method."""
        if not self.supports(capability):
            raise UnsupportedCapabilityError(
                self.title.id, capability, self.title.capabilities
            )

    def limit(self, value: int | None, fallback: int = 20) -> int:
        """Clamp a caller-supplied page size to something the upstreams accept."""
        return clamp(value if value is not None else fallback, 1, MAX_PAGE_SIZE)

    def require_identifier(self, query: PlayerQuery) -> None:
        """Raise when a query supplies none of the identifiers this title accepts."""
        accepted = self.title.identifiers
        if not accepted:
            raise UnsupportedCapabilityError(
                self.title.id, "resolvePlayer", self.title.capabilities
            )
        for key in accepted:
            value = query.get(key)
            if value is not None and str(value).strip():
                return
        raise IdentifierError(self.title.id, accepted)

    def ref(
        self,
        *,
        provider_id: str,
        id: str,  # noqa: A002 - mirrors the field name in the model
        display_name: str | None = None,
        platform: str | None = None,
        region: str | None = None,
    ) -> PlayerRef:
        """Build a :class:`PlayerRef` without repeating the boilerplate."""
        return PlayerRef(
            title_id=self.title.id,
            provider_id=provider_id,
            id=id,
            display_name=display_name,
            platform=platform,
            region=region,
        )

    def region(self, value: str | None, fallback: str | None = None) -> str:
        """Validate a region against the registry, or fall back to the first one.

        Titles that are not regionalised declare an empty list and pass through
        whatever they were given.
        """
        allowed = self.title.regions
        if not allowed:
            return value or fallback or ""
        if value is None:
            chosen = fallback or (allowed[0] if allowed else None)
            if not chosen:
                raise ValidationError(f"{self.title.id} needs a region")
            return chosen
        lowered = value.lower()
        if lowered not in allowed:
            raise ValidationError(
                f'unknown region "{value}" for {self.title.id}. '
                f"Expected one of: {', '.join(allowed)}"
            )
        return lowered

    async def _resolved(
        self, query: PlayerQuery | PlayerRef | dict[str, Any] | str
    ) -> PlayerRef:
        """A ref, resolving one first when the caller passed a query."""
        if isinstance(query, PlayerRef):
            return query
        return await self.resolve_player(as_query(query))

    # -----------------------------------------------------------------------
    # Player surface - overridden by the titles that have one
    # -----------------------------------------------------------------------

    async def resolve_player(self, query: PlayerQuery | dict[str, Any] | str) -> PlayerRef:
        """Turn a query into a stable :class:`PlayerRef`."""
        self.require("resolvePlayer")
        raise UnsupportedCapabilityError(
            self.title.id, "resolvePlayer", self.title.capabilities
        )

    async def get_player(
        self, query: PlayerQuery | PlayerRef | dict[str, Any] | str
    ) -> PlayerProfile:
        """Public profile."""
        self.require("getPlayer")
        raise UnsupportedCapabilityError(self.title.id, "getPlayer", self.title.capabilities)

    async def get_player_stats(
        self, query: PlayerQuery | PlayerRef | dict[str, Any] | str
    ) -> PlayerStats:
        """Career statistics."""
        self.require("getPlayerStats")
        raise UnsupportedCapabilityError(
            self.title.id, "getPlayerStats", self.title.capabilities
        )

    async def get_rank(
        self, query: PlayerQuery | PlayerRef | dict[str, Any] | str
    ) -> list[RankInfo]:
        """Competitive standing, one entry per queue.

        A list rather than a single value: League of Legends has solo and flex,
        Rocket League has five playlists, and picking one for the caller would be
        a guess.
        """
        self.require("getRank")
        raise UnsupportedCapabilityError(self.title.id, "getRank", self.title.capabilities)

    async def get_match_history(
        self,
        query: PlayerQuery | PlayerRef | dict[str, Any] | str,
        options: MatchHistoryOptions | None = None,
    ) -> list[MatchSummary]:
        """Recent matches, newest first."""
        self.require("getMatchHistory")
        raise UnsupportedCapabilityError(
            self.title.id, "getMatchHistory", self.title.capabilities
        )

    async def get_match(self, match_id: str, context: PlayerRef | None = None) -> MatchDetail:
        """One match in full."""
        self.require("getMatch")
        raise UnsupportedCapabilityError(self.title.id, "getMatch", self.title.capabilities)

    async def get_leaderboard(
        self, options: LeaderboardOptions | None = None
    ) -> list[LeaderboardEntry]:
        """A page of the ladder."""
        self.require("getLeaderboard")
        raise UnsupportedCapabilityError(
            self.title.id, "getLeaderboard", self.title.capabilities
        )

    async def get_metadata(self, kind: str | None = None) -> Any:
        """Static game data: heroes, agents, maps, cards."""
        self.require("getMetadata")
        raise UnsupportedCapabilityError(self.title.id, "getMetadata", self.title.capabilities)

    # -----------------------------------------------------------------------
    # Esports surface - identical for every title
    # -----------------------------------------------------------------------

    async def get_esports_matches(
        self, options: EsportsQueryOptions | None = None
    ) -> list[EsportsMatch]:
        """Professional fixtures."""
        self.require("getEsportsMatches")
        return await self.esports.get_matches(options)

    async def get_esports_tournaments(
        self, options: EsportsQueryOptions | None = None
    ) -> list[EsportsTournament]:
        """Tournaments and events."""
        self.require("getEsportsTournaments")
        return await self.esports.get_tournaments(options)

    async def get_esports_teams(
        self, options: EsportsQueryOptions | None = None
    ) -> list[EsportsTeam]:
        """Professional rosters."""
        self.require("getEsportsTeams")
        return await self.esports.get_teams(options)

    async def get_esports_players(
        self, options: EsportsQueryOptions | None = None
    ) -> list[EsportsPlayer]:
        """Professional players."""
        self.require("getEsportsPlayers")
        return await self.esports.get_players(options)

    async def get_standings(
        self, tournament_id: str, options: EsportsQueryOptions | None = None
    ) -> list[EsportsStanding]:
        """Standings for one tournament."""
        self.require("getStandings")
        return await self.esports.get_standings(tournament_id, options)

    async def get_earnings(self, handle: str) -> PrizeEarnings:
        """Career prize money for a professional handle."""
        self.require("getEarnings")
        return await self.esports.get_earnings(handle)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<{type(self).__name__} {self.title.id}>"


# ``__init_subclass__`` fires for subclasses only, so the base's own methods -
# the whole esports surface, which no title client overrides - are wrapped here.
_translate_all(TitleClient)
