/**
 * FACEIT Data API.
 *
 * The competitive layer that several titles have and their publishers do not
 * expose. For CS2 this is not a supplement - Valve publishes no matchmaking
 * rank at all, so "what rank is this player" and "FACEIT level" are the same
 * question in practice.
 *
 * One schema covers CS2, Dota 2, VALORANT, League of Legends, Rocket League and
 * Apex Legends; only the `game` parameter changes.
 */

import { ProviderClient } from "./base.js";
import { NotFoundError } from "../errors.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

/** This package's title ids mapped onto FACEIT's game ids. */
export const FACEIT_GAME_IDS: Readonly<Record<string, string>> = {
  cs2: "cs2",
  dota2: "dota2",
  valorant: "valorant",
  "league-of-legends": "lol_EUW",
  "rocket-league": "rocket_league",
  "apex-legends": "apex",
};

export interface FaceitPlayer {
  player_id: string;
  nickname: string;
  avatar?: string;
  country?: string;
  cover_image?: string;
  faceit_url?: string;
  memberships?: string[];
  steam_id_64?: string;
  steam_nickname?: string;
  games?: Record<
    string,
    {
      game_player_id?: string;
      game_player_name?: string;
      skill_level?: number;
      skill_level_label?: string;
      faceit_elo?: number;
      region?: string;
    }
  >;
}

export interface FaceitMatchHistoryEntry {
  match_id: string;
  game_id: string;
  region?: string;
  competition_name?: string;
  competition_type?: string;
  started_at?: number;
  finished_at?: number;
  results?: { winner?: string; score?: Record<string, number> };
  teams?: Record<
    string,
    { team_id?: string; nickname?: string; players?: { player_id: string; nickname: string }[] }
  >;
  playing_players?: string[];
}

export class FaceitProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("faceit", runtime);
  }

  /** Translate a title id into the game parameter FACEIT expects. */
  public gameId(titleId: string): string {
    return FACEIT_GAME_IDS[titleId] ?? titleId;
  }

  /** Look a player up by FACEIT nickname. */
  public async getPlayerByNickname(nickname: string, titleId: string): Promise<FaceitPlayer> {
    return this.cached(
      ["nickname", nickname.toLowerCase()],
      "resolvePlayer",
      titleId,
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const player = await this.get<FaceitPlayer | null>("/players", {
          query: { nickname },
          nullOn404: true,
        });
        if (!player?.player_id) {
          throw new NotFoundError(this.id, `FACEIT player "${nickname}"`, titleId);
        }
        return player;
      },
    );
  }

  /**
   * Look a player up by their in-game id.
   *
   * For CS2 that is the SteamID64, which is what makes FACEIT usable as a
   * second provider for a player already resolved through Steam.
   */
  public async getPlayerByGameId(
    gamePlayerId: string,
    titleId: string,
  ): Promise<FaceitPlayer> {
    const game = this.gameId(titleId);
    return this.cached(
      ["game-id", game, gamePlayerId],
      "resolvePlayer",
      titleId,
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const player = await this.get<FaceitPlayer | null>("/players", {
          query: { game, game_player_id: gamePlayerId },
          nullOn404: true,
        });
        if (!player?.player_id) {
          throw new NotFoundError(this.id, `FACEIT player for ${gamePlayerId}`, titleId);
        }
        return player;
      },
    );
  }

  /** The player record for a known FACEIT id. */
  public async getPlayer(playerId: string, titleId: string): Promise<FaceitPlayer> {
    return this.cached([playerId], "getPlayer", titleId, TTL.player ?? 300, async () => {
      const player = await this.get<FaceitPlayer | null>(`/players/${playerId}`, {
        nullOn404: true,
      });
      if (!player) throw new NotFoundError(this.id, `FACEIT player ${playerId}`, titleId);
      return player;
    });
  }

  /** Lifetime and per-map statistics for one game. */
  public async getPlayerStats(
    playerId: string,
    titleId: string,
  ): Promise<{
    lifetime?: Record<string, string>;
    segments?: { label?: string; mode?: string; stats?: Record<string, string> }[];
  }> {
    const game = this.gameId(titleId);
    return this.cached(
      [playerId, "stats", game],
      "getPlayerStats",
      titleId,
      TTL.playerStats ?? 180,
      async () => {
        const stats = await this.get<{
          lifetime?: Record<string, string>;
          segments?: { label?: string; mode?: string; stats?: Record<string, string> }[];
        } | null>(`/players/${playerId}/stats/${game}`, { nullOn404: true });
        return stats ?? {};
      },
    );
  }

  /** Match history, newest first. */
  public async getMatchHistory(
    playerId: string,
    titleId: string,
    options: { limit?: number; offset?: number; from?: number; to?: number } = {},
  ): Promise<FaceitMatchHistoryEntry[]> {
    const game = this.gameId(titleId);
    return this.cached(
      [playerId, "history", game, options.limit ?? 20, options.offset ?? 0],
      "getMatchHistory",
      titleId,
      TTL.matchHistory ?? 60,
      async () => {
        const response = await this.get<{ items?: FaceitMatchHistoryEntry[] }>(
          `/players/${playerId}/history`,
          {
            query: {
              game,
              limit: Math.min(options.limit ?? 20, 100),
              offset: options.offset ?? 0,
              // FACEIT takes seconds here, unlike the milliseconds it returns.
              from: options.from ? Math.floor(options.from / 1_000) : undefined,
              to: options.to ? Math.floor(options.to / 1_000) : undefined,
            },
            nullOn404: true,
          },
        );
        return response?.items ?? [];
      },
    );
  }

  /** One match: rosters, maps and the result. */
  public async getMatch(matchId: string, titleId: string): Promise<Record<string, unknown>> {
    return this.cached([matchId, "match"], "getMatch", titleId, TTL.match ?? 86_400, async () => {
      const match = await this.get<Record<string, unknown> | null>(`/matches/${matchId}`, {
        nullOn404: true,
      });
      if (!match) throw new NotFoundError(this.id, `FACEIT match ${matchId}`, titleId);
      return match;
    });
  }

  /** Per-round scoreboard for a finished match. */
  public async getMatchStats(matchId: string, titleId: string): Promise<Record<string, unknown>[]> {
    return this.cached(
      [matchId, "match-stats"],
      "getMatch",
      titleId,
      TTL.match ?? 86_400,
      async () => {
        const response = await this.get<{ rounds?: Record<string, unknown>[] }>(
          `/matches/${matchId}/stats`,
          { nullOn404: true },
        );
        return response?.rounds ?? [];
      },
    );
  }

  /** The regional Elo ladder. */
  public async getRankings(
    titleId: string,
    region: string,
    options: { country?: string; limit?: number; offset?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const game = this.gameId(titleId);
    return this.cached(
      ["rankings", game, region, options.country ?? "-", options.limit ?? 50],
      "getLeaderboard",
      titleId,
      TTL.leaderboard ?? 300,
      async () => {
        const response = await this.get<{ items?: Record<string, unknown>[] }>(
          `/rankings/games/${game}/regions/${region}`,
          {
            query: {
              country: options.country,
              limit: Math.min(options.limit ?? 50, 100),
              offset: options.offset ?? 0,
            },
            nullOn404: true,
          },
        );
        return response?.items ?? [];
      },
    );
  }

  /** Where a player sits on their regional ladder. */
  public async getPlayerRanking(
    playerId: string,
    titleId: string,
    region: string,
  ): Promise<{ position?: number; items?: Record<string, unknown>[] } | null> {
    const game = this.gameId(titleId);
    return this.get<{ position?: number; items?: Record<string, unknown>[] } | null>(
      `/rankings/games/${game}/regions/${region}/players/${playerId}`,
      { nullOn404: true },
    );
  }

  /** Championships - FACEIT's own tournament layer. */
  public async getChampionships(
    titleId: string,
    options: { type?: "ongoing" | "upcoming" | "past"; limit?: number; offset?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const game = this.gameId(titleId);
    const response = await this.get<{ items?: Record<string, unknown>[] }>("/championships", {
      query: {
        game,
        type: options.type ?? "ongoing",
        limit: Math.min(options.limit ?? 20, 100),
        offset: options.offset ?? 0,
      },
      nullOn404: true,
    });
    return response?.items ?? [];
  }
}
