/**
 * Valve's titles: Counter-Strike 2, Dota 2, Team Fortress 2 and Deadlock.
 *
 * What they share is Steam identity; what they do not share is anything else.
 * CS2 has career totals and no rank, Dota 2 has both through a third party,
 * TF2 has neither and a log archive instead. So each client below decides for
 * itself which provider answers which question - that decision is the value
 * this layer adds over calling the APIs directly.
 */

import { TitleClient, isPlayerRef } from "../title-client.js";
import * as providers from "../providers/index.js";
import { dotaRankName } from "../providers/dota.js";
import { STEAM_APP_IDS } from "../constants.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { isSteamId64, toSteamAccountId, toSteamId64 } from "../identity.js";
import {
  asArray,
  int,
  matchResult,
  modeStats,
  num,
  participantStats,
  permille,
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

// ---------------------------------------------------------------------------
// Counter-Strike 2
// ---------------------------------------------------------------------------

/**
 * Counter-Strike 2.
 *
 * Steam holds the account and the career totals. FACEIT holds everything
 * competitive - **Valve publishes no matchmaking rank at all**, so when a
 * caller asks CS2 for a rank, FACEIT level and Elo are the honest answer and
 * this client says so through `RankInfo.queue`.
 */
export class CS2Client extends TitleClient {
  private readonly appId = STEAM_APP_IDS.cs2 ?? 730;

  /** Accepts a SteamID64, a legacy Steam id, or a vanity URL. */
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const steam = providers.steam(this.runtime);

    let steamId: string;
    if (query.steamId) {
      steamId = toSteamId64(query.steamId);
    } else {
      const name = query.name as string;
      // A 17-digit "name" is a Steam id somebody pasted into the wrong field.
      steamId = isSteamId64(name)
        ? name
        : await steam.resolveVanityUrl(name, this.title.id);
    }

    const summary = await steam.getPlayerSummary(steamId, this.title.id);
    return this.ref({
      providerId: "steam",
      id: steamId,
      displayName: summary.personaname,
      platform: "steam",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const steam = providers.steam(this.runtime);
    const summary = await steam.getPlayerSummary(ref.id, this.title.id);

    return {
      ref,
      displayName: summary.personaname,
      level: null,
      avatarUrl: summary.avatarfull ?? null,
      profileUrl: summary.profileurl ?? null,
      createdAt: ts(summary.timecreated),
      lastSeenAt: ts(summary.lastlogoff),
      country: summary.loccountrycode ?? null,
      clan: summary.primaryclanid ?? null,
      isPrivate: !steam.isPublic(summary),
      raw: summary,
    };
  }

  /**
   * Career totals from the Steam stat list.
   *
   * The stat names are Valve's, unchanged since CS:GO. Per-map performance is
   * exposed as modes, because that is the breakdown players actually look at.
   */
  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const stats = await providers
      .steam(this.runtime)
      .getStatMap(ref.id, this.appId, this.title.id);

    const modes: Record<string, ReturnType<typeof modeStats>> = {};
    for (const [key, value] of Object.entries(stats)) {
      const map = /^total_wins_map_(.+)$/.exec(key)?.[1];
      if (map) {
        modes[map] = modeStats({
          id: map,
          label: map.replace(/^(de|cs|ar)_/, ""),
          wins: value,
          extra: { rounds: stats[`total_rounds_map_${map}`] ?? null },
        });
      }
    }

    return playerStats({
      ref,
      matchesPlayed: stats.total_matches_played ?? null,
      wins: stats.total_matches_won ?? null,
      losses:
        stats.total_matches_played !== undefined && stats.total_matches_won !== undefined
          ? stats.total_matches_played - stats.total_matches_won
          : null,
      kills: stats.total_kills ?? null,
      deaths: stats.total_deaths ?? null,
      timePlayedSeconds: stats.total_time_played ?? null,
      modes,
      raw: stats,
    });
  }

  /**
   * FACEIT level and Elo.
   *
   * Returns an empty list rather than throwing when the player has no FACEIT
   * account: that is a fact about the player, not a failure of the call.
   */
  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const faceit = providers.faceit(this.runtime);
    try {
      const player = await faceit.getPlayerByGameId(ref.id, this.title.id);
      const game = player.games?.cs2 ?? player.games?.csgo;
      if (!game) return [];
      return [
        {
          ref,
          queue: "faceit",
          tier: game.skill_level_label ?? (game.skill_level ? `Level ${game.skill_level}` : null),
          division: null,
          tierPoints: game.skill_level ?? null,
          rating: game.faceit_elo ?? null,
          position: null,
          percentilePermille: null,
          wins: null,
          losses: null,
          season: null,
          raw: player,
        },
      ];
    } catch (error) {
      if (error instanceof NotFoundError) return [];
      throw error;
    }
  }

  /** FACEIT match history - Valve keeps no retrievable matchmaking record. */
  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const faceit = providers.faceit(this.runtime);
    const player = await faceit.getPlayerByGameId(ref.id, this.title.id);
    const history = await faceit.getMatchHistory(player.player_id, this.title.id, {
      limit: this.limit(options.limit),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
      ...(options.since !== undefined ? { from: options.since } : {}),
      ...(options.until !== undefined ? { to: options.until } : {}),
    });

    return history.map((entry) => {
      const winner = entry.results?.winner;
      const playerTeam = Object.entries(entry.teams ?? {}).find(([, team]) =>
        team.players?.some((p) => p.player_id === player.player_id),
      )?.[0];
      return {
        matchId: entry.match_id,
        titleId: this.title.id,
        mode: entry.competition_type ?? null,
        map: null,
        startedAt: ts(entry.started_at),
        durationSeconds:
          entry.finished_at && entry.started_at ? entry.finished_at - entry.started_at : null,
        result: winner && playerTeam ? matchResult(winner === playerTeam) : "unknown",
        playerStats: null,
        raw: entry,
      };
    });
  }

  public override async getMatch(matchId: string): Promise<MatchDetail> {
    this.require("getMatch");
    const faceit = providers.faceit(this.runtime);
    const match = await faceit.getMatch(matchId, this.title.id);
    const rounds = await faceit.getMatchStats(matchId, this.title.id);

    const teams = Object.entries(
      (match.teams as Record<string, Record<string, unknown>> | undefined) ?? {},
    ).map(([id, team]) => ({
      id,
      name: str(team.name),
      won: str((match.results as Record<string, unknown> | undefined)?.winner) === id,
      score: int(
        ((match.results as Record<string, unknown> | undefined)?.score as
          | Record<string, unknown>
          | undefined)?.[id],
      ),
      roundsWon: null,
    }));

    const participants = rounds.flatMap((round) =>
      asArray<Record<string, unknown>>(round.teams).flatMap((team) =>
        asArray<Record<string, unknown>>(team.players).map((player) => {
          const stats = (player.player_stats as Record<string, unknown>) ?? {};
          return {
            playerId: String(player.player_id ?? ""),
            displayName: str(player.nickname),
            teamId: str(team.team_id),
            character: null,
            stats: participantStats({
              kills: int(stats.Kills),
              deaths: int(stats.Deaths),
              assists: int(stats.Assists),
              extra: {
                headshots: int(stats.Headshots),
                mvps: int(stats.MVPs),
                adr: num(stats.ADR ?? stats["K/R Ratio"]),
                kdRatio: num(stats["K/D Ratio"]),
              },
            }),
            raw: player,
          };
        }),
      ),
    );

    const first = rounds[0] as Record<string, unknown> | undefined;
    const roundStats = (first?.round_stats as Record<string, unknown>) ?? {};

    return {
      matchId,
      titleId: this.title.id,
      mode: str(match.competition_type),
      map: str(roundStats.Map),
      startedAt: ts(match.started_at),
      durationSeconds:
        num(match.finished_at) !== null && num(match.started_at) !== null
          ? (num(match.finished_at) as number) - (num(match.started_at) as number)
          : null,
      result: "unknown",
      playerStats: null,
      teams,
      participants,
      rounds: [],
      patch: null,
      raw: { match, rounds },
    };
  }

  /** The FACEIT regional ladder. */
  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const rows = await providers.faceit(this.runtime).getRankings(
      this.title.id,
      options.region ?? "EU",
      {
        limit: this.limit(options.limit, 50),
        ...(options.offset !== undefined ? { offset: options.offset } : {}),
      },
    );
    return rows.map((row, index) => ({
      position: int(row.position) ?? (options.offset ?? 0) + index + 1,
      playerId: str(row.player_id),
      displayName: str(row.nickname),
      rating: int(row.faceit_elo),
      tier: row.game_skill_level ? `Level ${row.game_skill_level}` : null,
      wins: null,
      losses: null,
      country: str(row.country),
      raw: row,
    }));
  }
}

// ---------------------------------------------------------------------------
// Dota 2
// ---------------------------------------------------------------------------

/**
 * Dota 2.
 *
 * OpenDota is the primary source. Valve's own match API is reachable through
 * `providers.steam()` and is used only when a caller forces it, because it does
 * not carry the parsed data that makes a Dota match worth reading.
 */
export class Dota2Client extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);

    const raw = query.steamId ?? query.accountId ?? query.name;
    if (raw === undefined) throw new ValidationError("Dota 2 needs a Steam id or account id");
    const accountId = toSteamAccountId(String(raw));
    const player = await providers.opendota(this.runtime).getPlayer(accountId);

    return this.ref({
      providerId: "opendota",
      id: accountId,
      displayName: player.profile?.personaname ?? null,
      platform: "steam",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.opendota(this.runtime).getPlayer(ref.id);
    const profile = player.profile;

    return {
      ref,
      displayName: profile?.personaname ?? "unknown",
      level: null,
      avatarUrl: profile?.avatarfull ?? null,
      profileUrl: profile?.profileurl ?? null,
      createdAt: null,
      lastSeenAt: ts(profile?.last_login),
      country: profile?.loccountrycode ?? null,
      clan: null,
      // OpenDota reports the profile but not whether Steam hides the details.
      isPrivate: false,
      raw: player,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const opendota = providers.opendota(this.runtime);

    const [winLoss, heroes, totals] = await Promise.all([
      opendota.getWinLoss(ref.id),
      opendota.getHeroPerformance(ref.id),
      opendota.getTotals(ref.id),
    ]);

    const totalsByField = Object.fromEntries(totals.map((row) => [row.field, row]));
    const modes: Record<string, ReturnType<typeof modeStats>> = {};
    // Twenty is enough for a profile card and keeps the payload sane; the full
    // list is in `raw`.
    for (const hero of heroes.slice(0, 20)) {
      modes[String(hero.hero_id)] = modeStats({
        id: String(hero.hero_id),
        label: `hero-${hero.hero_id}`,
        matchesPlayed: hero.games,
        wins: hero.win,
        losses: hero.games - hero.win,
      });
    }

    return playerStats({
      ref,
      wins: winLoss.win,
      losses: winLoss.lose,
      kills: totalsByField.kills?.sum ?? null,
      deaths: totalsByField.deaths?.sum ?? null,
      assists: totalsByField.assists?.sum ?? null,
      timePlayedSeconds: totalsByField.duration?.sum ?? null,
      modes,
      raw: { winLoss, heroes, totals },
    });
  }

  /** Medal, star and - for the top 1000 - the leaderboard position. */
  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const opendota = providers.opendota(this.runtime);
    const [player, winLoss] = await Promise.all([
      opendota.getPlayer(ref.id),
      opendota.getWinLoss(ref.id),
    ]);

    return [
      {
        ref,
        queue: "ranked",
        tier: dotaRankName(player.rank_tier),
        division: player.rank_tier ? String(player.rank_tier % 10) : null,
        tierPoints: null,
        rating: player.mmr_estimate?.estimate ?? player.competitive_rank ?? null,
        position: player.leaderboard_rank ?? null,
        percentilePermille: null,
        wins: winLoss.win,
        losses: winLoss.lose,
        season: null,
        raw: player,
      },
    ];
  }

  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const matches = await providers.opendota(this.runtime).getMatches(ref.id, {
      limit: this.limit(options.limit),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
    });

    return matches.map((match) => {
      // Slots 0-127 are Radiant, 128+ are Dire. This is the only place the
      // player's side is recorded on a history row.
      const isRadiant = match.player_slot < 128;
      return {
        matchId: String(match.match_id),
        titleId: this.title.id,
        mode: String(match.game_mode),
        map: null,
        startedAt: ts(match.start_time),
        durationSeconds: match.duration,
        result: matchResult(match.radiant_win === isRadiant),
        playerStats: participantStats({
          kills: match.kills,
          deaths: match.deaths,
          assists: match.assists,
          extra: {
            heroId: match.hero_id,
            gpm: match.gold_per_min ?? null,
            xpm: match.xp_per_min ?? null,
            lastHits: match.last_hits ?? null,
            heroDamage: match.hero_damage ?? null,
          },
        }),
        raw: match,
      };
    });
  }

  public override async getMatch(matchId: string): Promise<MatchDetail> {
    this.require("getMatch");
    const match = await providers.opendota(this.runtime).getMatch(matchId);
    const players = asArray<Record<string, unknown>>(match.players);
    const radiantWin = match.radiant_win === true;

    return {
      matchId,
      titleId: this.title.id,
      mode: str(match.game_mode),
      map: null,
      startedAt: ts(match.start_time),
      durationSeconds: int(match.duration),
      result: "unknown",
      playerStats: null,
      teams: [
        {
          id: "radiant",
          name: str(match.radiant_name) ?? "Radiant",
          won: radiantWin,
          score: int(match.radiant_score),
          roundsWon: null,
        },
        {
          id: "dire",
          name: str(match.dire_name) ?? "Dire",
          won: !radiantWin,
          score: int(match.dire_score),
          roundsWon: null,
        },
      ],
      participants: players.map((player) => ({
        playerId: String(player.account_id ?? "anonymous"),
        displayName: str(player.personaname),
        teamId: (int(player.player_slot) ?? 0) < 128 ? "radiant" : "dire",
        character: str(player.hero_id),
        stats: participantStats({
          kills: int(player.kills),
          deaths: int(player.deaths),
          assists: int(player.assists),
          damageDealt: int(player.hero_damage),
          healing: int(player.hero_healing),
          extra: {
            gpm: int(player.gold_per_min),
            xpm: int(player.xp_per_min),
            lastHits: int(player.last_hits),
            denies: int(player.denies),
            netWorth: int(player.net_worth),
            towerDamage: int(player.tower_damage),
            level: int(player.level),
          },
        }),
        raw: player,
      })),
      rounds: [],
      patch: str(match.patch),
      raw: match,
    };
  }

  /** The regional Immortal leaderboard. */
  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const response = await providers
      .opendota(this.runtime)
      .getLeaderboard(options.region ?? "europe");
    const rows = response?.leaderboard ?? [];
    return rows.slice(0, this.limit(options.limit, 100)).map((row) => ({
      position: row.rank,
      playerId: null,
      displayName: row.name,
      rating: null,
      tier: "Immortal",
      wins: null,
      losses: null,
      country: null,
      raw: row,
    }));
  }

  /** The hero list, for turning hero ids into names. */
  public override async getMetadata(kind = "heroes"): Promise<unknown> {
    this.require("getMetadata");
    if (kind !== "heroes") {
      throw new ValidationError(`Dota 2 metadata "${kind}" is not available - try "heroes"`);
    }
    return providers.opendota(this.runtime).getHeroes();
  }
}

// ---------------------------------------------------------------------------
// Team Fortress 2
// ---------------------------------------------------------------------------

/**
 * Team Fortress 2.
 *
 * Steam holds career totals, logs.tf holds the competitive record. There is no
 * rank of any kind, which is why the title does not declare `getRank` - the
 * game has never had one.
 */
export class TeamFortress2Client extends TitleClient {
  private readonly appId = STEAM_APP_IDS["team-fortress-2"] ?? 440;

  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const steam = providers.steam(this.runtime);
    const steamId = query.steamId
      ? toSteamId64(query.steamId)
      : await steam.resolveVanityUrl(query.name as string, this.title.id);
    const summary = await steam.getPlayerSummary(steamId, this.title.id);
    return this.ref({
      providerId: "steam",
      id: steamId,
      displayName: summary.personaname,
      platform: "steam",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const steam = providers.steam(this.runtime);
    const summary = await steam.getPlayerSummary(ref.id, this.title.id);
    return {
      ref,
      displayName: summary.personaname,
      level: null,
      avatarUrl: summary.avatarfull ?? null,
      profileUrl: summary.profileurl ?? null,
      createdAt: ts(summary.timecreated),
      lastSeenAt: ts(summary.lastlogoff),
      country: summary.loccountrycode ?? null,
      clan: summary.primaryclanid ?? null,
      isPrivate: !steam.isPublic(summary),
      raw: summary,
    };
  }

  /** Per-class career totals, which is how TF2 records everything. */
  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const stats = await providers
      .steam(this.runtime)
      .getStatMap(ref.id, this.appId, this.title.id);

    const classes = [
      "Scout",
      "Soldier",
      "Pyro",
      "Demoman",
      "Heavy",
      "Engineer",
      "Medic",
      "Sniper",
      "Spy",
    ];
    const modes: Record<string, ReturnType<typeof modeStats>> = {};
    for (const className of classes) {
      const kills = stats[`${className}.accum.iNumberOfKills`];
      if (kills === undefined) continue;
      modes[className.toLowerCase()] = modeStats({
        id: className.toLowerCase(),
        label: className,
        kills,
        extra: {
          playtime: stats[`${className}.accum.iPlayTime`] ?? null,
          damage: stats[`${className}.accum.iDamageDealt`] ?? null,
          pointsScored: stats[`${className}.accum.iPointsScored`] ?? null,
        },
      });
    }

    const totalKills = Object.values(modes).reduce((sum, mode) => sum + (mode.kills ?? 0), 0);
    return playerStats({
      ref,
      kills: totalKills > 0 ? totalKills : null,
      modes,
      raw: stats,
    });
  }

  /** Competitive logs from logs.tf. */
  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const logs = await providers.logstf(this.runtime).getPlayerLogs(ref.id, {
      limit: this.limit(options.limit),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
    });

    return logs.map((log) => ({
      matchId: String(log.id ?? ""),
      titleId: this.title.id,
      mode: "competitive",
      map: str(log.map),
      startedAt: ts(log.date),
      durationSeconds: null,
      // A log records both teams' scores but not which side the player was on;
      // that needs the full log, so the summary honestly says "unknown".
      result: "unknown",
      playerStats: null,
      raw: log,
    }));
  }

  public override async getMatch(matchId: string): Promise<MatchDetail> {
    this.require("getMatch");
    const log = await providers.logstf(this.runtime).getLog(matchId);
    const teams = (log.teams as Record<string, Record<string, unknown>>) ?? {};
    const playerRows = (log.players as Record<string, Record<string, unknown>>) ?? {};
    const names = (log.names as Record<string, string>) ?? {};

    const redScore = int(teams.Red?.score);
    const blueScore = int(teams.Blue?.score);

    return {
      matchId,
      titleId: this.title.id,
      mode: "competitive",
      map: str((log.info as Record<string, unknown> | undefined)?.map),
      startedAt: ts((log.info as Record<string, unknown> | undefined)?.date),
      durationSeconds: int((log.info as Record<string, unknown> | undefined)?.total_length),
      result: "unknown",
      playerStats: null,
      teams: [
        {
          id: "Red",
          name: "RED",
          won: redScore !== null && blueScore !== null ? redScore > blueScore : null,
          score: redScore,
          roundsWon: redScore,
        },
        {
          id: "Blue",
          name: "BLU",
          won: redScore !== null && blueScore !== null ? blueScore > redScore : null,
          score: blueScore,
          roundsWon: blueScore,
        },
      ],
      participants: Object.entries(playerRows).map(([steamId3, row]) => ({
        playerId: steamId3,
        displayName: names[steamId3] ?? null,
        teamId: str(row.team),
        character: str(asArray<Record<string, unknown>>(row.class_stats)[0]?.type),
        stats: participantStats({
          kills: int(row.kills),
          deaths: int(row.deaths),
          assists: int(row.assists),
          damageDealt: int(row.dmg),
          damageTaken: int(row.dt),
          healing: int(row.hr ?? row.heal),
          extra: {
            dpm: int(row.dapm),
            ubers: int(row.ubers),
            drops: int(row.drops),
            headshots: int(row.headshots),
            backstabs: int(row.backstabs),
          },
        }),
        raw: row,
      })),
      rounds: asArray<Record<string, unknown>>(log.rounds).map((round, index) => ({
        index,
        winningTeamId: str(round.winner),
        durationSeconds: int(round.length),
        raw: round,
      })),
      patch: null,
      raw: log,
    };
  }
}

// ---------------------------------------------------------------------------
// Deadlock
// ---------------------------------------------------------------------------

/**
 * Deadlock.
 *
 * In closed testing, so the upstream schema moves between patches. Everything
 * normalised here is the part that has been stable; the rest survives in `raw`,
 * which is exactly the case the raw field was added for.
 */
export class DeadlockClient extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const raw = query.steamId ?? query.accountId;
    if (raw === undefined) throw new ValidationError("Deadlock needs a Steam id or account id");
    return this.ref({
      providerId: "deadlock-api",
      id: toSteamAccountId(String(raw)),
      platform: "steam",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const card = await providers.deadlock(this.runtime).getPlayerCard(ref.id);
    return {
      ref,
      displayName: str(card.account_name) ?? ref.id,
      level: int(card.account_level),
      avatarUrl: null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: null,
      country: null,
      clan: null,
      isPrivate: false,
      raw: card,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const history = await providers.deadlock(this.runtime).getMatchHistory(ref.id);
    const wins = history.filter((match) => int(match.match_result) === int(match.player_team)).length;
    return playerStats({
      ref,
      matchesPlayed: history.length,
      wins,
      losses: history.length - wins,
      kills: history.reduce((sum, match) => sum + (int(match.player_kills) ?? 0), 0),
      deaths: history.reduce((sum, match) => sum + (int(match.player_deaths) ?? 0), 0),
      assists: history.reduce((sum, match) => sum + (int(match.player_assists) ?? 0), 0),
      raw: history,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const card = await providers.deadlock(this.runtime).getPlayerCard(ref.id);
    const rank = int(card.ranked_rank ?? card.rank);
    if (rank === null) return [];
    return [
      {
        ref,
        queue: "ranked",
        // Deadlock encodes rank as `tier * 10 + subrank`, like Dota 2.
        tier: String(Math.floor(rank / 10)),
        division: String(rank % 10),
        tierPoints: null,
        rating: rank,
        position: null,
        percentilePermille: null,
        wins: null,
        losses: null,
        season: null,
        raw: card,
      },
    ];
  }

  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const history = await providers.deadlock(this.runtime).getMatchHistory(ref.id);
    return history.slice(0, this.limit(options.limit)).map((match) => ({
      matchId: String(match.match_id ?? ""),
      titleId: this.title.id,
      mode: str(match.game_mode),
      map: null,
      startedAt: ts(match.start_time),
      durationSeconds: int(match.match_duration_s),
      result: matchResult(int(match.match_result) === int(match.player_team)),
      playerStats: participantStats({
        kills: int(match.player_kills),
        deaths: int(match.player_deaths),
        assists: int(match.player_assists),
        extra: { heroId: int(match.hero_id), netWorth: int(match.net_worth) },
      }),
      raw: match,
    }));
  }

  public override async getMatch(matchId: string): Promise<MatchDetail> {
    this.require("getMatch");
    const match = await providers.deadlock(this.runtime).getMatch(matchId);
    const info = (match.match_info as Record<string, unknown>) ?? match;
    const players = asArray<Record<string, unknown>>(info.players);

    return {
      matchId,
      titleId: this.title.id,
      mode: str(info.game_mode),
      map: null,
      startedAt: ts(info.start_time),
      durationSeconds: int(info.duration_s),
      result: "unknown",
      playerStats: null,
      teams: [0, 1].map((team) => ({
        id: String(team),
        name: team === 0 ? "Sapphire" : "Amber",
        won: int(info.winning_team) === team,
        score: null,
        roundsWon: null,
      })),
      participants: players.map((player) => ({
        playerId: String(player.account_id ?? ""),
        displayName: null,
        teamId: str(player.team),
        character: str(player.hero_id),
        stats: participantStats({
          kills: int(player.kills),
          deaths: int(player.deaths),
          assists: int(player.assists),
          extra: {
            netWorth: int(player.net_worth),
            lastHits: int(player.last_hits),
            denies: int(player.denies),
          },
        }),
        raw: player,
      })),
      rounds: [],
      patch: null,
      raw: match,
    };
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const rows = await providers.deadlock(this.runtime).getLeaderboard(options.region ?? "Europe");
    return rows.slice(0, this.limit(options.limit, 100)).map((row, index) => ({
      position: int(row.rank) ?? index + 1,
      playerId: str(row.account_id),
      displayName: str(row.account_name),
      rating: int(row.ranked_rank),
      tier: null,
      wins: int(row.wins),
      losses: null,
      country: null,
      raw: row,
    }));
  }
}

/**
 * Steam-backed titles whose stats are a flat name/value list and nothing more.
 *
 * Rust, War Thunder, Naraka and Dead by Daylight all expose career totals
 * through `ISteamUserStats` and nothing else. Rather than four near-identical
 * classes, they share this one and differ only by app id.
 */
export class SteamStatsClient extends TitleClient {
  private get appId(): number {
    const appId = STEAM_APP_IDS[this.title.id];
    if (!appId) {
      throw new ValidationError(`no Steam app id registered for ${this.title.id}`);
    }
    return appId;
  }

  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const steam = providers.steam(this.runtime);
    const steamId = query.steamId
      ? toSteamId64(query.steamId)
      : await steam.resolveVanityUrl(query.name as string, this.title.id);
    const summary = await steam.getPlayerSummary(steamId, this.title.id);
    return this.ref({
      providerId: "steam",
      id: steamId,
      displayName: summary.personaname,
      platform: "steam",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const steam = providers.steam(this.runtime);
    const summary = await steam.getPlayerSummary(ref.id, this.title.id);
    const owned = await steam.getRecentlyPlayedGames(ref.id, this.title.id).catch(() => []);
    const thisGame = owned.find((game) => game.appid === this.appId);

    return {
      ref,
      displayName: summary.personaname,
      level: null,
      avatarUrl: summary.avatarfull ?? null,
      profileUrl: summary.profileurl ?? null,
      createdAt: ts(summary.timecreated),
      lastSeenAt: ts(summary.lastlogoff),
      country: summary.loccountrycode ?? null,
      clan: summary.primaryclanid ?? null,
      isPrivate: !steam.isPublic(summary),
      raw: { summary, recent: thisGame ?? null },
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const steam = providers.steam(this.runtime);
    const stats = await steam.getStatMap(ref.id, this.appId, this.title.id);
    const owned = await steam.getOwnedGames(ref.id, this.title.id).catch(() => []);
    const playtime = owned.find((game) => game.appid === this.appId)?.playtime_forever;

    // Names differ per title, so the common ones are probed and the rest kept
    // in `raw` - inventing a mapping per game would be guesswork.
    return playerStats({
      ref,
      wins: stats.wins ?? stats.total_wins ?? null,
      losses: stats.losses ?? stats.total_losses ?? null,
      kills: stats.kills ?? stats.total_kills ?? stats.player_kills ?? null,
      deaths: stats.deaths ?? stats.total_deaths ?? null,
      timePlayedSeconds: playtime !== undefined ? playtime * 60 : null,
      raw: stats,
    });
  }
}

/** Win rate helper kept local: several clients above compute it the same way. */
export function ratio(part: number | null, whole: number | null): number | null {
  return permille(part, whole);
}
