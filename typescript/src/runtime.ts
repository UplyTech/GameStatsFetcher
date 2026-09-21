/**
 * The shared runtime.
 *
 * One object, built once by {@link GameStatsClient}, handed to every provider
 * and every title client. It exists so that the cache, the rate limiter and the
 * HTTP client are genuinely shared rather than merely configured the same way
 * in forty places - which is what version 2 did, and why asking for CS2 and
 * Dota 2 in the same second used two independent Steam buckets and got the
 * caller a 429.
 */

import { createCache, type CacheAdapter } from "./cache.js";
import { HttpClient } from "./http.js";
import { TokenBucketRateLimiter } from "./rate-limiter.js";
import { rateLimitTable } from "./providers.js";
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TTL_SECONDS,
  DEFAULT_USER_AGENT,
} from "./constants.js";
import type {
  ApiKeys,
  GameStatsClientOptions,
  LoggerLike,
  LogLevel,
} from "./types.js";

export interface Runtime {
  readonly apiKeys: ApiKeys;
  readonly http: HttpClient;
  readonly cache: CacheAdapter;
  readonly limiter: TokenBucketRateLimiter;
  readonly logger: LoggerLike;
  readonly fetch: typeof fetch;
  /** Try the next provider in a title's list when the preferred one fails. */
  readonly fallback: boolean;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly defaultTtlSeconds: number;
  readonly ttlOverrides: Readonly<Record<string, number>>;
  /**
   * Scratch space shared across providers, for things worth computing once:
   * OAuth tokens, Hi-Rez sessions, iRacing cookies.
   */
  readonly state: Map<string, unknown>;
}

/** Build the runtime from the caller's options, filling in every default. */
export function createRuntime(options: GameStatsClientOptions = {}): Runtime {
  const logger = normaliseLogger(options.logger);
  const fetchImpl = options.fetch ?? resolveGlobalFetch();
  const limiter = new TokenBucketRateLimiter({
    ...(options.rateLimit ? { fallback: options.rateLimit } : {}),
    perProvider: rateLimitTable(),
  });
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  const http = new HttpClient({
    fetch: fetchImpl,
    limiter,
    logger,
    // Every configured credential, so a transport error or an upstream error
    // body cannot carry one into a caller's logs.
    secrets: Object.values(options.apiKeys ?? {}).filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
    ...(options.retry ? { retry: options.retry } : {}),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    userAgent,
  });

  return {
    apiKeys: options.apiKeys ?? {},
    http,
    cache: createCache(options.cache, logger),
    limiter,
    logger,
    fetch: fetchImpl,
    fallback: options.fallback ?? false,
    userAgent,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    defaultTtlSeconds: options.cache?.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS,
    ttlOverrides: options.cache?.ttlOverrides ?? {},
    state: new Map(),
  };
}

/**
 * Node 20 has `fetch` globally, but a bundler or a patched environment may not.
 *
 * Failing here with a clear sentence beats failing on the first request with a
 * `TypeError: fetch is not a function` from somewhere in the call stack.
 */
function resolveGlobalFetch(): typeof fetch {
  if (typeof globalThis.fetch !== "function") {
    throw new Error(
      "no global fetch available - run on Node 20+ or pass one as options.fetch",
    );
  }
  return globalThis.fetch.bind(globalThis);
}

const LEVELS: Record<LogLevel, number> = {
  silent: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/** Accept a level name, a logger object, or nothing at all. */
export function normaliseLogger(option: LogLevel | LoggerLike | undefined): LoggerLike {
  if (option === undefined || option === "silent") return silentLogger();
  if (typeof option !== "string") return option;

  const threshold = LEVELS[option];
  const at = (level: number, method: "debug" | "info" | "warn" | "error") =>
    threshold >= level
      ? (...args: unknown[]): void => {
          console[method]("[gsf]", ...args);
        }
      : (): void => undefined;

  return {
    error: at(0, "error"),
    warn: at(1, "warn"),
    info: at(2, "info"),
    debug: at(3, "debug"),
  };
}

/** A logger that does nothing. The default, and what the tests use. */
export function silentLogger(): LoggerLike {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}
