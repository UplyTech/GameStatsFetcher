import { describe, expect, it } from "vitest";
import {
  AllProvidersFailedError,
  AuthenticationError,
  GameStatsError,
  HttpError,
  IdentifierError,
  LocalRateLimitError,
  MissingCredentialError,
  NetworkError,
  NotFoundError,
  ParseError,
  PrivateProfileError,
  RateLimitError,
  TimeoutError,
  UnknownTitleError,
  UnsupportedCapabilityError,
  ValidationError,
  isRetryableWithFallback,
} from "../src/errors.js";

describe("hierarchy", () => {
  const cases: [string, GameStatsError][] = [
    ["HttpError", new HttpError("p", 500, "boom")],
    ["NetworkError", new NetworkError("p", "reset")],
    ["TimeoutError", new TimeoutError("p", 1_000)],
    ["AuthenticationError", new AuthenticationError("p")],
    ["MissingCredentialError", new MissingCredentialError("p", "riot", "https://d.test")],
    ["RateLimitError", new RateLimitError("p", 1_000)],
    ["LocalRateLimitError", new LocalRateLimitError("p", 500)],
    ["NotFoundError", new NotFoundError("p", "player")],
    ["PrivateProfileError", new PrivateProfileError("p", "123")],
    ["ValidationError", new ValidationError("bad")],
    ["IdentifierError", new IdentifierError("cs2", ["steamId"])],
    ["UnsupportedCapabilityError", new UnsupportedCapabilityError("t", "getRank", [])],
    ["UnknownTitleError", new UnknownTitleError("nope")],
    ["ParseError", new ParseError("p", "shape")],
  ];

  it.each(cases)("%s extends GameStatsError and carries a code", (_name, error) => {
    expect(error).toBeInstanceOf(GameStatsError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toMatch(/^[A-Z_]+$/);
    expect(error.message.length).toBeGreaterThan(0);
  });

  it.each(cases)("%s names itself correctly", (name, error) => {
    expect(error.name).toBe(name);
  });
});

describe("messages that save a debugging session", () => {
  it("MissingCredentialError names the option and the page", () => {
    const error = new MissingCredentialError("riot", "riot", "https://developer.riotgames.com");
    expect(error.message).toContain("apiKeys.riot");
    expect(error.message).toContain("developer.riotgames.com");
    expect(error.keyName).toBe("riot");
  });

  it("IdentifierError lists what the title does accept", () => {
    const error = new IdentifierError("cs2", ["steamId", "name"]);
    expect(error.message).toContain("steamId");
    expect(error.message).toContain("name");
    expect(error.accepted).toEqual(["steamId", "name"]);
  });

  it("UnsupportedCapabilityError lists what the title can do instead", () => {
    const error = new UnsupportedCapabilityError("tekken-8", "getRank", [
      "getEsportsMatches",
      "getEarnings",
    ]);
    expect(error.message).toContain("getEsportsMatches");
    expect(error.supported).toHaveLength(2);
  });

  it("UnsupportedCapabilityError copes with a title that supports nothing", () => {
    expect(new UnsupportedCapabilityError("t", "getRank", []).message).toContain("nothing yet");
  });

  it("UnknownTitleError offers the closest matches", () => {
    const error = new UnknownTitleError("valorent", ["valorant"]);
    expect(error.message).toContain("Did you mean");
    expect(error.suggestions).toEqual(["valorant"]);
  });

  it("RateLimitError says how long to wait when the provider said so", () => {
    expect(new RateLimitError("p", 5_000).message).toContain("5000ms");
    expect(new RateLimitError("p", null).message).not.toContain("retry in");
  });

  it("AllProvidersFailedError reports every failure, not just the last", () => {
    const error = new AllProvidersFailedError("cs2", "getEsportsMatches", [
      { provider: "pandascore", error: new MissingCredentialError("pandascore", "pandascore", "https://d.test") },
      { provider: "liquipedia", error: new RateLimitError("liquipedia", null) },
    ]);
    expect(error.message).toContain("pandascore (MISSING_CREDENTIAL)");
    expect(error.message).toContain("liquipedia (RATE_LIMIT)");
    expect(error.failures).toHaveLength(2);
  });
});

describe("HttpError body handling", () => {
  it("keeps the full body but truncates the message", () => {
    const body = "x".repeat(1_000);
    const error = new HttpError("p", 500, body);
    expect(error.body).toHaveLength(1_000);
    expect(error.message.length).toBeLessThan(400);
    expect(error.message).toContain("...");
  });

  it("flattens whitespace so an HTML error page stays on one log line", () => {
    const error = new HttpError("p", 500, "line one\n\n  line two");
    expect(error.message).toContain("line one line two");
  });
});

describe("toJSON", () => {
  it("produces a log-safe object", () => {
    const json = new HttpError("riot", 503, "unavailable").toJSON();
    expect(json).toMatchObject({
      name: "HttpError",
      code: "HTTP_ERROR",
      provider: "riot",
      statusCode: 503,
    });
  });

  it("never contains a credential, because none is ever stored on the error", () => {
    const error = new MissingCredentialError("riot", "riot", "https://d.test");
    expect(JSON.stringify(error.toJSON())).not.toContain("secret");
  });

  it("fills absent fields with null rather than omitting them", () => {
    expect(new ValidationError("bad").toJSON()).toMatchObject({
      provider: null,
      titleId: null,
      statusCode: null,
    });
  });
});

describe("isRetryableWithFallback", () => {
  it("is true for the failures another provider could plausibly survive", () => {
    expect(isRetryableWithFallback(new HttpError("p", 500, ""))).toBe(true);
    expect(isRetryableWithFallback(new NetworkError("p", "x"))).toBe(true);
    expect(isRetryableWithFallback(new TimeoutError("p", 1))).toBe(true);
    expect(isRetryableWithFallback(new RateLimitError("p", null))).toBe(true);
    expect(isRetryableWithFallback(new MissingCredentialError("p", "k", "u"))).toBe(true);
  });

  it("is false where a second provider would fail identically", () => {
    // A player who does not exist does not exist anywhere, and a private
    // profile stays private - switching provider only wastes a request.
    expect(isRetryableWithFallback(new NotFoundError("p", "player"))).toBe(false);
    expect(isRetryableWithFallback(new PrivateProfileError("p", "1"))).toBe(false);
    expect(isRetryableWithFallback(new ValidationError("bad"))).toBe(false);
  });

  it("is false for anything that is not one of ours", () => {
    expect(isRetryableWithFallback(new Error("plain"))).toBe(false);
    expect(isRetryableWithFallback("string")).toBe(false);
    expect(isRetryableWithFallback(null)).toBe(false);
  });
});
