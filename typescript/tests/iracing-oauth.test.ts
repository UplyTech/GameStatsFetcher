/**
 * iRacing over OAuth 2.0: the authorization URL, the token exchange, renewal.
 *
 * iRacing retired the email/password login on 9 December 2025. These tests pin
 * the replacement: Authorization Code with PKCE, refresh tokens that rotate, a
 * bearer token on every Data API call.
 *
 * Hosts are compared after parsing, never by substring, so a test cannot pass
 * on a look-alike host. Mirrors `python/tests/test_iracing_oauth.py`.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GameStatsClient } from "../src/client.js";
import { AuthenticationError, MissingCredentialError } from "../src/errors.js";
import {
  IRACING_TOKEN_URL,
  createPkcePair,
  maskClientSecret,
  type IRacingTokens,
} from "../src/providers/racing.js";
import { mockFetch, testOptions, type Route } from "./helpers.js";

const TOKEN = {
  access_token: "access-1",
  token_type: "Bearer",
  expires_in: 600,
  refresh_token: "refresh-2",
  refresh_token_expires_in: 604800,
  scope: "iracing.auth",
};

const MEMBER = { members: [{ cust_id: 1, display_name: "Probe Driver" }] };

function clientWith(routes: readonly Route[], key = "my-client") {
  const mock = mockFetch(routes);
  const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { iracing: key } }));
  return { client, mock };
}

function formOf(mock: ReturnType<typeof mockFetch>, index: number): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(mock.inits[index]?.body ?? "")));
}

function headersOf(mock: ReturnType<typeof mockFetch>, index: number): Record<string, string> {
  return (mock.inits[index]?.headers ?? {}) as Record<string, string>;
}

const hostOf = (url: string): string => new URL(url).hostname;

const s256 = (value: string): string => createHash("sha256").update(value).digest("base64url");

describe("PKCE and secret masking", () => {
  it("derives the challenge as the S256 of the verifier", () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    expect(codeChallenge).toBe(s256(codeVerifier));
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
  });

  it("never reuses a verifier", () => {
    expect(createPkcePair().codeVerifier).not.toBe(createPkcePair().codeVerifier);
  });

  it("masks a client secret with the documented formula", () => {
    const expected = createHash("sha256").update("the-secret" + "my-client").digest("base64");
    expect(maskClientSecret("the-secret", "  My-Client ")).toBe(expected);
  });
});

describe("authorizationUrl", () => {
  it("carries client, redirect, PKCE, state and scope", () => {
    const { client } = clientWith([]);
    const started = client
      .iracingAuth()
      .authorizationUrl("https://app.example/callback", { state: "xyz" });
    const url = new URL(started.url);
    const query = Object.fromEntries(url.searchParams);

    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("oauth.iracing.com");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(query).toMatchObject({
      client_id: "my-client",
      redirect_uri: "https://app.example/callback",
      response_type: "code",
      code_challenge_method: "S256",
      scope: "iracing.auth",
      state: "xyz",
    });
    expect(started.state).toBe("xyz");
    expect(query.code_challenge).toBe(s256(started.codeVerifier));
  });

  it("generates a fresh state when none is given", () => {
    const { client } = clientWith([]);
    const first = client.iracingAuth().authorizationUrl("https://app.example/cb");
    const second = client.iracingAuth().authorizationUrl("https://app.example/cb");
    expect(first.state).not.toBe("");
    expect(first.state).not.toBe(second.state);
  });

  it("names the missing option without a client id", () => {
    const mock = mockFetch([]);
    const client = new GameStatsClient(testOptions(mock.fetch));
    expect(() => client.iracingAuth().authorizationUrl("https://app.example/cb")).toThrow(
      MissingCredentialError,
    );
  });
});

describe("token exchange", () => {
  it("posts the documented form for authorization_code", async () => {
    const { client, mock } = clientWith([{ match: "/oauth2/token", body: TOKEN }]);
    const seen: IRacingTokens[] = [];
    const auth = client.iracingAuth();
    auth.onTokens((tokens) => {
      seen.push(tokens);
    });

    const tokens = await auth.exchangeCode("the-code", "https://app.example/cb", "verifier");

    expect(mock.calls[0]).toBe(IRACING_TOKEN_URL);
    expect(mock.inits[0]?.method).toBe("POST");
    expect(headersOf(mock, 0)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(formOf(mock, 0)).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://app.example/cb",
      code_verifier: "verifier",
      client_id: "my-client",
    });
    expect(tokens).toEqual({
      accessToken: "access-1",
      expiresIn: 600,
      refreshToken: "refresh-2",
      refreshTokenExpiresIn: 604800,
      scope: "iracing.auth",
    });
    expect(seen).toEqual([tokens]);
  });

  it("sends the masked secret for a confidential client", async () => {
    const { client, mock } = clientWith(
      [{ match: "/oauth2/token", body: TOKEN }],
      "my-client:the-secret",
    );
    await client.iracingAuth().exchangeCode("c", "https://app.example/cb", "v");
    const form = formOf(mock, 0);
    expect(form.client_id).toBe("my-client");
    expect(form.client_secret).toBe(maskClientSecret("the-secret", "my-client"));
    expect(String(mock.inits[0]?.body)).not.toContain("the-secret");
  });

  it("treats a response without access_token as an auth error", async () => {
    const { client } = clientWith([{ match: "/oauth2/token", body: { error: "x" } }]);
    await expect(
      client.iracingAuth().exchangeCode("c", "https://app.example/cb", "v"),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("awaits async listeners", async () => {
    const { client } = clientWith([{ match: "/oauth2/token", body: TOKEN }]);
    const stored: string[] = [];
    const auth = client.iracingAuth();
    auth.onTokens(async (tokens) => {
      await Promise.resolve();
      stored.push(tokens.refreshToken ?? "");
    });
    await auth.exchangeCode("c", "https://app.example/cb", "v");
    expect(stored).toEqual(["refresh-2"]);
  });
});

describe("Data API", () => {
  it("fails before any request without tokens", async () => {
    const { client, mock } = clientWith([]);
    await expect(client.iracing.getPlayer({ accountId: "1" })).rejects.toThrow(/useTokens/);
    expect(mock.calls).toEqual([]);
  });

  it("renews from a stored refresh token and sends it as bearer", async () => {
    const { client, mock } = clientWith([
      { match: "/oauth2/token", body: TOKEN },
      { match: "/data/member/get", body: MEMBER },
    ]);
    const rotated: (string | undefined)[] = [];
    const auth = client.iracingAuth();
    auth.useTokens("refresh-1");
    auth.onTokens((tokens) => {
      rotated.push(tokens.refreshToken);
    });

    const player = await client.iracing.getPlayer({ accountId: "1" });

    expect(player.displayName).toBe("Probe Driver");
    expect(formOf(mock, 0)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "my-client",
    });
    const dataIndex = mock.calls.findIndex((url) => hostOf(url) === "members-ng.iracing.com");
    expect(headersOf(mock, dataIndex).Authorization).toBe("Bearer access-1");
    expect(headersOf(mock, dataIndex).Cookie).toBeUndefined();
    expect(rotated).toEqual(["refresh-2"]);
  });

  it("reuses a valid access token without refreshing", async () => {
    const { client, mock } = clientWith([{ match: "/data/member/get", body: MEMBER }]);
    client.iracingAuth().useTokens("refresh-1", { accessToken: "live", expiresIn: 600 });

    await client.iracing.getPlayer({ accountId: "1" });

    expect(mock.countOf("/oauth2/token")).toBe(0);
    expect(headersOf(mock, 0).Authorization).toBe("Bearer live");
  });

  it("spends the refresh token once for concurrent calls", async () => {
    const { client, mock } = clientWith([
      { match: "/oauth2/token", body: TOKEN },
      { match: "/data/", body: MEMBER },
    ]);
    client.iracingAuth().useTokens("refresh-1");
    await Promise.all([
      client.iracing.getPlayer({ accountId: "1" }),
      client.iracing.getPlayer({ accountId: "2" }),
    ]);
    expect(mock.countOf("/oauth2/token")).toBe(1);
  });

  it("uses the rotated refresh token next time", async () => {
    const second = { ...TOKEN, access_token: "access-2", refresh_token: "refresh-3" };
    const { client, mock } = clientWith([
      { match: "/oauth2/token", sequence: [{ body: TOKEN }, { body: second }] },
    ]);
    const auth = client.iracingAuth();
    auth.useTokens("refresh-1");
    await auth.refresh();
    const renewed = await auth.refresh();

    expect(formOf(mock, 1).refresh_token).toBe("refresh-2");
    expect(renewed.accessToken).toBe("access-2");
  });

  it("follows S3 links without the bearer token", async () => {
    const { client, mock } = clientWith([
      {
        match: "/data/member/get",
        body: { link: "https://scorpio-assets.s3.amazonaws.com/x.json" },
      },
      { match: "scorpio-assets", body: MEMBER },
    ]);
    client.iracingAuth().useTokens("refresh-1", { accessToken: "live", expiresIn: 600 });

    await client.iracing.getPlayer({ accountId: "1" });

    const s3Index = mock.calls.findIndex(
      (url) => hostOf(url) === "scorpio-assets.s3.amazonaws.com",
    );
    expect(headersOf(mock, s3Index).Authorization).toBeUndefined();
  });
});
