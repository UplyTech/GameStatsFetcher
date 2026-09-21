/**
 * Riot's titles: League of Legends, Teamfight Tactics, VALORANT and Legends of
 * Runeterra.
 *
 * The PUUID is the unit of identity across all four, and it never changes -
 * which is why `resolvePlayer` is cached for a day and why a stored
 * {@link PlayerRef} stays valid after a rename. The Riot ID a user types does
 * not have that property.
 */

import { TitleClient, isPlayerRef } from "../title-client.js";
import * as providers from "../providers/index.js";
import { expandRiotQuery } from "../identity.js";
import { NotFoundError, ValidationError } from "../errors.js";
import {
  asArray,
  int,
  matchResult,
  modeStats,
  participantStats,
  playerStats,
  str,
  ts,
} from "../normalize.js";
import type {
  LeaderboardEntry,
  LeaderboardOptions,
  MatchDetail,
  MatchHistoryOptions,
  MatchSummary,
  PlayerProfile,
  PlayerQuery,
  PlayerRef,
  PlayerStats,
  RankInfo,
} from "../types.js";

/** Riot's tier ladder, lowest first. Shared by League and TFT. */
const TIER_ORDER = [
  "IRON",
  "BRONZE",
  "SILVER",
  "GOLD",
  "PLATINUM",
  "EMERALD",
  "DIAMOND",
  "MASTER",
  "GRANDMASTER",
  "CHALLENGER",
] as const;

/** Title case for display: `GRANDMASTER` becomes `Grandmaster`. */
function prettyTier(tier: string | undefined): string | null {
  if (!tier) return null;
  return tier.charAt(0) + tier.slice(1).toLowerCase();
}

/**
 * Where a tier sits on the ladder, in permille of the way to the top.
 *
 * A rough figure by construction - Riot publishes no distribution - so it is
 * reported as an ordinal position on the tier list rather than as a real
 * population percentile, and the field name says `percentile` because that is
 * what a caller will render it as.
 */
function tierPercentile(tier: string | undefined): number | null {
  if (!tier) return null;
  const index = TIER_ORDER.indexOf(tier.toUpperCase() as (typeof TIER_ORDER)[number]);
  if (index < 0) return null;
  return Math.round(((TIER_ORDER.length - index) / TIER_ORDER.length) * 1_000);
}

/** Shared resolution: Riot ID or PUUID to a {@link PlayerRef}. */
abstract class RiotTitleClient extends TitleClient {
  /** Default platform host when a caller does not name a region. */
  protected abstract defaultPlatform(): string;

  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    const expanded = expandRiotQuery(query);
    this.requireIdentifier(expanded);

    const platform = expanded.region ?? this.defaultPlatform();
    const riot = providers.riot(this.runtime);

    if (expanded.puuid) {
      const account = await riot.getAccountByPuuid(expanded.puuid, platform, this.title.id);
      return this.ref({
        providerId: "riot",
        id: account.puuid,
        displayName: account.gameName
          ? `${account.gameName}#${account.tagLine ?? ""}`
          : null,
        platform: "riot",
        region: platform,
      });
    }

    if (!expanded.gameName || !expanded.tagLine) {
      throw new ValidationError(
        `${this.title.id} needs a Riot ID - pass gameName and tagLine, or name as "Name#Tag"`,
      );
    }
    const account = await riot.getAccountByRiotId(
      expanded.gameName,
      expanded.tagLine,
      platform,
      this.title.id,
    );
    return this.ref({
      providerId: "riot",
      id: account.puuid,
      displayName: `${account.gameName ?? expanded.gameName}#${account.tagLine ?? expanded.tagLine}`,
      platform: "riot",
      region: platform,
    });
  }
}

// ---------------------------------------------------------------------------
// League of Legends
// ---------------------------------------------------------------------------

export class LeagueOfLegendsClient extends RiotTitleClient {
  protected defaultPlatform(): string {
    return "euw1";
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const platform = ref.region ?? this.defaultPlatform();
    const riot = providers.riot(this.runtime);
    const [summoner, account] = await Promise.all([
      riot.getSummonerByPuuid(ref.id, platform),
      riot.getAccountByPuuid(ref.id, platform, this.title.id).catch(() => null),
    ]);

    return {
      ref,
      displayName: account?.gameName
        ? `${account.gameName}#${account.tagLine ?? ""}`
        : (ref.displayName ?? ref.id),
      level: summoner.summonerLevel,
      avatarUrl: `https://ddragon.leagueoflegends.com/cdn/14.1.1/img/profileicon/${summoner.profileIconId}.png`,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: ts(summoner.revisionDate),
      country: null,
      clan: null,
      isPrivate: false,
      raw: { summoner, account },
    };
  }

  /**
   * Career statistics derived from ranked entries.
   *
   * Riot publishes no lifetime totals, so wins and losses here are this split's
   * ranked games. That is a real limitation of the API rather than of this
   * package, and `raw` carries the per-queue rows so a caller can be precise.
   */
  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const platform = ref.region ?? this.defaultPlatform();
    const entries = await providers.riot(this.runtime).getLeagueEntries(ref.id, platform);

    const modes: Record<string, ReturnType<typeof modeStats>> = {};
    for (const entry of entries) {
      modes[entry.queueType] = modeStats({
        id: entry.queueType,
        label: entry.queueType,
        wins: entry.wins,
        losses: entry.losses,
        extra: {
          tier: entry.tier,
          rank: entry.rank,
          leaguePoints: entry.leaguePoints,
        },
      });
    }

    const solo = entries.find((entry) => entry.queueType === "RANKED_SOLO_5x5");
    return playerStats({
      ref,
      wins: solo?.wins ?? null,
      losses: solo?.losses ?? null,
      modes,
      raw: entries,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const platform = ref.region ?? this.defaultPlatform();
    const entries = await providers.riot(this.runtime).getLeagueEntries(ref.id, platform);

    return entries.map((entry) => ({
      ref,
      queue: entry.queueType,
      tier: prettyTier(entry.tier),
      division: entry.rank,
      tierPoints: entry.leaguePoints,
      rating: null,
      position: null,
      percentilePermille: tierPercentile(entry.tier),
      wins: entry.wins,
      losses: entry.losses,
      season: null,
      raw: entry,
    }));
  }

  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const platform = ref.region ?? this.defaultPlatform();
    const riot = providers.riot(this.runtime);

    const ids = await riot.getMatchIds(ref.id, platform, {
      count: this.limit(options.limit),
      ...(options.offset !== undefined ? { start: options.offset } : {}),
      ...(options.since !== undefined ? { startTime: options.since } : {}),
      ...(options.until !== undefined ? { endTime: options.until } : {}),
      ...(options.mode ? { type: options.mode } : {}),
    });

    // Riot's list endpoint returns ids only, so every summary costs one call.
    // Sequential rather than parallel: twenty concurrent requests is exactly
    // how a development key hits its 100-per-two-minutes limit.
    const summaries: MatchSummary[] = [];
    for (const id of ids) {
      const match = await riot.getMatch(id, platform);
      summaries.push(this.toSummary(match, ref.id));
    }
    return summaries;
  }

  public override async getMatch(matchId: string, context?: PlayerRef): Promise<MatchDetail> {
    this.require("getMatch");
    const platform = context?.region ?? this.defaultPlatform();
    const match = await providers.riot(this.runtime).getMatch(matchId, platform);
    const info = (match.info as Record<string, unknown>) ?? {};
    const participants = asArray<Record<string, unknown>>(info.participants);
    const teams = asArray<Record<string, unknown>>(info.teams);

    return {
      ...this.toSummary(match, context?.id),
      teams: teams.map((team) => ({
        id: String(team.teamId ?? ""),
        name: int(team.teamId) === 100 ? "Blue" : "Red",
        won: team.win === true,
        score: int((team.objectives as Record<string, unknown> | undefined)?.champion
          ? ((team.objectives as Record<string, Record<string, unknown>>).champion?.kills as number)
          : null),
        roundsWon: null,
      })),
      participants: participants.map((participant) => ({
        playerId: String(participant.puuid ?? ""),
        displayName:
          str(participant.riotIdGameName) ?? str(participant.summonerName) ?? null,
        teamId: str(participant.teamId),
        character: str(participant.championName),
        stats: participantStats({
          kills: int(participant.kills),
          deaths: int(participant.deaths),
          assists: int(participant.assists),
          damageDealt: int(participant.totalDamageDealtToChampions),
          damageTaken: int(participant.totalDamageTaken),
          healing: int(participant.totalHeal),
          extra: {
            championId: int(participant.championId),
            champLevel: int(participant.champLevel),
            goldEarned: int(participant.goldEarned),
            cs:
              (int(participant.totalMinionsKilled) ?? 0) +
              (int(participant.neutralMinionsKilled) ?? 0),
            visionScore: int(participant.visionScore),
            role: str(participant.teamPosition),
          },
        }),
        raw: participant,
      })),
      rounds: [],
      patch: str(info.gameVersion),
    };
  }

  /** Ladder: the apex tiers first, then the requested division. */
  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const platform = options.region ?? this.defaultPlatform();
    const queue = options.queue ?? "RANKED_SOLO_5x5";
    const league = await providers
      .riot(this.runtime)
      .getApexLeague("challenger", queue, platform);
    const entries = league?.entries ?? [];

    return entries
      .slice()
      .sort((a, b) => b.leaguePoints - a.leaguePoints)
      .slice(0, this.limit(options.limit, 100))
      .map((entry, index) => ({
        position: index + 1,
        playerId: entry.puuid ?? entry.summonerId ?? null,
        displayName: null,
        rating: entry.leaguePoints,
        tier: "Challenger",
        wins: entry.wins,
        losses: entry.losses,
        country: null,
        raw: entry,
      }));
  }

  public override async getMetadata(kind = "rotation"): Promise<unknown> {
    this.require("getMetadata");
    if (kind !== "rotation") {
      throw new ValidationError(
        `League metadata "${kind}" is not available - try "rotation"`,
      );
    }
    return providers.riot(this.runtime).getChampionRotation(this.defaultPlatform());
  }

  /** Turn a Match-v5 payload into a summary from one player's perspective. */
  private toSummary(match: Record<string, unknown>, puuid?: string): MatchSummary {
    const info = (match.info as Record<string, unknown>) ?? {};
    const metadata = (match.metadata as Record<string, unknown>) ?? {};
    const participants = asArray<Record<string, unknown>>(info.participants);
    const mine = puuid ? participants.find((p) => p.puuid === puuid) : undefined;

    return {
      matchId: String(metadata.matchId ?? ""),
      titleId: this.title.id,
      mode: str(info.gameMode),
      map: str(info.mapId),
      startedAt: ts(info.gameStartTimestamp ?? info.gameCreation),
      durationSeconds: int(info.gameDuration),
      result: mine ? matchResult(mine.win) : "unknown",
      playerStats: mine
        ? participantStats({
            kills: int(mine.kills),
            deaths: int(mine.deaths),
            assists: int(mine.assists),
            damageDealt: int(mine.totalDamageDealtToChampions),
            damageTaken: int(mine.totalDamageTaken),
            healing: int(mine.totalHeal),
            extra: {
              champion: str(mine.championName),
              cs: (int(mine.totalMinionsKilled) ?? 0) + (int(mine.neutralMinionsKilled) ?? 0),
              goldEarned: int(mine.goldEarned),
              visionScore: int(mine.visionScore),
            },
          })
        : null,
      raw: match,
    };
  }
}

// ---------------------------------------------------------------------------
// Teamfight Tactics
// ---------------------------------------------------------------------------

/**
 * Teamfight Tactics.
 *
 * The one title here where placement matters more than win or loss: a top-four
 * finish is a win in TFT's own accounting, and that is what `result` reports.
 */
export class TeamfightTacticsClient extends RiotTitleClient {
  protected defaultPlatform(): string {
    return "euw1";
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const platform = ref.region ?? this.defaultPlatform();
    const summoner = await providers.riot(this.runtime).getTftSummoner(ref.id, platform);
    return {
      ref,
      displayName: ref.displayName ?? ref.id,
      level: summoner.summonerLevel,
      avatarUrl: null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: ts(summoner.revisionDate),
      country: null,
      clan: null,
      isPrivate: false,
      raw: summoner,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const platform = ref.region ?? this.defaultPlatform();
    const entries = await providers.riot(this.runtime).getTftLeagueEntries(ref.id, platform);
    const ranked = entries.find((entry) => entry.queueType === "RANKED_TFT") ?? entries[0];

    return playerStats({
      ref,
      wins: ranked?.wins ?? null,
      losses: ranked?.losses ?? null,
      modes: Object.fromEntries(
        entries.map((entry) => [
          entry.queueType,
          modeStats({
            id: entry.queueType,
            wins: entry.wins,
            losses: entry.losses,
            extra: { tier: entry.tier, rank: entry.rank, lp: entry.leaguePoints },
          }),
        ]),
      ),
      raw: entries,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const platform = ref.region ?? this.defaultPlatform();
    const entries = await providers.riot(this.runtime).getTftLeagueEntries(ref.id, platform);
    return entries.map((entry) => ({
      ref,
      queue: entry.queueType,
      tier: prettyTier(entry.tier),
      division: entry.rank,
      tierPoints: entry.leaguePoints,
      rating: null,
      position: null,
      percentilePermille: tierPercentile(entry.tier),
      wins: entry.wins,
      losses: entry.losses,
      season: null,
      raw: entry,
    }));
  }

  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const platform = ref.region ?? this.defaultPlatform();
    const riot = providers.riot(this.runtime);
    const ids = await riot.getTftMatchIds(ref.id, platform, {
      count: this.limit(options.limit),
      ...(options.offset !== undefined ? { start: options.offset } : {}),
    });

    const summaries: MatchSummary[] = [];
    for (const id of ids) {
      const match = await riot.getTftMatch(id, platform);
      summaries.push(this.toSummary(match, ref.id));
    }
    return summaries;
  }

  public override async getMatch(matchId: string, context?: PlayerRef): Promise<MatchDetail> {
    this.require("getMatch");
    const platform = context?.region ?? this.defaultPlatform();
    const match = await providers.riot(this.runtime).getTftMatch(matchId, platform);
    const info = (match.info as Record<string, unknown>) ?? {};
    const participants = asArray<Record<string, unknown>>(info.participants);

    return {
      ...this.toSummary(match, context?.id),
      teams: [],
      participants: participants.map((participant) => ({
        playerId: String(participant.puuid ?? ""),
        displayName: null,
        teamId: null,
        character: null,
        stats: participantStats({
          placement: int(participant.placement),
          extra: {
            level: int(participant.level),
            goldLeft: int(participant.gold_left),
            playersEliminated: int(participant.players_eliminated),
            damageToPlayers: int(participant.total_damage_to_players),
            timeAlive: int(participant.time_eliminated),
          },
        }),
        raw: participant,
      })),
      rounds: [],
      patch: str(info.game_version),
    };
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const platform = options.region ?? this.defaultPlatform();
    const league = await providers.riot(this.runtime).getTftApexLeague("challenger", platform);
    return (league?.entries ?? [])
      .slice()
      .sort((a, b) => b.leaguePoints - a.leaguePoints)
      .slice(0, this.limit(options.limit, 100))
      .map((entry, index) => ({
        position: index + 1,
        playerId: entry.puuid ?? entry.summonerId ?? null,
        displayName: null,
        rating: entry.leaguePoints,
        tier: "Challenger",
        wins: entry.wins,
        losses: entry.losses,
        country: null,
        raw: entry,
      }));
  }

  private toSummary(match: Record<string, unknown>, puuid?: string): MatchSummary {
    const info = (match.info as Record<string, unknown>) ?? {};
    const metadata = (match.metadata as Record<string, unknown>) ?? {};
    const participants = asArray<Record<string, unknown>>(info.participants);
    const mine = puuid ? participants.find((p) => p.puuid === puuid) : undefined;
    const placement = int(mine?.placement);

    return {
      matchId: String(metadata.match_id ?? ""),
      titleId: this.title.id,
      mode: str(info.tft_game_type) ?? "standard",
      map: null,
      startedAt: ts(info.game_datetime),
      durationSeconds: int(info.game_length),
      // In TFT a top-four finish is the win condition, not first place.
      result: placement === null ? "unknown" : placement <= 4 ? "win" : "loss",
      playerStats: mine
        ? participantStats({
            placement,
            extra: {
              level: int(mine.level),
              goldLeft: int(mine.gold_left),
              playersEliminated: int(mine.players_eliminated),
            },
          })
        : null,
      raw: match,
    };
  }
}

// ---------------------------------------------------------------------------
// VALORANT
// ---------------------------------------------------------------------------

/**
 * VALORANT.
 *
 * Riot's own VAL endpoints need an approved production key, so this client
 * prefers HenrikDev when only a development key is configured. Which one
 * answered is on `PlayerRef.providerId`, so a caller can tell.
 */
export class ValorantClient extends TitleClient {
  private defaultRegion(): string {
    return "eu";
  }

  /** True when the caller has a HenrikDev key, which is the richer path. */
  private useHenrik(): boolean {
    return providers.henrikdev(this.runtime).hasCredentials();
  }

  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    const expanded = expandRiotQuery(query);
    this.requireIdentifier(expanded);
    const region = this.region(expanded.region, this.defaultRegion());

    if (this.useHenrik()) {
      const henrik = providers.henrikdev(this.runtime);
      const account = expanded.puuid
        ? await henrik.getAccountByPuuid(expanded.puuid)
        : await henrik.getAccount(expanded.gameName as string, expanded.tagLine as string);
      return this.ref({
        providerId: "henrikdev",
        id: account.puuid,
        displayName: `${account.name}#${account.tag}`,
        platform: "riot",
        region: account.region ?? region,
      });
    }

    const riot = providers.riot(this.runtime);
    // VALORANT's shards are not Riot platform hosts, so the account lookup goes
    // through the regional cluster and the shard is carried separately.
    const cluster = region === "na" || region === "br" || region === "latam" ? "americas" : "europe";
    if (expanded.puuid) {
      const account = await riot.getAccountByPuuid(expanded.puuid, cluster, this.title.id);
      return this.ref({
        providerId: "riot",
        id: account.puuid,
        displayName: account.gameName ? `${account.gameName}#${account.tagLine}` : null,
        platform: "riot",
        region,
      });
    }
    if (!expanded.gameName || !expanded.tagLine) {
      throw new ValidationError('VALORANT needs a Riot ID - pass name as "Name#Tag"');
    }
    const account = await riot.getAccountByRiotId(
      expanded.gameName,
      expanded.tagLine,
      cluster,
      this.title.id,
    );
    return this.ref({
      providerId: "riot",
      id: account.puuid,
      displayName: `${account.gameName}#${account.tagLine}`,
      platform: "riot",
      region,
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    if (ref.providerId !== "henrikdev") {
      // Riot's own API has no VALORANT profile endpoint at all; the account
      // record is everything there is.
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
        raw: { note: "Riot publishes no VALORANT profile endpoint" },
      };
    }
    const account = await providers.henrikdev(this.runtime).getAccountByPuuid(ref.id);
    return {
      ref,
      displayName: `${account.name}#${account.tag}`,
      level: account.account_level,
      avatarUrl: account.card?.small ?? null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: ts(account.last_update_raw),
      country: null,
      clan: null,
      isPrivate: false,
      raw: account,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const matches = await this.getMatchHistory(ref, { limit: 10 });

    const wins = matches.filter((match) => match.result === "win").length;
    const losses = matches.filter((match) => match.result === "loss").length;

    // Riot exposes no VALORANT career totals, so these are derived from the
    // recent matches the API does return. The window is stated in `raw` so a
    // caller cannot mistake it for a lifetime figure.
    return playerStats({
      ref,
      matchesPlayed: matches.length,
      wins,
      losses,
      kills: matches.reduce((sum, match) => sum + (match.playerStats?.kills ?? 0), 0),
      deaths: matches.reduce((sum, match) => sum + (match.playerStats?.deaths ?? 0), 0),
      assists: matches.reduce((sum, match) => sum + (match.playerStats?.assists ?? 0), 0),
      raw: { window: "last 10 matches", matches },
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    if (ref.providerId !== "henrikdev") {
      throw new NotFoundError(
        "riot",
        "VALORANT rank (Riot's ranked endpoints need an approved production key - configure apiKeys.henrikdev instead)",
        this.title.id,
      );
    }
    const mmr = await providers
      .henrikdev(this.runtime)
      .getMmr(ref.region ?? this.defaultRegion(), ref.id);
    const current = mmr.current_data;
    if (!current) return [];

    return [
      {
        ref,
        queue: "competitive",
        tier: current.currenttierpatched ?? null,
        division: null,
        tierPoints: current.ranking_in_tier ?? null,
        rating: current.elo ?? null,
        position: null,
        percentilePermille: null,
        wins: null,
        losses: null,
        season: null,
        raw: mmr,
      },
    ];
  }

  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const region = ref.region ?? this.defaultRegion();

    if (ref.providerId === "henrikdev") {
      const matches = await providers.henrikdev(this.runtime).getMatches(region, ref.id, {
        size: this.limit(options.limit, 10),
        ...(options.mode ? { mode: options.mode } : {}),
      });
      return matches.map((match) => this.fromHenrik(match, ref.id));
    }

    const riot = providers.riot(this.runtime);
    const list = await riot.getValorantMatchList(ref.id, region);
    const summaries: MatchSummary[] = [];
    for (const entry of list.slice(0, this.limit(options.limit))) {
      const match = await riot.getValorantMatch(entry.matchId, region);
      summaries.push(this.fromRiot(match, ref.id));
    }
    return summaries;
  }

  public override async getMatch(matchId: string, context?: PlayerRef): Promise<MatchDetail> {
    this.require("getMatch");
    const region = context?.region ?? this.defaultRegion();
    const raw = this.useHenrik()
      ? await providers.henrikdev(this.runtime).getMatch(matchId)
      : await providers.riot(this.runtime).getValorantMatch(matchId, region);

    // The two providers disagree about the envelope: HenrikDev nests metadata
    // and players, Riot uses matchInfo and players. Both are handled.
    const metadata = (raw.metadata as Record<string, unknown>) ?? (raw.matchInfo as Record<string, unknown>) ?? {};
    const playersNode = raw.players as Record<string, unknown> | Record<string, unknown>[] | undefined;
    const players = Array.isArray(playersNode)
      ? playersNode
      : asArray<Record<string, unknown>>((playersNode as Record<string, unknown> | undefined)?.all_players);
    const teamsNode = raw.teams as Record<string, Record<string, unknown>> | undefined;

    return {
      matchId,
      titleId: this.title.id,
      mode: str(metadata.mode ?? metadata.gameMode),
      map: str(metadata.map ?? metadata.mapId),
      startedAt: ts(metadata.game_start ?? metadata.gameStartMillis),
      durationSeconds: (() => {
        const millis = int(metadata.game_length ?? metadata.gameLengthMillis);
        return millis === null ? null : Math.round(millis / 1_000);
      })(),
      result: "unknown",
      playerStats: null,
      teams: Object.entries(teamsNode ?? {}).map(([id, team]) => ({
        id,
        name: id,
        won: team.has_won === true,
        score: int(team.rounds_won),
        roundsWon: int(team.rounds_won),
      })),
      participants: players.map((player) => {
        const stats = (player.stats as Record<string, unknown>) ?? {};
        return {
          playerId: String(player.puuid ?? ""),
          displayName: player.name ? `${player.name}#${player.tag ?? ""}` : null,
          teamId: str(player.team ?? player.teamId),
          character: str(player.character ?? player.characterId),
          stats: participantStats({
            kills: int(stats.kills ?? (stats.kills as Record<string, unknown> | undefined)?.value),
            deaths: int(stats.deaths ?? (stats.deaths as Record<string, unknown> | undefined)?.value),
            assists: int(stats.assists ?? (stats.assists as Record<string, unknown> | undefined)?.value),
            score: int(stats.score ?? (stats.score as Record<string, unknown> | undefined)?.value),
            extra: {
              headshots: int(stats.headshots),
              bodyshots: int(stats.bodyshots),
              legshots: int(stats.legshots),
              rank: str(player.currenttier_patched),
            },
          }),
          raw: player,
        };
      }),
      rounds: asArray<Record<string, unknown>>(raw.rounds).map((round, index) => ({
        index,
        winningTeamId: str(round.winning_team),
        durationSeconds: null,
        raw: round,
      })),
      patch: null,
      raw,
    };
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const region = this.region(options.region, this.defaultRegion());
    if (!this.useHenrik()) {
      throw new NotFoundError(
        "riot",
        "VALORANT leaderboard (needs an approved production key, or configure apiKeys.henrikdev)",
        this.title.id,
      );
    }
    const rows = await providers.henrikdev(this.runtime).getLeaderboard(region, {
      size: this.limit(options.limit, 100),
      ...(options.offset !== undefined ? { startIndex: options.offset } : {}),
      ...(options.season ? { season: options.season } : {}),
    });
    return rows.map((row, index) => ({
      position: int(row.leaderboardRank) ?? index + 1,
      playerId: str(row.puuid),
      displayName: row.gameName ? `${row.gameName}#${row.tagLine ?? ""}` : null,
      rating: int(row.rankedRating),
      tier: null,
      wins: int(row.numberOfWins),
      losses: null,
      country: null,
      raw: row,
    }));
  }

  public override async getMetadata(kind = "content"): Promise<unknown> {
    this.require("getMetadata");
    if (kind !== "content") {
      throw new ValidationError(`VALORANT metadata "${kind}" is not available - try "content"`);
    }
    return this.useHenrik()
      ? providers.henrikdev(this.runtime).getContent()
      : providers.riot(this.runtime).getValorantContent(this.defaultRegion());
  }

  private fromHenrik(match: Record<string, unknown>, puuid: string): MatchSummary {
    const metadata = (match.metadata as Record<string, unknown>) ?? {};
    const allPlayers = asArray<Record<string, unknown>>(
      (match.players as Record<string, unknown> | undefined)?.all_players,
    );
    const mine = allPlayers.find((player) => player.puuid === puuid);
    const teams = (match.teams as Record<string, Record<string, unknown>>) ?? {};
    const myTeam = str(mine?.team)?.toLowerCase();
    const won = myTeam ? teams[myTeam]?.has_won === true : null;
    const stats = (mine?.stats as Record<string, unknown>) ?? {};

    return {
      matchId: String(metadata.matchid ?? ""),
      titleId: this.title.id,
      mode: str(metadata.mode),
      map: str(metadata.map),
      startedAt: ts(metadata.game_start),
      durationSeconds: (() => {
        const millis = int(metadata.game_length);
        return millis === null ? null : Math.round(millis / 1_000);
      })(),
      result: won === null ? "unknown" : matchResult(won),
      playerStats: mine
        ? participantStats({
            kills: int(stats.kills),
            deaths: int(stats.deaths),
            assists: int(stats.assists),
            score: int(stats.score),
            extra: {
              agent: str(mine.character),
              headshots: int(stats.headshots),
              rank: str(mine.currenttier_patched),
            },
          })
        : null,
      raw: match,
    };
  }

  private fromRiot(match: Record<string, unknown>, puuid: string): MatchSummary {
    const info = (match.matchInfo as Record<string, unknown>) ?? {};
    const players = asArray<Record<string, unknown>>(match.players);
    const mine = players.find((player) => player.puuid === puuid);
    const teams = asArray<Record<string, unknown>>(match.teams);
    const myTeam = teams.find((team) => team.teamId === mine?.teamId);
    const stats = (mine?.stats as Record<string, unknown>) ?? {};

    return {
      matchId: String(info.matchId ?? ""),
      titleId: this.title.id,
      mode: str(info.queueId ?? info.gameMode),
      map: str(info.mapId),
      startedAt: ts(info.gameStartMillis),
      durationSeconds: (() => {
        const millis = int(info.gameLengthMillis);
        return millis === null ? null : Math.round(millis / 1_000);
      })(),
      result: myTeam ? matchResult(myTeam.won) : "unknown",
      playerStats: mine
        ? participantStats({
            kills: int(stats.kills),
            deaths: int(stats.deaths),
            assists: int(stats.assists),
            score: int(stats.score),
            extra: { agent: str(mine.characterId) },
          })
        : null,
      raw: match,
    };
  }
}

// ---------------------------------------------------------------------------
// Legends of Runeterra
// ---------------------------------------------------------------------------

/**
 * Legends of Runeterra.
 *
 * Riot's LoR API has a ladder and match ids and nothing else - no profile, no
 * statistics. The title declares only what exists, so `getPlayer` is absent
 * rather than returning a hollow object.
 */
export class LegendsOfRuneterraClient extends RiotTitleClient {
  protected defaultPlatform(): string {
    return "europe";
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const routing = ref.region ?? this.defaultPlatform();
    const board = await providers.riot(this.runtime).getLorLeaderboard(routing);
    const name = ref.displayName?.split("#")[0]?.toLowerCase();
    const row = board.find((entry) => entry.name.toLowerCase() === name);
    if (!row) return [];

    return [
      {
        ref,
        queue: "ranked",
        tier: "Master",
        division: null,
        tierPoints: row.lp,
        rating: row.lp,
        position: row.rank,
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
    const routing = options.region ?? this.defaultPlatform();
    const board = await providers.riot(this.runtime).getLorLeaderboard(routing);
    return board.slice(0, this.limit(options.limit, 100)).map((row) => ({
      position: row.rank,
      playerId: null,
      displayName: row.name,
      rating: row.lp,
      tier: "Master",
      wins: null,
      losses: null,
      country: null,
      raw: row,
    }));
  }
}
