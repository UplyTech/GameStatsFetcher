/**
 * iRacing, Trackmania and Brawlhalla.
 *
 * Two sim-racing titles and the one fighting game whose publisher ships a
 * player API. Racing breaks the win/loss model that the rest of the package
 * assumes: a race has forty entrants and one winner, so `result` is `win` only
 * for a first place and `MatchParticipantStats.placement` is the number that
 * actually matters.
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
  ModeStats,
  PlayerProfile,
  PlayerQuery,
  PlayerRef,
  PlayerStats,
  RankInfo,
} from "../types.js";

// ---------------------------------------------------------------------------
// iRacing
// ---------------------------------------------------------------------------

/**
 * iRacing.
 *
 * The categories - oval, road, dirt oval, dirt road - each carry their own
 * iRating and Safety Rating, and a driver can be strong in one and new to
 * another. So `getRank` returns one entry per category rather than a single
 * number that would be meaningless.
 */
export class IRacingClient extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);

    if (query.accountId) {
      const member = await providers.iracing(this.runtime).getMember(String(query.accountId));
      return this.ref({
        providerId: "iracing",
        id: String(member.cust_id ?? query.accountId),
        displayName: str(member.display_name),
        platform: "web",
      });
    }

    const term = String(query.name ?? "");
    const drivers = await providers.iracing(this.runtime).searchDrivers(term);
    const exact =
      drivers.find((driver) => str(driver.display_name)?.toLowerCase() === term.toLowerCase()) ??
      drivers[0];
    if (!exact) throw new NotFoundError("iracing", `driver "${term}"`, this.title.id);

    return this.ref({
      providerId: "iracing",
      id: String(exact.cust_id ?? ""),
      displayName: str(exact.display_name),
      platform: "web",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const member = await providers.iracing(this.runtime).getMember(ref.id);

    return {
      ref,
      displayName: str(member.display_name) ?? ref.id,
      level: null,
      avatarUrl: null,
      profileUrl: `https://members.iracing.com/membersite/member/CareerStats.do?custid=${ref.id}`,
      createdAt: ts(member.member_since),
      lastSeenAt: ts(member.last_login),
      country: str(member.club_name),
      clan: str(member.club_name),
      isPrivate: false,
      raw: member,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const career = await providers.iracing(this.runtime).getCareerStats(ref.id);

    const modes: Record<string, ModeStats> = {};
    for (const row of career) {
      const id = str(row.category) ?? "unknown";
      modes[id] = modeStats({
        id,
        matchesPlayed: int(row.starts),
        wins: int(row.wins),
        losses:
          int(row.starts) !== null && int(row.wins) !== null
            ? (int(row.starts) as number) - (int(row.wins) as number)
            : null,
        extra: {
          top5: int(row.top5),
          poles: int(row.poles),
          avgStartPosition: num(row.avg_start_position),
          avgFinishPosition: num(row.avg_finish_position),
          lapsLed: int(row.laps_led),
          incidentsPerRace: num(row.avg_incidents),
        },
      });
    }

    const overall = career.find((row) => str(row.category) === "Overall") ?? career[0];
    return playerStats({
      ref,
      matchesPlayed: int(overall?.starts),
      wins: int(overall?.wins),
      modes,
      raw: career,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const member = await providers.iracing(this.runtime).getMember(ref.id);
    const licenses = asArray<Record<string, unknown>>(member.licenses);

    return licenses.map((licence) => ({
      ref,
      queue: str(licence.category) ?? "unknown",
      // The licence class - Rookie through Pro - is the tier a driver names.
      tier: str(licence.group_name),
      division: str(licence.safety_rating),
      tierPoints: int(licence.safety_rating !== undefined ? Math.round((num(licence.safety_rating) ?? 0) * 100) : null),
      rating: int(licence.irating),
      position: null,
      percentilePermille: null,
      wins: null,
      losses: null,
      season: null,
      raw: licence,
    }));
  }

  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const races = await providers.iracing(this.runtime).getRecentRaces(ref.id);

    return races.slice(0, this.limit(options.limit)).map((race) => ({
      matchId: String(race.subsession_id ?? ""),
      titleId: this.title.id,
      mode: str(race.license_category ?? race.series_name),
      map: str(race.track ? (race.track as Record<string, unknown>).track_name : null),
      startedAt: ts(race.session_start_time),
      durationSeconds: null,
      // A race is a win only for a first place; everything else is a finish.
      result: matchResult(int(race.finish_position) === 0 || int(race.finish_position) === 1),
      playerStats: participantStats({
        placement: (() => {
          const position = int(race.finish_position);
          // iRacing counts positions from zero, which reads wrong to everyone.
          return position === null ? null : position + 1;
        })(),
        extra: {
          startPosition: int(race.start_position),
          incidents: int(race.incidents),
          strengthOfField: int(race.strength_of_field),
          oldIrating: int(race.oldi_rating),
          newIrating: int(race.newi_rating),
          points: int(race.points),
        },
      }),
      raw: race,
    }));
  }

  public override async getMatch(matchId: string): Promise<MatchDetail> {
    this.require("getMatch");
    const result = await providers.iracing(this.runtime).getResult(matchId);
    const sessions = asArray<Record<string, unknown>>(result.session_results);
    const race = sessions.find((session) => str(session.simsession_type_name) === "Race") ?? sessions[0];
    const rows = asArray<Record<string, unknown>>(race?.results);

    return {
      matchId,
      titleId: this.title.id,
      mode: str(result.license_category),
      map: str((result.track as Record<string, unknown> | undefined)?.track_name),
      startedAt: ts(result.start_time),
      durationSeconds: int(result.event_average_lap),
      result: "unknown",
      playerStats: null,
      teams: [],
      participants: rows.map((row) => ({
        playerId: String(row.cust_id ?? ""),
        displayName: str(row.display_name),
        teamId: null,
        character: str(row.car_name),
        stats: participantStats({
          placement: (int(row.finish_position) ?? 0) + 1,
          extra: {
            startPosition: (int(row.starting_position) ?? 0) + 1,
            lapsComplete: int(row.laps_complete),
            lapsLed: int(row.laps_led),
            incidents: int(row.incidents),
            bestLapTime: int(row.best_lap_time),
            oldIrating: int(row.oldi_rating),
            newIrating: int(row.newi_rating),
          },
        }),
        raw: row,
      })),
      rounds: [],
      patch: null,
      raw: result,
    };
  }

  public override async getLeaderboard(
    _options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    throw new ValidationError(
      "iRacing standings are per season and car class - use providers.iracing().getSeasonStandings() with the season id",
    );
  }
}

// ---------------------------------------------------------------------------
// Trackmania
// ---------------------------------------------------------------------------

/**
 * Trackmania.
 *
 * Two competitive systems: matchmaking (the Trackmaster ladder) and the
 * Campaign/Track of the Day leaderboards. `getRank` reports the former;
 * `getLeaderboard` reports the former too, because a per-map board needs a map
 * and belongs on the provider rather than in the canonical surface.
 */
export class TrackmaniaClient extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);

    if (query.accountId) {
      return this.ref({
        providerId: "trackmania-io",
        id: String(query.accountId),
        displayName: str(query.name),
        platform: "ubisoft",
      });
    }
    const players = await providers.trackmania(this.runtime).searchPlayers(String(query.name));
    const first = players[0];
    const account = (first?.player as Record<string, unknown> | undefined) ?? first ?? {};

    return this.ref({
      providerId: "trackmania-io",
      id: String(account.id ?? account.accountid ?? ""),
      displayName: str(account.name),
      platform: "ubisoft",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.trackmania(this.runtime).getPlayer(ref.id);

    return {
      ref,
      displayName: str(player.displayname ?? player.name) ?? ref.id,
      level: null,
      avatarUrl: null,
      profileUrl: `https://trackmania.io/#/player/${ref.id}`,
      createdAt: null,
      lastSeenAt: null,
      country: str((player.trophies as Record<string, unknown> | undefined)?.zone
        ? (((player.trophies as Record<string, Record<string, unknown>>).zone)?.name as string)
        : null),
      clan: str((player.club as Record<string, unknown> | undefined)?.name),
      isPrivate: false,
      raw: player,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.trackmania(this.runtime).getPlayer(ref.id);
    const matchmaking = asArray<Record<string, unknown>>(player.matchmaking);

    const modes: Record<string, ModeStats> = {};
    for (const entry of matchmaking) {
      const id = str(entry.typename) ?? String(entry.typeid ?? "matchmaking");
      modes[id] = modeStats({
        id,
        extra: {
          rank: int(entry.rank),
          score: int(entry.score),
          division: int((entry.division as Record<string, unknown> | undefined)?.position),
          divisionName: str((entry.division as Record<string, unknown> | undefined)?.rule),
        },
      });
    }

    return playerStats({
      ref,
      modes,
      raw: player,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.trackmania(this.runtime).getPlayer(ref.id);

    return asArray<Record<string, unknown>>(player.matchmaking).map((entry) => ({
      ref,
      queue: str(entry.typename) ?? "matchmaking",
      tier: str((entry.division as Record<string, unknown> | undefined)?.rule),
      division: str((entry.division as Record<string, unknown> | undefined)?.position),
      tierPoints: int(entry.score),
      rating: int(entry.score),
      position: int(entry.rank),
      percentilePermille: null,
      wins: null,
      losses: null,
      season: null,
      raw: entry,
    }));
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const page = options.offset ? Math.floor(options.offset / 100) : 0;
    const ranks = await providers.trackmania(this.runtime).getMatchmakingLeaderboard(page);

    return ranks.slice(0, this.limit(options.limit, 100)).map((entry, index) => ({
      position: int(entry.rank) ?? index + 1,
      playerId: str(entry.accountid),
      displayName: str((entry.player as Record<string, unknown> | undefined)?.name),
      rating: int(entry.score),
      tier: str((entry.division as Record<string, unknown> | undefined)?.rule),
      wins: null,
      losses: null,
      country: null,
      raw: entry,
    }));
  }
}

// ---------------------------------------------------------------------------
// Brawlhalla
// ---------------------------------------------------------------------------

/**
 * Brawlhalla.
 *
 * The exception among fighting games: Blue Mammoth publishes a real player API,
 * so this title has ranks and career statistics where Tekken and Street Fighter
 * have only brackets.
 */
export class BrawlhallaClient extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);

    if (query.steamId) {
      const found = await providers
        .brawlhalla(this.runtime)
        .getIdBySteamId(String(query.steamId));
      return this.ref({
        providerId: "brawlhalla",
        id: String(found.brawlhalla_id),
        displayName: found.name,
        platform: "steam",
      });
    }
    if (query.accountId) {
      return this.ref({
        providerId: "brawlhalla",
        id: String(query.accountId),
        displayName: str(query.name),
      });
    }

    // Brawlhalla has no name search outside the ranked ladder, so a name-only
    // lookup walks the first pages of the ladder rather than failing.
    const name = String(query.name ?? "");
    for (let page = 1; page <= 3; page += 1) {
      const rows = await providers.brawlhalla(this.runtime).getRankings("1v1", "all", page, name);
      const match = rows.find((row) => str(row.name)?.toLowerCase() === name.toLowerCase());
      if (match) {
        return this.ref({
          providerId: "brawlhalla",
          id: String(match.brawlhalla_id ?? ""),
          displayName: str(match.name),
        });
      }
    }
    throw new NotFoundError(
      "brawlhalla",
      `player "${name}" (only ranked players are searchable by name - pass a Steam id otherwise)`,
      this.title.id,
    );
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const stats = await providers.brawlhalla(this.runtime).getStats(ref.id);

    return {
      ref,
      displayName: str(stats.name) ?? ref.id,
      level: int(stats.level),
      avatarUrl: null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: null,
      country: null,
      clan: str((stats.clan as Record<string, unknown> | undefined)?.clan_name),
      isPrivate: false,
      raw: stats,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const stats = await providers.brawlhalla(this.runtime).getStats(ref.id);

    const modes: Record<string, ModeStats> = {};
    for (const legend of asArray<Record<string, unknown>>(stats.legends)) {
      const id = str(legend.legend_name_key) ?? String(legend.legend_id ?? "unknown");
      modes[id] = modeStats({
        id,
        matchesPlayed: int(legend.games),
        wins: int(legend.wins),
        losses:
          int(legend.games) !== null && int(legend.wins) !== null
            ? (int(legend.games) as number) - (int(legend.wins) as number)
            : null,
        kills: int(legend.kos),
        deaths: int(legend.falls),
        extra: {
          damageDealt: int(legend.damagedealt),
          damageTaken: int(legend.damagetaken),
          matchTime: int(legend.matchtime),
        },
      });
    }

    return playerStats({
      ref,
      matchesPlayed: int(stats.games),
      wins: int(stats.wins),
      losses:
        int(stats.games) !== null && int(stats.wins) !== null
          ? (int(stats.games) as number) - (int(stats.wins) as number)
          : null,
      modes,
      raw: stats,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const ranked = await providers.brawlhalla(this.runtime).getRanked(ref.id);
    if (!ranked) return [];

    const rows: RankInfo[] = [
      {
        ref,
        queue: "1v1",
        tier: str(ranked.tier),
        division: null,
        tierPoints: int(ranked.rating),
        rating: int(ranked.rating),
        position: null,
        percentilePermille: null,
        wins: int(ranked.wins),
        losses:
          int(ranked.games) !== null && int(ranked.wins) !== null
            ? (int(ranked.games) as number) - (int(ranked.wins) as number)
            : null,
        season: null,
        raw: ranked,
      },
    ];

    for (const team of asArray<Record<string, unknown>>(ranked["2v2"])) {
      rows.push({
        ref,
        queue: `2v2:${str(team.teamname) ?? "team"}`,
        tier: str(team.tier),
        division: null,
        tierPoints: int(team.rating),
        rating: int(team.rating),
        position: null,
        percentilePermille: null,
        wins: int(team.wins),
        losses:
          int(team.games) !== null && int(team.wins) !== null
            ? (int(team.games) as number) - (int(team.wins) as number)
            : null,
        season: null,
        raw: team,
      });
    }
    return rows;
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const bracket = (options.queue === "2v2" ? "2v2" : "1v1") as "1v1" | "2v2";
    const rows = await providers
      .brawlhalla(this.runtime)
      .getRankings(bracket, options.region ?? "all", options.offset ? options.offset / 50 + 1 : 1);

    return rows.slice(0, this.limit(options.limit, 50)).map((row, index) => ({
      position: int(row.rank) ?? index + 1,
      playerId: str(row.brawlhalla_id),
      displayName: str(row.name),
      rating: int(row.rating),
      tier: str(row.tier),
      wins: int(row.wins),
      losses:
        int(row.games) !== null && int(row.wins) !== null
          ? (int(row.games) as number) - (int(row.wins) as number)
          : null,
      country: str(row.region),
      raw: row,
    }));
  }

  public override async getMetadata(): Promise<unknown> {
    this.require("getMetadata");
    return providers.brawlhalla(this.runtime).getLegends();
  }
}
