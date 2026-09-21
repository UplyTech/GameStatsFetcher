/**
 * The Supercell titles: Clash Royale, Clash of Clans and Brawl Stars.
 *
 * All three are keyed on a player tag rather than a name, which changes what
 * `resolvePlayer` means here: there is nothing to search, so resolution is a
 * validation of the tag plus one lookup to confirm it exists.
 *
 * Two of the three keep a battle log of roughly the last 25 games and nothing
 * older. That is a hard limit of the API, and it is why `limit` above 25 is
 * clamped rather than paged.
 */

import { TitleClient, isPlayerRef } from "../title-client.js";
import * as providers from "../providers/index.js";
import { normaliseSupercellTag } from "../identity.js";
import { ValidationError } from "../errors.js";
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
  ModeStats,
  PlayerProfile,
  PlayerQuery,
  PlayerRef,
  PlayerStats,
  RankInfo,
} from "../types.js";

/** Shared: resolve and validate a Supercell player tag. */
abstract class SupercellTitleClient extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const tag = normaliseSupercellTag(String(query.playerTag ?? query.name ?? ""));
    const player = await this.fetchPlayer(tag);
    return this.ref({
      providerId: this.providerId(),
      id: tag,
      displayName: str(player.name) ?? tag,
      platform: "android",
    });
  }

  protected abstract providerId(): string;
  protected abstract fetchPlayer(tag: string): Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Clash Royale
// ---------------------------------------------------------------------------

export class ClashRoyaleClient extends SupercellTitleClient {
  protected providerId(): string {
    return "supercell-clash-royale";
  }

  protected fetchPlayer(tag: string): Promise<Record<string, unknown>> {
    return providers.clashRoyale(this.runtime).getPlayer(tag);
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await this.fetchPlayer(ref.id);
    return {
      ref,
      displayName: str(player.name) ?? ref.id,
      level: int(player.expLevel),
      avatarUrl: null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: null,
      country: null,
      clan: str((player.clan as Record<string, unknown> | undefined)?.name),
      isPrivate: false,
      raw: player,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await this.fetchPlayer(ref.id);

    return playerStats({
      ref,
      matchesPlayed: int(player.battleCount),
      wins: int(player.wins),
      losses: int(player.losses),
      draws:
        int(player.battleCount) !== null && int(player.wins) !== null && int(player.losses) !== null
          ? (int(player.battleCount) as number) -
            (int(player.wins) as number) -
            (int(player.losses) as number)
          : null,
      modes: {
        ladder: modeStats({
          id: "ladder",
          label: "Trophy Road",
          extra: {
            trophies: int(player.trophies),
            bestTrophies: int(player.bestTrophies),
            threeCrownWins: int(player.threeCrownWins),
          },
        }),
      },
      raw: player,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await this.fetchPlayer(ref.id);
    const league = player.leagueStatistics as Record<string, unknown> | undefined;

    return [
      {
        ref,
        queue: "trophies",
        tier: str((player.arena as Record<string, unknown> | undefined)?.name),
        division: null,
        tierPoints: int(player.trophies),
        rating: int(player.trophies),
        position: null,
        percentilePermille: null,
        wins: int(player.wins),
        losses: int(player.losses),
        season: str((league?.currentSeason as Record<string, unknown> | undefined)?.id),
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
    const log = await providers.clashRoyale(this.runtime).getBattleLog(ref.id);

    return log.slice(0, this.limit(options.limit, 25)).map((battle) => {
      const team = asArray<Record<string, unknown>>(battle.team)[0];
      const opponent = asArray<Record<string, unknown>>(battle.opponent)[0];
      const teamCrowns = int(team?.crowns) ?? 0;
      const opponentCrowns = int(opponent?.crowns) ?? 0;
      return {
        matchId: `${str(battle.battleTime) ?? ""}:${str(team?.tag) ?? ""}`,
        titleId: this.title.id,
        mode: str((battle.gameMode as Record<string, unknown> | undefined)?.name ?? battle.type),
        map: str((battle.arena as Record<string, unknown> | undefined)?.name),
        startedAt: ts(battle.battleTime),
        durationSeconds: null,
        result: matchResult(teamCrowns > opponentCrowns, teamCrowns === opponentCrowns),
        playerStats: participantStats({
          score: teamCrowns,
          extra: {
            crowns: teamCrowns,
            opponentCrowns,
            trophyChange: int(team?.trophyChange),
          },
        }),
        raw: battle,
      };
    });
  }

  /**
   * Clash Royale has no addressable match ids.
   *
   * A battle is identified only by its timestamp inside the log, so the detail
   * is looked up there rather than fetched - and if it has aged out of the
   * 25-entry log, it is genuinely gone.
   */
  public override async getMatch(matchId: string, context?: PlayerRef): Promise<MatchDetail> {
    this.require("getMatch");
    if (!context) {
      throw new ValidationError(
        "Clash Royale battles are only addressable inside a player's log - pass the PlayerRef as the second argument",
      );
    }
    const log = await providers.clashRoyale(this.runtime).getBattleLog(context.id);
    const battle = log.find((entry) => matchId.startsWith(String(entry.battleTime ?? "")));
    if (!battle) {
      const { NotFoundError } = await import("../errors.js");
      throw new NotFoundError(
        "supercell-clash-royale",
        `battle ${matchId} (Supercell keeps only the last 25)`,
        this.title.id,
      );
    }

    const sides = [
      ["team", asArray<Record<string, unknown>>(battle.team)],
      ["opponent", asArray<Record<string, unknown>>(battle.opponent)],
    ] as const;

    return {
      matchId,
      titleId: this.title.id,
      mode: str((battle.gameMode as Record<string, unknown> | undefined)?.name),
      map: str((battle.arena as Record<string, unknown> | undefined)?.name),
      startedAt: ts(battle.battleTime),
      durationSeconds: null,
      result: "unknown",
      playerStats: null,
      teams: sides.map(([id, players]) => ({
        id,
        name: id,
        won: null,
        score: int(players[0]?.crowns),
        roundsWon: int(players[0]?.crowns),
      })),
      participants: sides.flatMap(([id, players]) =>
        players.map((player) => ({
          playerId: String(player.tag ?? ""),
          displayName: str(player.name),
          teamId: id,
          character: null,
          stats: participantStats({
            score: int(player.crowns),
            extra: {
              startingTrophies: int(player.startingTrophies),
              trophyChange: int(player.trophyChange),
              elixirLeaked: int(player.elixirLeaked),
            },
          }),
          raw: player,
        })),
      ),
      rounds: [],
      patch: null,
      raw: battle,
    };
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const rows = await providers
      .clashRoyale(this.runtime)
      .getPlayerRankings(options.region ?? "global", this.limit(options.limit, 100));
    return rows.map((row, index) => ({
      position: int(row.rank) ?? index + 1,
      playerId: str(row.tag),
      displayName: str(row.name),
      rating: int(row.trophies ?? row.eloRating),
      tier: null,
      wins: null,
      losses: null,
      country: null,
      raw: row,
    }));
  }

  public override async getMetadata(kind = "cards"): Promise<unknown> {
    this.require("getMetadata");
    if (kind !== "cards") {
      throw new ValidationError(`Clash Royale metadata "${kind}" is not available - try "cards"`);
    }
    return providers.clashRoyale(this.runtime).getCards();
  }
}

// ---------------------------------------------------------------------------
// Clash of Clans
// ---------------------------------------------------------------------------

/**
 * Clash of Clans.
 *
 * No per-player match record exists - the game's unit of competition is the
 * clan war, which lives on the clan endpoints. The title declares no
 * `getMatchHistory` for that reason.
 */
export class ClashOfClansClient extends SupercellTitleClient {
  protected providerId(): string {
    return "supercell-clash-of-clans";
  }

  protected fetchPlayer(tag: string): Promise<Record<string, unknown>> {
    return providers.clashOfClans(this.runtime).getPlayer(tag);
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await this.fetchPlayer(ref.id);
    return {
      ref,
      displayName: str(player.name) ?? ref.id,
      level: int(player.expLevel),
      avatarUrl: null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: null,
      country: null,
      clan: str((player.clan as Record<string, unknown> | undefined)?.name),
      isPrivate: false,
      raw: player,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await this.fetchPlayer(ref.id);

    return playerStats({
      ref,
      wins: int(player.attackWins),
      losses: null,
      modes: {
        home: modeStats({
          id: "home",
          label: "Home Village",
          extra: {
            trophies: int(player.trophies),
            bestTrophies: int(player.bestTrophies),
            townHallLevel: int(player.townHallLevel),
            attackWins: int(player.attackWins),
            defenseWins: int(player.defenseWins),
            warStars: int(player.warStars),
          },
        }),
        builder: modeStats({
          id: "builder",
          label: "Builder Base",
          extra: {
            trophies: int(player.builderBaseTrophies),
            bestTrophies: int(player.bestBuilderBaseTrophies),
            hallLevel: int(player.builderHallLevel),
          },
        }),
      },
      raw: player,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await this.fetchPlayer(ref.id);
    return [
      {
        ref,
        queue: "home",
        tier: str((player.league as Record<string, unknown> | undefined)?.name),
        division: null,
        tierPoints: int(player.trophies),
        rating: int(player.trophies),
        position: null,
        percentilePermille: null,
        wins: int(player.attackWins),
        losses: null,
        season: null,
        raw: player,
      },
    ];
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const rows = await providers
      .clashOfClans(this.runtime)
      .getPlayerRankings(options.region ?? "global", this.limit(options.limit, 100));
    return rows.map((row, index) => ({
      position: int(row.rank) ?? index + 1,
      playerId: str(row.tag),
      displayName: str(row.name),
      rating: int(row.trophies),
      tier: str((row.league as Record<string, unknown> | undefined)?.name),
      wins: int(row.attackWins),
      losses: null,
      country: null,
      raw: row,
    }));
  }
}

// ---------------------------------------------------------------------------
// Brawl Stars
// ---------------------------------------------------------------------------

export class BrawlStarsClient extends SupercellTitleClient {
  protected providerId(): string {
    return "supercell-brawl-stars";
  }

  protected fetchPlayer(tag: string): Promise<Record<string, unknown>> {
    return providers.brawlStars(this.runtime).getPlayer(tag);
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await this.fetchPlayer(ref.id);
    return {
      ref,
      displayName: str(player.name) ?? ref.id,
      level: int(player.expLevel),
      avatarUrl: null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: null,
      country: null,
      clan: str((player.club as Record<string, unknown> | undefined)?.name),
      isPrivate: false,
      raw: player,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await this.fetchPlayer(ref.id);

    const modes: Record<string, ModeStats> = {};
    for (const brawler of asArray<Record<string, unknown>>(player.brawlers)) {
      const id = String(brawler.name ?? brawler.id ?? "unknown");
      modes[id] = modeStats({
        id,
        label: str(brawler.name) ?? id,
        extra: {
          power: int(brawler.power),
          rank: int(brawler.rank),
          trophies: int(brawler.trophies),
          highestTrophies: int(brawler.highestTrophies),
        },
      });
    }

    return playerStats({
      ref,
      wins:
        (int(player["3vs3Victories"]) ?? 0) +
        (int(player.soloVictories) ?? 0) +
        (int(player.duoVictories) ?? 0),
      modes,
      raw: player,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await this.fetchPlayer(ref.id);
    return [
      {
        ref,
        queue: "trophies",
        tier: null,
        division: null,
        tierPoints: int(player.trophies),
        rating: int(player.trophies),
        position: null,
        percentilePermille: null,
        wins: int(player["3vs3Victories"]),
        losses: null,
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
    const log = await providers.brawlStars(this.runtime).getBattleLog(ref.id);

    return log.slice(0, this.limit(options.limit, 25)).map((entry) => {
      const battle = (entry.battle as Record<string, unknown>) ?? {};
      const event = (entry.event as Record<string, unknown>) ?? {};
      const result = str(battle.result);
      return {
        matchId: `${str(entry.battleTime) ?? ""}:${str(event.id) ?? ""}`,
        titleId: this.title.id,
        mode: str(battle.mode ?? event.mode),
        map: str(event.map),
        startedAt: ts(entry.battleTime),
        durationSeconds: int(battle.duration),
        result:
          result === "victory"
            ? "win"
            : result === "defeat"
              ? "loss"
              : result === "draw"
                ? "draw"
                : "unknown",
        playerStats: participantStats({
          placement: int(battle.rank),
          extra: { trophyChange: int(battle.trophyChange), starPlayer: str((battle.starPlayer as Record<string, unknown> | undefined)?.tag) },
        }),
        raw: entry,
      };
    });
  }

  public override async getMatch(matchId: string, context?: PlayerRef): Promise<MatchDetail> {
    this.require("getMatch");
    if (!context) {
      throw new ValidationError(
        "Brawl Stars battles are only addressable inside a player's log - pass the PlayerRef as the second argument",
      );
    }
    const log = await providers.brawlStars(this.runtime).getBattleLog(context.id);
    const entry = log.find((row) => matchId.startsWith(String(row.battleTime ?? "")));
    if (!entry) {
      const { NotFoundError } = await import("../errors.js");
      throw new NotFoundError(
        "supercell-brawl-stars",
        `battle ${matchId} (Supercell keeps only the most recent battles)`,
        this.title.id,
      );
    }
    const battle = (entry.battle as Record<string, unknown>) ?? {};
    const event = (entry.event as Record<string, unknown>) ?? {};
    const teams = asArray<Record<string, unknown>[]>(battle.teams);

    return {
      matchId,
      titleId: this.title.id,
      mode: str(battle.mode ?? event.mode),
      map: str(event.map),
      startedAt: ts(entry.battleTime),
      durationSeconds: int(battle.duration),
      result: "unknown",
      playerStats: null,
      teams: teams.map((_, index) => ({
        id: String(index),
        name: `Team ${index + 1}`,
        won: null,
        score: null,
        roundsWon: null,
      })),
      participants: teams.flatMap((team, index) =>
        team.map((player) => ({
          playerId: String(player.tag ?? ""),
          displayName: str(player.name),
          teamId: String(index),
          character: str((player.brawler as Record<string, unknown> | undefined)?.name),
          stats: participantStats({
            extra: {
              power: int((player.brawler as Record<string, unknown> | undefined)?.power),
              trophies: int((player.brawler as Record<string, unknown> | undefined)?.trophies),
            },
          }),
          raw: player,
        })),
      ),
      rounds: [],
      patch: null,
      raw: entry,
    };
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const rows = await providers
      .brawlStars(this.runtime)
      .getPlayerRankings(options.region ?? "global", this.limit(options.limit, 100));
    return rows.map((row, index) => ({
      position: int(row.rank) ?? index + 1,
      playerId: str(row.tag),
      displayName: str(row.name),
      rating: int(row.trophies),
      tier: null,
      wins: null,
      losses: null,
      country: null,
      raw: row,
    }));
  }

  public override async getMetadata(kind = "brawlers"): Promise<unknown> {
    this.require("getMetadata");
    const brawlStars = providers.brawlStars(this.runtime);
    if (kind === "brawlers") return brawlStars.getBrawlers();
    if (kind === "events") return brawlStars.getEventRotation();
    throw new ValidationError(
      `Brawl Stars metadata "${kind}" is not available - try brawlers or events`,
    );
  }
}
