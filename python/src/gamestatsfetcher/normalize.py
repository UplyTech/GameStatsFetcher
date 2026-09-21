"""Normalisation helpers.

The provider modules do the interesting mapping; these are the small decisions
that would otherwise be made fifty times, slightly differently.

The recurring one is **absent versus zero**. ``num(None)`` is ``None`` and
``num(0)`` is ``0``, because a player with no recorded kills and a provider that
does not report kills are different facts and a dashboard should be able to show
them differently.

Every function here has a counterpart in the TypeScript edition, and
``shared/vectors/normalize.json`` pins both to the same answers.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import datetime, timezone
from typing import Any, TypeVar, overload

from .constants import PERMILLE
from .types import MatchParticipantStats, MatchResult, ModeStats, PlayerRef, PlayerStats

__all__ = [
    "num",
    "as_int",
    "as_str",
    "as_bool",
    "ts",
    "permille",
    "win_rate",
    "kd",
    "clamp",
    "match_result",
    "empty_participant_stats",
    "participant_stats",
    "mode_stats",
    "player_stats",
    "pick",
    "as_list",
    "total",
    "to_minor_units",
]

T = TypeVar("T")

#: Below this, a timestamp is seconds; at or above it, milliseconds.
#:
#: 10^11 seconds is the year 5138, and 10^11 milliseconds is 1973 - so the split
#: is unambiguous for every timestamp any of these APIs will ever return.
_MILLISECOND_THRESHOLD = 1e11


def num(value: Any) -> float | int | None:
    """Coerce to a finite number, or ``None``. Never returns ``nan``."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, (int, float)):
        parsed: float = float(value)
    else:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return None
    if parsed != parsed or parsed in (float("inf"), float("-inf")):
        return None
    # Keep integers integral: 4 must not come back as 4.0 and print as "4.0".
    return int(parsed) if parsed.is_integer() else parsed


def as_int(value: Any) -> int | None:
    """Coerce to an integer, or ``None``. Truncates rather than rounds."""
    parsed = num(value)
    return None if parsed is None else int(parsed)


def as_str(value: Any) -> str | None:
    """Coerce to a non-empty trimmed string, or ``None``."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def as_bool(value: Any) -> bool | None:
    """Coerce to a boolean, or ``None`` when the field was absent or unclear."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if value in (1, "1", "true", "True"):
        return True
    if value in (0, "0", "false", "False"):
        return False
    return None


def ts(value: Any) -> int | None:
    """A timestamp in epoch milliseconds, whatever form it arrived in.

    Handles ISO strings, epoch seconds and epoch milliseconds. The
    seconds/milliseconds split is decided by magnitude, which is unambiguous for
    every timestamp these APIs return.
    """
    if value is None or value == "" or isinstance(value, bool):
        return None

    if isinstance(value, (int, float)):
        if value != value or value <= 0:
            return None
        return round(value * 1_000) if value < _MILLISECOND_THRESHOLD else round(value)

    text = str(value).strip()
    if not text:
        return None
    if text.lstrip("-").isdigit():
        return ts(int(text))

    # Python's fromisoformat rejects the trailing Z that most of these APIs send.
    candidate = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return _parse_http_date(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return round(parsed.timestamp() * 1_000)


def _parse_http_date(text: str) -> int | None:
    """Last resort for RFC 1123 dates, which Cloudflare fronts several APIs with."""
    from email.utils import parsedate_to_datetime

    try:
        parsed = parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return round(parsed.timestamp() * 1_000)


def permille(numerator: float | int | None, denominator: float | int | None) -> int | None:
    """A ratio in permille, or ``None`` when it cannot be computed.

    Integers, matching the convention RankMode and EconomyWorld use, so a value
    from this package can be stored and compared without a float ever entering
    the pipeline.
    """
    if numerator is None or denominator is None or denominator == 0:
        return None
    return _round_half_up(numerator / denominator * PERMILLE)


def _round_half_up(value: float) -> int:
    """Round half away from zero, the way JavaScript's ``Math.round`` does.

    Python's ``round`` is banker's rounding, so ``round(0.5)`` is 0 while
    JavaScript gives 1. Using it here would make the two editions disagree on
    every ratio that lands exactly on a half - which the shared vectors would
    catch, but only after somebody had shipped it.
    """
    import math

    return math.floor(value + 0.5) if value >= 0 else math.ceil(value - 0.5)


def win_rate(wins: int | None, losses: int | None, draws: int | None = None) -> int | None:
    """Win rate from wins and losses.

    Draws are included in the denominator when supplied, because a title that
    has draws and ignores them reports a win rate above what the player has.
    """
    if wins is None:
        return None
    played = wins + (losses or 0) + (draws or 0)
    return None if played == 0 else permille(wins, played)


def kd(kills: int | None, deaths: int | None) -> int | None:
    """K/D in permille.

    Zero deaths is treated as one, which is the convention every scoreboard in
    every one of these games uses. Returning ``None`` would be defensible and
    would also make a perfect game look like missing data.
    """
    if kills is None:
        return None
    return permille(kills, max(1, deaths or 0))


def clamp(value: int, minimum: int, maximum: int) -> int:
    """Bound a value. Used on every caller-supplied ``limit``."""
    return min(maximum, max(minimum, value))


def match_result(won: Any, drawn: Any = False) -> MatchResult:
    """``win`` / ``loss`` / ``draw`` from whatever the upstream used to say so."""
    if drawn is True:
        return MatchResult.DRAW
    parsed = as_bool(won)
    if parsed is None:
        return MatchResult.UNKNOWN
    return MatchResult.WIN if parsed else MatchResult.LOSS


def empty_participant_stats() -> MatchParticipantStats:
    """An empty stat block. Every field absent, nothing invented."""
    return MatchParticipantStats()


def participant_stats(**fields: Any) -> MatchParticipantStats:
    """Build a stat block, filling absent fields with ``None``."""
    extra = fields.pop("extra", None) or {}
    return MatchParticipantStats(extra=extra, **fields)


def mode_stats(
    *,
    id: str,  # noqa: A002 - mirrors the field name in the model
    label: str | None = None,
    matches_played: int | None = None,
    wins: int | None = None,
    losses: int | None = None,
    kills: int | None = None,
    deaths: int | None = None,
    assists: int | None = None,
    extra: Mapping[str, Any] | None = None,
) -> ModeStats:
    """Build a :class:`ModeStats`, deriving the win rate when it was not given."""
    played = matches_played
    if played is None and wins is not None and losses is not None:
        played = wins + losses
    return ModeStats(
        id=id,
        label=label or id,
        matches_played=played,
        wins=wins,
        losses=losses,
        win_rate_permille=win_rate(wins, losses),
        kills=kills,
        deaths=deaths,
        assists=assists,
        extra=dict(extra or {}),
    )


def player_stats(
    *,
    ref: PlayerRef,
    matches_played: int | None = None,
    wins: int | None = None,
    losses: int | None = None,
    draws: int | None = None,
    kills: int | None = None,
    deaths: int | None = None,
    assists: int | None = None,
    time_played_seconds: int | None = None,
    modes: Mapping[str, ModeStats] | None = None,
    raw: Any = None,
) -> PlayerStats:
    """Build a :class:`PlayerStats`, deriving every ratio and total that follows.

    Deriving here rather than in each provider is what makes the derived fields
    consistent: one definition of win rate, one definition of K/D, applied to
    fifty different upstream shapes.
    """
    played = matches_played
    if played is None and wins is not None and losses is not None:
        played = wins + losses + (draws or 0)

    return PlayerStats(
        ref=ref,
        matches_played=played,
        wins=wins,
        losses=losses,
        draws=draws,
        win_rate_permille=win_rate(wins, losses, draws),
        kills=kills,
        deaths=deaths,
        assists=assists,
        kd_permille=kd(kills, deaths),
        time_played_seconds=time_played_seconds,
        modes=dict(modes or {}),
        raw=raw,
    )


def pick(source: Any, *path: str | int) -> Any:
    """Read a nested field without a chain of guarded accesses.

    Upstream payloads nest deeply and inconsistently; ``pick(data, "data", 0,
    "stats", "kills")`` reads better than the equivalent chain and says plainly
    that the shape is not guaranteed.
    """
    current = source
    for segment in path:
        if current is None:
            return None
        if isinstance(current, Mapping):
            current = current.get(segment)
        elif isinstance(current, Sequence) and not isinstance(current, (str, bytes)):
            if not isinstance(segment, int) or segment >= len(current):
                return None
            current = current[segment]
        else:
            return None
    return current


def as_list(value: Any) -> list[Any]:
    """A list from a field that may be a list, a single item, or absent."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


@overload
def total(values: Iterable[int | None]) -> int | None: ...


@overload
def total(values: Iterable[int | float | None]) -> int | float | None: ...


def total(values: Iterable[int | float | None]) -> int | float | None:
    """Sum, ignoring absent values - but ``None`` when they were all absent.

    Used to fold per-mode numbers into a career total. Returning ``0`` for a
    player whose provider reported nothing would turn missing data into a fact.

    The overloads exist because almost every caller folds integers - kills,
    wins, rounds - and hands the result straight to :func:`player_stats`, whose
    fields are integers. Without them every one of those call sites would need a
    cast for a value that cannot be anything but an int.
    """
    running: float = 0
    seen = False
    for value in values:
        if isinstance(value, bool) or value is None:
            continue
        if isinstance(value, (int, float)):
            running += value
            seen = True
    if not seen:
        return None
    return int(running) if float(running).is_integer() else running


def to_minor_units(amount: float | int | None, exponent: int = 2) -> int | None:
    """Convert a decimal amount into integer minor units."""
    if amount is None:
        return None
    return _round_half_up(amount * (10**exponent))
