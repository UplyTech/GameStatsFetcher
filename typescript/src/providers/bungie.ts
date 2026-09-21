/**
 * Bungie.net API - Destiny 2.
 *
 * Two things make this API unlike the others here:
 *
 * 1. **Everything is wrapped.** A successful call is a 200 with
 *    `{ ErrorCode: 1, Response: ... }`, and a *failed* call is also a 200 with
 *    a different `ErrorCode`. So a plain HTTP check would treat "player not
 *    found" as a success, and the unwrapping below is not optional.
 * 2. **Components are opt-in.** `GetProfile` returns nothing useful unless you
 *    ask for numbered components, and the payload grows quickly - which is why
 *    the component sets are named constants rather than magic numbers at each
 *    call site.
 */

import { ProviderClient } from "./base.js";
import { NotFoundError, ParseError, PrivateProfileError } from "../errors.js";
import { TTL } from "../constants.js";
import { parseRiotId } from "../identity.js";
import type { Runtime } from "../runtime.js";

/** `membershipType` values. `-1` means "all platforms", which is usually right. */
export const DESTINY_PLATFORMS = {
  xbox: 1,
  playstation: 2,
  steam: 3,
  battlenet: 4,
  stadia: 5,
  epic: 6,
  all: -1,
} as const;

/** The component numbers this package asks for, named. */
const COMPONENTS = {
  profiles: 100,
  characters: 200,
  characterActivities: 204,
  records: 900,
  metrics: 1100,
} as const;

interface BungieEnvelope<T> {
  Response?: T;
  ErrorCode?: number;
  ErrorStatus?: string;
  Message?: string;
}

export interface DestinyMembership {
  membershipId: string;
  membershipType: number;
  displayName?: string;
  bungieGlobalDisplayName?: string;
  bungieGlobalDisplayNameCode?: number;
  iconPath?: string;
  crossSaveOverride?: number;
}

export class BungieProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("bungie", runtime);
  }

  protected override authHeaderName(): string {
    return "X-API-Key";
  }

  /**
   * Unwrap the envelope, turning a non-1 `ErrorCode` into a real error.
   *
   * Error code 1 is success. 217 and 1601 mean the account or profile is not
   * there; the privacy codes mean it is there and closed.
   */
  private unwrap<T>(envelope: BungieEnvelope<T> | null, what: string): T {
    if (!envelope) throw new NotFoundError(this.id, what, "destiny-2");
    if (envelope.ErrorCode === 1 && envelope.Response !== undefined) return envelope.Response;

    const status = envelope.ErrorStatus ?? "unknown";
    if (status === "DestinyAccountNotFound" || envelope.ErrorCode === 1601) {
      throw new NotFoundError(this.id, what, "destiny-2");
    }
    if (status.includes("Privacy") || status === "DestinyPrivacyRestriction") {
      throw new PrivateProfileError(this.id, what, "destiny-2");
    }
    throw new ParseError(this.id, `${status}: ${envelope.Message ?? "no message"}`);
  }

  /**
   * Find memberships from a Bungie Name (`Guardian#1234`).
   *
   * Bungie splits the name and the four-digit code into two body fields, so the
   * Riot ID parser is reused here - the format is the same shape.
   */
  public async searchByBungieName(
    bungieName: string,
    membershipType: number = DESTINY_PLATFORMS.all,
  ): Promise<DestinyMembership[]> {
    const { gameName, tagLine } = parseRiotId(bungieName);
    const code = Number(tagLine);
    if (!Number.isInteger(code)) {
      throw new NotFoundError(this.id, `Bungie name ${bungieName}`, "destiny-2");
    }
    return this.cached(
      ["search", gameName.toLowerCase(), code, membershipType],
      "resolvePlayer",
      "destiny-2",
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const envelope = await this.post<BungieEnvelope<DestinyMembership[]>>(
          `/Destiny2/SearchDestinyPlayerByBungieName/${membershipType}/`,
          { displayName: gameName, displayNameCode: code },
        );
        return this.unwrap(envelope, `Bungie name ${bungieName}`);
      },
    );
  }

  /** The primary membership for a Bungie.net account, following cross-save. */
  public async getPrimaryMembership(bungieName: string): Promise<DestinyMembership> {
    const memberships = await this.searchByBungieName(bungieName);
    if (memberships.length === 0) {
      throw new NotFoundError(this.id, `Bungie name ${bungieName}`, "destiny-2");
    }
    // With cross-save on, only the overridden platform holds live data; the
    // others are shells that answer with empty character lists.
    const primary = memberships.find(
      (m) => m.crossSaveOverride === 0 || m.crossSaveOverride === m.membershipType,
    );
    return primary ?? (memberships[0] as DestinyMembership);
  }

  /** Profile with the components this package needs. */
  public async getProfile(
    membershipType: number,
    membershipId: string,
    components: readonly number[] = [COMPONENTS.profiles, COMPONENTS.characters],
  ): Promise<Record<string, unknown>> {
    return this.cached(
      ["profile", membershipType, membershipId, components.join(",")],
      "getPlayer",
      "destiny-2",
      TTL.player ?? 300,
      async () => {
        const envelope = await this.get<BungieEnvelope<Record<string, unknown>>>(
          `/Destiny2/${membershipType}/Profile/${membershipId}/`,
          { query: { components: components.join(",") } },
        );
        return this.unwrap(envelope, `Destiny profile ${membershipId}`);
      },
    );
  }

  /** Character ids, newest played first. */
  public async getCharacterIds(membershipType: number, membershipId: string): Promise<string[]> {
    const profile = await this.getProfile(membershipType, membershipId, [COMPONENTS.profiles]);
    const data = (profile as { profile?: { data?: { characterIds?: string[] } } }).profile?.data;
    return data?.characterIds ?? [];
  }

  /** Lifetime historical stats, per character or account-wide. */
  public async getHistoricalStats(
    membershipType: number,
    membershipId: string,
    characterId = "0",
    modes: readonly number[] = [],
  ): Promise<Record<string, unknown>> {
    const envelope = await this.get<BungieEnvelope<Record<string, unknown>>>(
      `/Destiny2/${membershipType}/Account/${membershipId}/Character/${characterId}/Stats/`,
      { query: { modes: modes.length > 0 ? modes.join(",") : undefined } },
    );
    return this.unwrap(envelope, `stats for ${membershipId}`);
  }

  /** Account-wide aggregate, merging every character. */
  public async getAccountStats(
    membershipType: number,
    membershipId: string,
  ): Promise<Record<string, unknown>> {
    return this.cached(
      ["account-stats", membershipType, membershipId],
      "getPlayerStats",
      "destiny-2",
      TTL.playerStats ?? 180,
      async () => {
        const envelope = await this.get<BungieEnvelope<Record<string, unknown>>>(
          `/Destiny2/${membershipType}/Account/${membershipId}/Stats/`,
          { query: { groups: "General" } },
        );
        return this.unwrap(envelope, `account stats for ${membershipId}`);
      },
    );
  }

  /** Recent activities for one character. `mode` 5 is all PvP, 84 is Trials. */
  public async getActivityHistory(
    membershipType: number,
    membershipId: string,
    characterId: string,
    options: { count?: number; page?: number; mode?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const envelope = await this.get<BungieEnvelope<{ activities?: Record<string, unknown>[] }>>(
      `/Destiny2/${membershipType}/Account/${membershipId}/Character/${characterId}/Stats/Activities/`,
      {
        query: {
          count: options.count ?? 25,
          page: options.page ?? 0,
          mode: options.mode,
        },
      },
    );
    return this.unwrap(envelope, `activities for ${characterId}`).activities ?? [];
  }

  /** The post-game carnage report: the full scoreboard for one activity. */
  public async getPostGameCarnageReport(activityId: string): Promise<Record<string, unknown>> {
    return this.cached(
      ["pgcr", activityId],
      "getMatch",
      "destiny-2",
      TTL.match ?? 86_400,
      async () => {
        // The PGCR endpoint lives on a stats host, not the main platform one.
        const envelope = await this.get<BungieEnvelope<Record<string, unknown>>>(
          `https://stats.bungie.net/Platform/Destiny2/Stats/PostGameCarnageReport/${activityId}/`,
        );
        return this.unwrap(envelope, `activity ${activityId}`);
      },
    );
  }

  /** One entry of the Destiny manifest, for turning hashes into names. */
  public async getManifest(): Promise<Record<string, unknown>> {
    return this.cached(["manifest"], "getMetadata", "destiny-2", TTL.metadata ?? 3_600, async () => {
      const envelope = await this.get<BungieEnvelope<Record<string, unknown>>>(
        "/Destiny2/Manifest/",
      );
      return this.unwrap(envelope, "manifest");
    });
  }
}
