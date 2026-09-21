import { describe, expect, it } from "vitest";
import { TokenBucketRateLimiter } from "../src/rate-limiter.js";
import { LocalRateLimitError } from "../src/errors.js";

/**
 * A controllable clock and sleep, so the limiter can be tested without waiting.
 *
 * `sleep` advances the clock rather than blocking, which is the whole reason
 * the limiter takes both as parameters.
 */
function controllable(): {
  limiter: (options?: ConstructorParameters<typeof TokenBucketRateLimiter>[0]) => TokenBucketRateLimiter;
  advance: (ms: number) => void;
  slept: number[];
} {
  let now = 1_000_000;
  const slept: number[] = [];
  const advance = (ms: number): void => {
    now += ms;
  };
  return {
    slept,
    advance,
    limiter: (options = {}) =>
      new TokenBucketRateLimiter({
        ...options,
        now: () => now,
        sleep: async (ms) => {
          slept.push(ms);
          advance(ms);
        },
      }),
  };
}

describe("token bucket", () => {
  it("starts full, because the provider has not heard from us yet", () => {
    const { limiter } = controllable();
    const bucket = limiter({ fallback: { rps: 1, burst: 3 } });
    expect(bucket.tryAcquire("p")).toBe(true);
    expect(bucket.tryAcquire("p")).toBe(true);
    expect(bucket.tryAcquire("p")).toBe(true);
    expect(bucket.tryAcquire("p")).toBe(false);
  });

  it("refills continuously at the configured rate", () => {
    const { limiter, advance } = controllable();
    const bucket = limiter({ fallback: { rps: 2, burst: 2 } });
    bucket.tryAcquire("p");
    bucket.tryAcquire("p");
    expect(bucket.tryAcquire("p")).toBe(false);

    advance(500);
    expect(bucket.tryAcquire("p")).toBe(true);
  });

  it("never accumulates beyond the burst", () => {
    const { limiter, advance } = controllable();
    const bucket = limiter({ fallback: { rps: 10, burst: 2 } });
    advance(60_000);
    expect(bucket.tryAcquire("p")).toBe(true);
    expect(bucket.tryAcquire("p")).toBe(true);
    expect(bucket.tryAcquire("p")).toBe(false);
  });

  it("keeps a separate bucket per provider", () => {
    const { limiter } = controllable();
    const bucket = limiter({ fallback: { rps: 1, burst: 1 } });
    expect(bucket.tryAcquire("steam")).toBe(true);
    expect(bucket.tryAcquire("steam")).toBe(false);
    expect(bucket.tryAcquire("riot")).toBe(true);
  });

  it("uses the registry limits when given, and the fallback otherwise", () => {
    const { limiter } = controllable();
    const bucket = limiter({
      fallback: { rps: 1, burst: 1 },
      perProvider: { generous: { rps: 10, burst: 5 } },
    });
    for (let i = 0; i < 5; i += 1) expect(bucket.tryAcquire("generous")).toBe(true);
    expect(bucket.tryAcquire("generous")).toBe(false);
    expect(bucket.tryAcquire("stingy")).toBe(true);
    expect(bucket.tryAcquire("stingy")).toBe(false);
  });
});

describe("acquire", () => {
  it("waits for a token when the wait is short enough", async () => {
    const { limiter, slept } = controllable();
    const bucket = limiter({ fallback: { rps: 2, burst: 1 } });
    await bucket.acquire("p");
    await bucket.acquire("p");
    expect(slept).toEqual([500]);
  });

  it("throws rather than blocking for longer than maxWaitMs", async () => {
    const { limiter } = controllable();
    // One token per ten seconds: the second request would wait far too long.
    const bucket = limiter({ fallback: { rps: 0.1, burst: 1 } });
    await bucket.acquire("p");
    await expect(bucket.acquire("p", 1_000)).rejects.toBeInstanceOf(LocalRateLimitError);
  });

  it("reports how long the caller would have had to wait", async () => {
    const { limiter } = controllable();
    const bucket = limiter({ fallback: { rps: 0.5, burst: 1 } });
    await bucket.acquire("p");
    try {
      await bucket.acquire("p", 100);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalRateLimitError);
      expect((error as LocalRateLimitError).retryAfterMs).toBe(2_000);
    }
  });
});

describe("penalize", () => {
  it("blocks every caller after a 429, not just the one that got it", () => {
    const { limiter } = controllable();
    const bucket = limiter({ fallback: { rps: 100, burst: 100 } });
    bucket.penalize("p", 5_000);
    // Without this, a fan-out would keep firing into a provider that already
    // said stop - which gets a key revoked rather than merely throttled.
    expect(bucket.tryAcquire("p")).toBe(false);
    expect(bucket.availableIn("p")).toBe(5_000);
  });

  it("lifts the block once the penalty expires", () => {
    const { limiter, advance } = controllable();
    const bucket = limiter({ fallback: { rps: 100, burst: 100 } });
    bucket.penalize("p", 1_000);
    advance(1_001);
    expect(bucket.tryAcquire("p")).toBe(true);
  });

  it("waits out a short penalty inside acquire", async () => {
    const { limiter, slept } = controllable();
    const bucket = limiter({ fallback: { rps: 100, burst: 100 } });
    bucket.penalize("p", 200);
    await bucket.acquire("p", 5_000);
    expect(slept).toContain(200);
  });

  it("keeps the longer of two overlapping penalties", () => {
    const { limiter } = controllable();
    const bucket = limiter();
    bucket.penalize("p", 5_000);
    bucket.penalize("p", 1_000);
    expect(bucket.availableIn("p")).toBe(5_000);
  });
});

describe("introspection", () => {
  it("reports zero wait when a token is free", () => {
    const { limiter } = controllable();
    expect(limiter().availableIn("p")).toBe(0);
  });

  it("reports the wait when the bucket is empty", () => {
    const { limiter } = controllable();
    const bucket = limiter({ fallback: { rps: 1, burst: 1 } });
    bucket.tryAcquire("p");
    expect(bucket.availableIn("p")).toBe(1_000);
  });

  it("snapshots every touched bucket", () => {
    const { limiter } = controllable();
    const bucket = limiter({ fallback: { rps: 5, burst: 5 } });
    bucket.tryAcquire("steam");
    bucket.penalize("riot", 3_000);
    const snapshot = bucket.snapshot();
    expect(snapshot.steam?.tokens).toBe(4);
    expect(snapshot.riot?.blockedForMs).toBe(3_000);
  });

  it("reconfigures a provider at runtime", () => {
    const { limiter } = controllable();
    const bucket = limiter({ fallback: { rps: 10, burst: 10 } });
    bucket.configure("p", { burst: 1 });
    expect(bucket.tryAcquire("p")).toBe(true);
    expect(bucket.tryAcquire("p")).toBe(false);
  });

  it("resets one bucket or all of them", () => {
    const { limiter } = controllable();
    const bucket = limiter({ fallback: { rps: 1, burst: 1 } });
    bucket.tryAcquire("p");
    bucket.reset("p");
    expect(bucket.tryAcquire("p")).toBe(true);

    bucket.tryAcquire("q");
    bucket.reset();
    expect(bucket.tryAcquire("q")).toBe(true);
  });
});
