import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryCache,
  NullCache,
  RedisCache,
  createCache,
  resolveTtl,
  type RedisLike,
} from "../src/cache.js";
import { silentLogger } from "../src/runtime.js";

describe("MemoryCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and reads a value", async () => {
    const cache = new MemoryCache();
    await cache.set("k", { a: 1 }, 60);
    expect(await cache.get("k")).toEqual({ a: 1 });
  });

  it("misses on an unknown key", async () => {
    expect(await new MemoryCache().get("nope")).toBeNull();
  });

  it("expires an entry when its TTL passes", async () => {
    const cache = new MemoryCache();
    await cache.set("k", "v", 10);
    vi.advanceTimersByTime(9_000);
    expect(await cache.get("k")).toBe("v");
    vi.advanceTimersByTime(2_000);
    expect(await cache.get("k")).toBeNull();
  });

  it("drops the expired entry rather than keeping it around", async () => {
    const cache = new MemoryCache();
    await cache.set("k", "v", 1);
    vi.advanceTimersByTime(2_000);
    await cache.get("k");
    expect(cache.size()).toBe(0);
  });

  it("ignores a zero or negative TTL", async () => {
    const cache = new MemoryCache();
    await cache.set("k", "v", 0);
    expect(await cache.get("k")).toBeNull();
  });

  it("evicts the least recently used entry when full", async () => {
    const cache = new MemoryCache(2);
    await cache.set("a", 1, 60);
    await cache.set("b", 2, 60);
    // Reading "a" makes it the most recent, so "b" is the one to go.
    await cache.get("a");
    await cache.set("c", 3, 60);

    expect(await cache.get("a")).toBe(1);
    expect(await cache.get("b")).toBeNull();
    expect(await cache.get("c")).toBe(3);
  });

  it("deletes and clears", async () => {
    const cache = new MemoryCache();
    await cache.set("a", 1, 60);
    await cache.del("a");
    expect(await cache.get("a")).toBeNull();

    await cache.set("b", 2, 60);
    await cache.clear();
    expect(cache.size()).toBe(0);
  });
});

describe("NullCache", () => {
  it("never remembers anything", async () => {
    const cache = new NullCache();
    await cache.set();
    expect(await cache.get()).toBeNull();
    expect(cache.driver).toBe("none");
  });
});

/** A hand-rolled ioredis stand-in, so the tests need no Redis server. */
function fakeRedis(overrides: Partial<RedisLike> = {}): RedisLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
      return "OK";
    },
    async del(...keys) {
      for (const key of keys) store.delete(key);
      return keys.length;
    },
    async scan(_cursor, _match, pattern) {
      const prefix = pattern.replace(/\*$/, "");
      return ["0", [...store.keys()].filter((key) => key.startsWith(prefix))];
    },
    async quit() {
      return "OK";
    },
    on() {
      return undefined;
    },
    ...overrides,
  };
}

describe("RedisCache", () => {
  it("prefixes every key", async () => {
    const redis = fakeRedis();
    const cache = new RedisCache(redis, "gsf:", silentLogger());
    await cache.set("k", { a: 1 }, 60);
    expect([...redis.store.keys()]).toEqual(["gsf:k"]);
    expect(await cache.get("k")).toEqual({ a: 1 });
  });

  it("treats a read failure as a miss instead of throwing", async () => {
    const cache = new RedisCache(
      fakeRedis({
        get: async () => {
          throw new Error("connection reset");
        },
      }),
      "gsf:",
      silentLogger(),
    );
    // A cache failure must never become a request failure.
    expect(await cache.get("k")).toBeNull();
  });

  it("drops a write failure silently", async () => {
    const cache = new RedisCache(
      fakeRedis({
        set: async () => {
          throw new Error("read only replica");
        },
      }),
      "gsf:",
      silentLogger(),
    );
    await expect(cache.set("k", 1, 60)).resolves.toBeUndefined();
  });

  it("survives a value that is not JSON", async () => {
    const redis = fakeRedis();
    redis.store.set("gsf:k", "{not json");
    const cache = new RedisCache(redis, "gsf:", silentLogger());
    expect(await cache.get("k")).toBeNull();
  });

  it("clears only its own prefix", async () => {
    const redis = fakeRedis();
    redis.store.set("gsf:a", "1");
    redis.store.set("other:b", "2");
    await new RedisCache(redis, "gsf:", silentLogger()).clear();
    expect([...redis.store.keys()]).toEqual(["other:b"]);
  });
});

describe("createCache", () => {
  it("defaults to memory", () => {
    expect(createCache(undefined, silentLogger()).driver).toBe("memory");
  });

  it("honours an explicit none", () => {
    expect(createCache({ driver: "none" }, silentLogger()).driver).toBe("none");
  });

  it("uses a caller-supplied redis client", () => {
    const cache = createCache(
      { driver: "redis", redis: { client: fakeRedis() } },
      silentLogger(),
    );
    expect(cache.driver).toBe("redis");
  });

  it("falls back to memory rather than refusing to start", () => {
    // Requesting Redis without ioredis installed must degrade, not throw: an
    // optional dependency should not become mandatory at the worst moment.
    const cache = createCache(
      { driver: "redis", redis: { host: "127.0.0.1", port: 1 } },
      silentLogger(),
    );
    expect(["redis", "memory"]).toContain(cache.driver);
  });
});

describe("resolveTtl", () => {
  it("prefers the most specific override", () => {
    const overrides = { "valorant:getRank": 5, getRank: 10 };
    expect(resolveTtl(overrides, "valorant", "getRank", 60, 30)).toBe(5);
    expect(resolveTtl(overrides, "cs2", "getRank", 60, 30)).toBe(10);
  });

  it("falls through to the method default and then the client default", () => {
    expect(resolveTtl({}, "cs2", "getRank", 60, 30)).toBe(60);
    expect(resolveTtl({}, "cs2", "getRank", undefined, 30)).toBe(30);
  });
});
