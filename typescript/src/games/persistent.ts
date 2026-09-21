/**
 * The long-running worlds: RuneScape, Old School RuneScape, EVE Online and
 * Diablo III.
 *
 * None of these has matchmaking, and three of the four have no esports circuit
 * at all. They are here for the reason the package exists: a player asks "how
 * am I doing", and there is a real, published, first-party API that answers.
 *
 * What they have in common is that **progress is the rank**. There is no MMR to
 * report — there is a skill total, a security status, a paragon level — so each
 * client maps whatever its game counts into the same `RankInfo`, and says in
 * `queue` what it actually counted.
 */

import { TitleClient, isPlayerRef } from "../title-client.js";
import * as providers from "../providers/index.js";
import type { RuneScapeGame } from "../providers/jagex.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { int, modeStats, playerStats, str } from "../normalize.js";
import type {
  LeaderboardEntry,
  LeaderboardOptions,
  ModeStats,
  PlayerProfile,
  PlayerQuery,
  PlayerRef,
  PlayerStats,
  RankInfo,
} from "../types.js";

// ---------------------------------------------------------------------------
// RuneScape and Old School RuneScape
// ---------------------------------------------------------------------------

/**
 * The shared half of the two RuneScape clients.
 *
 * One API, two games, one path segment between them — so the only thing the
 * subclasses supply is which game they are.
 *
 * # A name is the identifier, and it is not stable
 *
 * Jagex has no public account id. The display name is the key, and a player can
 * change it, which means a stored name can silently start pointing at somebody
 * else. That is a property of the upstream and it is written down here rather
 * than papered over: `resolvePlayer` returns the name as the id because there
 * is nothing better to return.
 */
abstract class RuneScapeClient extends TitleClient {
  /** Which of the two hiscore tables this client reads. */
  protected abstract game(): RuneScapeGame;

  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    const name = str(query.name ?? query.accountId);
    if (!name) {
      throw new ValidationError("RuneScape is looked up by display name; pass `name`");
    }
    // Asking for the hiscores is the only way to find out whether the name
    // exists, so the resolve is the lookup. The provider caches it, which is
    // why calling resolve and then getRank costs one request rather than two.
    await providers.jagex(this.runtime).getHiscores(this.game(), name);
    return this.ref({
      providerId: "jagex",
      id: name,
      displayName: name,
      platform: "web",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const entry = await providers.jagex(this.runtime).getHiscores(this.game(), ref.id);
    const overall = entry.skills[0];
    return {
      ref,
      displayName: ref.displayName ?? ref.id,
      // The overall *level* is the closest thing the hiscores have to an
      // account level, and it is what every RuneScape player means by "level".
      level: overall?.level ?? null,
      avatarUrl: null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: null,
      country: null,
      clan: null,
      isPrivate: false,
      raw: entry,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const entry = await providers.jagex(this.runtime).getHiscores(this.game(), ref.id);

    // Every skill is a mode, and so is every activity. A boss kill count and a
    // Slayer level are not the same kind of number, so the two are kept apart
    // by an `id` prefix rather than merged into one namespace.
    const modes: Record<string, ModeStats> = {};
    for (const skill of entry.skills) {
      modes[`skill:${skill.id}`] = modeStats({
        id: `skill:${skill.id}`,
        label: skill.name,
        extra: { level: skill.level, xp: skill.xp, rank: skill.rank },
      });
    }
    for (const activity of entry.activities) {
      modes[`activity:${activity.id}`] = modeStats({
        id: `activity:${activity.id}`,
        label: activity.name,
        extra: { score: activity.score, rank: activity.rank },
      });
    }

    return playerStats({
      ref,
      // Skills are not matches. Reporting a made-up match count would be worse
      // than reporting none, so every match-shaped field stays null.
      modes,
      raw: entry,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const entry = await providers.jagex(this.runtime).getHiscores(this.game(), ref.id);

    // One rank per skill, plus the overall one first. A caller who wants "the"
    // rank takes the first; a caller building a skill page has the rest.
    return entry.skills
      .filter((skill) => skill.rank !== null)
      .map((skill) => ({
        ref,
        queue: skill.name,
        tier: skill.level === null ? null : `Level ${skill.level}`,
        division: null,
        tierPoints: skill.xp,
        rating: null,
        position: skill.rank,
        percentilePermille: null,
        wins: null,
        losses: null,
        season: null,
        raw: skill,
      }));
  }
}

/** Old School RuneScape. */
export class OldSchoolRuneScapeClient extends RuneScapeClient {
  protected override game(): RuneScapeGame {
    return "osrs";
  }
}

/** RuneScape, the modern line. */
export class RuneScapeClient3 extends RuneScapeClient {
  protected override game(): RuneScapeGame {
    return "rs3";
  }
}

// ---------------------------------------------------------------------------
// EVE Online
// ---------------------------------------------------------------------------

/**
 * EVE Online.
 *
 * The public half of ESI: who a character is, who they fly for, and how far
 * their security status has fallen. Everything a caller would need a login for
 * — assets, wallet, skills — is out of scope, and the registry does not claim
 * it.
 */
export class EveOnlineClient extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    const eve = providers.eve(this.runtime);

    // A numeric id is already the answer; a name has to be looked up. Both are
    // accepted because a caller storing ids should not have to pretend to have
    // a name.
    const id = int(query.accountId);
    if (id !== null && id > 0) {
      const character = await eve.getCharacter(id);
      return this.ref({
        providerId: "eve-esi",
        id: String(character.id),
        displayName: character.name,
        platform: "web",
      });
    }

    const name = str(query.name);
    if (!name) {
      throw new ValidationError("EVE Online needs a character `name` or a numeric `accountId`");
    }
    const found = await eve.resolveCharacter(name);
    return this.ref({
      providerId: "eve-esi",
      id: String(found.id),
      displayName: found.name,
      platform: "web",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const eve = providers.eve(this.runtime);
    const character = await eve.getCharacter(Number(ref.id));

    // The corporation is the closest thing EVE has to a clan, and it is one
    // extra call. Alliances are looked up only when the character is in one.
    const corporation = character.corporationId
      ? await eve.getCorporation(character.corporationId)
      : null;

    return {
      ref,
      displayName: character.name,
      level: null,
      avatarUrl: `https://images.evetech.net/characters/${character.id}/portrait`,
      profileUrl: null,
      createdAt: character.birthday ? Date.parse(character.birthday) || null : null,
      lastSeenAt: null,
      country: null,
      clan: corporation?.name ?? null,
      isPrivate: false,
      raw: { character, corporation },
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const eve = providers.eve(this.runtime);
    const character = await eve.getCharacter(Number(ref.id));
    // The corporation and the alliance are two independent lookups that both
    // need only the ids the character record already carried. Sequentially they
    // are two round trips deep for one profile page; together they are one.
    const [corporation, alliance] = await Promise.all([
      character.corporationId ? eve.getCorporation(character.corporationId) : null,
      character.allianceId ? eve.getAlliance(character.allianceId) : null,
    ]);

    return playerStats({
      ref,
      modes: {
        standing: modeStats({
          id: "standing",
          label: "Standing",
          extra: {
            // Permille, because -4.9 and -5.0 mean different things at a gate
            // and rounding to an integer would lose exactly that difference.
            securityStatusPermille:
              character.securityStatus === null
                ? null
                : Math.round(character.securityStatus * 1_000),
            corporation: corporation?.name ?? null,
            corporationTicker: corporation?.ticker ?? null,
            alliance: alliance?.name ?? null,
            allianceTicker: alliance?.ticker ?? null,
          },
        }),
      },
      raw: { character, corporation, alliance },
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const character = await providers.eve(this.runtime).getCharacter(Number(ref.id));
    if (character.securityStatus === null) return [];

    return [
      {
        ref,
        queue: "security-status",
        tier: null,
        division: null,
        tierPoints: null,
        rating: Math.round(character.securityStatus * 1_000),
        position: null,
        percentilePermille: null,
        wins: null,
        losses: null,
        season: null,
        raw: character,
      },
    ];
  }

  public override async getMetadata(kind = "status"): Promise<unknown> {
    this.require("getMetadata");
    if (kind !== "status") {
      throw new ValidationError(`EVE Online exposes "status"; asked for "${kind}"`);
    }
    return providers.eve(this.runtime).getServerStatus();
  }
}

// ---------------------------------------------------------------------------
// Diablo III
// ---------------------------------------------------------------------------

/**
 * Diablo III.
 *
 * A career is a list of heroes and a paragon level; the ladder is the seasonal
 * Greater Rift leaderboard. Both come from Blizzard's own API, on the same
 * credential as World of Warcraft and StarCraft II.
 *
 * # The leaderboard is a leaderboard of parties
 *
 * A four-player Greater Rift record belongs to the group that set it. The entry
 * therefore names one of them and carries the rest in `raw`, rather than being
 * split into four rows that would each claim the same clear.
 */
export class DiabloThreeClient extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    const tag = str(query.battleTag ?? query.name);
    if (!tag) {
      throw new ValidationError("Diablo III is looked up by BattleTag; pass `battleTag`");
    }
    const region = this.region(query.region, "us");
    const profile = await providers.blizzard(this.runtime).getD3Profile(region, tag);
    return this.ref({
      providerId: "blizzard",
      id: tag.replace("#", "-"),
      displayName: str(profile.battleTag) ?? tag,
      region,
      platform: "battlenet",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const profile = await providers
      .blizzard(this.runtime)
      .getD3Profile(ref.region ?? "us", ref.id);
    return {
      ref,
      displayName: str(profile.battleTag) ?? ref.id,
      level: int(profile.paragonLevel),
      avatarUrl: null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: int(profile.lastUpdated) === null ? null : int(profile.lastUpdated)! * 1_000,
      country: null,
      clan: str(profile.guildName),
      isPrivate: false,
      raw: profile,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const profile = await providers
      .blizzard(this.runtime)
      .getD3Profile(ref.region ?? "us", ref.id);

    // One mode per hero. A dead hero is still a hero and is reported, because
    // hardcore deaths are the statistic that Diablo players actually discuss.
    const modes: Record<string, ModeStats> = {};
    const heroes = Array.isArray(profile.heroes) ? profile.heroes : [];
    for (const raw of heroes) {
      const hero = (raw ?? {}) as Record<string, unknown>;
      const id = str(hero.id) ?? String(Object.keys(modes).length);
      modes[`hero:${id}`] = modeStats({
        id: `hero:${id}`,
        label: str(hero.name) ?? `Hero ${id}`,
        extra: {
          class: str(hero.class),
          level: int(hero.level),
          paragonLevel: int(hero.paragonLevel),
          hardcore: hero.hardcore === true ? "true" : "false",
          seasonal: hero.seasonal === true ? "true" : "false",
          dead: hero.dead === true ? "true" : "false",
        },
      });
    }

    const kills = (profile.kills ?? {}) as Record<string, unknown>;
    return playerStats({
      ref,
      kills: int(kills.elites),
      modes,
      raw: profile,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const profile = await providers
      .blizzard(this.runtime)
      .getD3Profile(ref.region ?? "us", ref.id);

    const paragon = int(profile.paragonLevel);
    const seasonal = int(profile.paragonLevelSeason);
    const ranks: RankInfo[] = [];

    // Paragon is the only persistent number Diablo III has that everybody
    // compares. It is a level rather than a rating, and it is reported as one.
    if (paragon !== null) {
      ranks.push({
        ref,
        queue: "paragon",
        tier: `Paragon ${paragon}`,
        division: null,
        tierPoints: paragon,
        rating: null,
        position: null,
        percentilePermille: null,
        wins: null,
        losses: null,
        season: null,
        raw: profile,
      });
    }
    if (seasonal !== null) {
      ranks.push({
        ref,
        queue: "paragon-season",
        tier: `Paragon ${seasonal}`,
        division: null,
        tierPoints: seasonal,
        rating: null,
        position: null,
        percentilePermille: null,
        wins: null,
        losses: null,
        season: str(profile.seasonalProfiles ? "current" : null),
        raw: profile,
      });
    }
    return ranks;
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const region = this.region(options.region, "us");
    const board = str(options.queue) ?? "rift-barbarian";

    // A season has to be named. Guessing "the current one" would mean caching a
    // number that changes without warning, so the season index is asked for and
    // the highest one is used when the caller does not say.
    const season = int(options.season) ?? (await this.currentSeason(region));
    if (season === null) {
      throw new NotFoundError("blizzard", "a Diablo III season", "diablo-3");
    }

    const payload = await providers
      .blizzard(this.runtime)
      .getD3SeasonLeaderboard(region, season, board);
    const rows = Array.isArray((payload ?? {}).row) ? ((payload as Record<string, unknown>).row as unknown[]) : [];

    return rows.slice(0, this.limit(options.limit, 50)).map((raw, index) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      const players = Array.isArray(row.player) ? (row.player as Record<string, unknown>[]) : [];
      const first = (players[0] ?? {}) as Record<string, unknown>;
      const data = Array.isArray(row.data) ? (row.data as Record<string, unknown>[]) : [];
      const riftLevel = data.find((entry) => entry.id === "RiftLevel");
      const name = str(first.data) ?? str(first.accountId);

      return {
        position: index + 1,
        playerId: str(first.accountId) ?? name,
        displayName: name ?? `Party ${index + 1}`,
        rating: int((riftLevel ?? {}).number),
        tier: null,
        wins: null,
        losses: null,
        country: null,
        raw: row,
      };
    });
  }

  public override async getMetadata(kind = "seasons"): Promise<unknown> {
    this.require("getMetadata");
    if (kind !== "seasons") {
      throw new ValidationError(`Diablo III exposes "seasons"; asked for "${kind}"`);
    }
    return providers.blizzard(this.runtime).getD3SeasonIndex("us");
  }

  /** The highest season Blizzard lists, used when the caller names none. */
  private async currentSeason(region: string): Promise<number | null> {
    const index = await providers.blizzard(this.runtime).getD3SeasonIndex(region);
    const current = int((index ?? {}).currentSeason);
    if (current !== null) return current;
    const seasons = Array.isArray((index ?? {}).season) ? ((index as Record<string, unknown>).season as unknown[]) : [];
    const numbers = seasons
      .map((entry) => int((entry as Record<string, unknown>)?.seasonId))
      .filter((value): value is number => value !== null);
    return numbers.length > 0 ? Math.max(...numbers) : null;
  }
}
