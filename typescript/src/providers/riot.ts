/**
 * Riot Games API.
 *
 * Serves League of Legends, Teamfight Tactics, VALORANT and Legends of
 * Runeterra.
 *
 * The thing that catches everybody is the **split routing**. Riot has two
 * kinds of host and they are not interchangeable:
 *
 * - **Platform hosts** (`euw1`, `na1`, `kr`, ...) serve anything tied to a
 *   game account on one shard: summoners, league entries, spectator.
 * - **Regional clusters** (`europe`, `americas`, `asia`, `sea`) serve the
 *   account API and, since Match-v5, all match data.
 *
 * Calling the right endpoint on the wrong host returns 404, not a helpful
 * error, so the mapping lives here in one table rather than being guessed at
 * each call site.
 */

import { ProviderClient } from "./base.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

/** Platform host to regional cluster. The table that prevents the 404s. */
const PLATFORM_TO_CLUSTER: Readonly<Record<string, string>> = {
  br1: "americas",
  la1: "americas",
  la2: "americas",
  na1: "americas",
  oc1: "sea",
  ru: "europe",
  tr1: "europe",
  eun1: "europe",
  euw1: "europe",
  me1: "europe",
  jp1: "asia",
  kr: "asia",
  ph2: "sea",
  sg2: "sea",
  th2: "sea",
  tw2: "sea",
  vn2: "sea",
};

/** VALORANT uses its own shard names, which are not the platform hosts. */
const VALORANT_SHARDS = new Set(["eu", "na", "ap", "kr", "latam", "br", "esports"]);

export interface RiotAccount {
  puuid: string;
  gameName?: string;
  tagLine?: string;
}

export interface RiotSummoner {
  id?: string;
  accountId?: string;
  puuid: string;
  name?: string;
  profileIconId: number;
  revisionDate: number;
  summonerLevel: number;
}

export interface RiotLeagueEntry {
  leagueId?: string;
  queueType: string;
  tier: string;
  rank: string;
  summonerId?: string;
  puuid?: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  hotStreak?: boolean;
  veteran?: boolean;
  freshBlood?: boolean;
  inactive?: boolean;
  miniSeries?: { target: number; wins: number; losses: number; progress: string };
}

export class RiotProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("riot", runtime);
  }

  protected override authHeaderName(): string {
    return "X-Riot-Token";
  }

  /** The regional cluster a platform belongs to. */
  public clusterFor(platform: string): string {
    const cluster = PLATFORM_TO_CLUSTER[platform.toLowerCase()];
    if (cluster) return cluster;
    // A caller who already passed a cluster gets it back rather than an error;
    // "europe" is a legitimate thing to hand a match lookup.
    if (["americas", "europe", "asia", "sea"].includes(platform.toLowerCase())) {
      return platform.toLowerCase();
    }
    throw new ValidationError(
      `unknown Riot platform "${platform}". Expected one of: ${Object.keys(PLATFORM_TO_CLUSTER).join(", ")}`,
    );
  }

  /** Validate a VALORANT shard, which uses a different vocabulary again. */
  public valorantShard(shard: string): string {
    const value = shard.toLowerCase();
    if (!VALORANT_SHARDS.has(value)) {
      throw new ValidationError(
        `unknown VALORANT shard "${shard}". Expected one of: ${[...VALORANT_SHARDS].join(", ")}`,
      );
    }
    return value;
  }

  private host(routing: string): string {
    return `https://${routing}.api.riotgames.com`;
  }

  // -------------------------------------------------------------------------
  // Account (regional cluster)
  // -------------------------------------------------------------------------

  /** Riot ID to PUUID. The entry point for every Riot title. */
  public async getAccountByRiotId(
    gameName: string,
    tagLine: string,
    routing: string,
    titleId: string,
  ): Promise<RiotAccount> {
    const cluster = this.clusterFor(routing);
    return this.cached(
      ["account", cluster, gameName.toLowerCase(), tagLine.toLowerCase()],
      "resolvePlayer",
      titleId,
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const account = await this.get<RiotAccount | null>(
          `${this.host(cluster)}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
          { nullOn404: true },
        );
        if (!account?.puuid) {
          throw new NotFoundError(this.id, `Riot ID ${gameName}#${tagLine}`, titleId);
        }
        return account;
      },
    );
  }

  /** PUUID back to a Riot ID, for showing the current name of a stored id. */
  public async getAccountByPuuid(
    puuid: string,
    routing: string,
    titleId: string,
  ): Promise<RiotAccount> {
    const cluster = this.clusterFor(routing);
    return this.cached(
      ["account", cluster, puuid],
      "resolvePlayer",
      titleId,
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const account = await this.get<RiotAccount | null>(
          `${this.host(cluster)}/riot/account/v1/accounts/by-puuid/${puuid}`,
          { nullOn404: true },
        );
        if (!account?.puuid) throw new NotFoundError(this.id, `PUUID ${puuid}`, titleId);
        return account;
      },
    );
  }

  // -------------------------------------------------------------------------
  // League of Legends (platform host, except matches)
  // -------------------------------------------------------------------------

  /** Summoner record, which carries the account level. */
  public async getSummonerByPuuid(puuid: string, platform: string): Promise<RiotSummoner> {
    return this.cached(
      ["summoner", platform, puuid],
      "getPlayer",
      "league-of-legends",
      TTL.player ?? 300,
      async () => {
        const summoner = await this.get<RiotSummoner | null>(
          `${this.host(platform)}/lol/summoner/v4/summoners/by-puuid/${puuid}`,
          { nullOn404: true },
        );
        if (!summoner) {
          throw new NotFoundError(this.id, `summoner ${puuid} on ${platform}`, "league-of-legends");
        }
        return summoner;
      },
    );
  }

  /** Ranked entries - one per queue the player has played this split. */
  public async getLeagueEntries(puuid: string, platform: string): Promise<RiotLeagueEntry[]> {
    return this.cached(
      ["league", platform, puuid],
      "getRank",
      "league-of-legends",
      TTL.rank ?? 60,
      async () => {
        const entries = await this.get<RiotLeagueEntry[] | null>(
          `${this.host(platform)}/lol/league/v4/entries/by-puuid/${puuid}`,
          { nullOn404: true },
        );
        // An unranked player is a 200 with an empty array, and an old account
        // can be a 404. Both mean "no rank", not "no player".
        return entries ?? [];
      },
    );
  }

  /** Match ids, newest first. Match-v5 lives on the cluster, not the platform. */
  public async getMatchIds(
    puuid: string,
    routing: string,
    options: {
      count?: number;
      start?: number;
      startTime?: number;
      endTime?: number;
      queue?: number;
      type?: string;
    } = {},
  ): Promise<string[]> {
    const cluster = this.clusterFor(routing);
    const ids = await this.get<string[] | null>(
      `${this.host(cluster)}/lol/match/v5/matches/by-puuid/${puuid}/ids`,
      {
        query: {
          count: options.count ?? 20,
          start: options.start ?? 0,
          // Riot wants seconds here while every other timestamp it returns is
          // in milliseconds.
          startTime: options.startTime ? Math.floor(options.startTime / 1_000) : undefined,
          endTime: options.endTime ? Math.floor(options.endTime / 1_000) : undefined,
          queue: options.queue,
          type: options.type,
        },
        nullOn404: true,
      },
    );
    return ids ?? [];
  }

  /** One League match. Cached hard - a finished match never changes. */
  public async getMatch(matchId: string, routing: string): Promise<Record<string, unknown>> {
    const cluster = this.clusterFor(routing);
    return this.cached(
      ["match", cluster, matchId],
      "getMatch",
      "league-of-legends",
      TTL.match ?? 86_400,
      async () => {
        const match = await this.get<Record<string, unknown> | null>(
          `${this.host(cluster)}/lol/match/v5/matches/${matchId}`,
          { nullOn404: true },
        );
        if (!match) throw new NotFoundError(this.id, `match ${matchId}`, "league-of-legends");
        return match;
      },
    );
  }

  /** The apex tiers, which are separate endpoints from the normal ladder. */
  public async getApexLeague(
    tier: "challenger" | "grandmaster" | "master",
    queue: string,
    platform: string,
  ): Promise<{ entries?: RiotLeagueEntry[] } | null> {
    return this.get<{ entries?: RiotLeagueEntry[] } | null>(
      `${this.host(platform)}/lol/league/v4/${tier}leagues/by-queue/${queue}`,
      { nullOn404: true },
    );
  }

  /** A page of one division, for walking the ladder below the apex tiers. */
  public async getLeagueByDivision(
    queue: string,
    tier: string,
    division: string,
    platform: string,
    page = 1,
  ): Promise<RiotLeagueEntry[]> {
    const entries = await this.get<RiotLeagueEntry[] | null>(
      `${this.host(platform)}/lol/league/v4/entries/${queue}/${tier}/${division}`,
      { query: { page }, nullOn404: true },
    );
    return entries ?? [];
  }

  /** Champion mastery, highest first. */
  public async getChampionMastery(
    puuid: string,
    platform: string,
  ): Promise<{ championId: number; championLevel: number; championPoints: number }[]> {
    const list = await this.get<
      { championId: number; championLevel: number; championPoints: number }[] | null
    >(`${this.host(platform)}/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}`, {
      nullOn404: true,
    });
    return list ?? [];
  }

  /** The free champion rotation. */
  public async getChampionRotation(platform: string): Promise<{
    freeChampionIds: number[];
    freeChampionIdsForNewPlayers: number[];
    maxNewPlayerLevel: number;
  } | null> {
    return this.cached(
      ["rotation", platform],
      "getMetadata",
      "league-of-legends",
      TTL.metadata ?? 3_600,
      () =>
        this.get<{
          freeChampionIds: number[];
          freeChampionIdsForNewPlayers: number[];
          maxNewPlayerLevel: number;
        } | null>(`${this.host(platform)}/lol/platform/v3/champion-rotations`, {
          nullOn404: true,
        }),
    );
  }

  /** The game the player is in right now, or `null`. */
  public async getActiveGame(
    puuid: string,
    platform: string,
  ): Promise<Record<string, unknown> | null> {
    return this.get<Record<string, unknown> | null>(
      `${this.host(platform)}/lol/spectator/v5/active-games/by-summoner/${puuid}`,
      { nullOn404: true },
    );
  }

  // -------------------------------------------------------------------------
  // Teamfight Tactics
  // -------------------------------------------------------------------------

  public async getTftSummoner(puuid: string, platform: string): Promise<RiotSummoner> {
    const summoner = await this.get<RiotSummoner | null>(
      `${this.host(platform)}/tft/summoner/v1/summoners/by-puuid/${puuid}`,
      { nullOn404: true },
    );
    if (!summoner) {
      throw new NotFoundError(this.id, `TFT summoner ${puuid}`, "teamfight-tactics");
    }
    return summoner;
  }

  public async getTftLeagueEntries(puuid: string, platform: string): Promise<RiotLeagueEntry[]> {
    return this.cached(
      ["tft", "league", platform, puuid],
      "getRank",
      "teamfight-tactics",
      TTL.rank ?? 60,
      async () => {
        const entries = await this.get<RiotLeagueEntry[] | null>(
          `${this.host(platform)}/tft/league/v1/by-puuid/${puuid}`,
          { nullOn404: true },
        );
        return entries ?? [];
      },
    );
  }

  public async getTftMatchIds(
    puuid: string,
    routing: string,
    options: { count?: number; start?: number } = {},
  ): Promise<string[]> {
    const cluster = this.clusterFor(routing);
    const ids = await this.get<string[] | null>(
      `${this.host(cluster)}/tft/match/v1/matches/by-puuid/${puuid}/ids`,
      { query: { count: options.count ?? 20, start: options.start ?? 0 }, nullOn404: true },
    );
    return ids ?? [];
  }

  public async getTftMatch(matchId: string, routing: string): Promise<Record<string, unknown>> {
    const cluster = this.clusterFor(routing);
    return this.cached(
      ["tft", "match", cluster, matchId],
      "getMatch",
      "teamfight-tactics",
      TTL.match ?? 86_400,
      async () => {
        const match = await this.get<Record<string, unknown> | null>(
          `${this.host(cluster)}/tft/match/v1/matches/${matchId}`,
          { nullOn404: true },
        );
        if (!match) throw new NotFoundError(this.id, `TFT match ${matchId}`, "teamfight-tactics");
        return match;
      },
    );
  }

  public async getTftApexLeague(
    tier: "challenger" | "grandmaster" | "master",
    platform: string,
  ): Promise<{ entries?: RiotLeagueEntry[] } | null> {
    return this.get<{ entries?: RiotLeagueEntry[] } | null>(
      `${this.host(platform)}/tft/league/v1/${tier}`,
      { nullOn404: true },
    );
  }

  // -------------------------------------------------------------------------
  // VALORANT (shard routing, production key required)
  // -------------------------------------------------------------------------

  public async getValorantMatchList(
    puuid: string,
    shard: string,
  ): Promise<{ matchId: string; gameStartTimeMillis: number; queueId: string }[]> {
    const region = this.valorantShard(shard);
    const response = await this.get<{
      history?: { matchId: string; gameStartTimeMillis: number; queueId: string }[];
    } | null>(`${this.host(region)}/val/match/v1/matchlists/by-puuid/${puuid}`, {
      nullOn404: true,
    });
    return response?.history ?? [];
  }

  public async getValorantMatch(matchId: string, shard: string): Promise<Record<string, unknown>> {
    const region = this.valorantShard(shard);
    return this.cached(
      ["val", "match", region, matchId],
      "getMatch",
      "valorant",
      TTL.match ?? 86_400,
      async () => {
        const match = await this.get<Record<string, unknown> | null>(
          `${this.host(region)}/val/match/v1/matches/${matchId}`,
          { nullOn404: true },
        );
        if (!match) throw new NotFoundError(this.id, `VALORANT match ${matchId}`, "valorant");
        return match;
      },
    );
  }

  /** The act leaderboard. `actId` comes from the content endpoint below. */
  public async getValorantLeaderboard(
    actId: string,
    shard: string,
    options: { size?: number; startIndex?: number } = {},
  ): Promise<Record<string, unknown> | null> {
    const region = this.valorantShard(shard);
    return this.get<Record<string, unknown> | null>(
      `${this.host(region)}/val/ranked/v1/leaderboards/by-act/${actId}`,
      {
        query: { size: options.size ?? 200, startIndex: options.startIndex ?? 0 },
        nullOn404: true,
      },
    );
  }

  /** Agents, maps, acts and the rest of the static content. */
  public async getValorantContent(shard: string): Promise<Record<string, unknown> | null> {
    const region = this.valorantShard(shard);
    return this.cached(
      ["val", "content", region],
      "getMetadata",
      "valorant",
      TTL.metadata ?? 3_600,
      () =>
        this.get<Record<string, unknown> | null>(
          `${this.host(region)}/val/content/v1/contents`,
          { query: { locale: "en-US" }, nullOn404: true },
        ),
    );
  }

  // -------------------------------------------------------------------------
  // Legends of Runeterra
  // -------------------------------------------------------------------------

  public async getLorLeaderboard(
    routing: string,
  ): Promise<{ name: string; rank: number; lp: number }[]> {
    const cluster = this.clusterFor(routing);
    const response = await this.get<{
      players?: { name: string; rank: number; lp: number }[];
    } | null>(`${this.host(cluster)}/lor/ranked/v1/leaderboards`, { nullOn404: true });
    return response?.players ?? [];
  }

  public async getLorMatchIds(puuid: string, routing: string): Promise<string[]> {
    const cluster = this.clusterFor(routing);
    const response = await this.get<string[] | null>(
      `${this.host(cluster)}/lor/match/v1/matches/by-puuid/${puuid}/ids`,
      { nullOn404: true },
    );
    return response ?? [];
  }
}
