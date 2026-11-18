/**
 * Sim racing and the fighting-game ladder.
 *
 * iRacing and Trackmania are the two racing titles with a real API. Brawlhalla
 * is here because it is the one fighting game whose publisher ships a player
 * API - every other title in that genre is start.gg brackets and nothing else.
 */

import { createHash, randomBytes } from "node:crypto";
import { ProviderClient } from "./base.js";
import type { RequestSpec } from "../http.js";
import { AuthenticationError, NotFoundError, ValidationError } from "../errors.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

/** iRacing's OAuth server. Documented at https://oauth.iracing.com/oauth2/book/. */
export const IRACING_AUTHORIZE_URL = "https://oauth.iracing.com/oauth2/authorize";
export const IRACING_TOKEN_URL = "https://oauth.iracing.com/oauth2/token";

/** The scope the Data API needs. */
export const IRACING_DATA_SCOPE = "iracing.auth";

/**
 * Renew an access token this long before iRacing says it lapses, so a token
 * cannot expire between the check and the request that carries it.
 */
const EXPIRY_MARGIN_MS = 30_000;

/**
 * What iRacing's token endpoint hands back.
 *
 * Refresh tokens are single use: every refresh returns a new one and the old
 * one stops working. An application that keeps tokens across restarts must
 * store the newest one - register a listener with
 * {@link IRacingProvider.onTokens} to be told when it changes.
 */
export interface IRacingTokens {
  readonly accessToken: string;
  /** Seconds the access token is valid for, counted from when it was issued. */
  readonly expiresIn: number;
  readonly refreshToken?: string;
  readonly refreshTokenExpiresIn?: number;
  readonly scope?: string;
}

/**
 * One started authorization: where to send the user, and what to keep.
 *
 * `codeVerifier` and `state` must survive until the redirect comes back,
 * server-side in the session, not in anything the browser can read.
 */
export interface IRacingAuthorization {
  readonly url: string;
  readonly codeVerifier: string;
  readonly state: string;
}

/** Called with every new token pair. */
export type IRacingTokenListener = (tokens: IRacingTokens) => void | Promise<void>;

/**
 * A PKCE pair using `S256`.
 *
 * The verifier is 64 random bytes in base64url (86 characters, inside the
 * 43-128 that RFC 7636 allows). The challenge is the unpadded base64url
 * SHA-256 of it.
 */
export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(64).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

function asSeconds(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(Math.trunc(parsed), 0) : fallback;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * iRacing Data API, authenticated with OAuth 2.0.
 *
 * iRacing retired the old `/auth` login (email plus a hashed password) with
 * the 2026 Season 1 release on 9 December 2025. This provider uses the OAuth
 * Authorization Code flow with PKCE instead and never sees a password:
 *
 * 1. `apiKeys.iracing` is the id of a *public* client iRacing issued. Clients
 *    with a secret are not supported: PKCE does the job a secret would, and
 *    iRacing would want that secret hashed before it is sent.
 * 2. {@link authorizationUrl} starts the flow, {@link exchangeCode} finishes
 *    it. An application that already holds a refresh token passes it to
 *    {@link useTokens} instead.
 * 3. Access tokens last about ten minutes and are renewed from the refresh
 *    token on demand. The refresh token rotates on every renewal, and
 *    {@link onTokens} reports each new one.
 *
 * Data endpoints still answer `{ link: "https://..." }` with the payload behind
 * a pre-signed S3 URL, so every call is two round trips.
 */
export class IRacingProvider extends ProviderClient {
  private accessToken: string | undefined;
  private accessExpiresAt = 0;
  private refreshToken: string | undefined;
  private readonly listeners: IRacingTokenListener[] = [];
  /** Token requests run one after another, so a refresh token is never spent twice. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(runtime: Runtime) {
    super("iracing", runtime);
  }

  /** The OAuth client id. */
  private client(): string {
    const clientId = this.requireKey().trim();
    if (!clientId || clientId.includes(":")) {
      throw new ValidationError(
        "apiKeys.iracing must be the client id of a public iRacing OAuth client (PKCE, no client secret)",
      );
    }
    return clientId;
  }

  /**
   * Start the Authorization Code flow.
   *
   * Send the user to `url`. iRacing redirects back to `redirectUri` with `code`
   * and `state`; check that the state matches, then pass the code and the
   * `codeVerifier` to {@link exchangeCode}. The redirect URI must be registered
   * with iRacing and match exactly.
   */
  public authorizationUrl(
    redirectUri: string,
    options: { state?: string; scope?: string } = {},
  ): IRacingAuthorization {
    const clientId = this.client();
    const { codeVerifier, codeChallenge } = createPkcePair();
    const state = options.state ?? randomBytes(24).toString("base64url");
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      scope: options.scope ?? IRACING_DATA_SCOPE,
    });
    return { url: `${IRACING_AUTHORIZE_URL}?${query.toString()}`, codeVerifier, state };
  }

  /** Finish the flow: trade the authorization code for tokens. */
  public async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier: string,
  ): Promise<IRacingTokens> {
    return this.single(() =>
      this.tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    );
  }

  /**
   * Resume with tokens stored from an earlier session.
   *
   * Without `accessToken` the first request renews one from the refresh token.
   * `expiresIn` counts from now.
   */
  public useTokens(
    refreshToken: string,
    options: { accessToken?: string; expiresIn?: number } = {},
  ): void {
    this.refreshToken = refreshToken;
    this.accessToken = options.accessToken;
    this.accessExpiresAt =
      options.accessToken && options.expiresIn
        ? Date.now() + options.expiresIn * 1_000 - EXPIRY_MARGIN_MS
        : 0;
  }

  /** Be told about every new token pair, to persist the rotated refresh token. */
  public onTokens(listener: IRacingTokenListener): void {
    this.listeners.push(listener);
  }

  /** Renew the access token now, whether or not it has expired. */
  public async refresh(): Promise<IRacingTokens> {
    return this.single(() => this.refreshNow());
  }

  /** Run token requests one at a time, in the order they were asked for. */
  private single(task: () => Promise<IRacingTokens>): Promise<IRacingTokens> {
    const running = this.queue.then(task);
    // The queue must survive a failed request, or every later one would fail too.
    this.queue = running.catch(() => undefined);
    return running;
  }

  private async refreshNow(): Promise<IRacingTokens> {
    if (!this.refreshToken) {
      throw new AuthenticationError(
        this.id,
        "no iRacing token yet - run the OAuth flow (authorizationUrl, exchangeCode) " +
          "or pass a stored refresh token to useTokens()",
      );
    }
    return this.tokenRequest({ grant_type: "refresh_token", refresh_token: this.refreshToken });
  }

  /** POST to the token endpoint and keep what comes back. */
  private async tokenRequest(form: Record<string, string>): Promise<IRacingTokens> {
    const fields: Record<string, string> = { ...form, client_id: this.client() };

    const response = await this.runtime.http.send<Record<string, unknown> | null>(
      this.id,
      IRACING_TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      },
    );
    const accessToken = asText(response?.access_token);
    if (!response || !accessToken) {
      throw new AuthenticationError(this.id, "token endpoint returned no access_token");
    }

    const expiresIn = asSeconds(response.expires_in, 600);
    const refreshToken = asText(response.refresh_token) ?? this.refreshToken;
    const scope = asText(response.scope);
    const tokens: IRacingTokens = {
      accessToken,
      expiresIn,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(response.refresh_token_expires_in === undefined
        ? {}
        : { refreshTokenExpiresIn: asSeconds(response.refresh_token_expires_in, 0) }),
      ...(scope === undefined ? {} : { scope }),
    };
    this.accessToken = accessToken;
    this.accessExpiresAt = Date.now() + expiresIn * 1_000 - EXPIRY_MARGIN_MS;
    this.refreshToken = refreshToken;
    await this.listeners.reduce<Promise<void>>(
      (previous, listener) => previous.then(() => listener(tokens)),
      Promise.resolve(),
    );
    return tokens;
  }

  /**
   * A current access token, renewed if it has lapsed.
   *
   * Serialised, because refresh tokens are single use: two requests renewing at
   * once would spend the same token twice, and iRacing would refuse the second.
   */
  private async bearer(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessExpiresAt) return this.accessToken;
    const tokens = await this.single(async () => {
      // Another caller may have renewed while this one waited for its turn.
      if (this.accessToken && Date.now() < this.accessExpiresAt) {
        return { accessToken: this.accessToken, expiresIn: 0 };
      }
      return this.refreshNow();
    });
    return tokens.accessToken;
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    this.client(); // a missing key is MissingCredentialError, before any call
    const token = await this.bearer();
    return { ...spec, headers: { Authorization: `Bearer ${token}`, ...spec.headers } };
  }

  /**
   * Call a data endpoint and follow the S3 link it returns.
   *
   * Some endpoints answer with the payload directly and some with a link; both
   * shapes are handled so callers see one behaviour.
   */
  private async data<T>(path: string, query: Record<string, unknown> = {}): Promise<T> {
    const first = await this.get<{ link?: string } & Record<string, unknown>>(path, {
      query: query as RequestSpec["query"],
    });
    if (first && typeof first.link === "string") {
      // The S3 link is pre-signed and must not carry the bearer token.
      return this.runtime.http.send<T>(this.id, first.link, { method: "GET" });
    }
    return first as unknown as T;
  }

  /** Look drivers up by name. */
  public async searchDrivers(searchTerm: string): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["search", searchTerm.toLowerCase()],
      "resolvePlayer",
      "iracing",
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const drivers = await this.data<Record<string, unknown>[]>("/data/lookup/drivers", {
          search_term: searchTerm,
        });
        if (!drivers || drivers.length === 0) {
          throw new NotFoundError(this.id, `iRacing driver "${searchTerm}"`, "iracing");
        }
        return drivers;
      },
    );
  }

  /** A member's profile. */
  public async getMember(customerId: string | number): Promise<Record<string, unknown>> {
    return this.cached(
      ["member", customerId],
      "getPlayer",
      "iracing",
      TTL.player ?? 300,
      async () => {
        const response = await this.data<{ members?: Record<string, unknown>[] }>(
          "/data/member/get",
          { cust_ids: customerId, include_licenses: true },
        );
        const member = response?.members?.[0];
        if (!member) throw new NotFoundError(this.id, `iRacing member ${customerId}`, "iracing");
        return member;
      },
    );
  }

  /** Career statistics, one row per category. */
  public async getCareerStats(customerId: string | number): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["career", customerId],
      "getPlayerStats",
      "iracing",
      TTL.playerStats ?? 180,
      async () => {
        const response = await this.data<{ stats?: Record<string, unknown>[] }>(
          "/data/stats/member_career",
          { cust_id: customerId },
        );
        return response?.stats ?? [];
      },
    );
  }

  /** Recent races. */
  public async getRecentRaces(customerId: string | number): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["recent", customerId],
      "getMatchHistory",
      "iracing",
      TTL.matchHistory ?? 60,
      async () => {
        const response = await this.data<{ races?: Record<string, unknown>[] }>(
          "/data/stats/member_recent_races",
          { cust_id: customerId },
        );
        return response?.races ?? [];
      },
    );
  }

  /** Full results for one subsession. */
  public async getResult(subsessionId: string | number): Promise<Record<string, unknown>> {
    return this.cached(
      ["result", subsessionId],
      "getMatch",
      "iracing",
      TTL.match ?? 86_400,
      async () => {
        const result = await this.data<Record<string, unknown>>("/data/results/get", {
          subsession_id: subsessionId,
        });
        if (!result) throw new NotFoundError(this.id, `subsession ${subsessionId}`, "iracing");
        return result;
      },
    );
  }

  /** A season standings page. */
  public async getSeasonStandings(
    seasonId: number,
    carClassId?: number,
  ): Promise<Record<string, unknown>[]> {
    const response = await this.data<{ chunk_info?: Record<string, unknown> }>(
      "/data/stats/season_driver_standings",
      { season_id: seasonId, car_class_id: carClassId },
    );
    return (response?.chunk_info?.chunk_file_names as Record<string, unknown>[]) ?? [];
  }
}

/**
 * trackmania.io.
 *
 * Wraps Nadeo's own live services in something usable. It requires a
 * User-Agent naming the application and a contact address, and will refuse
 * requests without one - the runtime's `userAgent` option exists partly for
 * this provider.
 */
export class TrackmaniaProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("trackmania-io", runtime);
  }

  protected override authHeaderName(): string {
    return "Authorization";
  }

  /** The key is optional for the public endpoints. */
  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    const key = this.runtime.apiKeys.trackmania;
    if (!key) return spec;
    return { ...spec, headers: { Authorization: key, ...spec.headers } };
  }

  /** Search players by name. */
  public async searchPlayers(query: string): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["search", query.toLowerCase()],
      "resolvePlayer",
      "trackmania",
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const response = await this.get<{ players?: Record<string, unknown>[] }>(
          `/players/find`,
          { query: { search: query }, nullOn404: true },
        );
        const players = response?.players ?? [];
        if (players.length === 0) {
          throw new NotFoundError(this.id, `Trackmania player "${query}"`, "trackmania");
        }
        return players;
      },
    );
  }

  /** A player's profile, including their Trackmaster rank. */
  public async getPlayer(accountId: string): Promise<Record<string, unknown>> {
    return this.cached(
      ["player", accountId],
      "getPlayer",
      "trackmania",
      TTL.player ?? 300,
      async () => {
        const player = await this.get<Record<string, unknown> | null>(`/player/${accountId}`, {
          nullOn404: true,
        });
        if (!player) {
          throw new NotFoundError(this.id, `Trackmania account ${accountId}`, "trackmania");
        }
        return player;
      },
    );
  }

  /** Recent matchmaking games. */
  public async getPlayerMatches(accountId: string, page = 0): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ matches?: Record<string, unknown>[] }>(
      `/player/${accountId}/matches/2/${page}`,
      { nullOn404: true },
    );
    return response?.matches ?? [];
  }

  /** The Trackmaster matchmaking ladder. */
  public async getMatchmakingLeaderboard(page = 0): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["mm-leaderboard", page],
      "getLeaderboard",
      "trackmania",
      TTL.leaderboard ?? 300,
      async () => {
        const response = await this.get<{ ranks?: Record<string, unknown>[] }>(
          `/matchmaking/2/${page}`,
          { nullOn404: true },
        );
        return response?.ranks ?? [];
      },
    );
  }

  /** The Campaign or Totd leaderboard for one map. */
  public async getMapLeaderboard(mapUid: string, page = 0): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ tops?: Record<string, unknown>[] }>(
      `/leaderboard/map/${mapUid}`,
      { query: { offset: page * 100, length: 100 }, nullOn404: true },
    );
    return response?.tops ?? [];
  }

  /** Track of the Day for a month. */
  public async getTrackOfTheDay(month = 0): Promise<Record<string, unknown> | null> {
    return this.get<Record<string, unknown> | null>(`/totd/${month}`, { nullOn404: true });
  }
}

/**
 * Brawlhalla API.
 *
 * The one fighting game in this package with a first-party player API. Ids are
 * `brawlhalla_id`, resolvable from a Steam id or by searching the ranked ladder.
 */
export class BrawlhallaProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("brawlhalla", runtime);
  }

  protected override authQueryName(): string {
    return "api_key";
  }

  /** Steam id to Brawlhalla id. */
  public async getIdBySteamId(steamId: string): Promise<{ brawlhalla_id: number; name: string }> {
    return this.cached(
      ["steam", steamId],
      "resolvePlayer",
      "brawlhalla",
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const found = await this.get<{ brawlhalla_id?: number; name?: string } | null>(
          "/search",
          { query: { steamid: steamId }, nullOn404: true },
        );
        if (!found?.brawlhalla_id) {
          throw new NotFoundError(this.id, `Brawlhalla account for ${steamId}`, "brawlhalla");
        }
        return { brawlhalla_id: found.brawlhalla_id, name: found.name ?? "" };
      },
    );
  }

  /** Lifetime statistics, including per-legend numbers. */
  public async getStats(brawlhallaId: string | number): Promise<Record<string, unknown>> {
    return this.cached(
      ["stats", brawlhallaId],
      "getPlayerStats",
      "brawlhalla",
      TTL.playerStats ?? 180,
      async () => {
        const stats = await this.get<Record<string, unknown> | null>(
          `/player/${brawlhallaId}/stats`,
          { nullOn404: true },
        );
        if (!stats) {
          throw new NotFoundError(this.id, `Brawlhalla player ${brawlhallaId}`, "brawlhalla");
        }
        return stats;
      },
    );
  }

  /** Current season ranked standing, 1v1 and 2v2. */
  public async getRanked(brawlhallaId: string | number): Promise<Record<string, unknown> | null> {
    return this.cached(
      ["ranked", brawlhallaId],
      "getRank",
      "brawlhalla",
      TTL.rank ?? 60,
      () =>
        this.get<Record<string, unknown> | null>(`/player/${brawlhallaId}/ranked`, {
          nullOn404: true,
        }),
    );
  }

  /** A page of the ranked ladder. */
  public async getRankings(
    bracket: "1v1" | "2v2" = "1v1",
    region = "all",
    page = 1,
    name?: string,
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["rankings", bracket, region, page, name ?? "-"],
      "getLeaderboard",
      "brawlhalla",
      TTL.leaderboard ?? 300,
      async () => {
        const rows = await this.get<Record<string, unknown>[] | null>(
          `/rankings/${bracket}/${region}/${page}`,
          { query: { name }, nullOn404: true },
        );
        return rows ?? [];
      },
    );
  }

  /** The legend roster. */
  public async getLegends(): Promise<Record<string, unknown>[]> {
    return this.cached(["legends"], "getMetadata", "brawlhalla", TTL.metadata ?? 3_600, async () => {
      const legends = await this.get<Record<string, unknown>[] | null>("/legend/all", {
        nullOn404: true,
      });
      return legends ?? [];
    });
  }
}
