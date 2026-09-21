import { describe, expect, it } from "vitest";
import { HttpClient, appendQuery, parseRetryAfter, redactSecrets } from "../src/http.js";
import { GameStatsClient } from "../src/client.js";
import { TokenBucketRateLimiter } from "../src/rate-limiter.js";
import { silentLogger } from "../src/runtime.js";
import {
  AuthenticationError,
  HttpError,
  NetworkError,
  NotFoundError,
  ParseError,
  RateLimitError,
  TimeoutError,
} from "../src/errors.js";
import { mockFetch, testOptions } from "./helpers.js";

function client(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}): HttpClient {
  return new HttpClient({
    fetch: fetchImpl,
    limiter: new TokenBucketRateLimiter({ fallback: { rps: 1_000, burst: 1_000 } }),
    logger: silentLogger(),
    retry: { attempts: 0 },
    ...overrides,
  });
}

describe("appendQuery", () => {
  it("encodes and appends", () => {
    expect(appendQuery("https://x.test/a", { q: "a b", n: 2 })).toBe(
      "https://x.test/a?q=a%20b&n=2",
    );
  });

  it("respects an existing query string", () => {
    expect(appendQuery("https://x.test/a?x=1", { y: 2 })).toBe("https://x.test/a?x=1&y=2");
  });

  it("drops absent values rather than sending empty ones", () => {
    expect(appendQuery("https://x.test/a", { a: 1, b: undefined, c: null })).toBe(
      "https://x.test/a?a=1",
    );
  });

  it("repeats an array parameter", () => {
    expect(appendQuery("https://x.test/a", { id: [1, 2] })).toBe("https://x.test/a?id=1&id=2");
  });

  it("leaves the URL alone when nothing survives", () => {
    expect(appendQuery("https://x.test/a", { a: undefined })).toBe("https://x.test/a");
  });
});

describe("parseRetryAfter", () => {
  it("reads the seconds form", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
  });

  it("reads the HTTP-date form", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const parsed = parseRetryAfter(future) ?? 0;
    expect(parsed).toBeGreaterThan(8_000);
    expect(parsed).toBeLessThanOrEqual(11_000);
  });

  it("returns null for a missing or unparseable header", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("responses", () => {
  it("parses JSON", async () => {
    const mock = mockFetch([{ match: "/ok", body: { a: 1 } }]);
    expect(await client(mock.fetch).send("p", "https://x.test/ok")).toEqual({ a: 1 });
  });

  it("returns text when asked to", async () => {
    const mock = mockFetch([{ match: "/text", text: "hello" }]);
    expect(await client(mock.fetch).send("p", "https://x.test/text", { parse: "text" })).toBe(
      "hello",
    );
  });

  it("treats 204 and an empty body as null", async () => {
    const mock = mockFetch([
      { match: "/empty", status: 204 },
      { match: "/blank", status: 200 },
    ]);
    expect(await client(mock.fetch).send("p", "https://x.test/empty")).toBeNull();
    expect(await client(mock.fetch).send("p", "https://x.test/blank")).toBeNull();
  });

  it("reports a body that is not JSON as a parse error, not a transport one", async () => {
    const mock = mockFetch([
      { match: "/bad", text: "<html>oops</html>", headers: { "Content-Type": "application/json" } },
    ]);
    await expect(client(mock.fetch).send("p", "https://x.test/bad")).rejects.toBeInstanceOf(
      ParseError,
    );
  });
});

describe("error mapping", () => {
  it("maps 401 and 403 to an authentication error", async () => {
    const mock = mockFetch([{ match: "/401", status: 401, body: { message: "bad key" } }]);
    await expect(client(mock.fetch).send("p", "https://x.test/401")).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("maps 404 to not found", async () => {
    const mock = mockFetch([{ match: "/404", status: 404 }]);
    await expect(client(mock.fetch).send("p", "https://x.test/404")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("turns 404 into null when the endpoint uses it to mean 'none'", async () => {
    const mock = mockFetch([{ match: "/404", status: 404 }]);
    expect(
      await client(mock.fetch).send("p", "https://x.test/404", { nullOn404: true }),
    ).toBeNull();
  });

  it("maps 429 to a rate limit error carrying Retry-After", async () => {
    const mock = mockFetch([
      { match: "/429", status: 429, headers: { "Retry-After": "12" } },
    ]);
    try {
      await client(mock.fetch).send("p", "https://x.test/429");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterMs).toBe(12_000);
    }
  });

  it("tells the limiter about a 429, so concurrent callers stop too", async () => {
    const limiter = new TokenBucketRateLimiter({ fallback: { rps: 1_000, burst: 1_000 } });
    const mock = mockFetch([{ match: "/429", status: 429, headers: { "Retry-After": "5" } }]);
    const http = new HttpClient({
      fetch: mock.fetch,
      limiter,
      logger: silentLogger(),
      retry: { attempts: 0 },
    });
    await expect(http.send("p", "https://x.test/429")).rejects.toBeInstanceOf(RateLimitError);
    expect(limiter.availableIn("p")).toBeGreaterThan(0);
  });

  it("maps anything else to an HTTP error with the body attached", async () => {
    const mock = mockFetch([{ match: "/500", status: 500, body: { detail: "boom" } }]);
    try {
      await client(mock.fetch).send("p", "https://x.test/500");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).statusCode).toBe(500);
      expect((error as HttpError).body).toContain("boom");
    }
  });

  it("maps a thrown fetch to a network error", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(client(failing).send("p", "https://x.test/a")).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it("maps an abort to a timeout error", async () => {
    const aborting = (async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;
    await expect(
      client(aborting, { timeoutMs: 5 }).send("p", "https://x.test/a"),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe("retries", () => {
  it("retries a 500 and succeeds on the second attempt", async () => {
    const mock = mockFetch([
      { match: "/flaky", sequence: [{ status: 500 }, { status: 200, body: { ok: true } }] },
    ]);
    const http = client(mock.fetch, { retry: { attempts: 2, baseDelayMs: 1 } });
    expect(await http.send("p", "https://x.test/flaky")).toEqual({ ok: true });
    expect(mock.countOf("/flaky")).toBe(2);
  });

  it("does not retry a 404, because it will not change", async () => {
    const mock = mockFetch([{ match: "/gone", status: 404 }]);
    const http = client(mock.fetch, { retry: { attempts: 3, baseDelayMs: 1 } });
    await expect(http.send("p", "https://x.test/gone")).rejects.toBeInstanceOf(NotFoundError);
    expect(mock.countOf("/gone")).toBe(1);
  });

  it("does not retry a 401 either", async () => {
    const mock = mockFetch([{ match: "/auth", status: 401 }]);
    const http = client(mock.fetch, { retry: { attempts: 3, baseDelayMs: 1 } });
    await expect(http.send("p", "https://x.test/auth")).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(mock.countOf("/auth")).toBe(1);
  });

  it("gives up after the configured number of attempts", async () => {
    const mock = mockFetch([{ match: "/down", status: 503 }]);
    const http = client(mock.fetch, { retry: { attempts: 2, baseDelayMs: 1 } });
    await expect(http.send("p", "https://x.test/down")).rejects.toBeInstanceOf(HttpError);
    expect(mock.countOf("/down")).toBe(3);
  });
});

describe("headers", () => {
  it("sends the configured User-Agent", async () => {
    const mock = mockFetch([{ match: "/ua", body: {} }]);
    await client(mock.fetch, { userAgent: "MyBot/1.0 (me@example.com)" }).send(
      "p",
      "https://x.test/ua",
    );
    const headers = mock.inits[0]?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("MyBot/1.0 (me@example.com)");
  });

  it("lets a caller override Accept and add its own headers", async () => {
    const mock = mockFetch([{ match: "/h", body: {} }]);
    await client(mock.fetch).send("p", "https://x.test/h", {
      headers: { Accept: "application/vnd.api+json", "X-Custom": "1" },
    });
    const headers = mock.inits[0]?.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/vnd.api+json");
    expect(headers["X-Custom"]).toBe("1");
  });

  it("sets a JSON content type for a JSON body", async () => {
    const mock = mockFetch([{ match: "/post", body: {} }]);
    await client(mock.fetch).send("p", "https://x.test/post", {
      method: "POST",
      json: { a: 1 },
    });
    const init = mock.inits[0];
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ a: 1 }));
  });
});

describe("secret redaction", () => {
  /**
   * No credential this client was given may leave it inside a message.
   *
   * Eight providers authenticate by query parameter, so their key is in the
   * URL. Errors never carry the URL - but a transport error message can be
   * built from it, and an upstream error body frequently quotes the key back
   * ("invalid api key: abc123"). Both end up in a log aggregator, which is why
   * the value is replaced when the error is *constructed*.
   */

  it("replaces a key wherever it appears", () => {
    const text = "GET https://api.test/v1?api_key=sk-live-abcdef123456 failed";
    expect(redactSecrets(text, ["sk-live-abcdef123456"])).toBe(
      "GET https://api.test/v1?api_key=*** failed",
    );
  });

  it("redacts the longest match first", () => {
    // Blizzard and osu! credentials are `clientId:clientSecret` pairs. A naive
    // pass would redact the id and leave the secret next to three asterisks,
    // which is worse than not redacting at all.
    const secrets = ["client-id-value", "client-id-value:super-secret-value"];
    expect(redactSecrets("using client-id-value:super-secret-value", secrets)).toBe("using ***");
  });

  it("leaves a short placeholder alone", () => {
    // A one-character key is a test fixture or a misconfiguration. Redacting it
    // would turn every message into asterisks and hide the real problem.
    expect(redactSecrets("no route for k", ["k"])).toBe("no route for k");
  });

  it("keeps an upstream error body from leaking the key", async () => {
    const key = "sk-live-abcdef123456";
    const mock = mockFetch([
      { match: "/ISteamUser", status: 403, body: { error: `invalid api key: ${key}` } },
    ]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { steam: key } }));
    await expect(
      client.title("cs2").getPlayer({ steamId: "76561197960287930" }),
    ).rejects.toThrow(/\*\*\*/);
    await expect(
      client.title("cs2").getPlayer({ steamId: "76561197960287930" }),
    ).rejects.not.toThrow(new RegExp(key));
  });

  it("keeps a transport failure from leaking the key", async () => {
    const key = "sk-live-abcdef123456";
    const failing = (async (input: RequestInfo | URL) => {
      // undici puts the URL in the message for some failures, and the URL is
      // where a query key lives.
      throw new Error(`connection refused for ${String(input)}&api_key=${key}`);
    }) as unknown as typeof fetch;

    const client = new GameStatsClient(testOptions(failing, { apiKeys: { steam: key } }));
    let message = "";
    try {
      await client.title("cs2").getPlayer({ steamId: "76561197960287930" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(key);
    expect(message).toContain("***");
  });
});
