/**
 * The transport.
 *
 * One place where every request in the package goes out, so that rate
 * limiting, retries, timeouts and error normalisation exist once rather than
 * forty times. Provider modules build a URL and hand it here; they never call
 * `fetch` themselves.
 *
 * What this layer deliberately does *not* do is interpret the body. A 200 with
 * a payload that means "player not found" is a provider quirk, and unpicking it
 * belongs in that provider's module, next to the rest of its oddities.
 */

import {
  AuthenticationError,
  HttpError,
  NetworkError,
  NotFoundError,
  ParseError,
  RateLimitError,
  TimeoutError,
} from "./errors.js";
import type { TokenBucketRateLimiter } from "./rate-limiter.js";
import { DEFAULT_RETRY, DEFAULT_TIMEOUT_MS, DEFAULT_USER_AGENT } from "./constants.js";
import type { LoggerLike, RetryConfig } from "./types.js";

/** Query values a caller may pass. `undefined` and `null` entries are dropped. */
export type QueryValue = string | number | boolean | undefined | null;

export interface RequestSpec {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Appended to the URL. Encoding happens here, so pass raw values. */
  readonly query?: Readonly<Record<string, QueryValue | readonly QueryValue[]>>;
  readonly headers?: Readonly<Record<string, string>>;
  /** Serialised as JSON with the matching Content-Type. */
  readonly json?: unknown;
  /** Sent verbatim. Use for form bodies; set Content-Type yourself. */
  readonly body?: string;
  /**
   * Treat a 404 as an empty answer instead of an error.
   *
   * A handful of endpoints - Riot's league entries, Supercell's club lookup -
   * use 404 to mean "this player has none of these", which is a normal result
   * and not a missing player.
   */
  readonly nullOn404?: boolean;
  /** Expected response body. `text` skips JSON parsing. */
  readonly parse?: "json" | "text";
  /** Overrides the client-wide timeout for one call. */
  readonly timeoutMs?: number;
  /** Longest the limiter may block this call before it gives up. */
  readonly maxWaitMs?: number;
}

export interface HttpClientOptions {
  readonly fetch: typeof fetch;
  readonly limiter: TokenBucketRateLimiter;
  readonly logger: LoggerLike;
  readonly retry?: RetryConfig;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
  /**
   * Every configured credential, so nothing this layer emits can contain one.
   *
   * Eight providers authenticate by query parameter, which puts the key in the
   * URL. Errors here never carry the URL - but two things they *do* carry can
   * still hold a key: a transport error message, which for some failures is
   * built from the URL, and an upstream error body, because a surprising number
   * of APIs answer "invalid api key: abc123" with the key quoted back.
   *
   * Both end up in somebody's log aggregator. So the values are replaced before
   * the error is constructed, not before it is printed - by then it is already
   * in three places.
   */
  readonly secrets?: readonly string[];
}

/**
 * Replace every known credential with `***`.
 *
 * Sorted longest-first so a key that contains another key as a prefix - a
 * `clientId:clientSecret` pair and the id on its own, which is exactly how the
 * Blizzard and osu! credentials are shaped - is redacted whole rather than
 * leaving the tail exposed.
 *
 * Short values are skipped. A one-character "key" is a placeholder from a test
 * or a misconfiguration, and redacting it would turn every message into
 * asterisks and hide the actual problem.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length < 8) continue;
    output = output.split(secret).join("***");
  }
  return output;
}

export class HttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: TokenBucketRateLimiter;
  private readonly logger: LoggerLike;
  private readonly retry: Required<RetryConfig>;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly secrets: readonly string[];

  constructor(options: HttpClientOptions) {
    this.fetchImpl = options.fetch;
    this.limiter = options.limiter;
    this.logger = options.logger;
    this.retry = { ...DEFAULT_RETRY, ...options.retry } as Required<RetryConfig>;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.secrets = (options.secrets ?? []).filter(
      (secret): secret is string => typeof secret === "string" && secret.length > 0,
    );
  }

  /** Nothing this client reports may contain a credential. */
  private safe(text: string): string {
    return this.secrets.length === 0 ? text : redactSecrets(text, this.secrets);
  }

  /**
   * Send one request, with rate limiting, retries and normalised errors.
   *
   * Returns `null` only when `nullOn404` was set and the upstream answered 404.
   */
  public async send<T>(providerId: string, url: string, spec: RequestSpec = {}): Promise<T> {
    const finalUrl = spec.query ? appendQuery(url, spec.query) : url;
    const attempts = Math.max(0, this.retry.attempts) + 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // The limiter is inside the retry loop on purpose: a retry is a new
      // request against the provider's quota, not a free continuation.
      await this.limiter.acquire(providerId, spec.maxWaitMs ?? 5_000);

      try {
        return await this.attempt<T>(providerId, finalUrl, spec);
      } catch (err) {
        lastError = err;
        const delay = this.retryDelay(err, attempt);
        if (delay === null || attempt === attempts - 1) throw err;
        this.logger.debug(
          `[gsf] ${providerId} attempt ${attempt + 1}/${attempts} failed, retrying in ${delay}ms`,
        );
        await sleep(delay);
      }
    }

    // Unreachable: the loop either returns or throws. Kept so the compiler can
    // see a terminating path without widening the return type.
    throw lastError;
  }

  private async attempt<T>(providerId: string, url: string, spec: RequestSpec): Promise<T> {
    const method = spec.method ?? "GET";
    const timeoutMs = spec.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      Accept: spec.parse === "text" ? "*/*" : "application/json",
      "User-Agent": this.userAgent,
      ...spec.headers,
    };

    let body: string | undefined;
    if (spec.json !== undefined) {
      body = JSON.stringify(spec.json);
      headers["Content-Type"] ??= "application/json";
    } else if (spec.body !== undefined) {
      body = spec.body;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        signal: controller.signal,
        ...(body === undefined ? {} : { body }),
      });
    } catch (err) {
      if (isAbort(err)) throw new TimeoutError(providerId, timeoutMs);
      throw new NetworkError(providerId, this.safe(describe(err)), err);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404 && spec.nullOn404) {
      return null as T;
    }
    if (!response.ok) {
      throw await this.toError(providerId, response);
    }

    if (spec.parse === "text") {
      return (await response.text()) as T;
    }

    // 204 and an empty 200 both happen; neither is JSON.
    if (response.status === 204) return null as T;
    const text = await response.text();
    if (text.length === 0) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new ParseError(providerId, "response body was not valid JSON", err);
    }
  }

  /** Map a non-2xx response onto the class that says what actually went wrong. */
  private async toError(providerId: string, response: Response): Promise<Error> {
    const body = await safeText(response);

    if (response.status === 401 || response.status === 403) {
      // The likeliest place of all for a key to come back: an API that answers
      // "invalid api key: abc123" does it on exactly this status.
      return new AuthenticationError(providerId, this.safe(truncate(body)) || "key rejected");
    }
    if (response.status === 404) {
      return new NotFoundError(providerId, "resource");
    }
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
      // Tell the limiter, so concurrent callers stop rather than pile on.
      this.limiter.penalize(providerId, retryAfterMs ?? 1_000);
      return new RateLimitError(providerId, retryAfterMs);
    }
    return new HttpError(providerId, response.status, this.safe(body));
  }

  /**
   * How long to wait before the next attempt, or `null` to give up now.
   *
   * `Retry-After` wins over the computed backoff when the provider sent one:
   * the provider knows when its window resets and we are guessing.
   */
  private retryDelay(err: unknown, attempt: number): number | null {
    const status = err instanceof HttpError ? err.statusCode : undefined;
    const retryable =
      err instanceof NetworkError ||
      err instanceof TimeoutError ||
      err instanceof RateLimitError ||
      (status !== undefined && this.retry.retryOn.includes(status));
    if (!retryable) return null;

    if (this.retry.respectRetryAfter && err instanceof RateLimitError && err.retryAfterMs !== null) {
      return Math.min(err.retryAfterMs, this.retry.maxDelayMs);
    }

    const exponential = this.retry.baseDelayMs * 2 ** attempt;
    // Full jitter. Without it, a fan-out of twenty match lookups that all hit a
    // 429 would retry in lockstep and hit the same wall again.
    const jittered = Math.random() * exponential;
    return Math.min(Math.max(this.retry.baseDelayMs / 2, jittered), this.retry.maxDelayMs);
  }
}

/** Append query parameters, dropping empty ones and repeating array values. */
export function appendQuery(
  url: string,
  query: Readonly<Record<string, QueryValue | readonly QueryValue[]>>,
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value as QueryValue];
    for (const item of values) {
      if (item === undefined || item === null) continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
    }
  }
  if (parts.length === 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${parts.join("&")}`;
}

/**
 * Parse `Retry-After`, which is either a delay in seconds or an HTTP date.
 *
 * Both forms appear in the wild - Riot sends seconds, Cloudflare in front of
 * several of the community APIs sends a date.
 */
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1_000));
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

function isAbort(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: string }).name === "AbortError"
  );
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return response.statusText;
  }
}

function truncate(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}...`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
