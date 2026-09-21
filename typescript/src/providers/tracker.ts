/**
 * Tracker Network API.
 *
 * The reason Rainbow Six Siege, Call of Duty and Battlefield appear in this
 * package at all: Ubisoft, Activision and EA publish no player API, and Tracker
 * has an approved one that does.
 *
 * The schema is uniform across titles - a profile is a list of `segments`, each
 * with a `stats` map of `{ value, displayValue, percentile, rank }`. So one
 * flattener serves every game, and the per-title clients only decide which
 * segment is the interesting one.
 *
 * The quota is small (about one request per second, and a low daily ceiling),
 * which is why this provider is listed after a first-party option wherever one
 * exists.
 */

import { ProviderClient } from "./base.js";
import { NotFoundError, PrivateProfileError } from "../errors.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

/** This package's title ids mapped onto Tracker's route segments. */
export const TRACKER_GAME_IDS: Readonly<Record<string, string>> = {
  "apex-legends": "apex",
  cs2: "csgo",
  valorant: "valorant",
  "rainbow-six-siege": "r6siege",
  "call-of-duty": "warzone",
  battlefield: "bf2042",
  "halo-infinite": "halo-infinite",
  splitgate: "splitgate",
  "rocket-league": "rocket-league",
  fortnite: "fortnite",
};

export interface TrackerStat {
  rank?: number | null;
  percentile?: number | null;
  displayName?: string;
  displayValue?: string;
  value?: number | string | null;
  metadata?: Record<string, unknown>;
}

export interface TrackerSegment {
  type: string;
  attributes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  stats?: Record<string, TrackerStat>;
}

export interface TrackerProfile {
  platformInfo?: {
    platformSlug?: string;
    platformUserId?: string;
    platformUserHandle?: string;
    avatarUrl?: string;
  };
  userInfo?: { countryCode?: string; isPremium?: boolean };
  segments?: TrackerSegment[];
  metadata?: Record<string, unknown>;
  expiryDate?: string;
}

export class TrackerProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("tracker", runtime);
  }

  protected override authHeaderName(): string {
    return "TRN-Api-Key";
  }

  public gameId(titleId: string): string {
    return TRACKER_GAME_IDS[titleId] ?? titleId;
  }

  /**
   * A player profile.
   *
   * Tracker answers 451 for a profile the player has hidden, which is neither a
   * 403 nor a 404 and would otherwise surface as an opaque HTTP error.
   */
  public async getProfile(
    titleId: string,
    platform: string,
    identifier: string,
  ): Promise<TrackerProfile> {
    const game = this.gameId(titleId);
    return this.cached(
      [game, platform, identifier.toLowerCase()],
      "getPlayerStats",
      titleId,
      TTL.playerStats ?? 180,
      async () => {
        try {
          const response = await this.get<{ data?: TrackerProfile }>(
            `/${game}/standard/profile/${platform}/${encodeURIComponent(identifier)}`,
            { nullOn404: true },
          );
          if (!response?.data) {
            throw new NotFoundError(this.id, `${titleId} profile "${identifier}"`, titleId);
          }
          return response.data;
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            (error as { statusCode?: number }).statusCode === 451
          ) {
            throw new PrivateProfileError(this.id, identifier, titleId);
          }
          throw error;
        }
      },
    );
  }

  /** Recent matches, where the title supports them. */
  public async getMatches(
    titleId: string,
    platform: string,
    identifier: string,
  ): Promise<Record<string, unknown>[]> {
    const game = this.gameId(titleId);
    return this.cached(
      [game, platform, identifier.toLowerCase(), "matches"],
      "getMatchHistory",
      titleId,
      TTL.matchHistory ?? 60,
      async () => {
        const response = await this.get<{ data?: { matches?: Record<string, unknown>[] } }>(
          `/${game}/standard/matches/${platform}/${encodeURIComponent(identifier)}`,
          { nullOn404: true },
        );
        return response?.data?.matches ?? [];
      },
    );
  }

  /** A leaderboard page. */
  public async getLeaderboard(
    titleId: string,
    board: string,
    options: { platform?: string; take?: number; skip?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const game = this.gameId(titleId);
    const response = await this.get<{ data?: { items?: Record<string, unknown>[] } }>(
      `/${game}/standard/leaderboards`,
      {
        query: {
          type: board,
          platform: options.platform,
          take: Math.min(options.take ?? 50, 100),
          skip: options.skip ?? 0,
        },
        nullOn404: true,
      },
    );
    return response?.data?.items ?? [];
  }

  /**
   * Flatten a segment's stats into plain numbers.
   *
   * Tracker wraps every value in an object with a display string beside it.
   * Callers want the number, so this drops the presentation and keeps the rest
   * available through the raw payload.
   */
  public flattenStats(segment: TrackerSegment | undefined): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, stat] of Object.entries(segment?.stats ?? {})) {
      const value = typeof stat.value === "string" ? Number(stat.value) : stat.value;
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  }

  /** The segment of a given type, e.g. `overview` or `legend`. */
  public segment(profile: TrackerProfile, type: string): TrackerSegment | undefined {
    return profile.segments?.find((entry) => entry.type === type);
  }
}
