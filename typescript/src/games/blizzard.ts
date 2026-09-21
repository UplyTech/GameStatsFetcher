/**
 * The Blizzard titles.
 *
 * Blizzard's API coverage is uneven in a way that shows up directly in these
 * clients: World of Warcraft has a full profile API, StarCraft II has one that
 * cannot find a player by name, Overwatch has none at all, and Hearthstone has
 * a card database and nothing about players. Each client uses the source that
 * actually has the data, which for three of the six is not Blizzard.
 */

import { TitleClient, isPlayerRef } from "../title-client.js";
import * as providers from "../providers/index.js";
import { NotFoundError, ValidationError } from "../errors.js";
import {
  asArray,
  int,
  matchResult,
  modeStats,
  num,
  playerStats,
  str,
  sum,
  ts,
} from "../normalize.js";
import type {
  LeaderboardEntry,
  LeaderboardOptions,
  MatchHistoryOptions,
  MatchSummary,
  PlayerProfile,
  PlayerQuery,
  PlayerRef,
  PlayerStats,
  RankInfo,
} from "../types.js";

// ---------------------------------------------------------------------------
// Overwatch 2
// ---------------------------------------------------------------------------

/**
 * Overwatch 2, through OverFast.
 *
 * OverFast reads the official career pages, so it sees exactly what Blizzard
 * publishes: career totals and per-role competitive ranks, but **no match
 * history** - Blizzard has never published one. The title reflects that.
 */
export class Overwatch2Client extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const tag = query.battleTag ?? query.name;
    if (!tag) throw new ValidationError("Overwatch 2 needs a BattleTag, e.g. Player#1234");
    const summary = await providers.overfast(this.runtime).getSummary(tag);
    return this.ref({
      providerId: "overfast",
      id: tag,
      displayName: summary.username,
      platform: "battlenet",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const summary = await providers.overfast(this.runtime).getSummary(ref.id);
    return {
      ref,
      displayName: summary.username,
      level: summary.endorsement?.level ?? null,
      avatarUrl: summary.avatar ?? null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: null,
      country: null,
      clan: null,
      isPrivate: summary.privacy === "private",
      raw: summary,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const stats = await providers.overfast(this.runtime).getStats(ref.id);

    // OverFast nests as platform -> gamemode -> careerStats -> hero -> category.
    const heroes = (stats.heroes_comparisons as Record<string, unknown>) ?? {};
    const career = (stats.career_stats as Record<string, unknown>) ?? {};
    const general = asArray<Record<string, unknown>>(
      (career["all-heroes"] as Record<string, unknown>[] | undefined) ?? [],
    );

    const flat: Record<string, number> = {};
    for (const category of general) {
      for (const entry of asArray<Record<string, unknown>>(category.stats)) {
        const key = str(entry.key);
        const value = num(entry.value);
        if (key && value !== null) flat[key] = value;
      }
    }

    const modes: Record<string, ReturnType<typeof modeStats>> = {};
    const timePlayed = (heroes.time_played as Record<string, unknown> | undefined)?.values;
    for (const entry of asArray<Record<string, unknown>>(timePlayed)) {
      const hero = str(entry.hero);
      if (!hero) continue;
      modes[hero] = modeStats({
        id: hero,
        label: str(entry.hero_display_name) ?? hero,
        extra: { timePlayedSeconds: num(entry.value) },
      });
    }

    return playerStats({
      ref,
      matchesPlayed: flat.games_played ?? null,
      wins: flat.games_won ?? null,
      losses: flat.games_lost ?? null,
      kills: flat.eliminations ?? null,
      deaths: flat.deaths ?? null,
      timePlayedSeconds: flat.time_played ?? null,
      modes,
      raw: stats,
    });
  }

  /** One rank per role - tank, damage and support are ranked separately. */
  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const summary = await providers.overfast(this.runtime).getSummary(ref.id);
    const ranks: RankInfo[] = [];

    for (const [platform, modes] of Object.entries(summary.competitive ?? {})) {
      if (!modes) continue;
      for (const [role, entry] of Object.entries(modes)) {
        if (!entry || typeof entry !== "object") continue;
        ranks.push({
          ref,
          queue: `${platform}:${role}`,
          tier: entry.division ? entry.division.charAt(0).toUpperCase() + entry.division.slice(1) : null,
          division: entry.tier !== undefined ? String(entry.tier) : null,
          tierPoints: entry.tier ?? null,
          rating: null,
          position: null,
          percentilePermille: null,
          wins: null,
          losses: null,
          season: null,
          raw: entry,
        });
      }
    }
    return ranks;
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    // Blizzard publishes no Overwatch ladder, so the closest honest answer is
    // the player search - and saying so beats returning an invented ranking.
    const rows = await providers
      .overfast(this.runtime)
      .searchPlayers(options.queue ?? "", this.limit(options.limit, 20));
    return rows.map((row, index) => ({
      position: index + 1,
      playerId: str(row.player_id),
      displayName: str(row.name),
      rating: null,
      tier: null,
      wins: null,
      losses: null,
      country: null,
      raw: row,
    }));
  }

  public override async getMetadata(kind = "heroes"): Promise<unknown> {
    this.require("getMetadata");
    const overfast = providers.overfast(this.runtime);
    if (kind === "heroes") return overfast.getHeroes();
    if (kind === "maps") return overfast.getMaps();
    throw new ValidationError(`Overwatch metadata "${kind}" is not available - try heroes or maps`);
  }
}

// ---------------------------------------------------------------------------
// StarCraft II
// ---------------------------------------------------------------------------

/**
 * StarCraft II, through SC2Pulse.
 *
 * Blizzard's own API cannot find a player by BattleTag and cannot see across
 * regions. SC2Pulse does both, which is why it is the primary provider even
 * though a first-party option exists.
 */
export class StarCraft2Client extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const term = String(query.battleTag ?? query.name ?? query.accountId ?? "");
    const results = await providers.sc2pulse(this.runtime).searchCharacters(term);
    const first = results[0];
    const character = (first?.members as Record<string, unknown> | undefined)?.character as
      | Record<string, unknown>
      | undefined;
    const id = str(character?.id);
    if (!id) throw new NotFoundError("sc2pulse", `SC2 player "${term}"`, this.title.id);

    return this.ref({
      providerId: "sc2pulse",
      id,
      displayName: str(character?.name) ?? term,
      platform: "battlenet",
      region: str(character?.region),
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const summary = await providers.sc2pulse(this.runtime).getCharacterSummary(ref.id);
    return {
      ref,
      displayName: ref.displayName ?? ref.id,
      level: null,
      avatarUrl: null,
      profileUrl: `https://sc2pulse.nephest.com/sc2/?type=character&id=${ref.id}&m=1`,
      createdAt: null,
      lastSeenAt: null,
      country: null,
      clan: null,
      isPrivate: false,
      raw: summary,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const summary = await providers.sc2pulse(this.runtime).getCharacterSummary(ref.id);

    const modes: Record<string, ReturnType<typeof modeStats>> = {};
    for (const row of summary) {
      const race = str(row.race) ?? "ALL";
      modes[race] = modeStats({
        id: race,
        label: race,
        matchesPlayed: int(row.games),
        extra: { mmr: int(row.ratingLast ?? row.ratingMax), maxMmr: int(row.ratingMax) },
      });
    }

    return playerStats({
      ref,
      matchesPlayed: sum(summary.map((row) => int(row.games))),
      modes,
      raw: summary,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const summary = await providers.sc2pulse(this.runtime).getCharacterSummary(ref.id);
    return summary.map((row) => ({
      ref,
      queue: `1v1:${str(row.race) ?? "ALL"}`,
      tier: null,
      division: null,
      tierPoints: null,
      rating: int(row.ratingLast),
      position: null,
      percentilePermille: null,
      wins: null,
      losses: null,
      season: null,
      raw: row,
    }));
  }

  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const matches = await providers.sc2pulse(this.runtime).getCharacterMatches(ref.id);

    return matches.slice(0, this.limit(options.limit)).map((row) => {
      const match = (row.match as Record<string, unknown>) ?? {};
      return {
        matchId: String(match.id ?? ""),
        titleId: this.title.id,
        mode: str(match.type) ?? "1v1",
        map: str((row.map as Record<string, unknown> | undefined)?.name),
        startedAt: ts(match.date),
        durationSeconds: int(match.duration),
        result: matchResult(str(row.decision)?.toUpperCase() === "WIN"),
        playerStats: null,
        raw: row,
      };
    });
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const region = options.region ?? "eu";
    const regionId = { us: 1, eu: 2, kr: 3, tw: 3 }[region.toLowerCase()] ?? 2;
    const ladder = await providers
      .blizzard(this.runtime)
      .getSc2GrandmasterLadder(region, regionId);

    return (ladder?.ladderTeams ?? [])
      .slice(0, this.limit(options.limit, 100))
      .map((team, index) => {
        const members = asArray<Record<string, unknown>>(team.teamMembers);
        return {
          position: index + 1,
          playerId: str(members[0]?.id),
          displayName: str(members[0]?.displayName),
          rating: int(team.mmr ?? team.points),
          tier: "Grandmaster",
          wins: int(team.wins),
          losses: int(team.losses),
          country: null,
          raw: team,
        };
      });
  }
}

// ---------------------------------------------------------------------------
// Warcraft III
// ---------------------------------------------------------------------------

/** Warcraft III, through W3Champions - the ladder the game is actually played on. */
export class Warcraft3Client extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const tag = String(query.battleTag ?? query.name ?? "");
    const player = await providers.w3champions(this.runtime).getPlayer(tag);
    return this.ref({
      providerId: "w3champions",
      id: tag,
      displayName: str(player.name) ?? tag,
      platform: "battlenet",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.w3champions(this.runtime).getPlayer(ref.id);
    return {
      ref,
      displayName: str(player.name) ?? ref.id,
      level: null,
      avatarUrl: null,
      profileUrl: `https://w3champions.com/player/${encodeURIComponent(ref.id)}`,
      createdAt: null,
      lastSeenAt: null,
      country: str(player.location),
      clan: null,
      isPrivate: false,
      raw: player,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const stats = await providers.w3champions(this.runtime).getPlayerStats(ref.id);

    const modes: Record<string, ReturnType<typeof modeStats>> = {};
    for (const row of stats) {
      const key = `${str(row.gameMode) ?? "1v1"}:${str(row.race) ?? "RANDOM"}`;
      modes[key] = modeStats({
        id: key,
        wins: int(row.wins),
        losses: int(row.losses),
        extra: { mmr: int(row.mmr), rank: int(row.rank), league: int(row.leagueId) },
      });
    }

    return playerStats({
      ref,
      wins: sum(stats.map((row) => int(row.wins))),
      losses: sum(stats.map((row) => int(row.losses))),
      modes,
      raw: stats,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const stats = await providers.w3champions(this.runtime).getPlayerStats(ref.id);
    return stats.map((row) => ({
      ref,
      queue: `${str(row.gameMode) ?? "1v1"}:${str(row.race) ?? "RANDOM"}`,
      tier: str(row.leagueName),
      division: str(row.division),
      tierPoints: null,
      rating: int(row.mmr),
      position: int(row.rank),
      percentilePermille: null,
      wins: int(row.wins),
      losses: int(row.losses),
      season: str(row.season),
      raw: row,
    }));
  }

  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const matches = await providers.w3champions(this.runtime).getMatches(ref.id, {
      limit: this.limit(options.limit),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
    });

    return matches.map((match) => {
      const teams = asArray<Record<string, unknown>>(match.teams);
      const myTeam = teams.find((team) =>
        asArray<Record<string, unknown>>(team.players).some(
          (player) => str(player.battleTag)?.toLowerCase() === ref.id.toLowerCase(),
        ),
      );
      return {
        matchId: String(match.id ?? ""),
        titleId: this.title.id,
        mode: str(match.gameMode),
        map: str(match.map),
        startedAt: ts(match.startTime),
        durationSeconds: int(match.durationInSeconds),
        result: myTeam ? matchResult(myTeam.won) : "unknown",
        playerStats: null,
        raw: match,
      };
    });
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const gateway = { eu: 20, us: 10, kr: 30 }[(options.region ?? "eu").toLowerCase()] ?? 20;
    const ladder = await providers.w3champions(this.runtime).getLadder(1, { gateway });
    return ladder.slice(0, this.limit(options.limit, 100)).map((row, index) => ({
      position: int(row.rankNumber) ?? index + 1,
      playerId: str(row.playerId ?? row.id),
      displayName: str(row.player1Id ?? row.name),
      rating: int(row.rankingPoints ?? row.mmr),
      tier: str(row.leagueName),
      wins: int(row.wins),
      losses: int(row.losses),
      country: null,
      raw: row,
    }));
  }
}

// ---------------------------------------------------------------------------
// Heroes of the Storm
// ---------------------------------------------------------------------------

/** Heroes of the Storm, through Heroes Profile - replay-derived, like Ballchasing. */
export class HeroesOfTheStormClient extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const tag = String(query.battleTag ?? query.name ?? "");
    await providers.heroesProfile(this.runtime).getPlayer(tag);
    return this.ref({
      providerId: "heroesprofile",
      id: tag,
      displayName: tag,
      platform: "battlenet",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.heroesProfile(this.runtime).getPlayer(ref.id);
    return {
      ref,
      displayName: ref.displayName ?? ref.id,
      level: null,
      avatarUrl: null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: null,
      country: null,
      clan: null,
      isPrivate: false,
      raw: player,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const heroes = await providers.heroesProfile(this.runtime).getHeroStats(ref.id);

    const modes: Record<string, ReturnType<typeof modeStats>> = {};
    for (const [hero, row] of Object.entries(heroes)) {
      const stats = row as Record<string, unknown>;
      modes[hero] = modeStats({
        id: hero,
        wins: int(stats.wins),
        losses: int(stats.losses),
        extra: { mmr: int(stats.mmr) },
      });
    }

    return playerStats({
      ref,
      wins: sum(Object.values(modes).map((mode) => mode.wins)),
      losses: sum(Object.values(modes).map((mode) => mode.losses)),
      modes,
      raw: heroes,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const mmr = await providers.heroesProfile(this.runtime).getMatches(ref.id);
    const latest = mmr[0];
    if (!latest) return [];
    return [
      {
        ref,
        queue: str(latest.game_type) ?? "ranked",
        tier: null,
        division: null,
        tierPoints: null,
        rating: int(latest.mmr ?? latest.player_conservative_rating),
        position: null,
        percentilePermille: null,
        wins: null,
        losses: null,
        season: null,
        raw: latest,
      },
    ];
  }

  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const matches = await providers.heroesProfile(this.runtime).getMatches(ref.id);
    return matches.slice(0, this.limit(options.limit)).map((match) => ({
      matchId: String(match.replayID ?? match.replay_id ?? ""),
      titleId: this.title.id,
      mode: str(match.game_type),
      map: str(match.game_map),
      startedAt: ts(match.game_date),
      durationSeconds: int(match.game_length),
      result: matchResult(int(match.winner) === 1),
      playerStats: null,
      raw: match,
    }));
  }
}

// ---------------------------------------------------------------------------
// World of Warcraft
// ---------------------------------------------------------------------------

/**
 * World of Warcraft.
 *
 * Blizzard has the character and the arena brackets; Raider.IO has the Mythic+
 * score the competitive scene is organised around. Both are used, which is why
 * `getPlayerStats` merges them.
 */
export class WorldOfWarcraftClient extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const name = String(query.name ?? "");
    // WoW characters are `name-realm`; realm may also arrive in `extra.realm`.
    const [character, realmFromName] = name.includes("-") ? name.split("-") : [name, undefined];
    const realm = String(query.extra?.realm ?? realmFromName ?? "");
    if (!realm) {
      throw new ValidationError(
        'World of Warcraft needs a realm - pass name as "Character-Realm" or set extra.realm',
      );
    }
    const region = this.region(query.region, "eu");
    return this.ref({
      providerId: "blizzard",
      id: `${character}-${realm}`,
      displayName: character ?? name,
      platform: "battlenet",
      region,
    });
  }

  private split(ref: PlayerRef): { name: string; realm: string; region: string } {
    const [name, realm] = ref.id.split("-");
    return {
      name: (name ?? ref.id).toLowerCase(),
      realm: (realm ?? "").toLowerCase(),
      region: ref.region ?? "eu",
    };
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const { name, realm, region } = this.split(ref);
    const character = await providers
      .blizzard(this.runtime)
      .getWowCharacter(region, realm, name);

    return {
      ref,
      displayName: str(character.name) ?? ref.id,
      level: int(character.level),
      avatarUrl: null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: ts(character.last_login_timestamp),
      country: null,
      clan: str((character.guild as Record<string, unknown> | undefined)?.name),
      isPrivate: false,
      raw: character,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const { name, realm, region } = this.split(ref);
    const raiderio = await providers
      .raiderio(this.runtime)
      .getCharacter(region, realm, name)
      .catch(() => null);

    const scores = (raiderio?.mythic_plus_scores_by_season as Record<string, unknown>[] | undefined)?.[0];
    const segments = (scores?.scores as Record<string, number>) ?? {};

    return playerStats({
      ref,
      modes: Object.fromEntries(
        Object.entries(segments).map(([role, score]) => [
          role,
          modeStats({ id: role, extra: { score } }),
        ]),
      ),
      raw: raiderio,
    });
  }

  /** Arena and rated battleground standings. */
  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const { name, realm, region } = this.split(ref);
    const blizzard = providers.blizzard(this.runtime);

    const brackets = ["2v2", "3v3", "rbg"] as const;
    const results = await Promise.all(
      brackets.map((bracket) =>
        blizzard.getWowPvpBracket(region, realm, name, bracket).catch(() => null),
      ),
    );

    // A bracket the character has never played answers 404, which `catch`
    // turned into null above; those are dropped rather than reported as a rank
    // of zero.
    const ranks: RankInfo[] = [];
    results.forEach((bracket, index) => {
      if (!bracket) return;
      const statistics = bracket.season_match_statistics as Record<string, unknown> | undefined;
      ranks.push({
        ref,
        queue: brackets[index] as string,
        tier: null,
        division: null,
        tierPoints: null,
        rating: int(bracket.rating),
        position: null,
        percentilePermille: null,
        wins: int(statistics?.won),
        losses: int(statistics?.lost),
        season: str((bracket.season as Record<string, unknown> | undefined)?.id),
        raw: bracket,
      });
    });
    return ranks;
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const region = this.region(options.region, "eu");
    const season = Number(options.season ?? 37);
    const board = await providers
      .blizzard(this.runtime)
      .getWowPvpLeaderboard(region, season, options.queue ?? "3v3");

    return (board?.entries ?? []).slice(0, this.limit(options.limit, 100)).map((row) => {
      const character = row.character as Record<string, unknown> | undefined;
      const statistics = row.season_match_statistics as Record<string, unknown> | undefined;
      return {
        position: int(row.rank) ?? 0,
        playerId: str(character?.id),
        displayName: str(character?.name),
        rating: int(row.rating),
        tier: null,
        wins: int(statistics?.won),
        losses: int(statistics?.lost),
        country: null,
        raw: row,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Hearthstone
// ---------------------------------------------------------------------------

/**
 * Hearthstone.
 *
 * Metadata only. Blizzard has never published a Hearthstone player endpoint, so
 * the title declares `getMetadata` and the esports capabilities and nothing
 * else - asking it for a rank throws, which is the truthful answer.
 */
export class HearthstoneClient extends TitleClient {
  public override async getMetadata(kind = "metadata"): Promise<unknown> {
    this.require("getMetadata");
    const blizzard = providers.blizzard(this.runtime);
    if (kind === "cards") return blizzard.getHearthstoneCards("eu");
    if (kind === "metadata") return blizzard.getHearthstoneMetadata("eu");
    throw new ValidationError(
      `Hearthstone metadata "${kind}" is not available - try "cards" or "metadata"`,
    );
  }
}
