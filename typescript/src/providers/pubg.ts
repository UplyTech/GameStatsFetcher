/**
 * PUBG Developer API.
 *
 * JSON:API shaped - everything comes back as `{ data, included, links }` with
 * relationships pointing between them, so the useful work in this module is
 * flattening that into something a caller can read.
 *
 * The rate limit is the tightest of any first-party API here: **10 requests per
 * minute** on a standard key. The registry's `rps: 0.16` reflects that, and it
 * is the reason this provider caches aggressively and resolves several players
 * in one call wherever the endpoint allows it.
 */

import { ProviderClient } from "./base.js";
import { NotFoundError } from "../errors.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

/** Shards. Console shards are merged, PC ones are per region, Kakao is separate. */
export const PUBG_SHARDS = [
  "steam",
  "kakao",
  "console",
  "psn",
  "xbox",
  "stadia",
  "tournament",
] as const;

export type PubgShard = (typeof PUBG_SHARDS)[number];

export interface PubgPlayer {
  type: "player";
  id: string;
  attributes: {
    name: string;
    shardId: string;
    patchVersion?: string;
    titleId?: string;
  };
  relationships?: {
    matches?: { data?: { type: string; id: string }[] };
  };
}

export interface PubgGameModeStats {
  assists: number;
  boosts: number;
  dBNOs: number;
  dailyKills: number;
  damageDealt: number;
  days: number;
  headshotKills: number;
  heals: number;
  kills: number;
  longestKill: number;
  longestTimeSurvived: number;
  losses: number;
  maxKillStreaks: number;
  mostSurvivalTime: number;
  revives: number;
  rideDistance: number;
  roadKills: number;
  roundMostKills: number;
  roundsPlayed: number;
  suicides: number;
  swimDistance: number;
  teamKills: number;
  timeSurvived: number;
  top10s: number;
  vehicleDestroys: number;
  walkDistance: number;
  weaponsAcquired: number;
  wins: number;
}

export class PubgProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("pubg", runtime);
  }

  /**
   * PUBG insists on the JSON:API accept header and answers 415 without it.
   */
  private jsonApi(extra: Record<string, string> = {}): Record<string, string> {
    return { Accept: "application/vnd.api+json", ...extra };
  }

  /** Look several players up by name in one request - the quota saver. */
  public async getPlayersByName(
    shard: string,
    names: readonly string[],
  ): Promise<PubgPlayer[]> {
    if (names.length === 0) return [];
    const response = await this.get<{ data?: PubgPlayer[] }>(`/shards/${shard}/players`, {
      query: { "filter[playerNames]": names.join(",") },
      headers: this.jsonApi(),
      nullOn404: true,
    });
    return response?.data ?? [];
  }

  /** One player by name. */
  public async getPlayerByName(shard: string, name: string): Promise<PubgPlayer> {
    return this.cached(
      [shard, "player", name.toLowerCase()],
      "resolvePlayer",
      "pubg",
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const players = await this.getPlayersByName(shard, [name]);
        const player = players[0];
        if (!player) throw new NotFoundError(this.id, `PUBG player ${name}`, "pubg");
        return player;
      },
    );
  }

  /** One player by account id, which is what a stored ref holds. */
  public async getPlayerById(shard: string, accountId: string): Promise<PubgPlayer> {
    return this.cached(
      [shard, "player-id", accountId],
      "getPlayer",
      "pubg",
      TTL.player ?? 300,
      async () => {
        const response = await this.get<{ data?: PubgPlayer }>(
          `/shards/${shard}/players/${accountId}`,
          { headers: this.jsonApi(), nullOn404: true },
        );
        if (!response?.data) {
          throw new NotFoundError(this.id, `PUBG account ${accountId}`, "pubg");
        }
        return response.data;
      },
    );
  }

  /** Seasons for a shard. The current one carries `isCurrentSeason: true`. */
  public async getSeasons(shard: string): Promise<
    { id: string; attributes: { isCurrentSeason: boolean; isOffseason: boolean } }[]
  > {
    return this.cached([shard, "seasons"], "getMetadata", "pubg", TTL.metadata ?? 3_600, async () => {
      const response = await this.get<{
        data?: { id: string; attributes: { isCurrentSeason: boolean; isOffseason: boolean } }[];
      }>(`/shards/${shard}/seasons`, { headers: this.jsonApi() });
      return response?.data ?? [];
    });
  }

  /** The id of the season currently running on a shard. */
  public async getCurrentSeasonId(shard: string): Promise<string> {
    const seasons = await this.getSeasons(shard);
    const current = seasons.find((season) => season.attributes.isCurrentSeason);
    if (!current) throw new NotFoundError(this.id, `current season on ${shard}`, "pubg");
    return current.id;
  }

  /** Career stats for one season, split by game mode. */
  public async getSeasonStats(
    shard: string,
    accountId: string,
    seasonId: string,
  ): Promise<Record<string, PubgGameModeStats>> {
    return this.cached(
      [shard, "season-stats", accountId, seasonId],
      "getPlayerStats",
      "pubg",
      TTL.playerStats ?? 180,
      async () => {
        const response = await this.get<{
          data?: { attributes?: { gameModeStats?: Record<string, PubgGameModeStats> } };
        }>(`/shards/${shard}/players/${accountId}/seasons/${seasonId}`, {
          headers: this.jsonApi(),
          nullOn404: true,
        });
        return response?.data?.attributes?.gameModeStats ?? {};
      },
    );
  }

  /** Ranked stats, which are a separate endpoint with a different shape. */
  public async getRankedStats(
    shard: string,
    accountId: string,
    seasonId: string,
  ): Promise<Record<string, Record<string, unknown>>> {
    return this.cached(
      [shard, "ranked", accountId, seasonId],
      "getRank",
      "pubg",
      TTL.rank ?? 60,
      async () => {
        const response = await this.get<{
          data?: { attributes?: { rankedGameModeStats?: Record<string, Record<string, unknown>> } };
        }>(`/shards/${shard}/players/${accountId}/seasons/${seasonId}/ranked`, {
          headers: this.jsonApi(),
          nullOn404: true,
        });
        return response?.data?.attributes?.rankedGameModeStats ?? {};
      },
    );
  }

  /** Lifetime stats across every season. */
  public async getLifetimeStats(
    shard: string,
    accountId: string,
  ): Promise<Record<string, PubgGameModeStats>> {
    return this.cached(
      [shard, "lifetime", accountId],
      "getPlayerStats",
      "pubg",
      TTL.playerStats ?? 180,
      async () => {
        const response = await this.get<{
          data?: { attributes?: { gameModeStats?: Record<string, PubgGameModeStats> } };
        }>(`/shards/${shard}/players/${accountId}/seasons/lifetime`, {
          headers: this.jsonApi(),
          nullOn404: true,
        });
        return response?.data?.attributes?.gameModeStats ?? {};
      },
    );
  }

  /**
   * One match, with participants and rosters flattened out of `included`.
   *
   * Matches expire from the API after 14 days, so a 404 here is usually age
   * rather than a wrong id.
   */
  public async getMatch(shard: string, matchId: string): Promise<{
    data: Record<string, unknown>;
    included: Record<string, unknown>[];
  }> {
    return this.cached(
      [shard, "match", matchId],
      "getMatch",
      "pubg",
      TTL.match ?? 86_400,
      async () => {
        const response = await this.get<{
          data?: Record<string, unknown>;
          included?: Record<string, unknown>[];
        }>(`/shards/${shard}/matches/${matchId}`, {
          headers: this.jsonApi(),
          nullOn404: true,
        });
        if (!response?.data) {
          throw new NotFoundError(
            this.id,
            `match ${matchId} (matches are dropped after 14 days)`,
            "pubg",
          );
        }
        return { data: response.data, included: response.included ?? [] };
      },
    );
  }

  /** Ranked leaderboard for a season and mode. */
  public async getLeaderboard(
    shard: string,
    seasonId: string,
    gameMode: string,
    page = 0,
  ): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ included?: Record<string, unknown>[] }>(
      `/shards/${shard}/leaderboards/${seasonId}/${gameMode}`,
      { query: { "page[number]": page }, headers: this.jsonApi(), nullOn404: true },
    );
    return response?.included ?? [];
  }
}
