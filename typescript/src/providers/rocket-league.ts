/**
 * Rocket League's two data sources.
 *
 * Psyonix publishes no API of any kind, so this title is assembled from what
 * the community keeps:
 *
 * - **Ballchasing** holds uploaded replays. Complete for anyone who uploads,
 *   invisible for anyone who does not - a limitation worth surfacing to a user
 *   rather than presenting an empty history as "no games played".
 * - **Octane.gg** is the reference database for the professional circuit:
 *   every RLCS game, roster and event since 2016.
 *
 * Ladder rank comes from Tracker, which is handled in `tracker.ts`.
 */

import { ProviderClient } from "./base.js";
import type { RequestSpec } from "../http.js";
import { NotFoundError } from "../errors.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

/**
 * Ballchasing.com.
 *
 * The token goes in a bare `Authorization` header - not `Bearer` - which is a
 * frequent cause of a puzzling 401.
 */
export class BallchasingProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("ballchasing", runtime);
  }

  protected override authHeaderName(): string {
    return "Authorization";
  }

  /** Check the token and the account it belongs to. */
  public async ping(): Promise<Record<string, unknown> | null> {
    return this.get<Record<string, unknown> | null>("/", { nullOn404: true });
  }

  /**
   * Replays involving a player.
   *
   * `playerId` is `steam:76561198...`, `epic:...`, `xbox:...` or `ps4:...`.
   */
  public async listReplays(options: {
    playerId?: string;
    playerName?: string;
    playlist?: string;
    season?: string;
    count?: number;
    after?: string;
    sortBy?: "replay-date" | "upload-date";
  } = {}): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["replays", options.playerId ?? options.playerName ?? "-", options.count ?? 20, options.playlist ?? "-"],
      "getMatchHistory",
      "rocket-league",
      TTL.matchHistory ?? 60,
      async () => {
        const response = await this.get<{ list?: Record<string, unknown>[] }>("/replays", {
          query: {
            "player-id": options.playerId,
            "player-name": options.playerName,
            playlist: options.playlist,
            season: options.season,
            count: Math.min(options.count ?? 20, 200),
            after: options.after,
            "sort-by": options.sortBy ?? "replay-date",
          },
          nullOn404: true,
        });
        return response?.list ?? [];
      },
    );
  }

  /** One replay, with the full per-player breakdown. */
  public async getReplay(replayId: string): Promise<Record<string, unknown>> {
    return this.cached(
      ["replay", replayId],
      "getMatch",
      "rocket-league",
      TTL.match ?? 86_400,
      async () => {
        const replay = await this.get<Record<string, unknown> | null>(`/replays/${replayId}`, {
          nullOn404: true,
        });
        if (!replay) throw new NotFoundError(this.id, `replay ${replayId}`, "rocket-league");
        return replay;
      },
    );
  }

  /** Maps, for turning internal names into readable ones. */
  public async getMaps(): Promise<Record<string, string>> {
    return this.cached(["maps"], "getMetadata", "rocket-league", TTL.metadata ?? 3_600, async () => {
      const maps = await this.get<Record<string, string> | null>("/maps", { nullOn404: true });
      return maps ?? {};
    });
  }
}

/**
 * Octane.gg - the Rocket League esports database.
 *
 * No key and no published quota, so the registry limits it conservatively. It
 * covers events, matches, games and player statistics for the professional
 * circuit; it knows nothing about ladder play.
 */
export class OctaneProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("octane", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  /** Events, newest first. */
  public async getEvents(options: {
    tier?: string;
    region?: string;
    after?: string;
    before?: string;
    page?: number;
    perPage?: number;
  } = {}): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["events", options.tier ?? "-", options.region ?? "-", options.page ?? 1],
      "getEsportsTournaments",
      "rocket-league",
      TTL.esportsTournaments ?? 1_800,
      async () => {
        const response = await this.get<{ events?: Record<string, unknown>[] }>("/events", {
          query: {
            tier: options.tier,
            region: options.region,
            after: options.after,
            before: options.before,
            page: options.page ?? 1,
            perPage: Math.min(options.perPage ?? 50, 500),
          },
          nullOn404: true,
        });
        return response?.events ?? [];
      },
    );
  }

  /** Professional matches. */
  public async getMatches(options: {
    event?: string;
    team?: string;
    player?: string;
    after?: string;
    before?: string;
    page?: number;
    perPage?: number;
  } = {}): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["matches", options.event ?? "-", options.team ?? "-", options.page ?? 1],
      "getEsportsMatches",
      "rocket-league",
      TTL.esportsMatches ?? 300,
      async () => {
        const response = await this.get<{ matches?: Record<string, unknown>[] }>("/matches", {
          query: {
            event: options.event,
            team: options.team,
            player: options.player,
            after: options.after,
            before: options.before,
            page: options.page ?? 1,
            perPage: Math.min(options.perPage ?? 50, 500),
          },
          nullOn404: true,
        });
        return response?.matches ?? [];
      },
    );
  }

  /** Professional teams. */
  public async getTeams(name?: string): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["teams", name ?? "-"],
      "getEsportsTeams",
      "rocket-league",
      TTL.esportsTeams ?? 3_600,
      async () => {
        const response = await this.get<{ teams?: Record<string, unknown>[] }>("/teams", {
          query: { name, perPage: 500 },
          nullOn404: true,
        });
        return response?.teams ?? [];
      },
    );
  }

  /** Professional players. */
  public async getPlayers(tag?: string): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["players", tag ?? "-"],
      "getEsportsPlayers",
      "rocket-league",
      TTL.esportsPlayers ?? 3_600,
      async () => {
        const response = await this.get<{ players?: Record<string, unknown>[] }>("/players", {
          query: { tag, perPage: 500 },
          nullOn404: true,
        });
        return response?.players ?? [];
      },
    );
  }

  /** One professional match, with games and per-player statistics. */
  public async getMatch(matchId: string): Promise<Record<string, unknown>> {
    return this.cached(
      ["match", matchId],
      "getMatch",
      "rocket-league",
      TTL.match ?? 86_400,
      async () => {
        const match = await this.get<Record<string, unknown> | null>(`/matches/${matchId}`, {
          nullOn404: true,
        });
        if (!match) throw new NotFoundError(this.id, `Octane match ${matchId}`, "rocket-league");
        return match;
      },
    );
  }

  /** Aggregate player statistics across events. */
  public async getPlayerStats(options: {
    player?: string;
    event?: string;
    after?: string;
    before?: string;
  } = {}): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ players?: Record<string, unknown>[] }>("/stats/players", {
      query: {
        player: options.player,
        event: options.event,
        after: options.after,
        before: options.before,
      },
      nullOn404: true,
    });
    return response?.players ?? [];
  }
}
