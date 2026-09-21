/**
 * Supercell's three APIs: Clash Royale, Clash of Clans and Brawl Stars.
 *
 * They share a schema, a tag format and one operational trap worth stating
 * plainly, because it is the single most common support question about them:
 *
 * > **Supercell tokens are bound to IP addresses.** A key created on a laptop
 * > will answer `403 accessDenied.invalidIp` from a server, and the message
 * > does not say so clearly. If a call fails with 403 and the key is definitely
 * > right, the key is right and the address is wrong.
 *
 * One base class, three thin subclasses - the endpoints differ but nothing else
 * does.
 */

import { ProviderClient } from "./base.js";
import { NotFoundError } from "../errors.js";
import { encodeSupercellTag } from "../identity.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

abstract class SupercellProvider extends ProviderClient {
  /** The title this provider serves, for cache keys and error context. */
  protected abstract readonly titleId: string;

  /** A player record. Shape differs per game, so callers narrow it themselves. */
  public async getPlayer(tag: string): Promise<Record<string, unknown>> {
    const encoded = encodeSupercellTag(tag);
    return this.cached(
      ["player", encoded],
      "getPlayer",
      this.titleId,
      TTL.player ?? 300,
      async () => {
        const player = await this.get<Record<string, unknown> | null>(
          `/players/${encoded}`,
          { nullOn404: true },
        );
        if (!player) throw new NotFoundError(this.id, `player ${tag}`, this.titleId);
        return player;
      },
    );
  }

  /**
   * Rankings for a location.
   *
   * `global` is the worldwide board; numeric ids are countries. Supercell
   * publishes the id list at `/locations`.
   */
  public async getPlayerRankings(
    locationId: string | number = "global",
    limit = 100,
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["rankings", locationId, limit],
      "getLeaderboard",
      this.titleId,
      TTL.leaderboard ?? 300,
      async () => {
        const response = await this.get<{ items?: Record<string, unknown>[] }>(
          `/locations/${locationId}/rankings/players`,
          { query: { limit }, nullOn404: true },
        );
        return response?.items ?? [];
      },
    );
  }

  /** Locations, so a caller can turn "Germany" into the id the board needs. */
  public async getLocations(): Promise<Record<string, unknown>[]> {
    return this.cached(["locations"], "getMetadata", this.titleId, TTL.metadata ?? 3_600, async () => {
      const response = await this.get<{ items?: Record<string, unknown>[] }>("/locations", {
        query: { limit: 500 },
      });
      return response?.items ?? [];
    });
  }
}

/**
 * Clash Royale.
 *
 * The only one of the three with a real match history: `battlelog` holds the
 * last 25 battles, and nothing older is retrievable at all.
 */
export class ClashRoyaleProvider extends SupercellProvider {
  protected readonly titleId = "clash-royale";

  constructor(runtime: Runtime) {
    super("supercell-clash-royale", runtime);
  }

  /** The last 25 battles. Supercell keeps no more than that. */
  public async getBattleLog(tag: string): Promise<Record<string, unknown>[]> {
    const encoded = encodeSupercellTag(tag);
    return this.cached(
      ["battlelog", encoded],
      "getMatchHistory",
      this.titleId,
      TTL.matchHistory ?? 60,
      async () => {
        const log = await this.get<Record<string, unknown>[] | null>(
          `/players/${encoded}/battlelog`,
          { nullOn404: true },
        );
        return log ?? [];
      },
    );
  }

  /** Upcoming chests, which is a Clash Royale peculiarity worth exposing. */
  public async getUpcomingChests(tag: string): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ items?: Record<string, unknown>[] }>(
      `/players/${encodeSupercellTag(tag)}/upcomingchests`,
      { nullOn404: true },
    );
    return response?.items ?? [];
  }

  /** Clan record. */
  public async getClan(tag: string): Promise<Record<string, unknown> | null> {
    return this.get<Record<string, unknown> | null>(`/clans/${encodeSupercellTag(tag)}`, {
      nullOn404: true,
    });
  }

  /** Cards, for turning deck ids into names. */
  public async getCards(): Promise<Record<string, unknown>[]> {
    return this.cached(["cards"], "getMetadata", this.titleId, TTL.metadata ?? 3_600, async () => {
      const response = await this.get<{ items?: Record<string, unknown>[] }>("/cards");
      return response?.items ?? [];
    });
  }
}

/** Clash of Clans. Clan-centric, so the clan endpoints matter more than usual. */
export class ClashOfClansProvider extends SupercellProvider {
  protected readonly titleId = "clash-of-clans";

  constructor(runtime: Runtime) {
    super("supercell-clash-of-clans", runtime);
  }

  public async getClan(tag: string): Promise<Record<string, unknown> | null> {
    return this.get<Record<string, unknown> | null>(`/clans/${encodeSupercellTag(tag)}`, {
      nullOn404: true,
    });
  }

  /** The current clan war, which is the closest thing to a match record here. */
  public async getCurrentWar(clanTag: string): Promise<Record<string, unknown> | null> {
    return this.get<Record<string, unknown> | null>(
      `/clans/${encodeSupercellTag(clanTag)}/currentwar`,
      { nullOn404: true },
    );
  }

  /** War log. Returns 403 rather than 404 when the clan keeps it private. */
  public async getWarLog(clanTag: string): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ items?: Record<string, unknown>[] }>(
      `/clans/${encodeSupercellTag(clanTag)}/warlog`,
      { nullOn404: true },
    );
    return response?.items ?? [];
  }

  /** Clan rankings for a location. */
  public async getClanRankings(
    locationId: string | number = "global",
    limit = 100,
  ): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ items?: Record<string, unknown>[] }>(
      `/locations/${locationId}/rankings/clans`,
      { query: { limit }, nullOn404: true },
    );
    return response?.items ?? [];
  }
}

/** Brawl Stars. Has a battle log, like Clash Royale, and brawler-level stats. */
export class BrawlStarsProvider extends SupercellProvider {
  protected readonly titleId = "brawl-stars";

  constructor(runtime: Runtime) {
    super("supercell-brawl-stars", runtime);
  }

  /** Recent battles. About 25, same as Clash Royale. */
  public async getBattleLog(tag: string): Promise<Record<string, unknown>[]> {
    const encoded = encodeSupercellTag(tag);
    return this.cached(
      ["battlelog", encoded],
      "getMatchHistory",
      this.titleId,
      TTL.matchHistory ?? 60,
      async () => {
        const response = await this.get<{ items?: Record<string, unknown>[] }>(
          `/players/${encoded}/battlelog`,
          { nullOn404: true },
        );
        return response?.items ?? [];
      },
    );
  }

  /** Club record. */
  public async getClub(tag: string): Promise<Record<string, unknown> | null> {
    return this.get<Record<string, unknown> | null>(`/clubs/${encodeSupercellTag(tag)}`, {
      nullOn404: true,
    });
  }

  /** Brawler list, for turning ids into names. */
  public async getBrawlers(): Promise<Record<string, unknown>[]> {
    return this.cached(["brawlers"], "getMetadata", this.titleId, TTL.metadata ?? 3_600, async () => {
      const response = await this.get<{ items?: Record<string, unknown>[] }>("/brawlers");
      return response?.items ?? [];
    });
  }

  /** Events currently in rotation. */
  public async getEventRotation(): Promise<Record<string, unknown>[]> {
    const response = await this.get<Record<string, unknown>[] | null>("/events/rotation", {
      nullOn404: true,
    });
    return response ?? [];
  }
}
