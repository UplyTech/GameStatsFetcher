/**
 * Blizzard Battle.net API.
 *
 * Serves StarCraft II, World of Warcraft and the Hearthstone card database.
 *
 * Authentication is OAuth2 client credentials: the client id and secret are
 * exchanged for a bearer token that lives for 24 hours. The exchange happens
 * once per runtime and is memoised, because doing it per request would triple
 * the call count and Blizzard counts the token endpoint against the same quota.
 */

import { ProviderClient } from "./base.js";
import type { RequestSpec } from "../http.js";
import { AuthenticationError, NotFoundError, ValidationError } from "../errors.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

/** Regions Blizzard serves, and the host each one answers on. */
const REGION_HOSTS: Readonly<Record<string, string>> = {
  us: "https://us.api.blizzard.com",
  eu: "https://eu.api.blizzard.com",
  kr: "https://kr.api.blizzard.com",
  tw: "https://tw.api.blizzard.com",
  cn: "https://gateway.battlenet.com.cn",
};

/** The token endpoint is region-specific too, and mainland China differs. */
const TOKEN_HOSTS: Readonly<Record<string, string>> = {
  us: "https://oauth.battle.net/token",
  eu: "https://oauth.battle.net/token",
  kr: "https://oauth.battle.net/token",
  tw: "https://oauth.battle.net/token",
  cn: "https://oauth.battlenet.com.cn/token",
};

export interface Sc2LadderSummary {
  showCaseEntries?: {
    ladderId: string;
    team?: { localizedGameMode?: string; mmr?: number; wins?: number; losses?: number };
  }[];
  placementMatches?: unknown[];
  allLadderMemberships?: { ladderId: string; localizedGameMode: string }[];
}

export class BlizzardProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("blizzard", runtime);
  }

  /** Region host, validated so a typo fails here rather than as a DNS error. */
  public host(region: string): string {
    const host = REGION_HOSTS[region.toLowerCase()];
    if (!host) {
      throw new ValidationError(
        `unknown Blizzard region "${region}". Expected one of: ${Object.keys(REGION_HOSTS).join(", ")}`,
      );
    }
    return host;
  }

  /**
   * Fetch and cache an access token.
   *
   * Held for 60 seconds less than Blizzard says, so a token cannot expire
   * between the check and the request that uses it.
   */
  private async accessToken(region: string): Promise<string> {
    const [clientId, clientSecret] = this.requireKeyParts(2, "clientId:clientSecret");
    const tokenHost = TOKEN_HOSTS[region.toLowerCase()] ?? TOKEN_HOSTS.us;

    return this.memo(`token:${region}`, 23 * 3_600 * 1_000, async () => {
      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      const response = await this.runtime.http.send<{
        access_token?: string;
        expires_in?: number;
      }>(this.id, tokenHost as string, {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });
      if (!response?.access_token) {
        throw new AuthenticationError(this.id, "token endpoint returned no access_token");
      }
      return response.access_token;
    });
  }

  /**
   * Attach the bearer token.
   *
   * The region is carried on the spec's query so `authorize` knows which token
   * to mint; it is stripped again before the request goes out, because Blizzard
   * would reject the unexpected parameter on some endpoints.
   */
  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    const region = String(spec.query?.__region ?? "us");
    const token = await this.accessToken(region);
    const query = { ...spec.query };
    delete (query as Record<string, unknown>).__region;
    return {
      ...spec,
      query,
      headers: { Authorization: `Bearer ${token}`, ...spec.headers },
    };
  }

  private async call<T>(region: string, path: string, spec: RequestSpec = {}): Promise<T> {
    return this.request<T>(`${this.host(region)}${path}`, {
      ...spec,
      query: { ...spec.query, __region: region },
    });
  }

  // -------------------------------------------------------------------------
  // StarCraft II
  // -------------------------------------------------------------------------

  /**
   * Find a StarCraft II profile from a BattleTag.
   *
   * Blizzard's SC2 endpoints are keyed by `regionId/realmId/profileId`, not by
   * BattleTag, so a name lookup means walking the account's profiles. That is
   * why SC2Pulse is the preferred provider for this title and this is the
   * fallback.
   */
  public async getSc2Profile(
    region: string,
    regionId: number,
    realmId: number,
    profileId: string,
  ): Promise<Record<string, unknown>> {
    return this.cached(
      ["sc2", region, regionId, realmId, profileId],
      "getPlayer",
      "starcraft-2",
      TTL.player ?? 300,
      async () => {
        const profile = await this.call<Record<string, unknown> | null>(
          region,
          `/sc2/profile/${regionId}/${realmId}/${profileId}`,
          { query: { locale: "en_US" }, nullOn404: true },
        );
        if (!profile) {
          throw new NotFoundError(this.id, `SC2 profile ${profileId}`, "starcraft-2");
        }
        return profile;
      },
    );
  }

  /** Ladder standings for one profile. */
  public async getSc2LadderSummary(
    region: string,
    regionId: number,
    realmId: number,
    profileId: string,
  ): Promise<Sc2LadderSummary | null> {
    return this.call<Sc2LadderSummary | null>(
      region,
      `/sc2/profile/${regionId}/${realmId}/${profileId}/ladder/summary`,
      { query: { locale: "en_US" }, nullOn404: true },
    );
  }

  /** Grandmaster league for a season. The one SC2 ladder Blizzard publishes whole. */
  public async getSc2GrandmasterLadder(
    region: string,
    regionId: number,
  ): Promise<{ ladderTeams?: Record<string, unknown>[] } | null> {
    return this.call<{ ladderTeams?: Record<string, unknown>[] } | null>(
      region,
      `/sc2/ladder/grandmaster/${regionId}`,
      { nullOn404: true },
    );
  }

  // -------------------------------------------------------------------------
  // World of Warcraft
  // -------------------------------------------------------------------------

  /** A character profile summary. `realm` is the slug, not the display name. */
  public async getWowCharacter(
    region: string,
    realmSlug: string,
    characterName: string,
  ): Promise<Record<string, unknown>> {
    const name = characterName.toLowerCase();
    return this.cached(
      ["wow", region, realmSlug, name],
      "getPlayer",
      "world-of-warcraft",
      TTL.player ?? 300,
      async () => {
        const profile = await this.call<Record<string, unknown> | null>(
          region,
          `/profile/wow/character/${realmSlug}/${encodeURIComponent(name)}`,
          {
            query: { namespace: `profile-${region}`, locale: "en_US" },
            nullOn404: true,
          },
        );
        if (!profile) {
          throw new NotFoundError(
            this.id,
            `WoW character ${characterName}-${realmSlug}`,
            "world-of-warcraft",
          );
        }
        return profile;
      },
    );
  }

  /** PvP bracket statistics: 2v2, 3v3, rbg. */
  public async getWowPvpBracket(
    region: string,
    realmSlug: string,
    characterName: string,
    bracket: "2v2" | "3v3" | "rbg" | "shuffle",
  ): Promise<Record<string, unknown> | null> {
    return this.call<Record<string, unknown> | null>(
      region,
      `/profile/wow/character/${realmSlug}/${encodeURIComponent(characterName.toLowerCase())}/pvp-bracket/${bracket}`,
      { query: { namespace: `profile-${region}`, locale: "en_US" }, nullOn404: true },
    );
  }

  /** A PvP leaderboard for a season and bracket. */
  public async getWowPvpLeaderboard(
    region: string,
    season: number,
    bracket: string,
  ): Promise<{ entries?: Record<string, unknown>[] } | null> {
    return this.call<{ entries?: Record<string, unknown>[] } | null>(
      region,
      `/data/wow/pvp-season/${season}/pvp-leaderboard/${bracket}`,
      { query: { namespace: `dynamic-${region}`, locale: "en_US" }, nullOn404: true },
    );
  }

  // -------------------------------------------------------------------------
  // Hearthstone (metadata only - there is no player API)
  // -------------------------------------------------------------------------

  /** Card search. The only Hearthstone data Blizzard exposes publicly. */
  public async getHearthstoneCards(
    region: string,
    query: Record<string, string | number> = {},
  ): Promise<Record<string, unknown> | null> {
    return this.cached(
      ["hs", "cards", region, JSON.stringify(query)],
      "getMetadata",
      "hearthstone",
      TTL.metadata ?? 3_600,
      () =>
        this.call<Record<string, unknown> | null>(region, "/hearthstone/cards", {
          query: { locale: "en_US", ...query },
          nullOn404: true,
        }),
    );
  }

  /** Sets, classes, rarities and the rest of the card metadata. */
  public async getHearthstoneMetadata(region: string): Promise<Record<string, unknown> | null> {
    return this.cached(
      ["hs", "metadata", region],
      "getMetadata",
      "hearthstone",
      TTL.metadata ?? 3_600,
      () =>
        this.call<Record<string, unknown> | null>(region, "/hearthstone/metadata", {
          query: { locale: "en_US" },
          nullOn404: true,
        }),
    );
  }

  // -------------------------------------------------------------------------
  // Diablo III
  //
  // The oldest of Blizzard's community APIs and the only one of their games
  // here whose ladder is a *leaderboard of parties*: a Greater Rift record
  // belongs to the group that set it, so a four-player entry names four
  // characters and one clear time. `getLeaderboard` reports it that way rather
  // than flattening it into four identical rows.
  //
  // Diablo IV has no equivalent. Blizzard publishes no player API for it, so it
  // is not in the registry — see the README on why an absent title is a fact
  // about the industry rather than a gap here.
  // -------------------------------------------------------------------------

  /**
   * A career profile: every hero, the paragon level, and the account totals.
   *
   * BattleTags carry a `#` that has to survive into the path, which Blizzard
   * spells as `-`. Passing the `#` form is the normal mistake, so it is
   * converted here rather than rejected.
   */
  public async getD3Profile(region: string, battleTag: string): Promise<Record<string, unknown>> {
    const tag = battleTag.replace("#", "-");
    return this.cached(
      ["d3", "profile", region, tag.toLowerCase()],
      "getPlayer",
      "diablo-3",
      TTL.player ?? 300,
      async () => {
        const profile = await this.call<Record<string, unknown> | null>(
          region,
          `/d3/profile/${encodeURIComponent(tag)}/`,
          { query: { locale: "en_US" }, nullOn404: true },
        );
        if (!profile) {
          throw new NotFoundError(this.id, `Diablo III career ${battleTag}`, "diablo-3");
        }
        return profile;
      },
    );
  }

  /** One hero in detail: skills, followers, the stats the career omits. */
  public async getD3Hero(
    region: string,
    battleTag: string,
    heroId: string | number,
  ): Promise<Record<string, unknown> | null> {
    const tag = battleTag.replace("#", "-");
    return this.cached(
      ["d3", "hero", region, tag.toLowerCase(), heroId],
      "getPlayerStats",
      "diablo-3",
      TTL.playerStats ?? 180,
      () =>
        this.call<Record<string, unknown> | null>(
          region,
          `/d3/profile/${encodeURIComponent(tag)}/hero/${encodeURIComponent(String(heroId))}`,
          { query: { locale: "en_US" }, nullOn404: true },
        ),
    );
  }

  /**
   * A season leaderboard.
   *
   * `board` is Blizzard's own key — `rift-barbarian`, `rift-team-4`, and so on.
   * It is passed through rather than validated against a list, because the set
   * changes every season and a hard-coded list would start refusing boards that
   * exist.
   */
  public async getD3SeasonLeaderboard(
    region: string,
    season: number,
    board: string,
  ): Promise<Record<string, unknown> | null> {
    return this.cached(
      ["d3", "leaderboard", region, season, board],
      "getLeaderboard",
      "diablo-3",
      TTL.leaderboard ?? 300,
      () =>
        this.call<Record<string, unknown> | null>(
          region,
          `/data/d3/season/${season}/leaderboard/${encodeURIComponent(board)}`,
          { query: { locale: "en_US" }, nullOn404: true },
        ),
    );
  }

  /** Which seasons exist, so a caller can ask for "the current one". */
  public async getD3SeasonIndex(region: string): Promise<Record<string, unknown> | null> {
    return this.cached(
      ["d3", "seasons", region],
      "getMetadata",
      "diablo-3",
      TTL.metadata ?? 3_600,
      () =>
        this.call<Record<string, unknown> | null>(region, "/data/d3/season/", {
          query: { locale: "en_US" },
          nullOn404: true,
        }),
    );
  }
}
