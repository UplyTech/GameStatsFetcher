/**
 * Steam Web API.
 *
 * Serves CS2, Dota 2, Team Fortress 2, Rust, War Thunder, Naraka and Dead by
 * Daylight in this package - every Steam title whose stats are exposed through
 * `ISteamUserStats`.
 *
 * Two things about this API shape everything below:
 *
 * 1. **A private profile is not an error.** `GetUserStatsForGame` answers 500
 *    or an empty object rather than 403, so private profiles have to be
 *    detected from `communityvisibilitystate` on the summary and turned into a
 *    {@link PrivateProfileError} by hand.
 * 2. **Stats are a flat name/value list.** Valve ships no schema for what the
 *    names mean, so the per-title clients map the ones they care about and the
 *    rest survive in `raw`.
 */

import { ProviderClient } from "./base.js";
import { NotFoundError, PrivateProfileError } from "../errors.js";
import { toSteamId64 } from "../identity.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

export interface SteamPlayerSummary {
  steamid: string;
  personaname: string;
  profileurl: string;
  avatar: string;
  avatarmedium: string;
  avatarfull: string;
  personastate: number;
  /** 3 means public. Anything else means the stats endpoints will be empty. */
  communityvisibilitystate: number;
  profilestate?: number;
  lastlogoff?: number;
  timecreated?: number;
  loccountrycode?: string;
  gameid?: string;
  gameextrainfo?: string;
  primaryclanid?: string;
}

export interface SteamStatValue {
  name: string;
  value: number;
}

export interface SteamAchievement {
  apiname: string;
  achieved: 0 | 1;
  unlocktime?: number;
  name?: string;
  description?: string;
}

export interface SteamUserStats {
  steamID: string;
  gameName: string;
  stats?: SteamStatValue[];
  achievements?: SteamAchievement[];
}

export interface SteamOwnedGame {
  appid: number;
  name?: string;
  playtime_forever: number;
  playtime_2weeks?: number;
  img_icon_url?: string;
  has_community_visible_stats?: boolean;
}

export class SteamProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("steam", runtime);
  }

  protected override authQueryName(): string {
    return "key";
  }

  /** Profile summaries for up to 100 ids in one call. */
  public async getPlayerSummaries(steamIds: readonly string[]): Promise<SteamPlayerSummary[]> {
    if (steamIds.length === 0) return [];
    const ids = steamIds.map((id) => toSteamId64(id));
    const response = await this.get<{ response?: { players?: SteamPlayerSummary[] } }>(
      "/ISteamUser/GetPlayerSummaries/v2/",
      { query: { steamids: ids.join(",") } },
    );
    return response?.response?.players ?? [];
  }

  /** One profile summary, or a {@link NotFoundError}. */
  public async getPlayerSummary(steamId: string, titleId: string): Promise<SteamPlayerSummary> {
    const id = toSteamId64(steamId);
    return this.cached([id, "summary"], "player", titleId, TTL.player ?? 300, async () => {
      const players = await this.getPlayerSummaries([id]);
      const player = players[0];
      if (!player) throw new NotFoundError(this.id, `Steam profile ${id}`, titleId);
      return player;
    });
  }

  /** True when the profile is set to public. */
  public isPublic(summary: SteamPlayerSummary): boolean {
    return summary.communityvisibilitystate === 3;
  }

  /**
   * Turn a vanity URL segment into a SteamID64.
   *
   * `steamcommunity.com/id/gaben` -> `76561197960287930`. A full URL is
   * accepted too, because that is what users paste.
   */
  public async resolveVanityUrl(vanity: string, titleId: string): Promise<string> {
    const segment = vanity.replace(/^.*steamcommunity\.com\/id\//, "").replace(/\/+$/, "");
    return this.cached(
      ["vanity", segment.toLowerCase()],
      "resolvePlayer",
      titleId,
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const response = await this.get<{
          response?: { success?: number; steamid?: string; message?: string };
        }>("/ISteamUser/ResolveVanityURL/v1/", { query: { vanityurl: segment } });
        const id = response?.response?.steamid;
        if (response?.response?.success !== 1 || !id) {
          throw new NotFoundError(this.id, `vanity URL "${segment}"`, titleId);
        }
        return id;
      },
    );
  }

  /**
   * Per-game stats and achievements.
   *
   * Throws {@link PrivateProfileError} when the profile is closed, which needs
   * the summary call first - Valve does not say so on this endpoint.
   */
  public async getUserStatsForGame(
    steamId: string,
    appId: number,
    titleId: string,
  ): Promise<SteamUserStats> {
    const id = toSteamId64(steamId);
    return this.cached(
      [id, "stats", appId],
      "getPlayerStats",
      titleId,
      TTL.playerStats ?? 180,
      async () => {
        const response = await this.get<{ playerstats?: SteamUserStats }>(
          "/ISteamUserStats/GetUserStatsForGame/v2/",
          { query: { appid: appId, steamid: id }, nullOn404: true },
        );
        const stats = response?.playerstats;
        if (!stats || (!stats.stats && !stats.achievements)) {
          const summary = await this.getPlayerSummary(id, titleId);
          if (!this.isPublic(summary)) throw new PrivateProfileError(this.id, id, titleId);
          throw new NotFoundError(this.id, `stats for ${id} in app ${appId}`, titleId);
        }
        return stats;
      },
    );
  }

  /** Stats as a name-keyed map, which is how every caller actually wants them. */
  public async getStatMap(
    steamId: string,
    appId: number,
    titleId: string,
  ): Promise<Record<string, number>> {
    const stats = await this.getUserStatsForGame(steamId, appId, titleId);
    const map: Record<string, number> = {};
    for (const entry of stats.stats ?? []) map[entry.name] = entry.value;
    return map;
  }

  /** Achievements for one app, with the display names from the game schema. */
  public async getPlayerAchievements(
    steamId: string,
    appId: number,
    titleId: string,
  ): Promise<SteamAchievement[]> {
    const id = toSteamId64(steamId);
    return this.cached(
      [id, "achievements", appId],
      "getPlayerStats",
      titleId,
      TTL.playerStats ?? 180,
      async () => {
        const response = await this.get<{
          playerstats?: { achievements?: SteamAchievement[]; success?: boolean };
        }>("/ISteamUserStats/GetPlayerAchievements/v1/", {
          query: { appid: appId, steamid: id, l: "english" },
          nullOn404: true,
        });
        return response?.playerstats?.achievements ?? [];
      },
    );
  }

  /** Owned games, with playtime. Requires a public game-details setting. */
  public async getOwnedGames(steamId: string, titleId: string): Promise<SteamOwnedGame[]> {
    const id = toSteamId64(steamId);
    return this.cached([id, "owned"], "getPlayer", titleId, 600, async () => {
      const response = await this.get<{ response?: { games?: SteamOwnedGame[] } }>(
        "/IPlayerService/GetOwnedGames/v1/",
        {
          query: {
            steamid: id,
            include_appinfo: true,
            include_played_free_games: true,
          },
        },
      );
      return response?.response?.games ?? [];
    });
  }

  /** Playtime over the last two weeks. */
  public async getRecentlyPlayedGames(
    steamId: string,
    titleId: string,
  ): Promise<SteamOwnedGame[]> {
    const id = toSteamId64(steamId);
    return this.cached([id, "recent"], "getPlayer", titleId, 300, async () => {
      const response = await this.get<{ response?: { games?: SteamOwnedGame[] } }>(
        "/IPlayerService/GetRecentlyPlayedGames/v1/",
        { query: { steamid: id } },
      );
      return response?.response?.games ?? [];
    });
  }

  /** Friends list. Empty when the friends list is private. */
  public async getFriendList(
    steamId: string,
    titleId: string,
  ): Promise<{ steamid: string; relationship: string; friend_since: number }[]> {
    const id = toSteamId64(steamId);
    return this.cached([id, "friends"], "getPlayer", titleId, 600, async () => {
      const response = await this.get<{
        friendslist?: { friends?: { steamid: string; relationship: string; friend_since: number }[] };
      }>("/ISteamUser/GetFriendList/v1/", {
        query: { steamid: id, relationship: "friend" },
        nullOn404: true,
      });
      return response?.friendslist?.friends ?? [];
    });
  }

  /** Total and current player counts for an app. */
  public async getCurrentPlayerCount(appId: number): Promise<number | null> {
    const response = await this.get<{ response?: { player_count?: number } }>(
      "/ISteamUserStats/GetNumberOfCurrentPlayers/v1/",
      { query: { appid: appId } },
    );
    return response?.response?.player_count ?? null;
  }

  /**
   * The Dota 2 match history endpoint.
   *
   * Valve's own match API is thin next to OpenDota, but it is authoritative and
   * it is available without a third party, so it stays as the fallback.
   */
  public async getDotaMatchHistory(
    accountId: string,
    options: { limit?: number; heroId?: number; startAtMatchId?: string } = {},
  ): Promise<{ match_id: number; start_time: number; lobby_type: number }[]> {
    const response = await this.get<{
      result?: { matches?: { match_id: number; start_time: number; lobby_type: number }[] };
    }>("/IDOTA2Match_570/GetMatchHistory/v1/", {
      query: {
        account_id: accountId,
        matches_requested: options.limit ?? 20,
        hero_id: options.heroId,
        start_at_match_id: options.startAtMatchId,
      },
    });
    return response?.result?.matches ?? [];
  }

  /** Full Dota 2 match detail from Valve. */
  public async getDotaMatchDetails(matchId: string): Promise<Record<string, unknown> | null> {
    const response = await this.get<{ result?: Record<string, unknown> }>(
      "/IDOTA2Match_570/GetMatchDetails/v1/",
      { query: { match_id: matchId } },
    );
    return response?.result ?? null;
  }

  /** The Dota 2 hero list, for turning hero ids into names. */
  public async getDotaHeroes(): Promise<{ id: number; name: string; localized_name: string }[]> {
    return this.cached(["dota", "heroes"], "getMetadata", "dota2", TTL.metadata ?? 3_600, async () => {
      const response = await this.get<{
        result?: { heroes?: { id: number; name: string; localized_name: string }[] };
      }>("/IEconDOTA2_570/GetHeroes/v1/", { query: { language: "en_us" } });
      return response?.result?.heroes ?? [];
    });
  }
}
