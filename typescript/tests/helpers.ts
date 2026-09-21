/**
 * A hand-rolled fetch stand-in.
 *
 * The package takes `fetch` as an option precisely so the tests can do this
 * without a mocking framework or a network. Routes are matched by substring in
 * declaration order, which keeps the tests readable: a route reads as "the URL
 * containing this bit answers with that".
 */
import type { GameStatsClient } from "../src/client.js";
import { listProviders } from "../src/index.js";

export interface Route {
  /** Substring the request URL must contain. */
  readonly match: string;
  readonly status?: number;
  /** Serialised as JSON unless `text` is set. */
  readonly body?: unknown;
  readonly text?: string;
  readonly headers?: Record<string, string>;
  /** Answer differently on each call - for testing retries. */
  readonly sequence?: readonly { status?: number; body?: unknown; headers?: Record<string, string> }[];
}

export interface MockFetch {
  readonly fetch: typeof fetch;
  /** Every URL requested, in order. */
  readonly calls: string[];
  /** Every request init, in order. */
  readonly inits: (RequestInit | undefined)[];
  /** How many times a route substring was hit. */
  countOf(match: string): number;
}

export function mockFetch(routes: readonly Route[]): MockFetch {
  const calls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const sequenceIndex = new Map<string, number>();

  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    inits.push(init);

    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) {
      return new Response(JSON.stringify({ error: "no route", url }), {
        status: 599,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (route.sequence) {
      const index = sequenceIndex.get(route.match) ?? 0;
      sequenceIndex.set(route.match, index + 1);
      const step = route.sequence[Math.min(index, route.sequence.length - 1)];
      return build(step?.status ?? 200, step?.body, "application/json", step?.headers);
    }

    if (route.text !== undefined) {
      return build(route.status ?? 200, route.text, "text/plain", route.headers, true);
    }

    return build(route.status ?? 200, route.body, "application/json", route.headers);
  }) as typeof fetch;

  /**
   * Build a Response, respecting the statuses that must not carry a body.
   *
   * `new Response("", { status: 204 })` throws in undici, so a null-body status
   * has to be constructed with a null body rather than an empty string.
   */
  function build(
    status: number,
    body: unknown,
    contentType: string,
    headers: Record<string, string> | undefined,
    raw = false,
  ): Response {
    const nullBody = status === 204 || status === 205 || status === 304;
    const payload = nullBody || body === undefined ? null : raw ? String(body) : JSON.stringify(body);
    return new Response(payload, {
      status,
      headers: { "Content-Type": contentType, ...headers },
    });
  }

  return {
    fetch: impl,
    calls,
    inits,
    countOf: (match) => calls.filter((url) => url.includes(match)).length,
  };
}

/** Client options that keep the tests fast, quiet and offline. */
export function testOptions(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return {
    fetch: fetchImpl,
    cache: { driver: "none" as const },
    // Retries would turn a deliberate 500 into three requests and a slow test.
    retry: { attempts: 0 },
    logger: "silent" as const,
    ...overrides,
  };
}

/**
 * Lift the published rate limits for a test that makes thousands of calls.
 *
 * Two reasons, and the second matters more than the first. A bucket at the
 * published 2 rps really does wait half a second between calls, so a sweep over
 * every title takes an hour. And once a bucket empties, `acquire` stops waiting
 * and throws `LocalRateLimitError` instead - which is a `GameStatsError`, so a
 * test asserting "this failed as a GameStatsError" would pass without the
 * request ever being made. A sweep has to lift the limits or it is measuring
 * the rate limiter.
 */
export function unthrottled(client: GameStatsClient): GameStatsClient {
  for (const descriptor of listProviders()) {
    client.internals.limiter.configure(descriptor.id, { rps: 1e6, burst: 1e6 });
  }
  return client;
}
