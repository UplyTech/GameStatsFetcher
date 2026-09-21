/**
 * Hi-Rez Studios API - SMITE and Paladins.
 *
 * The oldest-feeling API in this package, and the only one that needs real work
 * before a request can be made:
 *
 * 1. Every call carries an **MD5 signature** of
 *    `devId + methodName + authKey + utcTimestamp`.
 * 2. Every call needs an **open session**, obtained from `createsession` - and
 *    sessions expire after 15 minutes of inactivity.
 * 3. Parameters go in the **path**, not the query string, in a fixed order.
 *
 * MD5 here is Hi-Rez's protocol, not a security choice of this package: the
 * signature identifies the caller to their API and nothing is protected by it.
 *
 * Sessions are memoised for 12 minutes - short of the 15-minute expiry, so a
 * request never goes out with a session that lapsed while it was queued.
 */

import { createHash } from "node:crypto";
import { ProviderClient } from "./base.js";
import type { RequestSpec } from "../http.js";
import { AuthenticationError, NotFoundError } from "../errors.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

/** The two games, and the host each is served from. */
const GAME_HOSTS = {
  smite: "https://api.smitegame.com/smiteapi.svc",
  paladins: "https://api.paladins.com/paladinsapi.svc",
} as const;

export type HiRezGame = keyof typeof GAME_HOSTS;

export interface HiRezPlayer {
  Id: number;
  Name: string;
  hz_player_name?: string;
  hz_gamer_tag?: string;
  Level: number;
  Wins: number;
  Losses: number;
  Leaves?: number;
  Created_Datetime?: string;
  Last_Login_Datetime?: string;
  Total_Achievements?: number;
  Total_Worshippers?: number;
  Personal_Status_Message?: string;
  Region?: string;
  Team_Name?: string;
  Rank_Stat_Conquest?: number;
  RankedConquest?: HiRezRankedStats;
  RankedJoust?: HiRezRankedStats;
  RankedDuel?: HiRezRankedStats;
  RankedKBM?: HiRezRankedStats;
}

export interface HiRezRankedStats {
  Leaves: number;
  Losses: number;
  Name: string;
  Points: number;
  PrevRank: number;
  Rank: number;
  Season: number;
  Tier: number;
  Trend: number;
  Wins: number;
}

export class HiRezProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("hirez", runtime);
  }

  /**
   * Hi-Rez signs the URL itself, so the generic authoriser has nothing to add.
   *
   * Overridden rather than left to throw, because `authorize` is called for
   * every request and the signing happens in {@link call} where the method name
   * is known.
   */
  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  /** `yyyyMMddHHmmss` in UTC, which is the only timestamp format accepted. */
  private timestamp(): string {
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, "0");
    return [
      now.getUTCFullYear(),
      pad(now.getUTCMonth() + 1),
      pad(now.getUTCDate()),
      pad(now.getUTCHours()),
      pad(now.getUTCMinutes()),
      pad(now.getUTCSeconds()),
    ].join("");
  }

  private signature(devId: string, method: string, authKey: string, timestamp: string): string {
    return createHash("md5").update(`${devId}${method}${authKey}${timestamp}`).digest("hex");
  }

  /** Open a session, or reuse the one from the last twelve minutes. */
  private async session(game: HiRezGame): Promise<string> {
    const [devId, authKey] = this.requireKeyParts(2, "devId:authKey");
    return this.memo(`session:${game}`, 12 * 60 * 1_000, async () => {
      const timestamp = this.timestamp();
      const signature = this.signature(devId as string, "createsession", authKey as string, timestamp);
      const url = `${GAME_HOSTS[game]}/createsessionJson/${devId}/${signature}/${timestamp}`;
      const response = await this.runtime.http.send<{
        ret_msg?: string;
        session_id?: string;
      }>(this.id, url, { method: "GET" });
      if (!response?.session_id) {
        throw new AuthenticationError(
          this.id,
          `createsession failed: ${response?.ret_msg ?? "no session_id returned"}`,
        );
      }
      return response.session_id;
    });
  }

  /**
   * Call one method.
   *
   * The path is `/{method}Json/{devId}/{signature}/{session}/{timestamp}/{...params}`
   * and the parameter order is fixed per method, which is why callers pass an
   * ordered array rather than an object.
   */
  private async call<T>(
    game: HiRezGame,
    method: string,
    params: readonly (string | number)[] = [],
  ): Promise<T> {
    const [devId, authKey] = this.requireKeyParts(2, "devId:authKey");
    const session = await this.session(game);
    const timestamp = this.timestamp();
    const signature = this.signature(devId as string, method, authKey as string, timestamp);
    const suffix = params.length > 0 ? `/${params.map(String).map(encodeURIComponent).join("/")}` : "";
    const url = `${GAME_HOSTS[game]}/${method}Json/${devId}/${signature}/${session}/${timestamp}${suffix}`;
    return this.runtime.http.send<T>(this.id, url, { method: "GET" });
  }

  /** Whether the API is up, and how many calls today's key has left. */
  public async getDataUsed(game: HiRezGame): Promise<Record<string, unknown>[]> {
    return this.call<Record<string, unknown>[]>(game, "getdataused");
  }

  /** Player by in-game name or by player id. */
  public async getPlayer(game: HiRezGame, player: string): Promise<HiRezPlayer> {
    const titleId = game === "smite" ? "smite" : "paladins";
    return this.cached(
      [game, "player", player.toLowerCase()],
      "getPlayer",
      titleId,
      TTL.player ?? 300,
      async () => {
        const rows = await this.call<HiRezPlayer[]>(game, "getplayer", [player]);
        const found = rows?.[0];
        if (!found) throw new NotFoundError(this.id, `player "${player}"`, titleId);
        return found;
      },
    );
  }

  /**
   * Resolve a name to player ids across platforms.
   *
   * A console player and a PC player can share a name, so this returns every
   * match and the caller picks - guessing would silently show the wrong person.
   */
  public async getPlayerIdByName(
    game: HiRezGame,
    name: string,
  ): Promise<{ player_id: string; portal_id: string; Name: string }[]> {
    const rows = await this.call<{ player_id: string; portal_id: string; Name: string }[]>(
      game,
      "getplayeridbyname",
      [name],
    );
    return rows ?? [];
  }

  /** Recent matches. Hi-Rez returns roughly the last 50. */
  public async getMatchHistory(
    game: HiRezGame,
    playerId: string,
  ): Promise<Record<string, unknown>[]> {
    const titleId = game === "smite" ? "smite" : "paladins";
    return this.cached(
      [game, "history", playerId],
      "getMatchHistory",
      titleId,
      TTL.matchHistory ?? 60,
      async () => {
        const rows = await this.call<Record<string, unknown>[]>(game, "getmatchhistory", [playerId]);
        return rows ?? [];
      },
    );
  }

  /** Full detail for one match. */
  public async getMatchDetails(
    game: HiRezGame,
    matchId: string,
  ): Promise<Record<string, unknown>[]> {
    const titleId = game === "smite" ? "smite" : "paladins";
    return this.cached(
      [game, "match", matchId],
      "getMatch",
      titleId,
      TTL.match ?? 86_400,
      async () => {
        const rows = await this.call<Record<string, unknown>[]>(game, "getmatchdetails", [matchId]);
        if (!rows || rows.length === 0) {
          throw new NotFoundError(this.id, `match ${matchId}`, titleId);
        }
        return rows;
      },
    );
  }

  /** Per-god or per-champion career statistics. */
  public async getPlayerCharacterRanks(
    game: HiRezGame,
    playerId: string,
  ): Promise<Record<string, unknown>[]> {
    const method = game === "smite" ? "getgodranks" : "getchampionranks";
    const rows = await this.call<Record<string, unknown>[]>(game, method, [playerId]);
    return rows ?? [];
  }

  /** The god or champion list, for turning ids into names. */
  public async getCharacters(game: HiRezGame): Promise<Record<string, unknown>[]> {
    const titleId = game === "smite" ? "smite" : "paladins";
    const method = game === "smite" ? "getgods" : "getchampions";
    return this.cached([game, "characters"], "getMetadata", titleId, TTL.metadata ?? 3_600, async () => {
      const rows = await this.call<Record<string, unknown>[]>(game, method, [1]);
      return rows ?? [];
    });
  }

  /** The ranked leaderboard for a queue and tier. */
  public async getLeagueLeaderboard(
    game: HiRezGame,
    queueId: number,
    tier: number,
    season: number,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.call<Record<string, unknown>[]>(game, "getleagueleaderboard", [
      queueId,
      tier,
      season,
    ]);
    return rows ?? [];
  }

  /** Matches currently being played in a queue - the esports spectator feed. */
  public async getMatchIdsByQueue(
    game: HiRezGame,
    queueId: number,
    date: string,
    hour: string,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.call<Record<string, unknown>[]>(game, "getmatchidsbyqueue", [
      queueId,
      date,
      hour,
    ]);
    return rows ?? [];
  }
}
