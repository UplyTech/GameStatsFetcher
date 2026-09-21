/**
 * The cache layer.
 *
 * Two drivers, one interface, and one rule that applies to both: **a cache
 * failure is never a request failure.** Every read that goes wrong returns a
 * miss and every write that goes wrong is dropped. The alternative - a Redis
 * hiccup taking down a Discord bot's stats command - is a worse outcome than
 * spending one extra call on the game API.
 *
 * `memory` is the default. Version 2 of this package made Redis effectively
 * mandatory, which meant a caller who just wanted to look up one player had to
 * run a database first. The in-memory LRU covers that case with nothing to
 * deploy; Redis is for when several processes should share one warm cache.
 */

import { createRequire } from "node:module";
import { DEFAULT_MAX_CACHE_ENTRIES, DEFAULT_TTL_SECONDS } from "./constants.js";
import type { CacheConfig, CacheDriver, LoggerLike } from "./types.js";

/** What every driver implements. */
export interface CacheAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  clear(): Promise<void>;
  disconnect(): Promise<void>;
  readonly driver: CacheDriver;
}

interface MemoryEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * In-process LRU with per-entry expiry.
 *
 * Insertion order of a `Map` is the LRU order, so a hit re-inserts and eviction
 * is `keys().next()`. No dependency, no timer: expired entries are dropped when
 * they are next read, and the size bound takes care of the ones nobody reads
 * again.
 */
export class MemoryCache implements CacheAdapter {
  public readonly driver: CacheDriver = "memory";
  private readonly store = new Map<string, MemoryEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_CACHE_ENTRIES) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  public async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    // Re-insert so this key becomes the most recently used.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value as T;
  }

  public async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1_000 });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }

  public async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  public async clear(): Promise<void> {
    this.store.clear();
  }

  public async disconnect(): Promise<void> {
    this.store.clear();
  }

  /** Current entry count, expired ones included. Tests and metrics use it. */
  public size(): number {
    return this.store.size;
  }
}

/** Every cache call is a no-op. What `driver: "none"` gets you. */
export class NullCache implements CacheAdapter {
  public readonly driver: CacheDriver = "none";
  public async get<T>(): Promise<T | null> {
    return null;
  }
  public async set(): Promise<void> {
    /* nothing to do */
  }
  public async del(): Promise<void> {
    /* nothing to do */
  }
  public async clear(): Promise<void> {
    /* nothing to do */
  }
  public async disconnect(): Promise<void> {
    /* nothing to do */
  }
}

/** The subset of ioredis this package uses. Typed here so ioredis stays optional. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  scan(
    cursor: string,
    match: "MATCH",
    pattern: string,
    count: "COUNT",
    n: number,
  ): Promise<[string, string[]]>;
  quit(): Promise<unknown>;
  disconnect?(): void;
  status?: string;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Redis-backed cache.
 *
 * Takes an already-connected client, which is why `ioredis` can stay an
 * optional peer dependency: the caller constructs it, this package only speaks
 * to it. `createCache()` will build one for you when you pass host and port.
 */
export class RedisCache implements CacheAdapter {
  public readonly driver: CacheDriver = "redis";
  private readonly client: RedisLike;
  private readonly prefix: string;
  private readonly logger: LoggerLike;

  constructor(client: RedisLike, prefix: string, logger: LoggerLike) {
    this.client = client;
    this.prefix = prefix;
    this.logger = logger;
    // Connection errors are swallowed on purpose: an unreachable cache must
    // degrade to a miss, not crash the process with an unhandled 'error'.
    this.client.on?.("error", (err) => {
      this.logger.warn("[gsf] redis error, cache degraded to misses", err);
    });
  }

  private full(key: string): string {
    return `${this.prefix}${key}`;
  }

  public async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(this.full(key));
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.debug("[gsf] cache read failed, treating as miss", err);
      return null;
    }
  }

  public async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    try {
      await this.client.set(this.full(key), JSON.stringify(value), "EX", ttlSeconds);
    } catch (err) {
      this.logger.debug("[gsf] cache write failed, dropping", err);
    }
  }

  public async del(key: string): Promise<void> {
    try {
      await this.client.del(this.full(key));
    } catch {
      /* best effort */
    }
  }

  /** Delete every key under this prefix. Scans, so it never blocks the server. */
  public async clear(): Promise<void> {
    try {
      let cursor = "0";
      do {
        const [next, keys] = await this.client.scan(
          cursor,
          "MATCH",
          `${this.prefix}*`,
          "COUNT",
          500,
        );
        cursor = next;
        if (keys.length > 0) await this.client.del(...keys);
      } while (cursor !== "0");
    } catch (err) {
      this.logger.debug("[gsf] cache clear failed", err);
    }
  }

  public async disconnect(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect?.();
    }
  }
}

/**
 * Build the adapter a config asks for.
 *
 * Falls back to memory rather than throwing when Redis is requested but
 * `ioredis` is not installed. The warning says what happened; refusing to start
 * would turn an optional dependency into a required one at the worst moment.
 */
export function createCache(config: CacheConfig | undefined, logger: LoggerLike): CacheAdapter {
  const driver = config?.driver ?? "memory";
  const prefix = config?.keyPrefix ?? "gsf:";

  if (driver === "none") return new NullCache();
  if (driver === "memory") return new MemoryCache(config?.maxEntries);

  const provided = config?.redis?.client as RedisLike | undefined;
  if (provided) return new RedisCache(provided, prefix, logger);

  const built = tryCreateRedisClient(config, logger);
  if (built) return new RedisCache(built, prefix, logger);

  logger.warn("[gsf] redis cache requested but ioredis is unavailable - using memory");
  return new MemoryCache(config?.maxEntries);
}

/**
 * Load ioredis without making it a hard dependency.
 *
 * `createRequire` rather than a dynamic `import`, because `createCache` is
 * synchronous and making it async would push a promise through every
 * constructor in the package for the sake of one optional driver. The bundler
 * rewrites `import.meta.url` for the CommonJS build, so this works in both.
 */
function tryCreateRedisClient(
  config: CacheConfig | undefined,
  logger: LoggerLike,
): RedisLike | null {
  const redisConfig = config?.redis;
  if (!redisConfig?.host) return null;
  try {
    const req = createRequire(import.meta.url);
    const mod = req("ioredis") as { default?: unknown } & Record<string, unknown>;
    const Ctor = (mod.default ?? mod) as new (opts: Record<string, unknown>) => RedisLike;
    return new Ctor({
      host: redisConfig.host,
      port: redisConfig.port ?? 6379,
      ...(redisConfig.password ? { password: redisConfig.password } : {}),
      ...(redisConfig.db !== undefined ? { db: redisConfig.db } : {}),
      ...(redisConfig.tls ? { tls: {} } : {}),
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      // Queued commands against a dead server would resolve minutes later, long
      // after the caller gave up. A miss now is the better answer.
      enableOfflineQueue: false,
    });
  } catch (err) {
    logger.debug("[gsf] ioredis not loadable", err);
    return null;
  }
}

/**
 * Resolve the TTL for one call.
 *
 * Order: an override for this exact `title:method`, then an override for the
 * method alone, then the method's own default, then the client default. The
 * two-level override exists because "cache ranks for 10 s" and "cache *Valorant*
 * ranks for 10 s" are both things operators legitimately want.
 */
export function resolveTtl(
  overrides: Readonly<Record<string, number>>,
  titleId: string,
  method: string,
  methodDefault: number | undefined,
  clientDefault: number,
): number {
  const scoped = overrides[`${titleId}:${method}`];
  if (typeof scoped === "number") return scoped;
  const global = overrides[method];
  if (typeof global === "number") return global;
  return methodDefault ?? clientDefault ?? DEFAULT_TTL_SECONDS;
}
