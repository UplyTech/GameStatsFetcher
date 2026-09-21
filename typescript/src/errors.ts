/**
 * The error hierarchy.
 *
 * Every error thrown by this package extends {@link GameStatsError}, so a
 * caller can catch one class and still branch on `code` or `instanceof`.
 *
 * The distinction that matters most in practice is between the four kinds of
 * "no data":
 *
 * | Situation | Error | What the caller should do |
 * |---|---|---|
 * | The player does not exist | `NotFoundError` | tell the user |
 * | The profile is private | `PrivateProfileError` | tell the user to open it |
 * | The title cannot do this at all | `UnsupportedCapabilityError` | fix the code |
 * | No key was configured for it | `MissingCredentialError` | fix the deployment |
 *
 * Collapsing those into one "failed" would make every one of them look like an
 * outage, and three of the four are not.
 */

/** Base class for every error thrown by this package. */
export class GameStatsError extends Error {
  /** Stable, machine-readable discriminator. */
  public readonly code: string;
  /** Provider the failure came from, when there was one. */
  public readonly provider?: string;
  /** Title the call was about, when there was one. */
  public readonly titleId?: string;
  /** Upstream HTTP status, when the failure was an HTTP response. */
  public readonly statusCode?: number;
  /** Whatever caused this - an upstream body, a `TypeError` from fetch. */
  public readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      code: string;
      provider?: string;
      titleId?: string;
      statusCode?: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = new.target.name;
    this.code = options.code;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.titleId !== undefined) this.titleId = options.titleId;
    if (options.statusCode !== undefined) this.statusCode = options.statusCode;
    if (options.cause !== undefined) this.cause = options.cause;
    // Node only; the optional call keeps this working in a browser bundle.
    Error.captureStackTrace?.(this, new.target);
  }

  /** A log-safe object. Never contains an API key - none is ever stored here. */
  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      provider: this.provider ?? null,
      titleId: this.titleId ?? null,
      statusCode: this.statusCode ?? null,
    };
  }
}

/** An upstream request failed with a status this package has no specific class for. */
export class HttpError extends GameStatsError {
  /** The response body, truncated. Upstreams put the real reason in here. */
  public readonly body: string;

  constructor(provider: string, statusCode: number, body: string, cause?: unknown) {
    super(`${provider} responded ${statusCode}: ${truncate(body)}`, {
      code: "HTTP_ERROR",
      provider,
      statusCode,
      cause,
    });
    this.body = body;
  }
}

/** The request never got a response: DNS, TLS, socket, or an abort. */
export class NetworkError extends GameStatsError {
  constructor(provider: string, message: string, cause?: unknown) {
    super(`${provider} unreachable: ${message}`, {
      code: "NETWORK_ERROR",
      provider,
      cause,
    });
  }
}

/** The request exceeded `timeoutMs` and was aborted locally. */
export class TimeoutError extends GameStatsError {
  public readonly timeoutMs: number;

  constructor(provider: string, timeoutMs: number) {
    super(`${provider} did not respond within ${timeoutMs}ms`, {
      code: "TIMEOUT",
      provider,
    });
    this.timeoutMs = timeoutMs;
  }
}

/** Upstream returned 401 or 403: the key is wrong, expired, or lacks the scope. */
export class AuthenticationError extends GameStatsError {
  constructor(provider: string, message = "authentication rejected", cause?: unknown) {
    super(`${provider}: ${message}`, {
      code: "AUTH_ERROR",
      provider,
      statusCode: 401,
      cause,
    });
  }
}

/**
 * No key was configured for a provider that needs one.
 *
 * Thrown before any network call, and it names the option and the page the key
 * comes from - the two things somebody debugging a deployment actually needs.
 */
export class MissingCredentialError extends GameStatsError {
  public readonly keyName: string;
  public readonly docsUrl: string;

  constructor(provider: string, keyName: string, docsUrl: string, titleId?: string) {
    super(
      `${provider} needs an API key. Pass it as apiKeys.${keyName} - get one at ${docsUrl}`,
      { code: "MISSING_CREDENTIAL", provider, ...(titleId ? { titleId } : {}) },
    );
    this.keyName = keyName;
    this.docsUrl = docsUrl;
  }
}

/** Upstream returned 429. */
export class RateLimitError extends GameStatsError {
  /** From the `Retry-After` header, when the provider sent one. */
  public readonly retryAfterMs: number | null;

  constructor(provider: string, retryAfterMs: number | null, cause?: unknown) {
    super(
      retryAfterMs === null
        ? `${provider} rate limit reached`
        : `${provider} rate limit reached, retry in ${retryAfterMs}ms`,
      { code: "RATE_LIMIT", provider, statusCode: 429, cause },
    );
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The local token bucket refused the request before it reached the network.
 *
 * This is the limiter doing its job: it is cheaper to wait here than to spend
 * one of the provider's quota on a request that would come back 429.
 */
export class LocalRateLimitError extends GameStatsError {
  public readonly retryAfterMs: number;

  constructor(provider: string, retryAfterMs: number) {
    super(
      `local rate limit for ${provider} would need a ${retryAfterMs}ms wait`,
      { code: "LOCAL_RATE_LIMIT", provider },
    );
    this.retryAfterMs = retryAfterMs;
  }
}

/** The player, match or tournament does not exist. */
export class NotFoundError extends GameStatsError {
  constructor(provider: string, what: string, titleId?: string) {
    super(`${provider}: ${what} not found`, {
      code: "NOT_FOUND",
      provider,
      statusCode: 404,
      ...(titleId ? { titleId } : {}),
    });
  }
}

/**
 * The account exists but its stats are hidden.
 *
 * Steam, Xbox and PlayStation all default new profiles to private, so this is
 * a normal, frequent outcome rather than an exceptional one - and it needs a
 * different message to the user than "not found".
 */
export class PrivateProfileError extends GameStatsError {
  constructor(provider: string, playerId: string, titleId?: string) {
    super(`${provider}: profile ${playerId} is private`, {
      code: "PRIVATE_PROFILE",
      provider,
      ...(titleId ? { titleId } : {}),
    });
  }
}

/** The caller passed something this package can reject without asking upstream. */
export class ValidationError extends GameStatsError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "VALIDATION_ERROR", cause });
  }
}

/**
 * The identifiers handed to `resolvePlayer()` are not ones this title accepts.
 *
 * The message lists what the title does accept, because "invalid identifier"
 * on its own sends the caller to the documentation for no reason.
 */
export class IdentifierError extends GameStatsError {
  public readonly accepted: readonly string[];

  constructor(titleId: string, accepted: readonly string[]) {
    super(
      `${titleId} cannot resolve a player from the fields given. It accepts: ${accepted.join(", ")}`,
      { code: "IDENTIFIER_ERROR", titleId },
    );
    this.accepted = accepted;
  }
}

/**
 * The title exists but does not support this method.
 *
 * Thrown, never swallowed into an empty array: a caller who asks Tekken 8 for
 * a solo-queue rank has a bug, and an empty list would hide it until somebody
 * noticed the dashboard had been blank for a month.
 */
export class UnsupportedCapabilityError extends GameStatsError {
  public readonly capability: string;
  public readonly supported: readonly string[];

  constructor(titleId: string, capability: string, supported: readonly string[]) {
    super(
      `${titleId} does not support ${capability}. It supports: ${supported.join(", ") || "nothing yet"}`,
      { code: "UNSUPPORTED_CAPABILITY", titleId },
    );
    this.capability = capability;
    this.supported = supported;
  }
}

/** The title id is not in the registry. */
export class UnknownTitleError extends GameStatsError {
  public readonly suggestions: readonly string[];

  constructor(titleId: string, suggestions: readonly string[] = []) {
    super(
      suggestions.length > 0
        ? `unknown title "${titleId}". Did you mean: ${suggestions.join(", ")}?`
        : `unknown title "${titleId}"`,
      { code: "UNKNOWN_TITLE", titleId },
    );
    this.suggestions = suggestions;
  }
}

/** The provider id is not in the registry. */
export class UnknownProviderError extends GameStatsError {
  constructor(providerId: string) {
    super(`unknown provider "${providerId}"`, {
      code: "UNKNOWN_PROVIDER",
      provider: providerId,
    });
  }
}

/**
 * Upstream answered, but not with anything this package can map.
 *
 * Usually means the provider changed its schema. Kept distinct from
 * `HttpError` so a schema drift is visible in logs as itself rather than as a
 * generic failure.
 */
export class ParseError extends GameStatsError {
  constructor(provider: string, message: string, cause?: unknown) {
    super(`${provider} returned an unexpected shape: ${message}`, {
      code: "PARSE_ERROR",
      provider,
      cause,
    });
  }
}

/** The cache layer failed. Never propagates - caching is always best-effort. */
export class CacheError extends GameStatsError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "CACHE_ERROR", cause });
  }
}

/**
 * Every provider in a title's fallback chain failed.
 *
 * Carries all of them, because the first failure is rarely the interesting
 * one: "no key" followed by "429" followed by "500" is three different fixes.
 */
export class AllProvidersFailedError extends GameStatsError {
  public readonly failures: readonly { provider: string; error: GameStatsError }[];

  constructor(
    titleId: string,
    capability: string,
    failures: readonly { provider: string; error: GameStatsError }[],
  ) {
    const detail = failures.map((f) => `${f.provider} (${f.error.code})`).join(", ");
    super(`every provider for ${titleId}.${capability} failed: ${detail}`, {
      code: "ALL_PROVIDERS_FAILED",
      titleId,
    });
    this.failures = failures;
  }
}

/** Truncate an upstream body so a 2 MB HTML error page cannot land in a log line. */
function truncate(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}...`;
}

/** True for the errors where trying the next provider could plausibly help. */
export function isRetryableWithFallback(error: unknown): boolean {
  if (!(error instanceof GameStatsError)) return false;
  return (
    error.code === "HTTP_ERROR" ||
    error.code === "NETWORK_ERROR" ||
    error.code === "TIMEOUT" ||
    error.code === "RATE_LIMIT" ||
    error.code === "LOCAL_RATE_LIMIT" ||
    error.code === "MISSING_CREDENTIAL" ||
    error.code === "PARSE_ERROR"
  );
}
