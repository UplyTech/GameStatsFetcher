/**
 * Dota 2's two community APIs: OpenDota and STRATZ.
 *
 * Valve's own match API exists and is in `SteamProvider`, but it is thin: no
 * per-minute economy, no lane assignment, no aggregate hero performance. Both
 * providers here re-parse replays and expose what the game actually recorded,
 * and both are the reason Dota 2 has richer data in this package than titles
 * whose publishers are more generous.
 *
 * OpenDota is first because it works with no key at all. STRATZ needs a token
 * and speaks GraphQL, but answers questions OpenDota cannot - notably the
 * imp/rating fields and the guide data.
 */

import { ProviderClient } from "./base.js";
import type { RequestSpec } from "../http.js";
import { NotFoundError } from "../errors.js";
import { toSteamAccountId } from "../identity.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

export interface OpenDotaPlayer {
  profile?: {
    account_id: number;
    personaname?: string;
    name?: string | null;
    avatarfull?: string;
    profileurl?: string;
    last_login?: string | null;
    loccountrycode?: string | null;
    is_contributor?: boolean;
    plus?: boolean;
  };
  rank_tier?: number | null;
  leaderboard_rank?: number | null;
  mmr_estimate?: { estimate?: number | null };
  competitive_rank?: number | null;
}

export interface OpenDotaWinLoss {
  win: number;
  lose: number;
}

export interface OpenDotaMatch {
  match_id: number;
  player_slot: number;
  radiant_win: boolean;
  duration: number;
  game_mode: number;
  lobby_type: number;
  hero_id: number;
  start_time: number;
  version?: number | null;
  kills: number;
  deaths: number;
  assists: number;
  average_rank?: number | null;
  xp_per_min?: number;
  gold_per_min?: number;
  hero_damage?: number;
  tower_damage?: number;
  hero_healing?: number;
  last_hits?: number;
  party_size?: number | null;
}

/**
 * Dota 2 rank tiers are a two-digit code: tens are the medal, units the star.
 * `55` is Legend 5, `80` is Immortal.
 */
const MEDALS = [
  "Uncalibrated",
  "Herald",
  "Guardian",
  "Crusader",
  "Archon",
  "Legend",
  "Ancient",
  "Divine",
  "Immortal",
] as const;

/** Turn a `rank_tier` into the label a player would recognise. */
export function dotaRankName(rankTier: number | null | undefined): string | null {
  if (rankTier === null || rankTier === undefined) return null;
  const medal = MEDALS[Math.floor(rankTier / 10)];
  if (!medal) return null;
  const star = rankTier % 10;
  if (medal === "Immortal" || medal === "Uncalibrated" || star === 0) return medal;
  return `${medal} ${star}`;
}

export class OpenDotaProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("opendota", runtime);
  }

  protected override authQueryName(): string {
    return "api_key";
  }

  /**
   * OpenDota works without a key, so the generic authoriser - which would throw
   * for a missing one - is replaced by an opportunistic version.
   */
  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    const key = this.runtime.apiKeys.opendota;
    if (!key) return spec;
    return { ...spec, query: { api_key: key, ...spec.query } };
  }

  /** Player profile and rank. Keyed on the 32-bit account id. */
  public async getPlayer(steamIdOrAccountId: string): Promise<OpenDotaPlayer> {
    const accountId = toSteamAccountId(steamIdOrAccountId);
    return this.cached([accountId], "getPlayer", "dota2", TTL.player ?? 300, async () => {
      const player = await this.get<OpenDotaPlayer | null>(`/players/${accountId}`, {
        nullOn404: true,
      });
      // OpenDota answers 200 with `{}` for an account it has never seen.
      if (!player?.profile) {
        throw new NotFoundError(this.id, `Dota 2 account ${accountId}`, "dota2");
      }
      return player;
    });
  }

  /** Career wins and losses. */
  public async getWinLoss(
    steamIdOrAccountId: string,
    options: { limit?: number; lobbyType?: number } = {},
  ): Promise<OpenDotaWinLoss> {
    const accountId = toSteamAccountId(steamIdOrAccountId);
    return this.cached(
      [accountId, "wl", options.limit ?? 0, options.lobbyType ?? -1],
      "getPlayerStats",
      "dota2",
      TTL.playerStats ?? 180,
      async () => {
        const result = await this.get<OpenDotaWinLoss | null>(`/players/${accountId}/wl`, {
          query: { limit: options.limit, lobby_type: options.lobbyType },
          nullOn404: true,
        });
        return result ?? { win: 0, lose: 0 };
      },
    );
  }

  /** Recent matches, newest first. */
  public async getMatches(
    steamIdOrAccountId: string,
    options: { limit?: number; offset?: number; heroId?: number; date?: number } = {},
  ): Promise<OpenDotaMatch[]> {
    const accountId = toSteamAccountId(steamIdOrAccountId);
    return this.cached(
      [accountId, "matches", options.limit ?? 20, options.offset ?? 0, options.heroId ?? 0],
      "getMatchHistory",
      "dota2",
      TTL.matchHistory ?? 60,
      async () => {
        const matches = await this.get<OpenDotaMatch[] | null>(`/players/${accountId}/matches`, {
          query: {
            limit: options.limit ?? 20,
            offset: options.offset ?? 0,
            hero_id: options.heroId,
            // OpenDota's `date` is "how many days back", not a timestamp.
            date: options.date,
          },
          nullOn404: true,
        });
        return matches ?? [];
      },
    );
  }

  /** Per-hero career performance. */
  public async getHeroPerformance(steamIdOrAccountId: string): Promise<
    { hero_id: number; games: number; win: number; with_games?: number; against_games?: number }[]
  > {
    const accountId = toSteamAccountId(steamIdOrAccountId);
    const heroes = await this.get<
      { hero_id: number; games: number; win: number }[] | null
    >(`/players/${accountId}/heroes`, { nullOn404: true });
    return heroes ?? [];
  }

  /** Career totals: last hits, GPM, damage and the rest. */
  public async getTotals(
    steamIdOrAccountId: string,
  ): Promise<{ field: string; n: number; sum: number }[]> {
    const accountId = toSteamAccountId(steamIdOrAccountId);
    const totals = await this.get<{ field: string; n: number; sum: number }[] | null>(
      `/players/${accountId}/totals`,
      { nullOn404: true },
    );
    return totals ?? [];
  }

  /** Full match detail, including the per-player breakdown. */
  public async getMatch(matchId: string): Promise<Record<string, unknown>> {
    return this.cached(["match", matchId], "getMatch", "dota2", TTL.match ?? 86_400, async () => {
      const match = await this.get<Record<string, unknown> | null>(`/matches/${matchId}`, {
        nullOn404: true,
      });
      if (!match) throw new NotFoundError(this.id, `Dota 2 match ${matchId}`, "dota2");
      return match;
    });
  }

  /** The professional match feed. */
  public async getProMatches(lessThanMatchId?: string): Promise<Record<string, unknown>[]> {
    const matches = await this.get<Record<string, unknown>[] | null>("/proMatches", {
      query: { less_than_match_id: lessThanMatchId },
      nullOn404: true,
    });
    return matches ?? [];
  }

  /** Professional players, with their team affiliation. */
  public async getProPlayers(): Promise<Record<string, unknown>[]> {
    return this.cached(["proPlayers"], "getEsportsPlayers", "dota2", TTL.esportsPlayers ?? 3_600, async () => {
      const players = await this.get<Record<string, unknown>[] | null>("/proPlayers", {
        nullOn404: true,
      });
      return players ?? [];
    });
  }

  /** Professional teams, ranked by rating. */
  public async getTeams(): Promise<Record<string, unknown>[]> {
    return this.cached(["teams"], "getEsportsTeams", "dota2", TTL.esportsTeams ?? 3_600, async () => {
      const teams = await this.get<Record<string, unknown>[] | null>("/teams", {
        nullOn404: true,
      });
      return teams ?? [];
    });
  }

  /** Hero metadata, for turning hero ids into names. */
  public async getHeroes(): Promise<
    { id: number; name: string; localized_name: string; primary_attr: string; attack_type: string }[]
  > {
    return this.cached(["heroes"], "getMetadata", "dota2", TTL.metadata ?? 3_600, async () => {
      const heroes = await this.get<
        { id: number; name: string; localized_name: string; primary_attr: string; attack_type: string }[]
      >("/heroes");
      return heroes ?? [];
    });
  }

  /** Public leaderboard for a region: `europe`, `americas`, `se_asia`, `china`. */
  public async getLeaderboard(
    region: string,
  ): Promise<{ leaderboard?: { name: string; rank: number; team_tag?: string }[] } | null> {
    return this.get<{ leaderboard?: { name: string; rank: number; team_tag?: string }[] } | null>(
      "/leaderboard",
      { query: { region }, nullOn404: true },
    );
  }

  /**
   * Ask OpenDota to parse a match's replay.
   *
   * Unparsed matches have no per-minute data at all. Parsing is queued and
   * takes minutes, so this returns the job rather than the result.
   */
  public async requestParse(matchId: string): Promise<Record<string, unknown> | null> {
    return this.post<Record<string, unknown> | null>(`/request/${matchId}`, {});
  }
}

/**
 * STRATZ.
 *
 * GraphQL, and generous about what it exposes - but the free tier requires the
 * `STRATZ_API` User-Agent, and quietly returns nothing without it. That header
 * is set here rather than left to the caller.
 */
export class StratzProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("stratz", runtime);
  }

  /** Run a query against STRATZ, with the required User-Agent attached. */
  public async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await this.request<{ data?: T; errors?: { message?: string }[] }>("", {
      method: "POST",
      headers: { "User-Agent": "STRATZ_API" },
      json: { query, variables },
    });
    if (response?.errors?.length) {
      const { ParseError } = await import("../errors.js");
      throw new ParseError(
        this.id,
        response.errors.map((e) => e.message ?? "unknown").join("; "),
      );
    }
    if (!response?.data) {
      const { ParseError } = await import("../errors.js");
      throw new ParseError(this.id, "query returned no data");
    }
    return response.data;
  }

  /** Player summary, with the behaviour and imp figures OpenDota lacks. */
  public async getPlayer(steamIdOrAccountId: string): Promise<Record<string, unknown>> {
    const accountId = Number(toSteamAccountId(steamIdOrAccountId));
    return this.cached([accountId, "player"], "getPlayer", "dota2", TTL.player ?? 300, async () => {
      const data = await this.query<{ player?: Record<string, unknown> }>(
        `query Player($id: Long!) {
          player(steamAccountId: $id) {
            steamAccount { id name avatar profileUri seasonRank seasonLeaderboardRank isAnonymous }
            matchCount
            winCount
            behaviorScore
            firstMatchDate
            lastMatchDate
            imp
          }
        }`,
        { id: accountId },
      );
      if (!data.player) {
        throw new NotFoundError(this.id, `Dota 2 account ${accountId}`, "dota2");
      }
      return data.player;
    });
  }

  /** Recent matches with the fields STRATZ adds on top of the replay. */
  public async getMatches(
    steamIdOrAccountId: string,
    limit = 20,
  ): Promise<Record<string, unknown>[]> {
    const accountId = Number(toSteamAccountId(steamIdOrAccountId));
    const data = await this.query<{ player?: { matches?: Record<string, unknown>[] } }>(
      `query Matches($id: Long!, $take: Int!) {
        player(steamAccountId: $id) {
          matches(request: { take: $take }) {
            id
            didRadiantWin
            durationSeconds
            startDateTime
            lobbyType
            gameMode
            players(steamAccountId: $id) {
              heroId
              kills
              deaths
              assists
              networth
              goldPerMinute
              experiencePerMinute
              imp
              isVictory
            }
          }
        }
      }`,
      { id: accountId, take: limit },
    );
    return data.player?.matches ?? [];
  }

  /** Full match detail. */
  public async getMatch(matchId: string): Promise<Record<string, unknown>> {
    return this.cached(["match", matchId], "getMatch", "dota2", TTL.match ?? 86_400, async () => {
      const data = await this.query<{ match?: Record<string, unknown> }>(
        `query Match($id: Long!) {
          match(id: $id) {
            id
            didRadiantWin
            durationSeconds
            startDateTime
            gameMode
            lobbyType
            players {
              steamAccountId
              heroId
              isRadiant
              kills
              deaths
              assists
              networth
              goldPerMinute
              experiencePerMinute
              heroDamage
              towerDamage
              imp
              role
              lane
            }
          }
        }`,
        { id: Number(matchId) },
      );
      if (!data.match) throw new NotFoundError(this.id, `Dota 2 match ${matchId}`, "dota2");
      return data.match;
    });
  }
}
