/**
 * Sim racing and the fighting-game ladder.
 *
 * iRacing and Trackmania are the two racing titles with a real API. Brawlhalla
 * is here because it is the one fighting game whose publisher ships a player
 * API - every other title in that genre is start.gg brackets and nothing else.
 */

import { createHash } from "node:crypto";
import { ProviderClient } from "./base.js";
import type { RequestSpec } from "../http.js";
import { AuthenticationError, NotFoundError } from "../errors.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

/**
 * iRacing Data API.
 *
 * Three things make this the most awkward provider in the package, and all
 * three are handled here so no caller has to know about them:
 *
 * 1. **The password must be pre-hashed.** iRacing wants
 *    `base64(sha256(password + lowercase(email)))`, not the password.
 * 2. **Auth is a cookie.** `/auth` sets one, and every later call needs it.
 * 3. **Responses are S3 links.** A data endpoint answers `{ link: "https://..." }`
 *    and the actual payload is behind it, so every call is two round trips.
 */
export class IRacingProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("iracing", runtime);
  }

  /** The hash iRacing expects in place of the password. */
  private encodePassword(email: string, password: string): string {
    return createHash("sha256")
      .update(password + email.toLowerCase())
      .digest("base64");
  }

  /** Authenticate and hold the session cookie. */
  private async sessionCookie(): Promise<string> {
    const [email, password] = this.requireKeyParts(2, "email:password");
    return this.memo("cookie", 30 * 60 * 1_000, async () => {
      const response = await this.runtime.fetch(`${this.descriptor.baseUrl}/auth`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": this.runtime.userAgent,
        },
        body: JSON.stringify({
          email,
          password: this.encodePassword(email as string, password as string),
        }),
      });
      if (!response.ok) {
        throw new AuthenticationError(this.id, `auth returned ${response.status}`);
      }
      const cookies = response.headers.getSetCookie?.() ?? [];
      const cookie = cookies.map((entry) => entry.split(";")[0]).join("; ");
      if (!cookie) {
        throw new AuthenticationError(this.id, "auth succeeded but set no session cookie");
      }
      return cookie;
    });
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    const cookie = await this.sessionCookie();
    return { ...spec, headers: { Cookie: cookie, ...spec.headers } };
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
      // The S3 link is pre-signed and must not carry the session cookie.
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
