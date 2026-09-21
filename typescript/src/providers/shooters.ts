/**
 * The community APIs behind the shooters whose publishers ship none.
 *
 * Overwatch 2, Apex Legends, Fortnite, Halo Infinite, The Finals, Marvel Rivals
 * and Deadlock all have an active competitive scene and no first-party player
 * endpoint. Each of the providers below is the established substitute for one
 * of them, and each has its own idea of what a player identifier is - which is
 * most of what these classes exist to absorb.
 */

import { ProviderClient } from "./base.js";
import type { RequestSpec } from "../http.js";
import { NotFoundError, PrivateProfileError } from "../errors.js";
import { toBattleTagPath, toSteamAccountId } from "../identity.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

// ---------------------------------------------------------------------------
// Overwatch 2
// ---------------------------------------------------------------------------

export interface OverwatchSummary {
  username: string;
  avatar?: string;
  namecard?: string;
  title?: string | null;
  endorsement?: { level: number; frame: string };
  competitive?: Record<
    string,
    Record<string, { division: string; tier: number; role_icon?: string; rank_icon?: string }> | null
  >;
  privacy?: "public" | "private";
}

/**
 * OverFast - Overwatch 2.
 *
 * Reads the official career pages, so it sees exactly what Blizzard publishes
 * and nothing more. Two consequences worth knowing: a private career profile
 * yields empty statistics rather than an error, and BattleTags are written with
 * a dash (`Player-1234`) because a hash cannot appear in a URL path.
 */
export class OverFastProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("overfast", runtime);
  }

  /** Summary: name, endorsement level, and the competitive ranks per role. */
  public async getSummary(battleTag: string): Promise<OverwatchSummary> {
    const path = toBattleTagPath(battleTag);
    return this.cached([path, "summary"], "getPlayer", "overwatch-2", TTL.player ?? 300, async () => {
      const summary = await this.get<OverwatchSummary | null>(
        `/players/${encodeURIComponent(path)}/summary`,
        { nullOn404: true },
      );
      if (!summary) throw new NotFoundError(this.id, `BattleTag ${battleTag}`, "overwatch-2");
      return summary;
    });
  }

  /**
   * Career statistics for one platform and game mode.
   *
   * `platform` is `pc` or `console`; `gamemode` is `quickplay` or
   * `competitive`. A private profile answers 200 with empty stats, which is
   * turned into a {@link PrivateProfileError} here so callers can tell the
   * difference from a player who has simply not played.
   */
  public async getStats(
    battleTag: string,
    options: { platform?: "pc" | "console"; gamemode?: "quickplay" | "competitive" } = {},
  ): Promise<Record<string, unknown>> {
    const path = toBattleTagPath(battleTag);
    const platform = options.platform ?? "pc";
    const gamemode = options.gamemode ?? "competitive";
    return this.cached(
      [path, "stats", platform, gamemode],
      "getPlayerStats",
      "overwatch-2",
      TTL.playerStats ?? 180,
      async () => {
        const stats = await this.get<Record<string, unknown> | null>(
          `/players/${encodeURIComponent(path)}/stats`,
          { query: { platform, gamemode }, nullOn404: true },
        );
        if (!stats) {
          const summary = await this.getSummary(battleTag);
          if (summary.privacy === "private") {
            throw new PrivateProfileError(this.id, battleTag, "overwatch-2");
          }
          throw new NotFoundError(this.id, `stats for ${battleTag}`, "overwatch-2");
        }
        return stats;
      },
    );
  }

  /** Search for players by name prefix. */
  public async searchPlayers(name: string, limit = 20): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ results?: Record<string, unknown>[] }>("/players", {
      query: { name, limit },
      nullOn404: true,
    });
    return response?.results ?? [];
  }

  /** Hero roster, for turning ability keys into readable names. */
  public async getHeroes(): Promise<Record<string, unknown>[]> {
    return this.cached(["heroes"], "getMetadata", "overwatch-2", TTL.metadata ?? 3_600, async () => {
      const heroes = await this.get<Record<string, unknown>[] | null>("/heroes", {
        nullOn404: true,
      });
      return heroes ?? [];
    });
  }

  /** Current map pool. */
  public async getMaps(): Promise<Record<string, unknown>[]> {
    return this.cached(["maps"], "getMetadata", "overwatch-2", TTL.metadata ?? 3_600, async () => {
      const maps = await this.get<Record<string, unknown>[] | null>("/maps", { nullOn404: true });
      return maps ?? [];
    });
  }
}

// ---------------------------------------------------------------------------
// Apex Legends
// ---------------------------------------------------------------------------

/**
 * ApexLegendsAPI (mozambiquehe.re).
 *
 * Player names are not unique across platforms, so every lookup needs a
 * platform alongside the name. `PC` here means Origin/EA, not Steam.
 */
export class ApexProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("apex-legends-api", runtime);
  }

  protected override authQueryName(): string {
    return "auth";
  }

  /** Full player bridge: rank, legend stats and current status. */
  public async getPlayer(
    name: string,
    platform: "PC" | "X1" | "PS4" | "SWITCH" = "PC",
  ): Promise<Record<string, unknown>> {
    return this.cached(
      [platform, name.toLowerCase()],
      "getPlayerStats",
      "apex-legends",
      TTL.playerStats ?? 180,
      async () => {
        const response = await this.get<Record<string, unknown> | null>("/bridge", {
          query: { player: name, platform },
          nullOn404: true,
        });
        if (!response || "Error" in response) {
          throw new NotFoundError(this.id, `Apex player "${name}" on ${platform}`, "apex-legends");
        }
        return response;
      },
    );
  }

  /** The same, by EA account id, which is stable when a name is not. */
  public async getPlayerByUid(
    uid: string,
    platform: "PC" | "X1" | "PS4" | "SWITCH" = "PC",
  ): Promise<Record<string, unknown>> {
    const response = await this.get<Record<string, unknown> | null>("/bridge", {
      query: { uid, platform },
      nullOn404: true,
    });
    if (!response || "Error" in response) {
      throw new NotFoundError(this.id, `Apex uid ${uid}`, "apex-legends");
    }
    return response;
  }

  /** The current and upcoming map rotation. */
  public async getMapRotation(): Promise<Record<string, unknown> | null> {
    return this.get<Record<string, unknown> | null>("/maprotation", {
      query: { version: 2 },
      nullOn404: true,
    });
  }

  /** Predator and Master cutoffs, which is as close to a ladder as Apex gets. */
  public async getPredatorCutoff(): Promise<Record<string, unknown> | null> {
    return this.get<Record<string, unknown> | null>("/predator", { nullOn404: true });
  }
}

// ---------------------------------------------------------------------------
// Fortnite
// ---------------------------------------------------------------------------

/**
 * Fortnite-API.com.
 *
 * Stats need a key; the cosmetics and map endpoints do not. A player who has
 * turned off public stats in-game returns 403 whatever key you hold, which is
 * an in-game setting rather than an API problem - so it becomes a
 * {@link PrivateProfileError} rather than an authentication one.
 */
export class FortniteProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("fortnite-api", runtime);
  }

  protected override authHeaderName(): string {
    return "Authorization";
  }

  /** Career statistics by display name. */
  public async getStatsByName(
    name: string,
    options: { accountType?: "epic" | "psn" | "xbl"; timeWindow?: "season" | "lifetime" } = {},
  ): Promise<Record<string, unknown>> {
    return this.cached(
      ["stats", name.toLowerCase(), options.accountType ?? "epic", options.timeWindow ?? "lifetime"],
      "getPlayerStats",
      "fortnite",
      TTL.playerStats ?? 180,
      async () => {
        const response = await this.get<{ status?: number; data?: Record<string, unknown> }>(
          "/v2/stats/br/v2",
          {
            query: {
              name,
              accountType: options.accountType ?? "epic",
              timeWindow: options.timeWindow ?? "lifetime",
              image: "none",
            },
            nullOn404: true,
          },
        );
        if (!response?.data) {
          throw new NotFoundError(this.id, `Fortnite player "${name}"`, "fortnite");
        }
        return response.data;
      },
    );
  }

  /** The same by Epic account id. */
  public async getStatsById(
    accountId: string,
    timeWindow: "season" | "lifetime" = "lifetime",
  ): Promise<Record<string, unknown>> {
    const response = await this.get<{ data?: Record<string, unknown> }>("/v2/stats/br/v2", {
      query: { accountId, timeWindow, image: "none" },
      nullOn404: true,
    });
    if (!response?.data) {
      throw new NotFoundError(this.id, `Fortnite account ${accountId}`, "fortnite");
    }
    return response.data;
  }

  /** The full cosmetic catalogue. No key required. */
  public async getCosmetics(): Promise<Record<string, unknown> | null> {
    return this.cached(["cosmetics"], "getMetadata", "fortnite", TTL.metadata ?? 3_600, () =>
      this.get<{ data?: Record<string, unknown> }>("/v2/cosmetics/br").then(
        (response) => response?.data ?? null,
      ),
    );
  }

  /** Current playlists, which is how a caller learns what modes exist. */
  public async getPlaylists(): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ data?: Record<string, unknown>[] }>("/v1/playlists");
    return response?.data ?? [];
  }
}

// ---------------------------------------------------------------------------
// Halo Infinite
// ---------------------------------------------------------------------------

/** HaloDotAPI - Halo Infinite. Keyed on gamertag. */
export class HaloProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("halodotapi", runtime);
  }

  /** Multiplayer service record: the career totals. */
  public async getServiceRecord(gamertag: string): Promise<Record<string, unknown>> {
    return this.cached(
      ["service-record", gamertag.toLowerCase()],
      "getPlayerStats",
      "halo-infinite",
      TTL.playerStats ?? 180,
      async () => {
        const response = await this.get<{ data?: Record<string, unknown> }>(
          `/stats/players/${encodeURIComponent(gamertag)}/service-record/global`,
          { nullOn404: true },
        );
        if (!response?.data) {
          throw new NotFoundError(this.id, `gamertag "${gamertag}"`, "halo-infinite");
        }
        return response.data;
      },
    );
  }

  /** Competitive CSR, per playlist. */
  public async getCsr(gamertag: string): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ data?: Record<string, unknown>[] }>(
      `/stats/players/${encodeURIComponent(gamertag)}/csrs`,
      { query: { season: "current" }, nullOn404: true },
    );
    return response?.data ?? [];
  }

  /** Recent matches. */
  public async getMatches(
    gamertag: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["matches", gamertag.toLowerCase(), options.limit ?? 25, options.offset ?? 0],
      "getMatchHistory",
      "halo-infinite",
      TTL.matchHistory ?? 60,
      async () => {
        const response = await this.get<{ data?: Record<string, unknown>[] }>(
          `/stats/players/${encodeURIComponent(gamertag)}/matches`,
          {
            query: { limit: options.limit ?? 25, offset: options.offset ?? 0 },
            nullOn404: true,
          },
        );
        return response?.data ?? [];
      },
    );
  }

  /** One match, with the full scoreboard. */
  public async getMatch(matchId: string): Promise<Record<string, unknown>> {
    return this.cached(
      ["match", matchId],
      "getMatch",
      "halo-infinite",
      TTL.match ?? 86_400,
      async () => {
        const response = await this.get<{ data?: Record<string, unknown> }>(
          `/stats/matches/${matchId}`,
          { nullOn404: true },
        );
        if (!response?.data) {
          throw new NotFoundError(this.id, `Halo match ${matchId}`, "halo-infinite");
        }
        return response.data;
      },
    );
  }
}

// ---------------------------------------------------------------------------
// The Finals
// ---------------------------------------------------------------------------

/**
 * The Finals leaderboard API.
 *
 * Leaderboard-shaped rather than player-shaped: there is no "get player"
 * endpoint, only "search this season's ladder". That is why the title declares
 * `getRank` and `getLeaderboard` but not `getMatchHistory` - the data does not
 * exist to serve one.
 */
export class TheFinalsProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("the-finals-api", runtime);
  }

  /** Search a season's ladder. `season` is e.g. `s5` or `crossplay`. */
  public async search(
    name: string,
    season = "s5",
    platform = "crossplay",
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["search", season, platform, name.toLowerCase()],
      "getLeaderboard",
      "the-finals",
      TTL.leaderboard ?? 300,
      async () => {
        const response = await this.get<{ data?: Record<string, unknown>[] }>(
          `/leaderboard/${season}/${platform}`,
          { query: { name }, nullOn404: true },
        );
        return response?.data ?? [];
      },
    );
  }

  /** The exact ladder row for a name, or a {@link NotFoundError}. */
  public async getPlayer(
    name: string,
    season = "s5",
    platform = "crossplay",
  ): Promise<Record<string, unknown>> {
    const rows = await this.search(name, season, platform);
    const exact = rows.find(
      (row) =>
        String(row.name ?? "").toLowerCase() === name.toLowerCase() ||
        String(row.steamName ?? "").toLowerCase() === name.toLowerCase(),
    );
    const row = exact ?? rows[0];
    if (!row) throw new NotFoundError(this.id, `The Finals player "${name}"`, "the-finals");
    return row;
  }

  /** A page of the ladder. */
  public async getLeaderboard(
    season = "s5",
    platform = "crossplay",
  ): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ data?: Record<string, unknown>[] }>(
      `/leaderboard/${season}/${platform}`,
      { nullOn404: true },
    );
    return response?.data ?? [];
  }
}

// ---------------------------------------------------------------------------
// Marvel Rivals
// ---------------------------------------------------------------------------

/**
 * marvelrivalsapi.com.
 *
 * Data appears only once an account has been indexed at least once, so a brand
 * new player can legitimately 404 for a while. The message says so rather than
 * implying the name was wrong.
 */
export class MarvelRivalsProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("marvel-rivals", runtime);
  }

  protected override authHeaderName(): string {
    return "x-api-key";
  }

  public async getPlayer(nameOrUid: string): Promise<Record<string, unknown>> {
    return this.cached(
      ["player", nameOrUid.toLowerCase()],
      "getPlayer",
      "marvel-rivals",
      TTL.player ?? 300,
      async () => {
        const player = await this.get<Record<string, unknown> | null>(
          `/player/${encodeURIComponent(nameOrUid)}`,
          { nullOn404: true },
        );
        if (!player) {
          throw new NotFoundError(
            this.id,
            `Marvel Rivals player "${nameOrUid}" (new accounts appear only after their first index)`,
            "marvel-rivals",
          );
        }
        return player;
      },
    );
  }

  public async getMatchHistory(uid: string, limit = 20): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["matches", uid, limit],
      "getMatchHistory",
      "marvel-rivals",
      TTL.matchHistory ?? 60,
      async () => {
        const response = await this.get<{ match_history?: Record<string, unknown>[] }>(
          `/player/${uid}/match-history`,
          { query: { limit }, nullOn404: true },
        );
        return response?.match_history ?? [];
      },
    );
  }

  public async getMatch(matchId: string): Promise<Record<string, unknown>> {
    return this.cached(
      ["match", matchId],
      "getMatch",
      "marvel-rivals",
      TTL.match ?? 86_400,
      async () => {
        const match = await this.get<Record<string, unknown> | null>(`/match/${matchId}`, {
          nullOn404: true,
        });
        if (!match) throw new NotFoundError(this.id, `match ${matchId}`, "marvel-rivals");
        return match;
      },
    );
  }

  public async getLeaderboard(heroId: string): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ players?: Record<string, unknown>[] }>(
      `/heroes/leaderboard/${heroId}`,
      { nullOn404: true },
    );
    return response?.players ?? [];
  }

  public async getHeroes(): Promise<Record<string, unknown>[]> {
    return this.cached(["heroes"], "getMetadata", "marvel-rivals", TTL.metadata ?? 3_600, async () => {
      const heroes = await this.get<Record<string, unknown>[] | null>("/heroes", {
        nullOn404: true,
      });
      return heroes ?? [];
    });
  }
}

// ---------------------------------------------------------------------------
// Deadlock
// ---------------------------------------------------------------------------

/**
 * deadlock-api.com.
 *
 * Keyed on the 32-bit Steam account id, like Dota 2. The game is still in
 * closed testing, so the schema moves - which is exactly why the normalised
 * layer above keeps the raw payload attached.
 */
export class DeadlockProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("deadlock-api", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  public async getPlayerCard(steamIdOrAccountId: string): Promise<Record<string, unknown>> {
    const accountId = toSteamAccountId(steamIdOrAccountId);
    return this.cached(
      ["card", accountId],
      "getPlayer",
      "deadlock",
      TTL.player ?? 300,
      async () => {
        const card = await this.get<Record<string, unknown> | null>(
          `/players/${accountId}/card`,
          { nullOn404: true },
        );
        if (!card) throw new NotFoundError(this.id, `Deadlock account ${accountId}`, "deadlock");
        return card;
      },
    );
  }

  public async getMatchHistory(
    steamIdOrAccountId: string,
  ): Promise<Record<string, unknown>[]> {
    const accountId = toSteamAccountId(steamIdOrAccountId);
    return this.cached(
      ["history", accountId],
      "getMatchHistory",
      "deadlock",
      TTL.matchHistory ?? 60,
      async () => {
        const history = await this.get<Record<string, unknown>[] | null>(
          `/players/${accountId}/match-history`,
          { nullOn404: true },
        );
        return history ?? [];
      },
    );
  }

  public async getMatch(matchId: string): Promise<Record<string, unknown>> {
    return this.cached(["match", matchId], "getMatch", "deadlock", TTL.match ?? 86_400, async () => {
      const match = await this.get<Record<string, unknown> | null>(
        `/matches/${matchId}/metadata`,
        { nullOn404: true },
      );
      if (!match) throw new NotFoundError(this.id, `Deadlock match ${matchId}`, "deadlock");
      return match;
    });
  }

  public async getLeaderboard(region = "Europe"): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["leaderboard", region],
      "getLeaderboard",
      "deadlock",
      TTL.leaderboard ?? 300,
      async () => {
        const response = await this.get<{ entries?: Record<string, unknown>[] }>(
          `/leaderboard/${region}`,
          { nullOn404: true },
        );
        return response?.entries ?? [];
      },
    );
  }

  public async getHeroes(): Promise<Record<string, unknown>[]> {
    return this.cached(["heroes"], "getMetadata", "deadlock", TTL.metadata ?? 3_600, async () => {
      const heroes = await this.get<Record<string, unknown>[] | null>(
        "https://assets.deadlock-api.com/v2/heroes",
        { nullOn404: true },
      );
      return heroes ?? [];
    });
  }
}
