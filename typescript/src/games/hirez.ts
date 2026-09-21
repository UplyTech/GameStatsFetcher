/**
 * SMITE and Paladins.
 *
 * One provider, one schema, two titles. The only real difference is the word
 * for a character - gods in SMITE, champions in Paladins - so the shared base
 * below parameterises that and nothing else.
 *
 * Hi-Rez names are not unique across platforms, so `resolvePlayer` prefers an
 * exact PC match and otherwise takes the first result rather than guessing
 * between a console and a PC account with the same name.
 */

import { TitleClient, isPlayerRef } from "../title-client.js";
import * as providers from "../providers/index.js";
import type { HiRezGame, HiRezRankedStats } from "../providers/hirez.js";
import { NotFoundError } from "../errors.js";
import {
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
  ModeStats,
  PlayerProfile,
  PlayerQuery,
  PlayerRef,
  PlayerStats,
  RankInfo,
} from "../types.js";

abstract class HiRezTitleClient extends TitleClient {
  protected abstract game(): HiRezGame;

  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const name = String(query.name ?? query.accountId ?? "");
    const hirez = providers.hirez(this.runtime);

    // A console and a PC player can share a name. Portal 5 is PC (Hi-Rez),
    // and preferring it is the least surprising default for a stats lookup.
    const candidates = await hirez.getPlayerIdByName(this.game(), name);
    const chosen = candidates.find((row) => row.portal_id === "5") ?? candidates[0];
    const id = chosen?.player_id ?? name;

    const player = await hirez.getPlayer(this.game(), id);
    return this.ref({
      providerId: "hirez",
      id: String(player.Id ?? id),
      displayName: player.hz_player_name ?? player.Name ?? name,
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.hirez(this.runtime).getPlayer(this.game(), ref.id);

    return {
      ref,
      displayName: player.hz_player_name ?? player.Name,
      level: player.Level,
      avatarUrl: null,
      profileUrl: null,
      createdAt: ts(player.Created_Datetime),
      lastSeenAt: ts(player.Last_Login_Datetime),
      country: null,
      clan: player.Team_Name ?? null,
      isPrivate: false,
      raw: player,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const hirez = providers.hirez(this.runtime);
    const [player, characters] = await Promise.all([
      hirez.getPlayer(this.game(), ref.id),
      hirez.getPlayerCharacterRanks(this.game(), ref.id),
    ]);

    const modes: Record<string, ModeStats> = {};
    for (const row of characters) {
      const id = String(row.god ?? row.champion ?? row.god_id ?? row.champion_id ?? "unknown");
      modes[id] = modeStats({
        id,
        label: id,
        wins: int(row.Wins),
        losses: int(row.Losses),
        kills: int(row.Kills),
        deaths: int(row.Deaths),
        assists: int(row.Assists),
        extra: { rank: int(row.Rank), worshippers: int(row.Worshippers) },
      });
    }

    return playerStats({
      ref,
      wins: player.Wins,
      losses: player.Losses,
      modes,
      raw: { player, characters },
    });
  }

  /** One rank per ranked queue: conquest, joust, duel, and keyboard variants. */
  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.hirez(this.runtime).getPlayer(this.game(), ref.id);

    const queues: [string, HiRezRankedStats | undefined][] = [
      ["conquest", player.RankedConquest],
      ["joust", player.RankedJoust],
      ["duel", player.RankedDuel],
      ["keyboard", player.RankedKBM],
    ];

    return queues
      .filter(([, stats]) => stats && stats.Wins + stats.Losses > 0)
      .map(([queue, stats]) => ({
        ref,
        queue,
        tier: stats?.Name ?? null,
        division: stats?.Tier !== undefined ? String(stats.Tier) : null,
        tierPoints: stats?.Points ?? null,
        rating: stats?.Points ?? null,
        position: stats?.Rank ?? null,
        percentilePermille: null,
        wins: stats?.Wins ?? null,
        losses: stats?.Losses ?? null,
        season: stats?.Season !== undefined ? String(stats.Season) : null,
        raw: stats,
      }));
  }

  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const history = await providers.hirez(this.runtime).getMatchHistory(this.game(), ref.id);

    return history.slice(0, this.limit(options.limit)).map((match) => ({
      matchId: String(match.Match ?? ""),
      titleId: this.title.id,
      mode: str(match.Queue),
      map: str(match.Map_Game),
      startedAt: ts(match.Match_Time),
      durationSeconds: (() => {
        const minutes = int(match.Minutes);
        return minutes === null ? null : minutes * 60;
      })(),
      result: matchResult(str(match.Win_Status) === "Win"),
      playerStats: participantStats({
        kills: int(match.Kills),
        deaths: int(match.Deaths),
        assists: int(match.Assists),
        damageDealt: int(match.Damage_Player),
        damageTaken: int(match.Damage_Taken),
        healing: int(match.Healing),
        extra: {
          character: str(match.God ?? match.Champion),
          gold: int(match.Gold),
          level: int(match.Level),
        },
      }),
      raw: match,
    }));
  }

  public override async getMatch(matchId: string): Promise<MatchDetail> {
    this.require("getMatch");
    const rows = await providers.hirez(this.runtime).getMatchDetails(this.game(), matchId);
    const first = rows[0] ?? {};

    return {
      matchId,
      titleId: this.title.id,
      mode: str(first.name ?? first.Match_Queue_Id),
      map: str(first.Map_Game),
      startedAt: ts(first.Entry_Datetime),
      durationSeconds: int(first.Match_Duration),
      result: "unknown",
      playerStats: null,
      teams: [1, 2].map((team) => ({
        id: String(team),
        name: `Team ${team}`,
        won: int(first.Winning_TaskForce) === team,
        score: null,
        roundsWon: null,
      })),
      participants: rows.map((row) => ({
        playerId: String(row.playerId ?? row.ActivePlayerId ?? ""),
        displayName: str(row.playerName ?? row.hz_player_name),
        teamId: str(row.TaskForce),
        character: str(row.Reference_Name ?? row.God ?? row.Champion),
        stats: participantStats({
          kills: int(row.Kills_Player),
          deaths: int(row.Deaths),
          assists: int(row.Assists),
          damageDealt: int(row.Damage_Player),
          damageTaken: int(row.Damage_Taken),
          healing: int(row.Healing),
          extra: {
            gold: int(row.Gold_Earned),
            level: int(row.Final_Match_Level),
            objectiveDamage: int(row.Damage_Structure),
          },
        }),
        raw: row,
      })),
      rounds: [],
      patch: str(first.Match_Version),
      raw: rows,
    };
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const queueId = Number(options.queue ?? 451);
    const season = Number(options.season ?? 0);
    const rows = await providers
      .hirez(this.runtime)
      .getLeagueLeaderboard(this.game(), queueId, 26, season);

    if (rows.length === 0) {
      throw new NotFoundError(
        "hirez",
        `leaderboard for queue ${queueId} in season ${season}`,
        this.title.id,
      );
    }

    return rows.slice(0, this.limit(options.limit, 100)).map((row, index) => ({
      position: int(row.Rank) ?? index + 1,
      playerId: str(row.player_id),
      displayName: str(row.player_name),
      rating: int(row.Points),
      tier: str(row.Tier),
      wins: int(row.Wins),
      losses: int(row.Losses),
      country: null,
      raw: row,
    }));
  }

  public override async getMetadata(): Promise<unknown> {
    this.require("getMetadata");
    return providers.hirez(this.runtime).getCharacters(this.game());
  }
}

/** SMITE. */
export class SmiteClient extends HiRezTitleClient {
  protected game(): HiRezGame {
    return "smite";
  }
}

/** Paladins. */
export class PaladinsClient extends HiRezTitleClient {
  protected game(): HiRezGame {
    return "paladins";
  }
}
