/**
 * The persistent-world titles and the odds and ends.
 *
 * Minecraft (through Hypixel), Guild Wars 2, Path of Exile, Albion Online,
 * World of Warcraft's Mythic+ ladder and competitive Team Fortress 2. What they
 * have in common is that "a match" means something different in each - a
 * BedWars game, a PvP season, a race ladder, a GvG - so the title clients above
 * them do more mapping than usual.
 */

import { ProviderClient } from "./base.js";
import type { RequestSpec } from "../http.js";
import { NotFoundError } from "../errors.js";
import { dashUuid, toSteamId64, undashUuid } from "../identity.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

/**
 * Mojang account API.
 *
 * Used for exactly one thing: turning a Minecraft name into the UUID that
 * Hypixel is keyed on. Kept as its own provider so its rate limit is accounted
 * for separately - it is stricter than Hypixel's.
 */
export class MojangProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("mojang", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  /** Name to UUID, dashed. */
  public async getUuid(username: string): Promise<{ id: string; name: string }> {
    return this.cached(
      ["uuid", username.toLowerCase()],
      "resolvePlayer",
      "minecraft",
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const profile = await this.get<{ id?: string; name?: string } | null>(
          `/users/profiles/minecraft/${encodeURIComponent(username)}`,
          { nullOn404: true },
        );
        if (!profile?.id) {
          throw new NotFoundError(this.id, `Minecraft account "${username}"`, "minecraft");
        }
        return { id: dashUuid(profile.id), name: profile.name ?? username };
      },
    );
  }
}

/**
 * Hypixel API.
 *
 * The competitive Minecraft server: BedWars, SkyWars, Duels and the rest. Keyed
 * strictly on UUID, so a name lookup always costs a Mojang call first - which
 * is why the resolved UUID is cached for a day.
 */
export class HypixelProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("hypixel", runtime);
  }

  protected override authHeaderName(): string {
    return "API-Key";
  }

  /** The full player payload. Large - one object per game mode ever played. */
  public async getPlayer(uuid: string): Promise<Record<string, unknown>> {
    const id = undashUuid(uuid);
    return this.cached(["player", id], "getPlayer", "minecraft", TTL.player ?? 300, async () => {
      const response = await this.get<{ success?: boolean; player?: Record<string, unknown> }>(
        "/player",
        { query: { uuid: id }, nullOn404: true },
      );
      // Hypixel answers `{ success: true, player: null }` for an account that
      // has never joined the server, which is not the same as a bad UUID.
      if (!response?.player) {
        throw new NotFoundError(this.id, `Hypixel player ${uuid} (never joined?)`, "minecraft");
      }
      return response.player;
    });
  }

  /** Guild membership, which is the closest thing to a team here. */
  public async getGuild(uuid: string): Promise<Record<string, unknown> | null> {
    const response = await this.get<{ guild?: Record<string, unknown> | null }>("/guild", {
      query: { player: undashUuid(uuid) },
      nullOn404: true,
    });
    return response?.guild ?? null;
  }

  /** Recent games, which Hypixel keeps for about three days. */
  public async getRecentGames(uuid: string): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["recent", undashUuid(uuid)],
      "getMatchHistory",
      "minecraft",
      TTL.matchHistory ?? 60,
      async () => {
        const response = await this.get<{ games?: Record<string, unknown>[] }>("/recentgames", {
          query: { uuid: undashUuid(uuid) },
          nullOn404: true,
        });
        return response?.games ?? [];
      },
    );
  }

  /** Server-wide leaderboards, all games in one payload. */
  public async getLeaderboards(): Promise<Record<string, unknown>> {
    return this.cached(
      ["leaderboards"],
      "getLeaderboard",
      "minecraft",
      TTL.leaderboard ?? 300,
      async () => {
        const response = await this.get<{ leaderboards?: Record<string, unknown> }>(
          "/leaderboards",
          { nullOn404: true },
        );
        return response?.leaderboards ?? {};
      },
    );
  }
}

/**
 * Guild Wars 2 API.
 *
 * The public half of this API needs no key, but every endpoint *this* package
 * uses is account-scoped - `/account` and the `/pvp/*` family - and needs a
 * token carrying the `pvp` scope, which the player generates themselves.
 *
 * So the key is required here, and required loudly: sending the request
 * unauthenticated would spend a round trip to be told 401, and the caller would
 * see "unauthorised" rather than the name of the option they forgot to set.
 */
export class GuildWars2Provider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("guild-wars-2", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    const token = this.requireKey("guild-wars-2");
    return { ...spec, headers: { Authorization: `Bearer ${token}`, ...spec.headers } };
  }

  /** The account the token belongs to. */
  public async getAccount(): Promise<Record<string, unknown>> {
    const account = await this.get<Record<string, unknown> | null>("/account", {
      nullOn404: true,
    });
    if (!account) throw new NotFoundError(this.id, "GW2 account", "guild-wars-2");
    return account;
  }

  /** Structured PvP career statistics. */
  public async getPvpStats(): Promise<Record<string, unknown>> {
    return this.cached(
      ["pvp", "stats"],
      "getPlayerStats",
      "guild-wars-2",
      TTL.playerStats ?? 180,
      async () => {
        const stats = await this.get<Record<string, unknown> | null>("/pvp/stats", {
          nullOn404: true,
        });
        return stats ?? {};
      },
    );
  }

  /** Recent PvP games - the API keeps the last ten. */
  public async getPvpGames(): Promise<Record<string, unknown>[]> {
    const games = await this.get<Record<string, unknown>[] | null>("/pvp/games", {
      query: { ids: "all" },
      nullOn404: true,
    });
    return games ?? [];
  }

  /** PvP standings across seasons. */
  public async getPvpStandings(): Promise<Record<string, unknown>[]> {
    const standings = await this.get<Record<string, unknown>[] | null>("/pvp/standings", {
      nullOn404: true,
    });
    return standings ?? [];
  }

  /** A season leaderboard. */
  public async getPvpLeaderboard(
    seasonId: string,
    board = "legendary",
    region = "global",
  ): Promise<Record<string, unknown>[]> {
    const entries = await this.get<Record<string, unknown>[] | null>(
      `/pvp/seasons/${seasonId}/leaderboards/${board}/${region}`,
      { nullOn404: true },
    );
    return entries ?? [];
  }
}

/**
 * Path of Exile.
 *
 * Race ladders only - GGG publishes no per-character API without a session
 * cookie. The one hard requirement is a descriptive User-Agent; a generic one
 * is refused rather than throttled.
 */
export class PathOfExileProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("path-of-exile", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  /** A league ladder page. */
  public async getLadder(
    league: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["ladder", league, options.offset ?? 0],
      "getLeaderboard",
      "path-of-exile",
      TTL.leaderboard ?? 300,
      async () => {
        const response = await this.get<{ entries?: Record<string, unknown>[] }>(
          `/ladders/${encodeURIComponent(league)}`,
          {
            query: {
              limit: Math.min(options.limit ?? 50, 200),
              offset: options.offset ?? 0,
            },
            nullOn404: true,
          },
        );
        return response?.entries ?? [];
      },
    );
  }

  /** Current leagues, so a caller can find the race that is running. */
  public async getLeagues(): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["leagues"],
      "getMetadata",
      "path-of-exile",
      TTL.metadata ?? 3_600,
      async () => {
        const leagues = await this.get<Record<string, unknown>[] | null>("/leagues", {
          query: { type: "main", realm: "pc" },
          nullOn404: true,
        });
        return leagues ?? [];
      },
    );
  }
}

/**
 * Albion Online.
 *
 * Separate hosts per server, and the competitive content - Crystal League,
 * GvG - lives in the guild endpoints rather than the player ones.
 */
export class AlbionProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("albion", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  /** Region host. Albion runs three fully separate worlds. */
  public host(region: string): string {
    switch (region.toLowerCase()) {
      case "americas":
      case "west":
        return "https://gameinfo.albiononline.com/api/gameinfo";
      case "asia":
      case "east":
        return "https://gameinfo-sgp.albiononline.com/api/gameinfo";
      default:
        return "https://gameinfo-ams.albiononline.com/api/gameinfo";
    }
  }

  /** Search players and guilds by name. */
  public async search(
    query: string,
    region = "europe",
  ): Promise<{ players?: Record<string, unknown>[]; guilds?: Record<string, unknown>[] }> {
    return this.cached(
      ["search", region, query.toLowerCase()],
      "resolvePlayer",
      "albion-online",
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const response = await this.get<{
          players?: Record<string, unknown>[];
          guilds?: Record<string, unknown>[];
        } | null>(`${this.host(region)}/search`, { query: { q: query }, nullOn404: true });
        return response ?? {};
      },
    );
  }

  /** A player's PvE and PvP fame. */
  public async getPlayer(playerId: string, region = "europe"): Promise<Record<string, unknown>> {
    return this.cached(
      ["player", region, playerId],
      "getPlayer",
      "albion-online",
      TTL.player ?? 300,
      async () => {
        const player = await this.get<Record<string, unknown> | null>(
          `${this.host(region)}/players/${playerId}`,
          { nullOn404: true },
        );
        if (!player) {
          throw new NotFoundError(this.id, `Albion player ${playerId}`, "albion-online");
        }
        return player;
      },
    );
  }

  /** Kills and deaths, which is Albion's match history. */
  public async getPlayerKills(
    playerId: string,
    region = "europe",
  ): Promise<Record<string, unknown>[]> {
    const kills = await this.get<Record<string, unknown>[] | null>(
      `${this.host(region)}/players/${playerId}/kills`,
      { nullOn404: true },
    );
    return kills ?? [];
  }

  /** Guild record, including the Crystal League standing. */
  public async getGuild(guildId: string, region = "europe"): Promise<Record<string, unknown> | null> {
    return this.get<Record<string, unknown> | null>(
      `${this.host(region)}/guilds/${guildId}`,
      { nullOn404: true },
    );
  }
}

/**
 * Raider.IO - World of Warcraft Mythic+ and raid rankings.
 *
 * Blizzard's own API has the character but not the score, and the score is what
 * the competitive scene is organised around.
 */
export class RaiderIoProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("raiderio", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  /** A character profile with the requested fields attached. */
  public async getCharacter(
    region: string,
    realm: string,
    name: string,
    fields: readonly string[] = ["mythic_plus_scores_by_season:current", "gear"],
  ): Promise<Record<string, unknown>> {
    return this.cached(
      ["character", region, realm, name.toLowerCase()],
      "getPlayerStats",
      "world-of-warcraft",
      TTL.playerStats ?? 180,
      async () => {
        const character = await this.get<Record<string, unknown> | null>(
          "/characters/profile",
          {
            query: { region, realm, name, fields: fields.join(",") },
            nullOn404: true,
          },
        );
        if (!character) {
          throw new NotFoundError(
            this.id,
            `WoW character ${name}-${realm}`,
            "world-of-warcraft",
          );
        }
        return character;
      },
    );
  }

  /** Mythic+ runs a character has completed. */
  public async getMythicPlusRuns(
    region: string,
    realm: string,
    name: string,
  ): Promise<Record<string, unknown>[]> {
    const response = await this.get<{
      mythic_plus_recent_runs?: Record<string, unknown>[];
    } | null>("/characters/profile", {
      query: { region, realm, name, fields: "mythic_plus_recent_runs" },
      nullOn404: true,
    });
    return response?.mythic_plus_recent_runs ?? [];
  }

  /** The Mythic+ leaderboard for a dungeon and season. */
  public async getMythicPlusRankings(
    season: string,
    region: string,
    dungeon = "all",
    page = 0,
  ): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ rankings?: Record<string, unknown>[] } | null>(
      "/mythic-plus/runs",
      { query: { season, region, dungeon, page }, nullOn404: true },
    );
    return response?.rankings ?? [];
  }
}

/**
 * logs.tf - competitive Team Fortress 2.
 *
 * A log archive rather than a stats API: every serious TF2 match is uploaded
 * here, and this is the only structured record the game has.
 */
export class LogsTfProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("logstf", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  /** Logs a player appears in, newest first. Keyed on SteamID64. */
  public async getPlayerLogs(
    steamId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const id = toSteamId64(steamId);
    return this.cached(
      ["logs", id, options.limit ?? 20, options.offset ?? 0],
      "getMatchHistory",
      "team-fortress-2",
      TTL.matchHistory ?? 60,
      async () => {
        const response = await this.get<{ logs?: Record<string, unknown>[] }>("/log", {
          query: {
            player: id,
            limit: Math.min(options.limit ?? 20, 100),
            offset: options.offset ?? 0,
          },
          nullOn404: true,
        });
        return response?.logs ?? [];
      },
    );
  }

  /** One log in full: every class, every weapon, every heal. */
  public async getLog(logId: string): Promise<Record<string, unknown>> {
    return this.cached(
      ["log", logId],
      "getMatch",
      "team-fortress-2",
      TTL.match ?? 86_400,
      async () => {
        const log = await this.get<Record<string, unknown> | null>(`/log/${logId}`, {
          nullOn404: true,
        });
        if (!log) throw new NotFoundError(this.id, `logs.tf log ${logId}`, "team-fortress-2");
        return log;
      },
    );
  }
}
