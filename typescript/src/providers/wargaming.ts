/**
 * Wargaming.net Public API - World of Tanks and World of Warships.
 *
 * One application id, but the host encodes both the game and the region:
 * `api.worldoftanks.eu` and `api.worldofwarships.asia` are the same API with
 * different data behind them. Nothing in the response says which host answered,
 * so the region has to be carried through every call rather than inferred.
 *
 * The other quirk: **failure is a 200.** An unknown account comes back as
 * `{ status: "error", error: { message: "..." } }` with a successful HTTP
 * status, so the envelope has to be unwrapped by hand.
 */

import { ProviderClient } from "./base.js";
import { NotFoundError, ParseError, ValidationError } from "../errors.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

/** Region to top-level domain. `na` is `.com`, which is the one people miss. */
const REGION_TLD: Readonly<Record<string, string>> = {
  eu: "eu",
  na: "com",
  asia: "asia",
};

export type WargamingGame = "worldoftanks" | "worldofwarships";

interface WargamingEnvelope<T> {
  status?: "ok" | "error";
  error?: { field?: string; message?: string; code?: number; value?: string };
  meta?: { count?: number; total?: number };
  data?: T;
}

export interface WotAccountSummary {
  account_id: number;
  nickname: string;
  created_at?: number;
  last_battle_time?: number;
  global_rating?: number;
  clan_id?: number | null;
  statistics?: {
    all?: WotBattleStats;
    random?: WotBattleStats;
    clan?: WotBattleStats;
    company?: WotBattleStats;
  };
}

export interface WotBattleStats {
  battles: number;
  wins: number;
  losses: number;
  draws: number;
  damage_dealt: number;
  damage_received: number;
  frags: number;
  spotted: number;
  survived_battles: number;
  xp: number;
  hits?: number;
  shots?: number;
  max_frags?: number;
  max_xp?: number;
  capture_points?: number;
  dropped_capture_points?: number;
}

export class WargamingProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("wargaming", runtime);
  }

  protected override authQueryName(): string {
    return "application_id";
  }

  /** Build the host for a game and region. */
  public host(game: WargamingGame, region: string): string {
    const tld = REGION_TLD[region.toLowerCase()];
    if (!tld) {
      throw new ValidationError(
        `unknown Wargaming region "${region}". Expected one of: ${Object.keys(REGION_TLD).join(", ")}`,
      );
    }
    return `https://api.${game}.${tld}`;
  }

  /** The API path prefix, which is not the same as the host's game name. */
  private prefix(game: WargamingGame): string {
    return game === "worldoftanks" ? "/wot" : "/wows";
  }

  /** Unwrap the envelope, turning a 200-with-error into a real error. */
  private unwrap<T>(envelope: WargamingEnvelope<T> | null, what: string): T {
    if (!envelope) throw new NotFoundError(this.id, what);
    if (envelope.status === "error") {
      const message = envelope.error?.message ?? "unknown error";
      if (message.includes("NOT_FOUND") || message.includes("INVALID")) {
        throw new NotFoundError(this.id, `${what} (${message})`);
      }
      throw new ParseError(this.id, message);
    }
    if (envelope.data === undefined) throw new ParseError(this.id, "response had no data");
    return envelope.data;
  }

  private call<T>(
    game: WargamingGame,
    region: string,
    path: string,
    query: Record<string, string | number | undefined>,
  ): Promise<WargamingEnvelope<T>> {
    return this.get<WargamingEnvelope<T>>(
      `${this.host(game, region)}${this.prefix(game)}${path}`,
      { query },
    );
  }

  /** Search accounts by nickname. Prefix search, so it also powers autocomplete. */
  public async searchAccounts(
    game: WargamingGame,
    region: string,
    search: string,
    limit = 10,
  ): Promise<{ account_id: number; nickname: string }[]> {
    const titleId = game === "worldoftanks" ? "world-of-tanks" : "world-of-warships";
    return this.cached(
      [game, region, "search", search.toLowerCase(), limit],
      "resolvePlayer",
      titleId,
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const envelope = await this.call<{ account_id: number; nickname: string }[]>(
          game,
          region,
          "/account/list/",
          { search, limit },
        );
        return this.unwrap(envelope, `accounts matching "${search}"`);
      },
    );
  }

  /** The exact account for a nickname, or a {@link NotFoundError}. */
  public async findAccount(
    game: WargamingGame,
    region: string,
    nickname: string,
  ): Promise<{ account_id: number; nickname: string }> {
    const matches = await this.searchAccounts(game, region, nickname, 10);
    const exact = matches.find(
      (account) => account.nickname.toLowerCase() === nickname.toLowerCase(),
    );
    if (!exact) throw new NotFoundError(this.id, `account "${nickname}" on ${region}`);
    return exact;
  }

  /** Full account info including career statistics. */
  public async getAccountInfo(
    game: WargamingGame,
    region: string,
    accountId: string | number,
  ): Promise<WotAccountSummary> {
    const titleId = game === "worldoftanks" ? "world-of-tanks" : "world-of-warships";
    return this.cached(
      [game, region, "info", accountId],
      "getPlayerStats",
      titleId,
      TTL.playerStats ?? 180,
      async () => {
        const envelope = await this.call<Record<string, WotAccountSummary | null>>(
          game,
          region,
          "/account/info/",
          { account_id: accountId, extra: "statistics.random" },
        );
        const data = this.unwrap(envelope, `account ${accountId}`);
        const account = data[String(accountId)];
        // A hidden profile is `null` under its own id rather than an error.
        if (!account) throw new NotFoundError(this.id, `account ${accountId}`, titleId);
        return account;
      },
    );
  }

  /** Per-vehicle statistics. Large, so it is fetched only when asked for. */
  public async getVehicleStats(
    game: WargamingGame,
    region: string,
    accountId: string | number,
  ): Promise<Record<string, unknown>[]> {
    const envelope = await this.call<Record<string, Record<string, unknown>[] | null>>(
      game,
      region,
      game === "worldoftanks" ? "/tanks/stats/" : "/ships/stats/",
      { account_id: accountId },
    );
    const data = this.unwrap(envelope, `vehicle stats for ${accountId}`);
    return data[String(accountId)] ?? [];
  }

  /** Clan record. */
  public async getClanInfo(
    game: WargamingGame,
    region: string,
    clanId: string | number,
  ): Promise<Record<string, unknown> | null> {
    const envelope = await this.call<Record<string, Record<string, unknown> | null>>(
      game,
      region,
      "/clans/info/",
      { clan_id: clanId },
    );
    const data = this.unwrap(envelope, `clan ${clanId}`);
    return data[String(clanId)] ?? null;
  }

  /**
   * The vehicle encyclopaedia, for turning ids into names.
   *
   * Cached for an hour: it changes on a patch cycle and the payload is large.
   */
  public async getVehicleEncyclopedia(
    game: WargamingGame,
    region: string,
  ): Promise<Record<string, Record<string, unknown>>> {
    const titleId = game === "worldoftanks" ? "world-of-tanks" : "world-of-warships";
    return this.cached(
      [game, region, "encyclopedia"],
      "getMetadata",
      titleId,
      TTL.metadata ?? 3_600,
      async () => {
        const envelope = await this.call<Record<string, Record<string, unknown>>>(
          game,
          region,
          game === "worldoftanks" ? "/encyclopedia/vehicles/" : "/encyclopedia/ships/",
          { fields: "name,tier,type,nation" },
        );
        return this.unwrap(envelope, "vehicle encyclopedia");
      },
    );
  }
}
