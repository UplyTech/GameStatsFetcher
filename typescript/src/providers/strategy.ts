/**
 * The strategy titles' community ladders.
 *
 * StarCraft II, Warcraft III, the Age of Empires games, Company of Heroes 3 and
 * Heroes of the Storm all have a competitive scene organised around a community
 * ladder rather than a publisher one. In three of these cases the community
 * ladder *is* the competitive game: W3Champions is where Warcraft III is played,
 * and SC2Pulse is the only place a player's accounts across four regions appear
 * as one person.
 */

import { ProviderClient } from "./base.js";
import type { RequestSpec } from "../http.js";
import { NotFoundError } from "../errors.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

/**
 * SC2Pulse.
 *
 * Blizzard's SC2 API is per-region and keyed on opaque profile ids. SC2Pulse
 * indexes all four regions and groups the accounts a person actually plays on,
 * which is why it is listed before `blizzard` for this title.
 */
export class Sc2PulseProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("sc2pulse", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  /** Search characters by BattleTag or name. */
  public async searchCharacters(term: string): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["search", term.toLowerCase()],
      "resolvePlayer",
      "starcraft-2",
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const results = await this.get<Record<string, unknown>[] | null>("/character/search", {
          query: { term },
          nullOn404: true,
        });
        if (!results || results.length === 0) {
          throw new NotFoundError(this.id, `SC2 player "${term}"`, "starcraft-2");
        }
        return results;
      },
    );
  }

  /** Current ladder standing per race and queue for one character. */
  public async getCharacterSummary(
    characterId: string | number,
    depthDays = 120,
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["summary", characterId, depthDays],
      "getRank",
      "starcraft-2",
      TTL.rank ?? 60,
      async () => {
        const summary = await this.get<Record<string, unknown>[] | null>(
          `/character/${characterId}/summary/1v1/${depthDays}`,
          { nullOn404: true },
        );
        return summary ?? [];
      },
    );
  }

  /** Recent matches for a character. */
  public async getCharacterMatches(
    characterId: string | number,
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["matches", characterId],
      "getMatchHistory",
      "starcraft-2",
      TTL.matchHistory ?? 60,
      async () => {
        const matches = await this.get<Record<string, unknown>[] | null>(
          `/character/${characterId}/matches`,
          { query: { type: "_1V1" }, nullOn404: true },
        );
        return matches ?? [];
      },
    );
  }

  /** Every account this person plays on, across regions. */
  public async getLinkedAccounts(characterId: string | number): Promise<Record<string, unknown>[]> {
    const linked = await this.get<Record<string, unknown>[] | null>(
      `/character/${characterId}/common`,
      { nullOn404: true },
    );
    return linked ?? [];
  }
}

/**
 * W3Champions - the Warcraft III competitive ladder.
 *
 * Player ids are BattleTags with the hash intact, URL-encoded. The `gateway`
 * parameter (10 = Europe, 20 = America, 30 = Asia) decides which ladder is
 * being asked about.
 */
export class W3ChampionsProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("w3champions", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  /** Player profile with per-race statistics. */
  public async getPlayer(battleTag: string): Promise<Record<string, unknown>> {
    return this.cached(
      ["player", battleTag.toLowerCase()],
      "getPlayer",
      "warcraft-3",
      TTL.player ?? 300,
      async () => {
        const player = await this.get<Record<string, unknown> | null>(
          `/players/${encodeURIComponent(battleTag)}`,
          { nullOn404: true },
        );
        if (!player) throw new NotFoundError(this.id, `BattleTag ${battleTag}`, "warcraft-3");
        return player;
      },
    );
  }

  /** Per-season, per-race statistics. */
  public async getPlayerStats(
    battleTag: string,
    season?: number,
  ): Promise<Record<string, unknown>[]> {
    const stats = await this.get<Record<string, unknown>[] | null>(
      `/players/${encodeURIComponent(battleTag)}/game-mode-stats`,
      { query: { gateWay: 20, season }, nullOn404: true },
    );
    return stats ?? [];
  }

  /** Recent matches. */
  public async getMatches(
    battleTag: string,
    options: { offset?: number; limit?: number; season?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["matches", battleTag.toLowerCase(), options.offset ?? 0, options.limit ?? 20],
      "getMatchHistory",
      "warcraft-3",
      TTL.matchHistory ?? 60,
      async () => {
        const response = await this.get<{ matches?: Record<string, unknown>[] }>("/matches/search", {
          query: {
            playerId: battleTag,
            offset: options.offset ?? 0,
            pageSize: Math.min(options.limit ?? 20, 100),
            season: options.season,
          },
          nullOn404: true,
        });
        return response?.matches ?? [];
      },
    );
  }

  /** The ladder for a game mode and season. */
  public async getLadder(
    gameMode = 1,
    options: { gateway?: number; season?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["ladder", gameMode, options.gateway ?? 20, options.season ?? 0],
      "getLeaderboard",
      "warcraft-3",
      TTL.leaderboard ?? 300,
      async () => {
        const ladder = await this.get<Record<string, unknown>[] | null>("/ladder", {
          query: {
            gameMode,
            gateWay: options.gateway ?? 20,
            season: options.season,
          },
          nullOn404: true,
        });
        return ladder ?? [];
      },
    );
  }
}

/**
 * Relic Community API - Age of Empires II DE, Age of Empires IV and
 * Company of Heroes 3.
 *
 * One schema, three games, keyed by a numeric `title` parameter. The oddity is
 * that leaderboard lookups take a JSON-encoded array as a query parameter, and
 * a player is found by *searching the ladder* rather than by an id endpoint.
 */
export class RelicProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("relic", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  /** The `title` value each game answers to. */
  public titleParam(titleId: string): string {
    switch (titleId) {
      case "age-of-empires-2":
        return "age2";
      case "age-of-empires-4":
        return "age4";
      case "company-of-heroes-3":
        return "coh3";
      default:
        return "age4";
    }
  }

  /** Find a player on a ladder by name or Steam id. */
  public async findPlayer(
    titleId: string,
    query: { name?: string; steamId?: string },
  ): Promise<Record<string, unknown>> {
    const title = this.titleParam(titleId);
    const alias = query.steamId ? `/steam/${query.steamId}` : query.name;
    return this.cached(
      [title, "find", alias ?? "-"],
      "resolvePlayer",
      titleId,
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const response = await this.get<{
          statGroups?: Record<string, unknown>[];
          leaderboardStats?: Record<string, unknown>[];
        }>("/leaderboards/getPersonalStat", {
          query: { title, profile_names: JSON.stringify([alias]) },
          nullOn404: true,
        });
        const group = response?.statGroups?.[0];
        if (!group) throw new NotFoundError(this.id, `player "${alias}"`, titleId);
        return group;
      },
    );
  }

  /** Ladder standings and per-mode ratings for a player. */
  public async getPersonalStats(
    titleId: string,
    profileIds: readonly (string | number)[],
  ): Promise<{
    statGroups?: Record<string, unknown>[];
    leaderboardStats?: Record<string, unknown>[];
  }> {
    const title = this.titleParam(titleId);
    return this.cached(
      [title, "stats", profileIds.join(",")],
      "getPlayerStats",
      titleId,
      TTL.playerStats ?? 180,
      async () => {
        const response = await this.get<{
          statGroups?: Record<string, unknown>[];
          leaderboardStats?: Record<string, unknown>[];
        } | null>("/leaderboards/getPersonalStat", {
          query: { title, profile_ids: JSON.stringify(profileIds.map(String)) },
          nullOn404: true,
        });
        return response ?? {};
      },
    );
  }

  /** Recent match history for a player. */
  public async getRecentMatches(
    titleId: string,
    profileIds: readonly (string | number)[],
  ): Promise<Record<string, unknown>[]> {
    const title = this.titleParam(titleId);
    const response = await this.get<{ matchHistoryStats?: Record<string, unknown>[] }>(
      "/leaderboards/getRecentMatchHistory",
      {
        query: { title, profile_ids: JSON.stringify(profileIds.map(String)) },
        nullOn404: true,
      },
    );
    return response?.matchHistoryStats ?? [];
  }

  /** A page of a leaderboard. */
  public async getLeaderboard(
    titleId: string,
    leaderboardId: number,
    options: { start?: number; count?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const title = this.titleParam(titleId);
    const response = await this.get<{ leaderboardStats?: Record<string, unknown>[] }>(
      "/leaderboards/getleaderboard2",
      {
        query: {
          title,
          leaderboard_id: leaderboardId,
          start: options.start ?? 1,
          count: Math.min(options.count ?? 100, 200),
          sortBy: 1,
        },
        nullOn404: true,
      },
    );
    return response?.leaderboardStats ?? [];
  }
}

/**
 * AoE4World.
 *
 * Friendlier than the raw Relic endpoints and adds civilisation breakdowns and
 * per-patch trends, so it is Age of Empires IV's preferred provider. It asks
 * for a descriptive User-Agent, which the runtime supplies.
 */
export class Aoe4WorldProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("aoe4world", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  /** Search players by name. */
  public async searchPlayers(query: string): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["search", query.toLowerCase()],
      "resolvePlayer",
      "age-of-empires-4",
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const response = await this.get<{ players?: Record<string, unknown>[] }>(
          "/players/search",
          { query: { query }, nullOn404: true },
        );
        const players = response?.players ?? [];
        if (players.length === 0) {
          throw new NotFoundError(this.id, `AoE4 player "${query}"`, "age-of-empires-4");
        }
        return players;
      },
    );
  }

  /** Full profile with per-mode ratings. */
  public async getPlayer(profileId: string | number): Promise<Record<string, unknown>> {
    return this.cached(
      ["player", profileId],
      "getPlayer",
      "age-of-empires-4",
      TTL.player ?? 300,
      async () => {
        const player = await this.get<Record<string, unknown> | null>(`/players/${profileId}`, {
          nullOn404: true,
        });
        if (!player) {
          throw new NotFoundError(this.id, `AoE4 profile ${profileId}`, "age-of-empires-4");
        }
        return player;
      },
    );
  }

  /** Recent games. */
  public async getGames(
    profileId: string | number,
    options: { limit?: number; page?: number; leaderboard?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["games", profileId, options.page ?? 1, options.leaderboard ?? "-"],
      "getMatchHistory",
      "age-of-empires-4",
      TTL.matchHistory ?? 60,
      async () => {
        const response = await this.get<{ games?: Record<string, unknown>[] }>(
          `/players/${profileId}/games`,
          {
            query: {
              limit: Math.min(options.limit ?? 20, 50),
              page: options.page ?? 1,
              leaderboard: options.leaderboard,
            },
            nullOn404: true,
          },
        );
        return response?.games ?? [];
      },
    );
  }

  /** One game in full. */
  public async getGame(gameId: string): Promise<Record<string, unknown>> {
    return this.cached(
      ["game", gameId],
      "getMatch",
      "age-of-empires-4",
      TTL.match ?? 86_400,
      async () => {
        const game = await this.get<Record<string, unknown> | null>(`/games/${gameId}`, {
          nullOn404: true,
        });
        if (!game) throw new NotFoundError(this.id, `AoE4 game ${gameId}`, "age-of-empires-4");
        return game;
      },
    );
  }

  /** A leaderboard page - `rm_solo`, `qm_1v1`, `rm_team` and so on. */
  public async getLeaderboard(
    leaderboard = "rm_solo",
    options: { page?: number; query?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["leaderboard", leaderboard, options.page ?? 1],
      "getLeaderboard",
      "age-of-empires-4",
      TTL.leaderboard ?? 300,
      async () => {
        const response = await this.get<{ players?: Record<string, unknown>[] }>(
          `/leaderboards/${leaderboard}`,
          { query: { page: options.page ?? 1, query: options.query }, nullOn404: true },
        );
        return response?.players ?? [];
      },
    );
  }
}

/**
 * Heroes Profile - Heroes of the Storm.
 *
 * Blizzard never shipped a HotS profile API, and the game is in maintenance
 * mode, so this replay-derived database is all there is. Like Ballchasing, it
 * only knows the games somebody uploaded.
 */
export class HeroesProfileProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("heroesprofile", runtime);
  }

  protected override authQueryName(): string {
    return "api_token";
  }

  /** Career profile by BattleTag. */
  public async getPlayer(battleTag: string, region = 1): Promise<Record<string, unknown>> {
    return this.cached(
      ["player", battleTag.toLowerCase(), region],
      "getPlayer",
      "heroes-of-the-storm",
      TTL.player ?? 300,
      async () => {
        const player = await this.get<Record<string, unknown> | null>("/Player", {
          query: { battletag: battleTag, region },
          nullOn404: true,
        });
        if (!player || Object.keys(player).length === 0) {
          throw new NotFoundError(this.id, `BattleTag ${battleTag}`, "heroes-of-the-storm");
        }
        return player;
      },
    );
  }

  /** Per-hero career statistics. */
  public async getHeroStats(battleTag: string, region = 1): Promise<Record<string, unknown>> {
    const stats = await this.get<Record<string, unknown> | null>("/Player/Hero/All", {
      query: { battletag: battleTag, region },
      nullOn404: true,
    });
    return stats ?? {};
  }

  /** Recent matches. */
  public async getMatches(battleTag: string, region = 1): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["matches", battleTag.toLowerCase(), region],
      "getMatchHistory",
      "heroes-of-the-storm",
      TTL.matchHistory ?? 60,
      async () => {
        const matches = await this.get<Record<string, unknown>[] | null>("/Player/MMR", {
          query: { battletag: battleTag, region },
          nullOn404: true,
        });
        return matches ?? [];
      },
    );
  }
}
