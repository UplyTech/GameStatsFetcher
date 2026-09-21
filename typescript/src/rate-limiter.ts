/**
 * Per-provider token buckets.
 *
 * Every provider in the registry declares its own `rps` and `burst`, because
 * they are nowhere near each other: a Riot development key allows 20 requests
 * per second, Esports Earnings allows one per second and will ban an
 * application that ignores that, and Liquipedia allows one every two seconds
 * *and* requires a contact address in the User-Agent.
 *
 * One global limit would have to be the smallest of those, which would make the
 * package unusable for the providers that are generous. So the bucket is keyed
 * by provider, and the registry supplies the numbers.
 *
 * Buckets are shared across every title that uses a provider. That matters:
 * asking for CS2 and Dota 2 in the same second is two requests against one
 * Steam quota, and a limiter that did not know that would let both through.
 */

import { LocalRateLimitError } from "./errors.js";
import { DEFAULT_RATE_LIMIT } from "./constants.js";
import type { RateLimitConfig } from "./types.js";

interface Bucket {
  tokens: number;
  lastRefill: number;
  config: RateLimitConfig;
  /** Set when a 429 told us to stop until a point in time. */
  blockedUntil: number;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly fallback: RateLimitConfig;
  private readonly perProvider: Map<string, RateLimitConfig>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: {
    /** Applied to providers the registry has no numbers for. */
    fallback?: Partial<RateLimitConfig>;
    /** Registry-supplied limits, keyed by provider id. */
    perProvider?: Readonly<Record<string, RateLimitConfig>>;
    /** Injectable clock and sleep, so the tests do not have to wait in real time. */
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {}) {
    this.fallback = {
      rps: options.fallback?.rps ?? DEFAULT_RATE_LIMIT.rps,
      burst: options.fallback?.burst ?? DEFAULT_RATE_LIMIT.burst,
    };
    this.perProvider = new Map(Object.entries(options.perProvider ?? {}));
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Take one token for `provider`, waiting for it if the wait is short enough.
   *
   * Throws {@link LocalRateLimitError} rather than waiting when the wait would
   * exceed `maxWaitMs`. A caller that blocks for thirty seconds inside a slash
   * command has already failed; better to tell them now so they can queue the
   * work or answer "try again shortly".
   */
  public async acquire(provider: string, maxWaitMs = 5_000): Promise<void> {
    const bucket = this.bucketFor(provider);
    const now = this.now();

    // An upstream 429 outranks the local accounting: it is the provider telling
    // us our own model of its limit was wrong.
    if (bucket.blockedUntil > now) {
      const wait = bucket.blockedUntil - now;
      if (wait > maxWaitMs) throw new LocalRateLimitError(provider, wait);
      await this.sleep(wait);
      bucket.blockedUntil = 0;
    }

    this.refill(bucket, this.now());
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }

    const deficit = 1 - bucket.tokens;
    const waitMs = Math.ceil((deficit / bucket.config.rps) * 1_000);
    if (waitMs > maxWaitMs) throw new LocalRateLimitError(provider, waitMs);

    await this.sleep(waitMs);
    this.refill(bucket, this.now());
    // The refill above put at least one token back; spend it without letting a
    // rounding error push `tokens` below zero.
    bucket.tokens = Math.max(0, bucket.tokens - 1);
  }

  /** Take a token if one is free. Never waits, never throws. */
  public tryAcquire(provider: string): boolean {
    const bucket = this.bucketFor(provider);
    const now = this.now();
    if (bucket.blockedUntil > now) return false;
    this.refill(bucket, now);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /**
   * Record a 429 so nothing else is sent to this provider until it lifts.
   *
   * Without this, every concurrent caller keeps firing into a provider that has
   * already said stop - which is how an application gets its key revoked rather
   * than merely throttled.
   */
  public penalize(provider: string, retryAfterMs: number): void {
    const bucket = this.bucketFor(provider);
    bucket.blockedUntil = Math.max(bucket.blockedUntil, this.now() + Math.max(0, retryAfterMs));
    bucket.tokens = 0;
  }

  /** Milliseconds until `provider` could serve a request. `0` when it can now. */
  public availableIn(provider: string): number {
    const bucket = this.bucketFor(provider);
    const now = this.now();
    if (bucket.blockedUntil > now) return bucket.blockedUntil - now;
    this.refill(bucket, now);
    if (bucket.tokens >= 1) return 0;
    return Math.ceil(((1 - bucket.tokens) / bucket.config.rps) * 1_000);
  }

  /** Override the limits for one provider at runtime. */
  public configure(provider: string, config: Partial<RateLimitConfig>): void {
    const bucket = this.bucketFor(provider);
    bucket.config = {
      rps: config.rps ?? bucket.config.rps,
      burst: config.burst ?? bucket.config.burst,
    };
    bucket.tokens = Math.min(bucket.tokens, bucket.config.burst);
  }

  /** Drop one bucket, or all of them. */
  public reset(provider?: string): void {
    if (provider) this.buckets.delete(provider);
    else this.buckets.clear();
  }

  /** A snapshot for metrics or a `/debug` command. */
  public snapshot(): Record<string, { tokens: number; blockedForMs: number }> {
    const now = this.now();
    const out: Record<string, { tokens: number; blockedForMs: number }> = {};
    for (const [provider, bucket] of this.buckets) {
      this.refill(bucket, now);
      out[provider] = {
        tokens: Math.floor(bucket.tokens),
        blockedForMs: Math.max(0, bucket.blockedUntil - now),
      };
    }
    return out;
  }

  private refill(bucket: Bucket, now: number): void {
    const elapsedSeconds = (now - bucket.lastRefill) / 1_000;
    if (elapsedSeconds <= 0) return;
    bucket.tokens = Math.min(
      bucket.config.burst,
      bucket.tokens + elapsedSeconds * bucket.config.rps,
    );
    bucket.lastRefill = now;
  }

  private bucketFor(provider: string): Bucket {
    let bucket = this.buckets.get(provider);
    if (!bucket) {
      const config = this.perProvider.get(provider) ?? this.fallback;
      // A new bucket starts full. The provider has not heard from us yet, so
      // there is nothing to make up for.
      bucket = {
        tokens: config.burst,
        lastRefill: this.now(),
        config: { ...config },
        blockedUntil: 0,
      };
      this.buckets.set(provider, bucket);
    }
    return bucket;
  }
}
