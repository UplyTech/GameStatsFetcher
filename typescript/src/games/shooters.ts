/**
 * The shooters.
 *
 * Apex Legends, Fortnite, PUBG, Rainbow Six Siege, Call of Duty, Battlefield,
 * Splitgate, Halo Infinite, Destiny 2, The Finals and Marvel Rivals.
 *
 * Four of these share one provider (Tracker), which is why
 * {@link TrackerBackedClient} exists: Ubisoft, Activision, EA and 1047 all
 * publish nothing, and the shape of what Tracker returns is identical for all
 * of them. Writing that mapping four times would have been four chances to get
 * it subtly different.
 */

import { TitleClient, isPlayerRef } from "../title-client.js";
import * as providers from "../providers/index.js";
import { DESTINY_PLATFORMS } from "../providers/bungie.js";
import { NotFoundError, ValidationError } from "../errors.js";
import {
  asArray,
  int,
  matchResult,
  modeStats,
  num,
  participantStats,
  playerStats,
  str,
  sum,
  ts,
} from "../normalize.js";
import type {
  LeaderboardEntry,
  LeaderboardOptions,
  MatchDetail,
  MatchHistoryOptions,
  MatchSummary,
  ModeStats,
  PlayerProfile,
  PlayerQuery,
  PlayerRef,
  PlayerStats,
  Platform,
  RankInfo,
} from "../types.js";

// ---------------------------------------------------------------------------
// Tracker-backed titles
// ---------------------------------------------------------------------------

/**
 * The four titles whose only source is Tracker Network.
 *
 * Tracker's schema is one `overview` segment of career totals plus a segment
 * per legend, operator, weapon or season. The subclasses differ only in which
 * segment type is interesting and what the default platform is.
 */
export class TrackerBackedClient extends TitleClient {
  /** Segment type holding the per-mode breakdown, when the title has one. */
  protected modeSegmentType(): string | null {
    return null;
  }

  protected defaultPlatform(): string {
    return "ubi";
  }

  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const identifier = String(query.name ?? query.ubisoftId ?? query.accountId ?? "");
    const platform = query.platform ?? this.defaultPlatform();
    const profile = await providers
      .tracker(this.runtime)
      .getProfile(this.title.id, String(platform), identifier);

    return this.ref({
      providerId: "tracker",
      id: profile.platformInfo?.platformUserId ?? identifier,
      displayName: profile.platformInfo?.platformUserHandle ?? identifier,
      platform: (query.platform ?? null) as Platform | null,
      region: null,
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const tracker = providers.tracker(this.runtime);
    const profile = await tracker.getProfile(
      this.title.id,
      ref.platform ?? this.defaultPlatform(),
      ref.displayName ?? ref.id,
    );
    const overview = tracker.segment(profile, "overview");
    const stats = tracker.flattenStats(overview);

    return {
      ref,
      displayName: profile.platformInfo?.platformUserHandle ?? ref.id,
      level: stats.level ?? null,
      avatarUrl: profile.platformInfo?.avatarUrl ?? null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: null,
      country: profile.userInfo?.countryCode ?? null,
      clan: null,
      isPrivate: false,
      raw: profile,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const tracker = providers.tracker(this.runtime);
    const profile = await tracker.getProfile(
      this.title.id,
      ref.platform ?? this.defaultPlatform(),
      ref.displayName ?? ref.id,
    );
    const overview = tracker.segment(profile, "overview");
    const stats = tracker.flattenStats(overview);

    const modes: Record<string, ModeStats> = {};
    const segmentType = this.modeSegmentType();
    if (segmentType) {
      for (const segment of profile.segments ?? []) {
        if (segment.type !== segmentType) continue;
        const id = String(segment.attributes?.key ?? segment.metadata?.name ?? "unknown");
        const segmentStats = tracker.flattenStats(segment);
        modes[id] = modeStats({
          id,
          label: String(segment.metadata?.name ?? id),
          wins: segmentStats.wins ?? null,
          losses: segmentStats.losses ?? null,
          kills: segmentStats.kills ?? null,
          deaths: segmentStats.deaths ?? null,
          extra: segmentStats,
        });
      }
    }

    return playerStats({
      ref,
      matchesPlayed: stats.matchesPlayed ?? stats.gamesPlayed ?? null,
      wins: stats.wins ?? stats.matchesWon ?? null,
      losses: stats.losses ?? stats.matchesLost ?? null,
      kills: stats.kills ?? null,
      deaths: stats.deaths ?? null,
      assists: stats.assists ?? null,
      timePlayedSeconds: stats.timePlayed ?? null,
      modes,
      raw: profile,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const tracker = providers.tracker(this.runtime);
    const profile = await tracker.getProfile(
      this.title.id,
      ref.platform ?? this.defaultPlatform(),
      ref.displayName ?? ref.id,
    );
    const overview = tracker.segment(profile, "overview");
    const rankStat = overview?.stats?.rankScore ?? overview?.stats?.mmr ?? overview?.stats?.rank;
    if (!rankStat) return [];

    return [
      {
        ref,
        queue: "ranked",
        tier: str(rankStat.metadata?.tierName ?? rankStat.metadata?.name),
        division: str(rankStat.metadata?.divisionName),
        tierPoints: null,
        rating: num(rankStat.value),
        position: rankStat.rank ?? null,
        // Tracker's percentile is 0..100 with one decimal; the model wants
        // permille, so 43.7 becomes 437.
        percentilePermille:
          rankStat.percentile !== null && rankStat.percentile !== undefined
            ? Math.round(rankStat.percentile * 10)
            : null,
        wins: null,
        losses: null,
        season: null,
        raw: overview,
      },
    ];
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const rows = await providers
      .tracker(this.runtime)
      .getLeaderboard(this.title.id, options.queue ?? "Ranked", {
        ...(options.platform ? { platform: options.platform } : {}),
        take: this.limit(options.limit, 50),
        ...(options.offset !== undefined ? { skip: options.offset } : {}),
      });
    return rows.map((row, index) => ({
      position: int(row.rank) ?? (options.offset ?? 0) + index + 1,
      playerId: str((row.owner as Record<string, unknown> | undefined)?.id),
      displayName: str((row.owner as Record<string, unknown> | undefined)?.metadata
        ? ((row.owner as Record<string, Record<string, unknown>>).metadata?.platformUserHandle as string)
        : null),
      rating: num(row.value),
      tier: null,
      wins: null,
      losses: null,
      country: null,
      raw: row,
    }));
  }
}

/** Rainbow Six Siege. Segments are per operator. */
export class RainbowSixClient extends TrackerBackedClient {
  protected override modeSegmentType(): string {
    return "operator";
  }
  protected override defaultPlatform(): string {
    return "ubi";
  }
}

/** Call of Duty. Warzone by default - Tracker keys the modes separately. */
export class CallOfDutyClient extends TrackerBackedClient {
  protected override modeSegmentType(): string {
    return "mode";
  }
  protected override defaultPlatform(): string {
    return "battlenet";
  }
}

/** Battlefield. */
export class BattlefieldClient extends TrackerBackedClient {
  protected override modeSegmentType(): string {
    return "weapon";
  }
  protected override defaultPlatform(): string {
    return "origin";
  }
}

/** Splitgate. */
export class SplitgateClient extends TrackerBackedClient {
  protected override defaultPlatform(): string {
    return "steam";
  }
}

// ---------------------------------------------------------------------------
// Apex Legends
// ---------------------------------------------------------------------------

/**
 * Apex Legends.
 *
 * ApexLegendsAPI is preferred over Tracker because it carries the ranked ladder
 * points, which Tracker exposes only as a tier name. Names are not unique
 * across platforms, so the platform travels on the ref.
 */
export class ApexLegendsClient extends TitleClient {
  private platformFor(value: string | undefined): "PC" | "X1" | "PS4" | "SWITCH" {
    switch ((value ?? "origin").toLowerCase()) {
      case "xbox":
        return "X1";
      case "playstation":
        return "PS4";
      case "nintendo":
        return "SWITCH";
      default:
        return "PC";
    }
  }

  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const platform = this.platformFor(query.platform);
    const name = String(query.name ?? "");
    const player = query.accountId
      ? await providers.apex(this.runtime).getPlayerByUid(String(query.accountId), platform)
      : await providers.apex(this.runtime).getPlayer(name, platform);
    const global = player.global as Record<string, unknown> | undefined;

    return this.ref({
      providerId: "apex-legends-api",
      id: String(global?.uid ?? name),
      displayName: str(global?.name) ?? name,
      platform: (query.platform ?? "origin") as Platform,
    });
  }

  private async fetch(ref: PlayerRef): Promise<Record<string, unknown>> {
    const platform = this.platformFor(ref.platform ?? undefined);
    return /^\d+$/.test(ref.id)
      ? providers.apex(this.runtime).getPlayerByUid(ref.id, platform)
      : providers.apex(this.runtime).getPlayer(ref.displayName ?? ref.id, platform);
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await this.fetch(ref);
    const global = (player.global as Record<string, unknown>) ?? {};

    return {
      ref,
      displayName: str(global.name) ?? ref.id,
      level: int(global.level),
      avatarUrl: str(global.avatar),
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
    const player = await this.fetch(ref);
    const legends = (player.legends as Record<string, unknown> | undefined)?.all as
      | Record<string, Record<string, unknown>>
      | undefined;
    const total = (player.total as Record<string, Record<string, unknown>>) ?? {};

    const modes: Record<string, ModeStats> = {};
    for (const [legend, data] of Object.entries(legends ?? {})) {
      const trackers = asArray<Record<string, unknown>>(data.data);
      if (trackers.length === 0) continue;
      const extra: Record<string, number | string | null> = {};
      for (const tracker of trackers) {
        const key = str(tracker.key);
        if (key) extra[key] = num(tracker.value);
      }
      modes[legend] = modeStats({ id: legend, label: legend, extra });
    }

    return playerStats({
      ref,
      kills: int(total.kills?.value),
      deaths: int(total.deaths?.value),
      modes,
      raw: player,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await this.fetch(ref);
    const global = (player.global as Record<string, unknown>) ?? {};
    const ranked = global.rank as Record<string, unknown> | undefined;
    const arena = global.arena as Record<string, unknown> | undefined;

    const rows: RankInfo[] = [];
    for (const [queue, entry] of [
      ["battle-royale", ranked],
      ["arenas", arena],
    ] as const) {
      if (!entry) continue;
      rows.push({
        ref,
        queue,
        tier: str(entry.rankName),
        division: str(entry.rankDiv),
        tierPoints: int(entry.rankScore),
        rating: int(entry.rankScore),
        position: int(entry.ladderPosPlatform) ?? null,
        percentilePermille: null,
        wins: null,
        losses: null,
        season: null,
        raw: entry,
      });
    }
    return rows;
  }

  /** Predator and Master cutoffs - the closest thing Apex has to a ladder. */
  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const cutoff = await providers.apex(this.runtime).getPredatorCutoff();
    const rank = (cutoff?.RP as Record<string, Record<string, unknown>>) ?? {};
    return Object.entries(rank)
      .slice(0, this.limit(options.limit, 10))
      .map(([platform, entry], index) => ({
        position: index + 1,
        playerId: null,
        displayName: platform,
        rating: int(entry.val),
        tier: "Apex Predator cutoff",
        wins: null,
        losses: null,
        country: null,
        raw: entry,
      }));
  }
}

// ---------------------------------------------------------------------------
// Fortnite
// ---------------------------------------------------------------------------

/**
 * Fortnite.
 *
 * A player who has hidden their stats in-game is invisible whatever key you
 * hold, so a 403 here means an in-game setting rather than a bad credential -
 * the provider turns that into a clear message.
 */
export class FortniteClient extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const name = String(query.name ?? query.epicId ?? "");
    const stats = query.epicId
      ? await providers.fortnite(this.runtime).getStatsById(String(query.epicId))
      : await providers.fortnite(this.runtime).getStatsByName(name);
    const account = stats.account as Record<string, unknown> | undefined;

    return this.ref({
      providerId: "fortnite-api",
      id: String(account?.id ?? name),
      displayName: str(account?.name) ?? name,
      platform: (query.platform ?? "epic") as Platform,
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const stats = await providers.fortnite(this.runtime).getStatsById(ref.id);
    const account = (stats.account as Record<string, unknown>) ?? {};
    const battlePass = stats.battlePass as Record<string, unknown> | undefined;

    return {
      ref,
      displayName: str(account.name) ?? ref.id,
      level: int(battlePass?.level),
      avatarUrl: null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: null,
      country: null,
      clan: null,
      isPrivate: false,
      raw: stats,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const stats = await providers.fortnite(this.runtime).getStatsById(ref.id);
    const all = (stats.stats as Record<string, unknown> | undefined)?.all as
      | Record<string, Record<string, unknown>>
      | undefined;
    const overall = all?.overall ?? {};

    const modes: Record<string, ModeStats> = {};
    for (const [mode, data] of Object.entries(all ?? {})) {
      if (mode === "overall" || !data) continue;
      modes[mode] = modeStats({
        id: mode,
        matchesPlayed: int(data.matches),
        wins: int(data.wins),
        losses:
          int(data.matches) !== null && int(data.wins) !== null
            ? (int(data.matches) as number) - (int(data.wins) as number)
            : null,
        kills: int(data.kills),
        deaths: int(data.deaths),
        extra: {
          top10: int(data.top10),
          killsPerMatch: num(data.killsPerMatch),
          minutesPlayed: int(data.minutesPlayed),
        },
      });
    }

    return playerStats({
      ref,
      matchesPlayed: int(overall.matches),
      wins: int(overall.wins),
      losses:
        int(overall.matches) !== null && int(overall.wins) !== null
          ? (int(overall.matches) as number) - (int(overall.wins) as number)
          : null,
      kills: int(overall.kills),
      deaths: int(overall.deaths),
      timePlayedSeconds:
        int(overall.minutesPlayed) !== null ? (int(overall.minutesPlayed) as number) * 60 : null,
      modes,
      raw: stats,
    });
  }

  /**
   * Fortnite has no persistent rank the API exposes.
   *
   * Ranked mode exists in-game but is not published, so this returns an empty
   * list rather than dressing the battle pass level up as a rank.
   */
  public override async getRank(_query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    return [];
  }

  public override async getLeaderboard(
    _options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    throw new NotFoundError(
      "fortnite-api",
      "Fortnite ladder (Epic publishes none; use getEsportsTournaments for competitive results)",
      this.title.id,
    );
  }

  public override async getMetadata(kind = "cosmetics"): Promise<unknown> {
    this.require("getMetadata");
    const fortnite = providers.fortnite(this.runtime);
    if (kind === "cosmetics") return fortnite.getCosmetics();
    if (kind === "playlists") return fortnite.getPlaylists();
    throw new ValidationError(
      `Fortnite metadata "${kind}" is not available - try cosmetics or playlists`,
    );
  }
}

// ---------------------------------------------------------------------------
// PUBG
// ---------------------------------------------------------------------------

/**
 * PUBG: Battlegrounds.
 *
 * The tightest quota of any first-party API here - ten requests a minute - so
 * this client resolves once, caches hard, and never fans out over match ids
 * unless asked to.
 */
export class PubgClient extends TitleClient {
  private shard(value: string | undefined): string {
    return value ?? "steam";
  }

  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const shard = this.shard(query.region);
    const player = query.accountId
      ? await providers.pubg(this.runtime).getPlayerById(shard, String(query.accountId))
      : await providers.pubg(this.runtime).getPlayerByName(shard, String(query.name));

    return this.ref({
      providerId: "pubg",
      id: player.id,
      displayName: player.attributes.name,
      region: shard,
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers
      .pubg(this.runtime)
      .getPlayerById(this.shard(ref.region ?? undefined), ref.id);
    return {
      ref,
      displayName: player.attributes.name,
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
    const shard = this.shard(ref.region ?? undefined);
    const byMode = await providers.pubg(this.runtime).getLifetimeStats(shard, ref.id);

    const modes: Record<string, ModeStats> = {};
    for (const [mode, stats] of Object.entries(byMode)) {
      modes[mode] = modeStats({
        id: mode,
        matchesPlayed: stats.roundsPlayed,
        wins: stats.wins,
        losses: stats.losses,
        kills: stats.kills,
        assists: stats.assists,
        extra: {
          top10s: stats.top10s,
          damageDealt: Math.round(stats.damageDealt),
          headshotKills: stats.headshotKills,
          longestKill: Math.round(stats.longestKill),
          timeSurvived: Math.round(stats.timeSurvived),
          revives: stats.revives,
        },
      });
    }

    const all = Object.values(byMode);
    return playerStats({
      ref,
      matchesPlayed: sum(all.map((stats) => stats.roundsPlayed)),
      wins: sum(all.map((stats) => stats.wins)),
      losses: sum(all.map((stats) => stats.losses)),
      kills: sum(all.map((stats) => stats.kills)),
      assists: sum(all.map((stats) => stats.assists)),
      timePlayedSeconds: sum(all.map((stats) => Math.round(stats.timeSurvived))),
      modes,
      raw: byMode,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const shard = this.shard(ref.region ?? undefined);
    const pubg = providers.pubg(this.runtime);
    const seasonId = await pubg.getCurrentSeasonId(shard);
    const ranked = await pubg.getRankedStats(shard, ref.id, seasonId);

    return Object.entries(ranked).map(([mode, stats]) => {
      const tier = stats.currentTier as Record<string, unknown> | undefined;
      return {
        ref,
        queue: mode,
        tier: str(tier?.tier),
        division: str(tier?.subTier),
        tierPoints: int(stats.currentRankPoint),
        rating: int(stats.currentRankPoint),
        position: null,
        percentilePermille: null,
        wins: int(stats.wins),
        losses:
          int(stats.roundsPlayed) !== null && int(stats.wins) !== null
            ? (int(stats.roundsPlayed) as number) - (int(stats.wins) as number)
            : null,
        season: seasonId,
        raw: stats,
      };
    });
  }

  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const shard = this.shard(ref.region ?? undefined);
    const player = await providers.pubg(this.runtime).getPlayerById(shard, ref.id);
    const ids = (player.relationships?.matches?.data ?? []).slice(0, this.limit(options.limit, 10));

    if (!options.hydrate) {
      // The relationship list is ids only. Returning them as thin summaries is
      // the right default: hydrating ten matches costs ten of the ten calls
      // this API allows per minute.
      return ids.map((entry) => ({
        matchId: entry.id,
        titleId: this.title.id,
        mode: null,
        map: null,
        startedAt: null,
        durationSeconds: null,
        result: "unknown" as const,
        playerStats: null,
        raw: entry,
      }));
    }

    const summaries: MatchSummary[] = [];
    for (const entry of ids) {
      const match = await providers.pubg(this.runtime).getMatch(shard, entry.id);
      summaries.push(this.toSummary(match, ref.id));
    }
    return summaries;
  }

  public override async getMatch(matchId: string, context?: PlayerRef): Promise<MatchDetail> {
    this.require("getMatch");
    const shard = this.shard(context?.region ?? undefined);
    const match = await providers.pubg(this.runtime).getMatch(shard, matchId);
    const summary = this.toSummary(match, context?.id);
    const participants = match.included.filter((entry) => entry.type === "participant");
    const rosters = match.included.filter((entry) => entry.type === "roster");

    return {
      ...summary,
      teams: rosters.map((roster) => {
        const attributes = (roster.attributes as Record<string, unknown>) ?? {};
        const stats = (attributes.stats as Record<string, unknown>) ?? {};
        return {
          id: String(roster.id ?? ""),
          name: null,
          won: attributes.won === "true" || attributes.won === true,
          score: int(stats.rank),
          roundsWon: null,
        };
      }),
      participants: participants.map((participant) => {
        const stats =
          ((participant.attributes as Record<string, unknown>)?.stats as Record<string, unknown>) ??
          {};
        return {
          playerId: String(stats.playerId ?? ""),
          displayName: str(stats.name),
          teamId: null,
          character: null,
          stats: participantStats({
            kills: int(stats.kills),
            assists: int(stats.assists),
            damageDealt: Math.round(num(stats.damageDealt) ?? 0),
            placement: int(stats.winPlace),
            extra: {
              headshotKills: int(stats.headshotKills),
              longestKill: Math.round(num(stats.longestKill) ?? 0),
              timeSurvived: Math.round(num(stats.timeSurvived) ?? 0),
              revives: int(stats.revives),
              walkDistance: Math.round(num(stats.walkDistance) ?? 0),
            },
          }),
          raw: participant,
        };
      }),
      rounds: [],
      patch: null,
    };
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const shard = this.shard(options.region);
    const pubg = providers.pubg(this.runtime);
    const seasonId = options.season ?? (await pubg.getCurrentSeasonId(shard));
    const rows = await pubg.getLeaderboard(shard, seasonId, options.queue ?? "squad-fpp");

    return rows.slice(0, this.limit(options.limit, 100)).map((row, index) => {
      const attributes = (row.attributes as Record<string, unknown>) ?? {};
      const stats = (attributes.stats as Record<string, unknown>) ?? {};
      return {
        position: int(attributes.rank) ?? index + 1,
        playerId: String(row.id ?? ""),
        displayName: str(attributes.name),
        rating: int(stats.rankPoints),
        tier: null,
        wins: int(stats.wins),
        losses: null,
        country: null,
        raw: row,
      };
    });
  }

  private toSummary(
    match: { data: Record<string, unknown>; included: Record<string, unknown>[] },
    accountId?: string,
  ): MatchSummary {
    const attributes = (match.data.attributes as Record<string, unknown>) ?? {};
    const mine = accountId
      ? match.included.find(
          (entry) =>
            entry.type === "participant" &&
            ((entry.attributes as Record<string, Record<string, unknown>>)?.stats?.playerId as string) ===
              accountId,
        )
      : undefined;
    const stats =
      ((mine?.attributes as Record<string, unknown>)?.stats as Record<string, unknown>) ?? {};

    return {
      matchId: String(match.data.id ?? ""),
      titleId: this.title.id,
      mode: str(attributes.gameMode),
      map: str(attributes.mapName),
      startedAt: ts(attributes.createdAt),
      durationSeconds: int(attributes.duration),
      // A battle royale has one winner, so "win" means first place.
      result: mine ? matchResult(int(stats.winPlace) === 1) : "unknown",
      playerStats: mine
        ? participantStats({
            kills: int(stats.kills),
            assists: int(stats.assists),
            damageDealt: Math.round(num(stats.damageDealt) ?? 0),
            placement: int(stats.winPlace),
            extra: { timeSurvived: Math.round(num(stats.timeSurvived) ?? 0) },
          })
        : null,
      raw: match,
    };
  }
}

// ---------------------------------------------------------------------------
// Halo Infinite
// ---------------------------------------------------------------------------

/** Halo Infinite, through HaloDotAPI. Keyed on gamertag. */
export class HaloInfiniteClient extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const gamertag = String(query.name ?? "");
    await providers.halo(this.runtime).getServiceRecord(gamertag);
    return this.ref({
      providerId: "halodotapi",
      id: gamertag,
      displayName: gamertag,
      platform: "xbox",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const record = await providers.halo(this.runtime).getServiceRecord(ref.id);
    return {
      ref,
      displayName: ref.id,
      level: null,
      avatarUrl: null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: null,
      country: null,
      clan: null,
      isPrivate: false,
      raw: record,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const record = await providers.halo(this.runtime).getServiceRecord(ref.id);
    const core = (record.core as Record<string, unknown>) ?? {};
    const shots = (core.shots as Record<string, unknown>) ?? {};
    const summary = (core.summary as Record<string, unknown>) ?? {};
    const matches = (record.matches_played ?? record.matches) as Record<string, unknown> | undefined;

    return playerStats({
      ref,
      matchesPlayed: int(record.matches_played ?? matches?.total),
      wins: int(matches?.wins),
      losses: int(matches?.losses),
      draws: int(matches?.ties),
      kills: int(summary.kills),
      deaths: int(summary.deaths),
      assists: int(summary.assists),
      timePlayedSeconds: int((record.time_played as Record<string, unknown> | undefined)?.seconds),
      raw: { record, accuracy: shots.accuracy },
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const csrs = await providers.halo(this.runtime).getCsr(ref.id);
    return csrs.map((entry) => {
      const current = (entry.response as Record<string, unknown> | undefined) ?? entry;
      const tier = (current.current as Record<string, unknown>) ?? current;
      return {
        ref,
        queue: str(entry.queue ?? entry.playlist) ?? "ranked",
        tier: str(tier.tier),
        division: str(tier.sub_tier),
        tierPoints: int(tier.value),
        rating: int(tier.value),
        position: null,
        percentilePermille: null,
        wins: null,
        losses: null,
        season: null,
        raw: entry,
      };
    });
  }

  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const matches = await providers.halo(this.runtime).getMatches(ref.id, {
      limit: this.limit(options.limit, 25),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
    });

    return matches.map((match) => {
      const details = (match.details as Record<string, unknown>) ?? {};
      const player = (match.player as Record<string, unknown>) ?? {};
      const stats = ((player.stats as Record<string, unknown>)?.core as Record<string, unknown>) ?? {};
      const summary = (stats.summary as Record<string, unknown>) ?? {};
      return {
        matchId: String(match.id ?? ""),
        titleId: this.title.id,
        mode: str((details.category as Record<string, unknown> | undefined)?.name),
        map: str((details.map as Record<string, unknown> | undefined)?.name),
        startedAt: ts(match.played_at),
        durationSeconds: int((match.duration as Record<string, unknown> | undefined)?.seconds),
        result: matchResult(str(player.outcome)?.toLowerCase() === "win"),
        playerStats: participantStats({
          kills: int(summary.kills),
          deaths: int(summary.deaths),
          assists: int(summary.assists),
          score: int(stats.score),
          extra: { rank: int(player.rank) },
        }),
        raw: match,
      };
    });
  }

  public override async getMatch(matchId: string): Promise<MatchDetail> {
    this.require("getMatch");
    const match = await providers.halo(this.runtime).getMatch(matchId);
    const details = (match.details as Record<string, unknown>) ?? {};
    const players = asArray<Record<string, unknown>>(match.players);
    const teams = asArray<Record<string, unknown>>(match.teams);

    return {
      matchId,
      titleId: this.title.id,
      mode: str((details.category as Record<string, unknown> | undefined)?.name),
      map: str((details.map as Record<string, unknown> | undefined)?.name),
      startedAt: ts(match.played_at),
      durationSeconds: int((match.duration as Record<string, unknown> | undefined)?.seconds),
      result: "unknown",
      playerStats: null,
      teams: teams.map((team) => ({
        id: String(team.id ?? ""),
        name: str((team.details as Record<string, unknown> | undefined)?.name),
        won: str(team.outcome)?.toLowerCase() === "win",
        score: int(team.score),
        roundsWon: int(team.rounds_won),
      })),
      participants: players.map((player) => {
        const stats = ((player.stats as Record<string, unknown>)?.core as Record<string, unknown>) ?? {};
        const summary = (stats.summary as Record<string, unknown>) ?? {};
        return {
          playerId: String(player.id ?? player.gamertag ?? ""),
          displayName: str(player.gamertag),
          teamId: str((player.team as Record<string, unknown> | undefined)?.id),
          character: null,
          stats: participantStats({
            kills: int(summary.kills),
            deaths: int(summary.deaths),
            assists: int(summary.assists),
            score: int(stats.score),
            extra: { accuracy: num((stats.shots as Record<string, unknown> | undefined)?.accuracy) },
          }),
          raw: player,
        };
      }),
      rounds: [],
      patch: null,
      raw: match,
    };
  }
}

// ---------------------------------------------------------------------------
// Destiny 2
// ---------------------------------------------------------------------------

/**
 * Destiny 2.
 *
 * Bungie's API is complete but heavy: the profile is opt-in components, and
 * activity history is per character rather than per account, so a full history
 * means one call per character.
 */
export class Destiny2Client extends TitleClient {
  private membershipType(platform: string | undefined): number {
    const key = (platform ?? "all") as keyof typeof DESTINY_PLATFORMS;
    return DESTINY_PLATFORMS[key] ?? DESTINY_PLATFORMS.all;
  }

  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const bungie = providers.bungie(this.runtime);

    if (query.membershipId) {
      return this.ref({
        providerId: "bungie",
        id: String(query.membershipId),
        displayName: str(query.name),
        platform: (query.platform ?? null) as Platform | null,
        region: String(this.membershipType(query.platform)),
      });
    }

    const membership = await bungie.getPrimaryMembership(String(query.name));
    return this.ref({
      providerId: "bungie",
      id: membership.membershipId,
      displayName:
        membership.bungieGlobalDisplayName && membership.bungieGlobalDisplayNameCode
          ? `${membership.bungieGlobalDisplayName}#${membership.bungieGlobalDisplayNameCode}`
          : (membership.displayName ?? null),
      platform: null,
      // The membership type is not a region, but it is the second half of every
      // Destiny id and has to travel with it.
      region: String(membership.membershipType),
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const type = Number(ref.region ?? DESTINY_PLATFORMS.all);
    const profile = await providers.bungie(this.runtime).getProfile(type, ref.id);
    const data = (profile.profile as Record<string, unknown> | undefined)?.data as
      | Record<string, unknown>
      | undefined;

    return {
      ref,
      displayName: ref.displayName ?? ref.id,
      level: null,
      avatarUrl: null,
      profileUrl: `https://www.bungie.net/7/en/User/Profile/${type}/${ref.id}`,
      createdAt: ts(data?.dateLastPlayed),
      lastSeenAt: ts(data?.dateLastPlayed),
      country: null,
      clan: null,
      isPrivate: false,
      raw: profile,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const type = Number(ref.region ?? DESTINY_PLATFORMS.all);
    const stats = await providers.bungie(this.runtime).getAccountStats(type, ref.id);
    const pvp = (
      (stats.mergedAllCharacters as Record<string, unknown> | undefined)?.results as
        | Record<string, unknown>
        | undefined
    )?.allPvP as Record<string, unknown> | undefined;
    const all = (pvp?.allTime as Record<string, Record<string, Record<string, unknown>>>) ?? {};

    const value = (key: string): number | null => num(all[key]?.basic?.value);

    return playerStats({
      ref,
      matchesPlayed: value("activitiesEntered"),
      wins: value("activitiesWon"),
      losses:
        value("activitiesEntered") !== null && value("activitiesWon") !== null
          ? (value("activitiesEntered") as number) - (value("activitiesWon") as number)
          : null,
      kills: value("kills"),
      deaths: value("deaths"),
      assists: value("assists"),
      timePlayedSeconds: value("secondsPlayed"),
      raw: stats,
    });
  }

  /**
   * Destiny has no ranked ladder in the API.
   *
   * Glory and Valor exist in-game but are progression records rather than
   * published ranks, so this returns an empty list instead of a guess.
   */
  public override async getRank(_query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    return [];
  }

  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const type = Number(ref.region ?? DESTINY_PLATFORMS.all);
    const bungie = providers.bungie(this.runtime);
    const characters = await bungie.getCharacterIds(type, ref.id);

    const summaries: MatchSummary[] = [];
    for (const characterId of characters) {
      const activities = await bungie.getActivityHistory(type, ref.id, characterId, {
        count: this.limit(options.limit, 25),
        // Mode 5 is all PvP, which is what "match history" means for Destiny.
        mode: 5,
      });
      for (const activity of activities) {
        const details = (activity.activityDetails as Record<string, unknown>) ?? {};
        const values = (activity.values as Record<string, Record<string, Record<string, unknown>>>) ?? {};
        summaries.push({
          matchId: String(details.instanceId ?? ""),
          titleId: this.title.id,
          mode: str(details.mode),
          map: str(details.referenceId),
          startedAt: ts(activity.period),
          durationSeconds: num(values.activityDurationSeconds?.basic?.value),
          result: matchResult(num(values.standing?.basic?.value) === 0),
          playerStats: participantStats({
            kills: num(values.kills?.basic?.value),
            deaths: num(values.deaths?.basic?.value),
            assists: num(values.assists?.basic?.value),
            score: num(values.score?.basic?.value),
          }),
          raw: activity,
        });
      }
    }
    return summaries.slice(0, this.limit(options.limit, 25));
  }

  public override async getMatch(matchId: string): Promise<MatchDetail> {
    this.require("getMatch");
    const report = await providers.bungie(this.runtime).getPostGameCarnageReport(matchId);
    const details = (report.activityDetails as Record<string, unknown>) ?? {};
    const entries = asArray<Record<string, unknown>>(report.entries);

    return {
      matchId,
      titleId: this.title.id,
      mode: str(details.mode),
      map: str(details.referenceId),
      startedAt: ts(report.period),
      durationSeconds: null,
      result: "unknown",
      playerStats: null,
      teams: asArray<Record<string, unknown>>(report.teams).map((team) => ({
        id: String(team.teamId ?? ""),
        name: str(team.teamName),
        won:
          num(
            ((team.standing as Record<string, unknown> | undefined)?.basic as
              | Record<string, unknown>
              | undefined)?.value,
          ) === 0,
        score: num(
          ((team.score as Record<string, unknown> | undefined)?.basic as
            | Record<string, unknown>
            | undefined)?.value,
        ),
        roundsWon: null,
      })),
      participants: entries.map((entry) => {
        const values = (entry.values as Record<string, Record<string, Record<string, unknown>>>) ?? {};
        const player = (entry.player as Record<string, unknown>) ?? {};
        const info = (player.destinyUserInfo as Record<string, unknown>) ?? {};
        return {
          playerId: String(info.membershipId ?? ""),
          displayName: str(info.bungieGlobalDisplayName ?? info.displayName),
          teamId: str(entry.values ? values.team?.basic?.value : null),
          character: str(player.characterClass),
          stats: participantStats({
            kills: num(values.kills?.basic?.value),
            deaths: num(values.deaths?.basic?.value),
            assists: num(values.assists?.basic?.value),
            score: num(values.score?.basic?.value),
            extra: {
              efficiency: num(values.efficiency?.basic?.value),
              kdRatio: num(values.killsDeathsRatio?.basic?.value),
            },
          }),
          raw: entry,
        };
      }),
      rounds: [],
      patch: null,
      raw: report,
    };
  }

  public override async getLeaderboard(
    _options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    throw new NotFoundError(
      "bungie",
      "Destiny 2 ladder (Bungie publishes no global leaderboard through the API)",
      this.title.id,
    );
  }
}

// ---------------------------------------------------------------------------
// The Finals
// ---------------------------------------------------------------------------

/**
 * The Finals.
 *
 * The upstream is a leaderboard, not a player API: you find a player by
 * searching a season's ladder. So `getRank` and `getLeaderboard` are the whole
 * surface, and the title declares nothing else.
 */
export class TheFinalsClient extends TitleClient {
  private season(value: string | undefined): string {
    return value ?? "s5";
  }

  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const name = String(query.name ?? query.steamId ?? query.epicId ?? "");
    const row = await providers.theFinals(this.runtime).getPlayer(name, this.season(query.region));
    return this.ref({
      providerId: "the-finals-api",
      id: str(row.name) ?? name,
      displayName: str(row.name) ?? name,
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const row = await providers.theFinals(this.runtime).getPlayer(ref.id);
    return {
      ref,
      displayName: str(row.name) ?? ref.id,
      level: null,
      avatarUrl: null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: null,
      country: null,
      clan: str(row.clubTag),
      isPrivate: false,
      raw: row,
    };
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const row = await providers.theFinals(this.runtime).getPlayer(ref.id);
    return [
      {
        ref,
        queue: "ranked",
        tier: str(row.league),
        division: null,
        tierPoints: int(row.rankScore ?? row.fame),
        rating: int(row.rankScore ?? row.fame),
        position: int(row.rank),
        percentilePermille: null,
        wins: null,
        losses: null,
        season: null,
        raw: row,
      },
    ];
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const rows = await providers
      .theFinals(this.runtime)
      .getLeaderboard(this.season(options.season));
    return rows.slice(0, this.limit(options.limit, 100)).map((row, index) => ({
      position: int(row.rank) ?? index + 1,
      playerId: str(row.name),
      displayName: str(row.name),
      rating: int(row.rankScore ?? row.fame),
      tier: str(row.league),
      wins: null,
      losses: null,
      country: null,
      raw: row,
    }));
  }
}

// ---------------------------------------------------------------------------
// Marvel Rivals
// ---------------------------------------------------------------------------

/** Marvel Rivals. Recent enough that the upstream schema still moves. */
export class MarvelRivalsClient extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const key = String(query.name ?? query.accountId ?? "");
    const player = await providers.marvelRivals(this.runtime).getPlayer(key);
    return this.ref({
      providerId: "marvel-rivals",
      id: String(player.uid ?? key),
      displayName: str(player.name) ?? key,
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.marvelRivals(this.runtime).getPlayer(ref.id);
    const info = (player.player as Record<string, unknown>) ?? player;

    return {
      ref,
      displayName: str(info.name) ?? ref.id,
      level: int(info.level),
      avatarUrl: str(info.icon
        ? ((info.icon as Record<string, unknown>).player_icon as string)
        : null),
      profileUrl: null,
      createdAt: null,
      lastSeenAt: ts(player.updates ? (player.updates as Record<string, unknown>).last_update_request : null),
      country: null,
      clan: null,
      isPrivate: false,
      raw: player,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.marvelRivals(this.runtime).getPlayer(ref.id);
    const overall = (player.overall_stats as Record<string, unknown>) ?? {};
    const ranked = (overall.ranked as Record<string, unknown>) ?? {};
    const heroes = asArray<Record<string, unknown>>(player.heroes_ranked);

    const modes: Record<string, ModeStats> = {};
    for (const hero of heroes) {
      const id = String(hero.hero_id ?? hero.hero_name ?? "unknown");
      modes[id] = modeStats({
        id,
        label: str(hero.hero_name) ?? id,
        matchesPlayed: int(hero.matches),
        wins: int(hero.wins),
        losses:
          int(hero.matches) !== null && int(hero.wins) !== null
            ? (int(hero.matches) as number) - (int(hero.wins) as number)
            : null,
        kills: int(hero.kills),
        deaths: int(hero.deaths),
        assists: int(hero.assists),
        extra: { playTime: num(hero.play_time) },
      });
    }

    return playerStats({
      ref,
      matchesPlayed: int(ranked.total_matches),
      wins: int(ranked.total_wins),
      losses:
        int(ranked.total_matches) !== null && int(ranked.total_wins) !== null
          ? (int(ranked.total_matches) as number) - (int(ranked.total_wins) as number)
          : null,
      modes,
      raw: player,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.marvelRivals(this.runtime).getPlayer(ref.id);
    const info = (player.player as Record<string, unknown>) ?? {};
    const rank = info.rank as Record<string, unknown> | undefined;
    if (!rank) return [];
    return [
      {
        ref,
        queue: "ranked",
        tier: str(rank.rank),
        division: null,
        tierPoints: int(rank.score),
        rating: int(rank.score),
        position: null,
        percentilePermille: null,
        wins: null,
        losses: null,
        season: null,
        raw: rank,
      },
    ];
  }

  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const matches = await providers
      .marvelRivals(this.runtime)
      .getMatchHistory(ref.id, this.limit(options.limit));

    return matches.map((match) => {
      const player = (match.match_player as Record<string, unknown>) ?? {};
      const stats = (player.player_hero as Record<string, unknown>) ?? {};
      return {
        matchId: String(match.match_uid ?? ""),
        titleId: this.title.id,
        mode: str(match.game_mode_id),
        map: str(match.match_map_id),
        startedAt: ts(match.match_time_stamp),
        durationSeconds: int(match.match_play_duration),
        result: matchResult(int(match.match_player ? player.is_win : null) === 1),
        playerStats: participantStats({
          kills: int(stats.kills),
          deaths: int(stats.deaths),
          assists: int(stats.assists),
          extra: { hero: str(stats.hero_name) },
        }),
        raw: match,
      };
    });
  }

  public override async getMatch(matchId: string): Promise<MatchDetail> {
    this.require("getMatch");
    const match = await providers.marvelRivals(this.runtime).getMatch(matchId);
    const details = (match.match_details as Record<string, unknown>) ?? match;
    const players = asArray<Record<string, unknown>>(details.match_players);

    return {
      matchId,
      titleId: this.title.id,
      mode: str(details.game_mode_id),
      map: str(details.match_map_id),
      startedAt: ts(details.match_time_stamp),
      durationSeconds: int(details.match_play_duration),
      result: "unknown",
      playerStats: null,
      teams: [0, 1].map((side) => ({
        id: String(side),
        name: side === 0 ? "Team 1" : "Team 2",
        won: null,
        score: null,
        roundsWon: null,
      })),
      participants: players.map((player) => {
        const hero = (player.player_hero as Record<string, unknown>) ?? {};
        return {
          playerId: String(player.player_uid ?? ""),
          displayName: str(player.nick_name),
          teamId: str(player.camp),
          character: str(hero.hero_name),
          stats: participantStats({
            kills: int(player.kills),
            deaths: int(player.deaths),
            assists: int(player.assists),
            damageDealt: int(player.total_hero_damage),
            healing: int(player.total_hero_heal),
            damageTaken: int(player.total_damage_taken),
          }),
          raw: player,
        };
      }),
      rounds: [],
      patch: null,
      raw: match,
    };
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const heroId = options.queue ?? "1011";
    const rows = await providers.marvelRivals(this.runtime).getLeaderboard(heroId);
    return rows.slice(0, this.limit(options.limit, 100)).map((row, index) => ({
      position: index + 1,
      playerId: str(row.player_uid),
      displayName: str(row.nick_name),
      rating: int(row.score),
      tier: str(row.rank),
      wins: int(row.wins),
      losses: null,
      country: null,
      raw: row,
    }));
  }

  public override async getMetadata(kind = "heroes"): Promise<unknown> {
    this.require("getMetadata");
    if (kind !== "heroes") {
      throw new ValidationError(`Marvel Rivals metadata "${kind}" is not available - try "heroes"`);
    }
    return providers.marvelRivals(this.runtime).getHeroes();
  }
}
