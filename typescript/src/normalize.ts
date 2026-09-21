/**
 * Normalisation helpers.
 *
 * The provider modules do the interesting mapping; these are the small
 * decisions that would otherwise be made forty times, slightly differently.
 *
 * The recurring one is **absent versus zero**. `num(undefined)` is `null` and
 * `num(0)` is `0`, because a player with no recorded kills and a provider that
 * does not report kills are different facts and a dashboard should be able to
 * show them differently.
 */

import { PERMILLE } from "./constants.js";
import type {
  MatchParticipantStats,
  MatchResult,
  ModeStats,
  PlayerRef,
  PlayerStats,
} from "./types.js";

/** Coerce to a finite number, or `null`. Never returns `NaN`. */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Coerce to an integer, or `null`. Truncates rather than rounds. */
export function int(value: unknown): number | null {
  const parsed = num(value);
  return parsed === null ? null : Math.trunc(parsed);
}

/** Coerce to a non-empty trimmed string, or `null`. */
export function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

/** Coerce to a boolean, or `null` when the field was absent. */
export function bool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return null;
}

/**
 * A timestamp in epoch milliseconds, whatever form it arrived in.
 *
 * Handles ISO strings, epoch seconds and epoch milliseconds. The seconds/
 * milliseconds split is decided by magnitude: anything below 10^11 is seconds,
 * which holds until the year 5138 and is wrong only for timestamps before 1973.
 */
export function ts(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e11 ? Math.round(value * 1_000) : Math.round(value);
  }
  const text = String(value).trim();
  if (/^[0-9]+$/.test(text)) return ts(Number(text));
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * A ratio in permille, or `null` when it cannot be computed.
 *
 * Integers, matching the convention RankMode and EconomyWorld use, so a value
 * from this package can be stored and compared without a float ever entering
 * the pipeline.
 */
export function permille(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null) return null;
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * PERMILLE);
}

/**
 * Win rate from wins and losses.
 *
 * Draws are included in the denominator when supplied, because a title that
 * has draws and ignores them reports a win rate above what the player has.
 */
export function winRate(
  wins: number | null,
  losses: number | null,
  draws: number | null = null,
): number | null {
  if (wins === null) return null;
  const total = wins + (losses ?? 0) + (draws ?? 0);
  return total === 0 ? null : permille(wins, total);
}

/**
 * K/D in permille.
 *
 * Zero deaths is treated as one, which is the convention every scoreboard in
 * every one of these games uses. Returning `null` would be defensible and would
 * also make a perfect game look like missing data.
 */
export function kd(kills: number | null, deaths: number | null): number | null {
  if (kills === null) return null;
  return permille(kills, Math.max(1, deaths ?? 0));
}

/** Clamp into a range. Used on every caller-supplied `limit`. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** `win` / `loss` / `draw` from whatever the upstream used to say so. */
export function matchResult(won: unknown, drawn: unknown = false): MatchResult {
  if (drawn === true) return "draw";
  const parsed = bool(won);
  if (parsed === null) return "unknown";
  return parsed ? "win" : "loss";
}

/** An empty participant stat block. Every field absent, nothing invented. */
export function emptyParticipantStats(): MatchParticipantStats {
  return {
    kills: null,
    deaths: null,
    assists: null,
    score: null,
    damageDealt: null,
    damageTaken: null,
    healing: null,
    placement: null,
    extra: {},
  };
}

/** Build a participant stat block, filling absent fields with `null`. */
export function participantStats(
  partial: Partial<MatchParticipantStats>,
): MatchParticipantStats {
  return { ...emptyParticipantStats(), ...partial, extra: partial.extra ?? {} };
}

/** Build a {@link ModeStats}, deriving the win rate when it was not given. */
export function modeStats(input: {
  id: string;
  label?: string;
  matchesPlayed?: number | null;
  wins?: number | null;
  losses?: number | null;
  kills?: number | null;
  deaths?: number | null;
  assists?: number | null;
  extra?: Record<string, number | string | null>;
}): ModeStats {
  const wins = input.wins ?? null;
  const losses = input.losses ?? null;
  return {
    id: input.id,
    label: input.label ?? input.id,
    matchesPlayed: input.matchesPlayed ?? (wins !== null && losses !== null ? wins + losses : null),
    wins,
    losses,
    winRatePermille: winRate(wins, losses),
    kills: input.kills ?? null,
    deaths: input.deaths ?? null,
    assists: input.assists ?? null,
    extra: input.extra ?? {},
  };
}

/**
 * Build a {@link PlayerStats}, deriving every ratio and total that follows from
 * the numbers given.
 *
 * Deriving here rather than in each provider is what makes the derived fields
 * consistent: one definition of win rate, one definition of K/D, applied to
 * forty different upstream shapes.
 */
export function playerStats(input: {
  ref: PlayerRef;
  matchesPlayed?: number | null;
  wins?: number | null;
  losses?: number | null;
  draws?: number | null;
  kills?: number | null;
  deaths?: number | null;
  assists?: number | null;
  timePlayedSeconds?: number | null;
  modes?: Record<string, ModeStats>;
  raw: unknown;
}): PlayerStats {
  const wins = input.wins ?? null;
  const losses = input.losses ?? null;
  const draws = input.draws ?? null;
  const kills = input.kills ?? null;
  const deaths = input.deaths ?? null;

  const played =
    input.matchesPlayed ??
    (wins !== null && losses !== null ? wins + losses + (draws ?? 0) : null);

  return {
    ref: input.ref,
    matchesPlayed: played,
    wins,
    losses,
    draws,
    winRatePermille: winRate(wins, losses, draws),
    kills,
    deaths,
    assists: input.assists ?? null,
    kdPermille: kd(kills, deaths),
    timePlayedSeconds: input.timePlayedSeconds ?? null,
    modes: input.modes ?? {},
    raw: input.raw,
  };
}

/**
 * Read a nested field without a chain of optional accesses.
 *
 * Upstream payloads nest deeply and inconsistently; `pick(json, "data", "0",
 * "stats", "kills")` reads better than the equivalent chain of casts and says
 * plainly that the shape is not guaranteed.
 */
export function pick(source: unknown, ...path: readonly (string | number)[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

/** An array from a field that may be an array, a single item, or absent. */
export function asArray<T = unknown>(value: unknown): T[] {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}

/**
 * Sum numbers, ignoring the absent ones - but `null` when they were all absent.
 *
 * Used to fold per-mode numbers into a career total. Returning `0` for a player
 * whose provider reported nothing would turn missing data into a fact.
 */
export function sum(values: readonly (number | null | undefined)[]): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : null;
}

/** Convert a decimal amount and currency into minor units, as an integer. */
export function toMinorUnits(amount: number | null, exponent = 2): number | null {
  if (amount === null) return null;
  return Math.round(amount * 10 ** exponent);
}
