/**
 * The Relic-published strategy titles: Age of Empires II DE, Age of Empires IV
 * and Company of Heroes 3.
 *
 * All three answer to the Relic Community API, which has one property worth
 * knowing: **a player is found by searching a ladder, not by an id endpoint.**
 * There is no "get player" - you ask a leaderboard about a name and get back a
 * stat group. That shapes `resolvePlayer` here.
 *
 * Age of Empires IV additionally has AoE4World, which is friendlier and adds
 * civilisation breakdowns, so it is preferred for that title.
 */

import { TitleClient, isPlayerRef } from "../title-client.js";
import * as providers from "../providers/index.js";
import { NotFoundError } from "../errors.js";
import {
  asArray,
  int,
  matchResult,
  modeStats,
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
  RankInfo,
} from "../types.js";

/** Shared Relic behaviour for the two titles that have no better provider. */
class RelicTitleClient extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const group = await providers.relic(this.runtime).findPlayer(this.title.id, {
      ...(query.steamId ? { steamId: String(query.steamId) } : {}),
      ...(query.name ? { name: String(query.name) } : {}),
    });
    const member = asArray<Record<string, unknown>>(group.members)[0];

    return this.ref({
      providerId: "relic",
      id: String(member?.profile_id ?? group.id ?? ""),
      displayName: str(member?.alias),
      platform: "steam",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const response = await providers
      .relic(this.runtime)
      .getPersonalStats(this.title.id, [ref.id]);
    const member = asArray<Record<string, unknown>>(
      asArray<Record<string, unknown>>(response.statGroups)[0]?.members,
    )[0];

    return {
      ref,
      displayName: str(member?.alias) ?? ref.id,
      level: int(member?.level),
      avatarUrl: null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: null,
      country: str(member?.country),
      clan: null,
      isPrivate: false,
      raw: response,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const response = await providers
      .relic(this.runtime)
      .getPersonalStats(this.title.id, [ref.id]);
    const rows = asArray<Record<string, unknown>>(response.leaderboardStats);

    const modes: Record<string, ModeStats> = {};
    for (const row of rows) {
      const id = String(row.leaderboard_id ?? "unknown");
      modes[id] = modeStats({
        id,
        wins: int(row.wins),
        losses: int(row.losses),
        extra: {
          rating: int(row.rating),
          rank: int(row.rank),
          streak: int(row.streak),
          highestRating: int(row.highestrating),
        },
      });
    }

    return playerStats({
      ref,
      wins: sum(rows.map((row) => int(row.wins))),
      losses: sum(rows.map((row) => int(row.losses))),
      modes,
      raw: response,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const response = await providers
      .relic(this.runtime)
      .getPersonalStats(this.title.id, [ref.id]);

    return asArray<Record<string, unknown>>(response.leaderboardStats).map((row) => ({
      ref,
      queue: String(row.leaderboard_id ?? "unknown"),
      tier: null,
      division: null,
      tierPoints: null,
      rating: int(row.rating),
      position: int(row.rank),
      percentilePermille: null,
      wins: int(row.wins),
      losses: int(row.losses),
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
    const matches = await providers
      .relic(this.runtime)
      .getRecentMatches(this.title.id, [ref.id]);

    return matches.slice(0, this.limit(options.limit)).map((match) => {
      const members = asArray<Record<string, unknown>>(match.matchhistorymember);
      const mine = members.find((member) => String(member.profile_id) === ref.id);
      return {
        matchId: String(match.id ?? ""),
        titleId: this.title.id,
        mode: str(match.matchtype_id),
        map: str(match.mapname),
        startedAt: ts(match.startgametime),
        durationSeconds:
          int(match.completiontime) !== null && int(match.startgametime) !== null
            ? (int(match.completiontime) as number) - (int(match.startgametime) as number)
            : null,
        // Relic encodes the outcome as 1 for a win and 0 for a loss.
        result: mine ? matchResult(int(mine.outcome) === 1) : "unknown",
        playerStats: mine
          ? participantStats({
              extra: {
                civilization: int(mine.civilization_id),
                oldRating: int(mine.oldrating),
                newRating: int(mine.newrating),
              },
            })
          : null,
        raw: match,
      };
    });
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const leaderboardId = Number(options.queue ?? 3);
    const rows = await providers
      .relic(this.runtime)
      .getLeaderboard(this.title.id, leaderboardId, {
        count: this.limit(options.limit, 100),
        ...(options.offset !== undefined ? { start: options.offset + 1 } : {}),
      });

    return rows.map((row, index) => ({
      position: int(row.rank) ?? index + 1,
      playerId: str(row.statgroup_id),
      displayName: null,
      rating: int(row.rating),
      tier: null,
      wins: int(row.wins),
      losses: int(row.losses),
      country: null,
      raw: row,
    }));
  }
}

/** Age of Empires II: Definitive Edition. */
export class AgeOfEmpires2Client extends RelicTitleClient {}

/** Company of Heroes 3. */
export class CompanyOfHeroes3Client extends RelicTitleClient {}

/**
 * Age of Empires IV.
 *
 * AoE4World rather than the raw Relic endpoints: same underlying data, but with
 * civilisation breakdowns, readable leaderboard names and a real player search.
 */
export class AgeOfEmpires4Client extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const term = String(query.name ?? query.steamId ?? query.accountId ?? "");
    const players = await providers.aoe4world(this.runtime).searchPlayers(term);
    const exact =
      players.find((player) => str(player.name)?.toLowerCase() === term.toLowerCase()) ??
      players[0];
    if (!exact) throw new NotFoundError("aoe4world", `AoE4 player "${term}"`, this.title.id);

    return this.ref({
      providerId: "aoe4world",
      id: String(exact.profile_id ?? ""),
      displayName: str(exact.name),
      platform: "steam",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.aoe4world(this.runtime).getPlayer(ref.id);

    return {
      ref,
      displayName: str(player.name) ?? ref.id,
      level: null,
      avatarUrl: str((player.avatars as Record<string, unknown> | undefined)?.medium),
      profileUrl: `https://aoe4world.com/players/${ref.id}`,
      createdAt: null,
      lastSeenAt: ts(player.last_game_at),
      country: str(player.country),
      clan: null,
      isPrivate: false,
      raw: player,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.aoe4world(this.runtime).getPlayer(ref.id);
    const modesRaw = (player.modes as Record<string, Record<string, unknown>>) ?? {};

    const modes: Record<string, ModeStats> = {};
    for (const [id, data] of Object.entries(modesRaw)) {
      modes[id] = modeStats({
        id,
        matchesPlayed: int(data.games_count),
        wins: int(data.wins_count),
        losses: int(data.losses_count),
        extra: {
          rating: int(data.rating),
          maxRating: int(data.max_rating),
          rank: int(data.rank),
          streak: int(data.streak),
        },
      });
    }

    return playerStats({
      ref,
      matchesPlayed: sum(Object.values(modes).map((mode) => mode.matchesPlayed)),
      wins: sum(Object.values(modes).map((mode) => mode.wins)),
      losses: sum(Object.values(modes).map((mode) => mode.losses)),
      modes,
      raw: player,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.aoe4world(this.runtime).getPlayer(ref.id);
    const modesRaw = (player.modes as Record<string, Record<string, unknown>>) ?? {};

    return Object.entries(modesRaw).map(([queue, data]) => ({
      ref,
      queue,
      tier: str(data.rank_level),
      division: null,
      tierPoints: null,
      rating: int(data.rating),
      position: int(data.rank),
      percentilePermille: null,
      wins: int(data.wins_count),
      losses: int(data.losses_count),
      season: str(data.season),
      raw: data,
    }));
  }

  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const games = await providers.aoe4world(this.runtime).getGames(ref.id, {
      limit: this.limit(options.limit),
      ...(options.mode ? { leaderboard: options.mode } : {}),
    });

    return games.map((game) => {
      const teams = asArray<Record<string, unknown>[]>(game.teams);
      const mine = teams
        .flat()
        .map((entry) => (entry.player as Record<string, unknown>) ?? entry)
        .find((player) => String(player.profile_id) === ref.id);
      return {
        matchId: String(game.game_id ?? ""),
        titleId: this.title.id,
        mode: str(game.leaderboard ?? game.kind),
        map: str(game.map),
        startedAt: ts(game.started_at),
        durationSeconds: int(game.duration),
        result: mine ? matchResult(str(mine.result) === "win", str(mine.result) === "draw") : "unknown",
        playerStats: mine
          ? participantStats({
              extra: {
                civilization: str(mine.civilization),
                rating: int(mine.rating),
                ratingDiff: int(mine.rating_diff),
              },
            })
          : null,
        raw: game,
      };
    });
  }

  public override async getMatch(matchId: string): Promise<MatchDetail> {
    this.require("getMatch");
    const game = await providers.aoe4world(this.runtime).getGame(matchId);
    const teams = asArray<Record<string, unknown>[]>(game.teams);

    return {
      matchId,
      titleId: this.title.id,
      mode: str(game.leaderboard ?? game.kind),
      map: str(game.map),
      startedAt: ts(game.started_at),
      durationSeconds: int(game.duration),
      result: "unknown",
      playerStats: null,
      teams: teams.map((team, index) => {
        const first = (team[0]?.player as Record<string, unknown>) ?? team[0] ?? {};
        return {
          id: String(index),
          name: `Team ${index + 1}`,
          won: str(first.result) === "win",
          score: null,
          roundsWon: null,
        };
      }),
      participants: teams.flatMap((team, index) =>
        team.map((entry) => {
          const player = (entry.player as Record<string, unknown>) ?? entry;
          return {
            playerId: String(player.profile_id ?? ""),
            displayName: str(player.name),
            teamId: String(index),
            character: str(player.civilization),
            stats: participantStats({
              extra: {
                rating: int(player.rating),
                ratingDiff: int(player.rating_diff),
                result: str(player.result),
              },
            }),
            raw: player,
          };
        }),
      ),
      rounds: [],
      patch: str(game.patch),
      raw: game,
    };
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const players = await providers
      .aoe4world(this.runtime)
      .getLeaderboard(options.queue ?? "rm_solo", {
        page: options.offset ? Math.floor(options.offset / 50) + 1 : 1,
      });

    return players.slice(0, this.limit(options.limit, 100)).map((player, index) => ({
      position: int(player.rank) ?? index + 1,
      playerId: str(player.profile_id),
      displayName: str(player.name),
      rating: int(player.rating),
      tier: str(player.rank_level),
      wins: int(player.wins_count),
      losses: int(player.losses_count),
      country: str(player.country),
      raw: player,
    }));
  }
}
