/**
 * The individual-skill titles: osu!, Beat Saber and chess.
 *
 * These have a property none of the team titles do - a *global*, continuously
 * maintained ranking of every player, with no seasons and no reset. So the
 * leaderboard endpoints here are the primary data rather than a side feature,
 * and `RankInfo.position` is meaningful in a way it rarely is elsewhere.
 */

import { ProviderClient } from "./base.js";
import type { RequestSpec } from "../http.js";
import { AuthenticationError, NotFoundError, ValidationError } from "../errors.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

// ---------------------------------------------------------------------------
// osu!
// ---------------------------------------------------------------------------

export type OsuMode = "osu" | "taiko" | "fruits" | "mania";

export interface OsuUser {
  id: number;
  username: string;
  country_code?: string;
  avatar_url?: string;
  is_online?: boolean;
  join_date?: string;
  last_visit?: string | null;
  statistics?: {
    level?: { current: number; progress: number };
    pp?: number;
    global_rank?: number | null;
    country_rank?: number | null;
    ranked_score?: number;
    hit_accuracy?: number;
    play_count?: number;
    play_time?: number;
    total_score?: number;
    maximum_combo?: number;
    grade_counts?: { ss: number; ssh: number; s: number; sh: number; a: number };
  };
}

/**
 * osu! API v2.
 *
 * OAuth2 client credentials, exchanged once and held for the life of the token.
 * The v1 API still exists and takes a plain key, but it is deprecated and does
 * not expose the `pp` figures that make an osu! rank meaningful.
 */
export class OsuProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("osu", runtime);
  }

  private async accessToken(): Promise<string> {
    const [clientId, clientSecret] = this.requireKeyParts(2, "clientId:clientSecret");
    // osu! wants the client id as a JSON number, and `Number("abc")` is NaN,
    // which `JSON.stringify` writes as `null` - so a mistyped credential would
    // otherwise be sent as a null client id and come back as a bare 401. Saying
    // so here names the option instead.
    if (!/^\d+$/.test(clientId ?? "")) {
      throw new ValidationError(
        `apiKeys.${this.descriptor.keyName} must be "clientId:clientSecret", and the ` +
          "client id is the number shown on your osu! OAuth application page - " +
          `got "${clientId ?? ""}"`,
      );
    }
    return this.memo("token", 23 * 3_600 * 1_000, async () => {
      const response = await this.runtime.http.send<{
        access_token?: string;
        expires_in?: number;
      }>(this.id, "https://osu.ppy.sh/oauth/token", {
        method: "POST",
        json: {
          client_id: Number(clientId),
          client_secret: clientSecret,
          grant_type: "client_credentials",
          scope: "public",
        },
      });
      if (!response?.access_token) {
        throw new AuthenticationError(this.id, "token endpoint returned no access_token");
      }
      return response.access_token;
    });
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    const token = await this.accessToken();
    return { ...spec, headers: { Authorization: `Bearer ${token}`, ...spec.headers } };
  }

  /** A user by name or numeric id. */
  public async getUser(user: string, mode: OsuMode = "osu"): Promise<OsuUser> {
    return this.cached([user.toLowerCase(), mode], "getPlayer", "osu", TTL.player ?? 300, async () => {
      const found = await this.get<OsuUser | null>(
        `/users/${encodeURIComponent(user)}/${mode}`,
        { query: { key: /^\d+$/.test(user) ? "id" : "username" }, nullOn404: true },
      );
      if (!found) throw new NotFoundError(this.id, `osu! user "${user}"`, "osu");
      return found;
    });
  }

  /** Best, recent or first-place scores. */
  public async getScores(
    userId: string | number,
    type: "best" | "recent" | "firsts" = "recent",
    options: { mode?: OsuMode; limit?: number; offset?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["scores", userId, type, options.mode ?? "osu", options.limit ?? 20],
      "getMatchHistory",
      "osu",
      TTL.matchHistory ?? 60,
      async () => {
        const scores = await this.get<Record<string, unknown>[] | null>(
          `/users/${userId}/scores/${type}`,
          {
            query: {
              mode: options.mode ?? "osu",
              limit: Math.min(options.limit ?? 20, 100),
              offset: options.offset ?? 0,
              include_fails: type === "recent" ? 1 : undefined,
            },
            nullOn404: true,
          },
        );
        return scores ?? [];
      },
    );
  }

  /** The global performance ranking. */
  public async getRankings(
    mode: OsuMode = "osu",
    options: { type?: "performance" | "score" | "country"; country?: string; page?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["rankings", mode, options.type ?? "performance", options.country ?? "-", options.page ?? 1],
      "getLeaderboard",
      "osu",
      TTL.leaderboard ?? 300,
      async () => {
        const response = await this.get<{ ranking?: Record<string, unknown>[] }>(
          `/rankings/${mode}/${options.type ?? "performance"}`,
          { query: { country: options.country, page: options.page ?? 1 }, nullOn404: true },
        );
        return response?.ranking ?? [];
      },
    );
  }

  /** One beatmap, for turning a score's map id into a name. */
  public async getBeatmap(beatmapId: string | number): Promise<Record<string, unknown> | null> {
    return this.cached(["beatmap", beatmapId], "getMetadata", "osu", TTL.metadata ?? 3_600, () =>
      this.get<Record<string, unknown> | null>(`/beatmaps/${beatmapId}`, { nullOn404: true }),
    );
  }
}

// ---------------------------------------------------------------------------
// Beat Saber
// ---------------------------------------------------------------------------

/** ScoreSaber - the older of the two Beat Saber ladders. */
export class ScoreSaberProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("scoresaber", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  /** A player by their Steam or Oculus id. */
  public async getPlayer(playerId: string): Promise<Record<string, unknown>> {
    return this.cached(
      ["player", playerId],
      "getPlayer",
      "beat-saber",
      TTL.player ?? 300,
      async () => {
        const player = await this.get<Record<string, unknown> | null>(
          `/player/${playerId}/full`,
          { nullOn404: true },
        );
        if (!player) throw new NotFoundError(this.id, `ScoreSaber player ${playerId}`, "beat-saber");
        return player;
      },
    );
  }

  /** Search by name. */
  public async searchPlayers(search: string): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ players?: Record<string, unknown>[] }>("/players", {
      query: { search, page: 1 },
      nullOn404: true,
    });
    return response?.players ?? [];
  }

  /** A player's scores, ranked by pp or by recency. */
  public async getScores(
    playerId: string,
    options: { sort?: "top" | "recent"; limit?: number; page?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ playerScores?: Record<string, unknown>[] }>(
      `/player/${playerId}/scores`,
      {
        query: {
          sort: options.sort ?? "recent",
          limit: Math.min(options.limit ?? 20, 100),
          page: options.page ?? 1,
        },
        nullOn404: true,
      },
    );
    return response?.playerScores ?? [];
  }

  /** The global ladder. */
  public async getLeaderboard(page = 1, countries?: string): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["leaderboard", page, countries ?? "-"],
      "getLeaderboard",
      "beat-saber",
      TTL.leaderboard ?? 300,
      async () => {
        const response = await this.get<{ players?: Record<string, unknown>[] }>("/players", {
          query: { page, countries },
          nullOn404: true,
        });
        return response?.players ?? [];
      },
    );
  }
}

/** BeatLeader - the second Beat Saber ladder, with replays ScoreSaber drops. */
export class BeatLeaderProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("beatleader", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  public async getPlayer(playerId: string): Promise<Record<string, unknown>> {
    return this.cached(
      ["player", playerId],
      "getPlayer",
      "beat-saber",
      TTL.player ?? 300,
      async () => {
        const player = await this.get<Record<string, unknown> | null>(`/player/${playerId}`, {
          nullOn404: true,
        });
        if (!player) throw new NotFoundError(this.id, `BeatLeader player ${playerId}`, "beat-saber");
        return player;
      },
    );
  }

  public async getScores(
    playerId: string,
    options: { sortBy?: string; order?: "desc" | "asc"; count?: number; page?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ data?: Record<string, unknown>[] }>(
      `/player/${playerId}/scores`,
      {
        query: {
          sortBy: options.sortBy ?? "date",
          order: options.order ?? "desc",
          count: Math.min(options.count ?? 20, 100),
          page: options.page ?? 1,
        },
        nullOn404: true,
      },
    );
    return response?.data ?? [];
  }

  public async getLeaderboard(page = 1, count = 50): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ data?: Record<string, unknown>[] }>("/players", {
      query: { page, count: Math.min(count, 100), sortBy: "pp", order: "desc" },
      nullOn404: true,
    });
    return response?.data ?? [];
  }
}

// ---------------------------------------------------------------------------
// Chess
// ---------------------------------------------------------------------------

/**
 * Chess.com Published-Data API.
 *
 * No key at all, but it is strict about two things: a descriptive User-Agent,
 * and **serial requests**. Parallel calls get 429 immediately, which is why the
 * registry limits this provider tightly rather than optimistically.
 *
 * Games are archived by month, so "recent games" means "fetch the current
 * month's archive" rather than a limit-and-offset query.
 */
export class ChessComProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("chess-com", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  public async getPlayer(username: string): Promise<Record<string, unknown>> {
    const name = username.toLowerCase();
    return this.cached(["player", name], "getPlayer", "chess", TTL.player ?? 300, async () => {
      const player = await this.get<Record<string, unknown> | null>(`/player/${name}`, {
        nullOn404: true,
      });
      if (!player) throw new NotFoundError(this.id, `Chess.com user "${username}"`, "chess");
      return player;
    });
  }

  /** Ratings per time control, plus the puzzle and tactics records. */
  public async getStats(username: string): Promise<Record<string, unknown>> {
    const name = username.toLowerCase();
    return this.cached(
      ["stats", name],
      "getPlayerStats",
      "chess",
      TTL.playerStats ?? 180,
      async () => {
        const stats = await this.get<Record<string, unknown> | null>(`/player/${name}/stats`, {
          nullOn404: true,
        });
        return stats ?? {};
      },
    );
  }

  /** The list of monthly archive URLs, oldest first. */
  public async getGameArchives(username: string): Promise<string[]> {
    const name = username.toLowerCase();
    const response = await this.get<{ archives?: string[] }>(`/player/${name}/games/archives`, {
      nullOn404: true,
    });
    return response?.archives ?? [];
  }

  /**
   * Games from the most recent archives, newest first.
   *
   * Walks backwards through the monthly archives until it has enough, because
   * a player who has not played this month would otherwise get nothing.
   */
  public async getRecentGames(username: string, limit = 20): Promise<Record<string, unknown>[]> {
    const name = username.toLowerCase();
    return this.cached(
      ["games", name, limit],
      "getMatchHistory",
      "chess",
      TTL.matchHistory ?? 60,
      async () => {
        const archives = await this.getGameArchives(name);
        const games: Record<string, unknown>[] = [];
        // Three months back is enough for any active player and bounds the
        // request count for an inactive one.
        for (const url of archives.slice(-3).reverse()) {
          const month = await this.get<{ games?: Record<string, unknown>[] }>(url, {
            nullOn404: true,
          });
          games.push(...(month?.games ?? []).reverse());
          if (games.length >= limit) break;
        }
        return games.slice(0, limit);
      },
    );
  }

  /** The site leaderboards, all categories in one payload. */
  public async getLeaderboards(): Promise<Record<string, unknown>> {
    return this.cached(
      ["leaderboards"],
      "getLeaderboard",
      "chess",
      TTL.leaderboard ?? 300,
      async () => {
        const boards = await this.get<Record<string, unknown> | null>("/leaderboards", {
          nullOn404: true,
        });
        return boards ?? {};
      },
    );
  }
}

/**
 * Lichess API.
 *
 * Open, and generous. The catch is NDJSON: game exports stream one JSON object
 * per line rather than returning an array, so they are parsed here rather than
 * handed to `JSON.parse`.
 */
export class LichessProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("lichess", runtime);
  }

  /** The token is optional, so a missing one is not an error. */
  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    const token = this.runtime.apiKeys.lichess;
    if (!token) return spec;
    return { ...spec, headers: { Authorization: `Bearer ${token}`, ...spec.headers } };
  }

  public async getPlayer(username: string): Promise<Record<string, unknown>> {
    const name = username.toLowerCase();
    return this.cached(["user", name], "getPlayer", "chess", TTL.player ?? 300, async () => {
      const user = await this.get<Record<string, unknown> | null>(`/user/${name}`, {
        nullOn404: true,
      });
      if (!user) throw new NotFoundError(this.id, `Lichess user "${username}"`, "chess");
      return user;
    });
  }

  /**
   * Recent games.
   *
   * Requested as NDJSON and split by line - the array form of this endpoint
   * does not exist, and asking for JSON returns PGN text instead.
   */
  public async getGames(
    username: string,
    options: { max?: number; rated?: boolean; perfType?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    const name = username.toLowerCase();
    return this.cached(
      ["games", name, options.max ?? 20, options.perfType ?? "-"],
      "getMatchHistory",
      "chess",
      TTL.matchHistory ?? 60,
      async () => {
        const body = await this.get<string>(`/games/user/${name}`, {
          query: {
            max: Math.min(options.max ?? 20, 300),
            rated: options.rated,
            perfType: options.perfType,
            opening: true,
          },
          headers: { Accept: "application/x-ndjson" },
          parse: "text",
          nullOn404: true,
        });
        if (!body) return [];
        return body
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      },
    );
  }

  /** The top players for one time control. */
  public async getTopPlayers(perfType = "blitz", count = 50): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["top", perfType, count],
      "getLeaderboard",
      "chess",
      TTL.leaderboard ?? 300,
      async () => {
        const response = await this.get<{ users?: Record<string, unknown>[] }>(
          `/player/top/${Math.min(count, 200)}/${perfType}`,
          { nullOn404: true },
        );
        return response?.users ?? [];
      },
    );
  }

  /** Rating history per time control, one point per day played. */
  public async getRatingHistory(username: string): Promise<Record<string, unknown>[]> {
    const history = await this.get<Record<string, unknown>[] | null>(
      `/user/${username.toLowerCase()}/rating-history`,
      { nullOn404: true },
    );
    return history ?? [];
  }
}
