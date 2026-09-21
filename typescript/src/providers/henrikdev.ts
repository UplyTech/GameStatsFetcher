/**
 * HenrikDev VALORANT API.
 *
 * Riot's own VALORANT endpoints need an approved *production* key, which is
 * granted per application and not to most callers. This provider serves the
 * same data - MMR, full match detail, act leaderboards - to anyone with a free
 * tiered key, which is why VALORANT lists it directly after `riot`.
 *
 * Region here is VALORANT's own vocabulary (`eu`, `na`, `ap`, `kr`, `latam`,
 * `br`), not a Riot platform host.
 */

import { ProviderClient } from "./base.js";
import { NotFoundError } from "../errors.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

export interface HenrikAccount {
  puuid: string;
  region: string;
  account_level: number;
  name: string;
  tag: string;
  card?: { small?: string; large?: string; wide?: string; id?: string };
  last_update_raw?: number;
}

export interface HenrikMmr {
  current_data?: {
    currenttier?: number;
    currenttierpatched?: string;
    ranking_in_tier?: number;
    mmr_change_to_last_game?: number;
    elo?: number;
    games_needed_for_rating?: number;
    old?: boolean;
  };
  highest_rank?: { old?: boolean; tier?: number; patched_tier?: string; season?: string };
  by_season?: Record<string, Record<string, unknown>>;
}

export class HenrikDevProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("henrikdev", runtime);
  }

  /** HenrikDev takes the key in a bare `Authorization` header, without `Bearer`. */
  protected override authHeaderName(): string {
    return "Authorization";
  }

  /** Account by Riot ID, which is also how a PUUID is obtained here. */
  public async getAccount(name: string, tag: string): Promise<HenrikAccount> {
    return this.cached(
      ["account", name.toLowerCase(), tag.toLowerCase()],
      "resolvePlayer",
      "valorant",
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const response = await this.get<{ status?: number; data?: HenrikAccount }>(
          `/v1/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
          { nullOn404: true },
        );
        if (!response?.data?.puuid) {
          throw new NotFoundError(this.id, `Riot ID ${name}#${tag}`, "valorant");
        }
        return response.data;
      },
    );
  }

  /** Account by PUUID, for refreshing the display name of a stored ref. */
  public async getAccountByPuuid(puuid: string): Promise<HenrikAccount> {
    const response = await this.get<{ data?: HenrikAccount }>(`/v1/by-puuid/account/${puuid}`, {
      nullOn404: true,
    });
    if (!response?.data?.puuid) throw new NotFoundError(this.id, `PUUID ${puuid}`, "valorant");
    return response.data;
  }

  /** Competitive rank and RR. */
  public async getMmr(region: string, puuid: string): Promise<HenrikMmr> {
    return this.cached(
      ["mmr", region, puuid],
      "getRank",
      "valorant",
      TTL.rank ?? 60,
      async () => {
        const response = await this.get<{ data?: HenrikMmr }>(
          `/v2/by-puuid/mmr/${region}/${puuid}`,
          { nullOn404: true },
        );
        return response?.data ?? {};
      },
    );
  }

  /** RR changes match by match - the "why did I lose 20 RR" endpoint. */
  public async getMmrHistory(region: string, puuid: string): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ data?: Record<string, unknown>[] }>(
      `/v1/by-puuid/mmr-history/${region}/${puuid}`,
      { nullOn404: true },
    );
    return response?.data ?? [];
  }

  /** Recent matches with the full scoreboard attached. */
  public async getMatches(
    region: string,
    puuid: string,
    options: { size?: number; mode?: string; map?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["matches", region, puuid, options.size ?? 10, options.mode ?? "-"],
      "getMatchHistory",
      "valorant",
      TTL.matchHistory ?? 60,
      async () => {
        const response = await this.get<{ data?: Record<string, unknown>[] }>(
          `/v3/by-puuid/matches/${region}/${puuid}`,
          {
            query: {
              // The upstream caps this at 10 and errors above it rather than
              // clamping, so it is clamped here.
              size: Math.min(options.size ?? 10, 10),
              mode: options.mode,
              map: options.map,
            },
            nullOn404: true,
          },
        );
        return response?.data ?? [];
      },
    );
  }

  /** One match by id. */
  public async getMatch(matchId: string): Promise<Record<string, unknown>> {
    return this.cached(["match", matchId], "getMatch", "valorant", TTL.match ?? 86_400, async () => {
      const response = await this.get<{ data?: Record<string, unknown> }>(
        `/v2/match/${matchId}`,
        { nullOn404: true },
      );
      if (!response?.data) {
        throw new NotFoundError(this.id, `VALORANT match ${matchId}`, "valorant");
      }
      return response.data;
    });
  }

  /** The act leaderboard for a region. */
  public async getLeaderboard(
    region: string,
    options: { size?: number; startIndex?: number; season?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["leaderboard", region, options.season ?? "current", options.size ?? 100],
      "getLeaderboard",
      "valorant",
      TTL.leaderboard ?? 300,
      async () => {
        const response = await this.get<{ data?: { players?: Record<string, unknown>[] } }>(
          `/v3/leaderboard/${region}/pc`,
          {
            query: {
              size: Math.min(options.size ?? 100, 1_000),
              start: options.startIndex ?? 0,
              season: options.season,
            },
            nullOn404: true,
          },
        );
        return response?.data?.players ?? [];
      },
    );
  }

  /** Agents, maps and weapons. */
  public async getContent(): Promise<Record<string, unknown> | null> {
    return this.cached(["content"], "getMetadata", "valorant", TTL.metadata ?? 3_600, () =>
      this.get<Record<string, unknown> | null>("/v1/content", {
        query: { locale: "en-US" },
        nullOn404: true,
      }),
    );
  }

  /** Store and esports schedule endpoints share the same envelope shape. */
  public async getEsportsSchedule(
    region?: string,
    league?: string,
  ): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ data?: Record<string, unknown>[] }>("/v1/esports/schedule", {
      query: { region, league },
      nullOn404: true,
    });
    return response?.data ?? [];
  }
}
