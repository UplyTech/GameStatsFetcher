/**
 * Defaults, and the reasoning behind the ones that are not obvious.
 *
 * The TTL table below is the part worth reading. Cache lifetimes are not a
 * performance knob here, they are a correctness one: a rank cached for an hour
 * is a rank that is wrong for an hour, and a match history cached for a second
 * burns quota that most of these APIs charge for by the minute.
 */

import type { RateLimitConfig, RetryConfig } from "./types.js";

/** Package version, mirrored from package.json for the User-Agent. */
export const VERSION = "3.2.0";

/** Sent on every request unless the caller overrides it. */
export const DEFAULT_USER_AGENT = `GameStatsFetcher/${VERSION} (+https://github.com/uplytech/game-stats-fetcher)`;

/** Conservative enough for the strictest provider that does not publish a limit. */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  rps: 5,
  burst: 10,
};

export const DEFAULT_RETRY: Required<RetryConfig> = {
  attempts: 2,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  // 408 is in the list because several of these APIs answer a cold cache with
  // one and succeed on the immediate retry.
  retryOn: [408, 429, 500, 502, 503, 504],
  respectRetryAfter: true,
};

/** A request that has not answered in 15 s is not going to. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Entries the in-memory cache holds before it evicts the least recently used. */
export const DEFAULT_MAX_CACHE_ENTRIES = 5_000;

/** Used when neither the method nor the caller specifies a TTL. */
export const DEFAULT_TTL_SECONDS = 60;

/**
 * How long each kind of answer stays fresh.
 *
 * Chosen from how fast the underlying thing actually changes, not from how
 * often callers ask:
 *
 * - **Static metadata** (champion lists, map pools, item data) changes on a
 *   patch cycle. An hour is still conservative.
 * - **Profiles** change when somebody renames or levels up. Minutes.
 * - **Ranks** change every game. Short, because a Discord bot showing a stale
 *   rank right after a promotion is the complaint this package exists to avoid.
 * - **Match history** is append-only. The newest entry is what changes, so the
 *   TTL only has to be shorter than a match.
 * - **A finished match** never changes again, so it is cached for a day. This
 *   is the single biggest quota saver in the package: match detail is what
 *   callers fan out on.
 * - **Live esports fixtures** move constantly while an event is running.
 */
export const TTL: Readonly<Record<string, number>> = {
  metadata: 3_600,
  resolvePlayer: 86_400,
  player: 300,
  playerStats: 180,
  rank: 60,
  matchHistory: 60,
  match: 86_400,
  leaderboard: 300,
  esportsMatchesLive: 30,
  esportsMatches: 300,
  esportsTournaments: 1_800,
  esportsTeams: 3_600,
  esportsPlayers: 3_600,
  standings: 600,
  earnings: 43_200,
};

/** Upper bound on `limit`, so a caller cannot ask for a page an API will refuse. */
export const MAX_PAGE_SIZE = 500;

/** Permille scale, used everywhere a ratio is reported. */
export const PERMILLE = 1_000;

/**
 * Steam's app ids for the titles served through the Steam Web API.
 *
 * Kept here rather than in each title module because several titles share the
 * Steam client and the ids are the only thing that differs.
 */
export const STEAM_APP_IDS: Readonly<Record<string, number>> = {
  cs2: 730,
  dota2: 570,
  "team-fortress-2": 440,
  rust: 252490,
  "rocket-league": 252950,
  "apex-legends": 1172470,
  pubg: 578080,
  "naraka-bladepoint": 1203220,
  "war-thunder": 236390,
  "dead-by-daylight": 381210,
  "path-of-exile": 238960,
};

/**
 * The 64-bit offset between a SteamID64 and the 32-bit account id.
 *
 * `76561197960265728`. Several Steam-adjacent APIs (OpenDota, Ballchasing,
 * logs.tf) key on the 32-bit form, so the conversion happens constantly.
 */
export const STEAM_ID64_BASE = 76561197960265728n;
