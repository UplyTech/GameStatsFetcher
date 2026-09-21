/**
 * The individual-skill titles: osu!, Beat Saber, chess and Minecraft.
 *
 * These four break an assumption the rest of the package makes, and it is worth
 * naming: **a "match" here is not a match.** An osu! score is one play of one
 * beatmap; a Beat Saber score is the same; a chess game has two players and no
 * teams; a Hypixel game is one round of BedWars. Each client maps its unit onto
 * {@link MatchSummary} in the way that reads correctly for that game, and says
 * how in its own docstring rather than pretending they are all alike.
 */

import { TitleClient, isPlayerRef } from "../title-client.js";
import * as providers from "../providers/index.js";
import { ValidationError } from "../errors.js";
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
  MatchHistoryOptions,
  MatchSummary,
  ModeStats,
  PlayerProfile,
  PlayerQuery,
  PlayerRef,
  PlayerStats,
  RankInfo,
} from "../types.js";
import type { OsuMode } from "../providers/skill.js";

// ---------------------------------------------------------------------------
// osu!
// ---------------------------------------------------------------------------

/**
 * osu!.
 *
 * A "match" is one play of one beatmap, and `MatchSummary.result` is `win` when
 * the play was completed rather than failed - that is the only binary outcome
 * the game has.
 */
export class OsuClient extends TitleClient {
  private mode(value: string | undefined): OsuMode {
    const modes: OsuMode[] = ["osu", "taiko", "fruits", "mania"];
    const chosen = (value ?? "osu") as OsuMode;
    return modes.includes(chosen) ? chosen : "osu";
  }

  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const user = await providers
      .osu(this.runtime)
      .getUser(String(query.name ?? query.accountId ?? ""), this.mode(query.extra?.mode as string));
    return this.ref({
      providerId: "osu",
      id: String(user.id),
      displayName: user.username,
      platform: "web",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const user = await providers.osu(this.runtime).getUser(ref.id);

    return {
      ref,
      displayName: user.username,
      level: user.statistics?.level?.current ?? null,
      avatarUrl: user.avatar_url ?? null,
      profileUrl: `https://osu.ppy.sh/users/${user.id}`,
      createdAt: ts(user.join_date),
      lastSeenAt: ts(user.last_visit),
      country: user.country_code ?? null,
      clan: null,
      isPrivate: false,
      raw: user,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const osu = providers.osu(this.runtime);

    const modes: Record<string, ModeStats> = {};
    for (const mode of ["osu", "taiko", "fruits", "mania"] as const) {
      const user = await osu.getUser(ref.id, mode);
      const statistics = user.statistics;
      if (!statistics?.play_count) continue;
      modes[mode] = modeStats({
        id: mode,
        matchesPlayed: statistics.play_count,
        extra: {
          pp: statistics.pp ?? null,
          globalRank: statistics.global_rank ?? null,
          countryRank: statistics.country_rank ?? null,
          accuracy: statistics.hit_accuracy ?? null,
          rankedScore: statistics.ranked_score ?? null,
          maxCombo: statistics.maximum_combo ?? null,
        },
      });
    }

    const standard = await osu.getUser(ref.id, "osu");
    return playerStats({
      ref,
      matchesPlayed: standard.statistics?.play_count ?? null,
      timePlayedSeconds: standard.statistics?.play_time ?? null,
      modes,
      raw: standard,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const osu = providers.osu(this.runtime);

    const ranks: RankInfo[] = [];
    for (const mode of ["osu", "taiko", "fruits", "mania"] as const) {
      const user = await osu.getUser(ref.id, mode);
      const statistics = user.statistics;
      if (!statistics?.global_rank) continue;
      ranks.push({
        ref,
        queue: mode,
        tier: null,
        division: null,
        tierPoints: null,
        rating: statistics.pp ?? null,
        position: statistics.global_rank,
        percentilePermille: null,
        wins: null,
        losses: null,
        season: null,
        raw: statistics,
      });
    }
    return ranks;
  }

  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const scores = await providers.osu(this.runtime).getScores(ref.id, "recent", {
      limit: this.limit(options.limit),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
      ...(options.mode ? { mode: this.mode(options.mode) } : {}),
    });

    return scores.map((score) => {
      const beatmap = (score.beatmap as Record<string, unknown>) ?? {};
      const beatmapset = (score.beatmapset as Record<string, unknown>) ?? {};
      return {
        matchId: String(score.id ?? ""),
        titleId: this.title.id,
        mode: str(score.mode),
        map: [str(beatmapset.artist), str(beatmapset.title), str(beatmap.version)]
          .filter(Boolean)
          .join(" - "),
        startedAt: ts(score.created_at),
        durationSeconds: int(beatmap.total_length),
        // A completed play is the only "win" osu! has; a failed one is a loss.
        result: matchResult(score.passed === true),
        playerStats: participantStats({
          score: int(score.score),
          extra: {
            pp: num(score.pp),
            accuracy: num(score.accuracy),
            maxCombo: int(score.max_combo),
            rank: str(score.rank),
            stars: num(beatmap.difficulty_rating),
          },
        }),
        raw: score,
      };
    });
  }

  public override async getMatch(matchId: string): Promise<never> {
    this.require("getMatch");
    throw new ValidationError(
      `osu! scores are not addressable individually - read them from getMatchHistory (asked for ${matchId})`,
    );
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const rows = await providers.osu(this.runtime).getRankings(this.mode(options.queue), {
      ...(options.region ? { country: options.region } : {}),
      page: options.offset ? Math.floor(options.offset / 50) + 1 : 1,
    });

    return rows.slice(0, this.limit(options.limit, 50)).map((row, index) => {
      const user = (row.user as Record<string, unknown>) ?? {};
      return {
        position: int(row.global_rank) ?? index + 1,
        playerId: str(user.id),
        displayName: str(user.username),
        rating: num(row.pp),
        tier: null,
        wins: null,
        losses: null,
        country: str((user.country as Record<string, unknown> | undefined)?.code),
        raw: row,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Beat Saber
// ---------------------------------------------------------------------------

/**
 * Beat Saber.
 *
 * ScoreSaber first, BeatLeader as the alternative. The two ladders rank the
 * same players differently because they weight maps differently - that is a
 * real disagreement between two real ladders, not an error, so the provider is
 * recorded on the ref and never mixed within one answer.
 */
export class BeatSaberClient extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const id = String(query.steamId ?? query.accountId ?? "");

    if (id) {
      return this.ref({ providerId: "scoresaber", id, platform: "steam" });
    }
    const results = await providers
      .scoresaber(this.runtime)
      .searchPlayers(String(query.name ?? ""));
    const first = results[0];
    if (!first) {
      const { NotFoundError } = await import("../errors.js");
      throw new NotFoundError("scoresaber", `Beat Saber player "${query.name}"`, this.title.id);
    }
    return this.ref({
      providerId: "scoresaber",
      id: String(first.id ?? ""),
      displayName: str(first.name),
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.scoresaber(this.runtime).getPlayer(ref.id);

    return {
      ref,
      displayName: str(player.name) ?? ref.id,
      level: null,
      avatarUrl: str(player.profilePicture),
      profileUrl: `https://scoresaber.com/u/${ref.id}`,
      createdAt: ts(player.firstSeen),
      lastSeenAt: null,
      country: str(player.country),
      clan: null,
      isPrivate: player.inactive === true,
      raw: player,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.scoresaber(this.runtime).getPlayer(ref.id);
    const stats = (player.scoreStats as Record<string, unknown>) ?? {};

    return playerStats({
      ref,
      matchesPlayed: int(stats.totalPlayCount),
      modes: {
        ranked: modeStats({
          id: "ranked",
          matchesPlayed: int(stats.rankedPlayCount),
          extra: {
            pp: num(player.pp),
            averageRankedAccuracy: num(stats.averageRankedAccuracy),
            totalRankedScore: int(stats.totalRankedScore),
          },
        }),
      },
      raw: player,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.scoresaber(this.runtime).getPlayer(ref.id);
    return [
      {
        ref,
        queue: "global",
        tier: null,
        division: null,
        tierPoints: null,
        rating: num(player.pp),
        position: int(player.rank),
        percentilePermille: null,
        wins: null,
        losses: null,
        season: null,
        raw: player,
      },
      {
        ref,
        queue: "country",
        tier: str(player.country),
        division: null,
        tierPoints: null,
        rating: num(player.pp),
        position: int(player.countryRank),
        percentilePermille: null,
        wins: null,
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
    const players = await providers
      .scoresaber(this.runtime)
      .getLeaderboard(options.offset ? Math.floor(options.offset / 50) + 1 : 1, options.region);

    return players.slice(0, this.limit(options.limit, 50)).map((player, index) => ({
      position: int(player.rank) ?? index + 1,
      playerId: str(player.id),
      displayName: str(player.name),
      rating: num(player.pp),
      tier: null,
      wins: null,
      losses: null,
      country: str(player.country),
      raw: player,
    }));
  }
}

// ---------------------------------------------------------------------------
// Chess
// ---------------------------------------------------------------------------

/**
 * Chess, across Chess.com and Lichess.
 *
 * One title, two sites, and a caller usually means a specific one - so
 * `PlayerQuery.platform` picks: `web` (the default) is Chess.com, and passing
 * `extra: { site: "lichess" }` selects Lichess. The site is recorded on the ref
 * so later calls stay on the same site.
 */
export class ChessClient extends TitleClient {
  private site(query: PlayerQuery | PlayerRef): "chess-com" | "lichess" {
    if (isPlayerRef(query)) return query.providerId === "lichess" ? "lichess" : "chess-com";
    return String(query.extra?.site ?? "").toLowerCase() === "lichess" ? "lichess" : "chess-com";
  }

  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const username = String(query.name ?? "");
    const site = this.site(query);

    if (site === "lichess") {
      const user = await providers.lichess(this.runtime).getPlayer(username);
      return this.ref({
        providerId: "lichess",
        id: String(user.id ?? username).toLowerCase(),
        displayName: str(user.username) ?? username,
        platform: "web",
      });
    }
    const player = await providers.chessCom(this.runtime).getPlayer(username);
    return this.ref({
      providerId: "chess-com",
      id: username.toLowerCase(),
      displayName: str(player.username) ?? username,
      platform: "web",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);

    if (ref.providerId === "lichess") {
      const user = await providers.lichess(this.runtime).getPlayer(ref.id);
      const profile = (user.profile as Record<string, unknown>) ?? {};
      return {
        ref,
        displayName: str(user.username) ?? ref.id,
        level: null,
        avatarUrl: null,
        profileUrl: str(user.url) ?? `https://lichess.org/@/${ref.id}`,
        createdAt: ts(user.createdAt),
        lastSeenAt: ts(user.seenAt),
        country: str(profile.flag ?? profile.country),
        clan: null,
        isPrivate: user.disabled === true,
        raw: user,
      };
    }

    const player = await providers.chessCom(this.runtime).getPlayer(ref.id);
    return {
      ref,
      displayName: str(player.username) ?? ref.id,
      level: null,
      avatarUrl: str(player.avatar),
      profileUrl: str(player.url),
      createdAt: ts(player.joined),
      lastSeenAt: ts(player.last_online),
      country: str(player.country)?.split("/").pop() ?? null,
      clan: null,
      isPrivate: false,
      raw: player,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);

    if (ref.providerId === "lichess") {
      const user = await providers.lichess(this.runtime).getPlayer(ref.id);
      const perfs = (user.perfs as Record<string, Record<string, unknown>>) ?? {};
      const count = (user.count as Record<string, unknown>) ?? {};
      return playerStats({
        ref,
        matchesPlayed: int(count.all),
        wins: int(count.win),
        losses: int(count.loss),
        draws: int(count.draw),
        modes: Object.fromEntries(
          Object.entries(perfs).map(([id, perf]) => [
            id,
            modeStats({
              id,
              matchesPlayed: int(perf.games),
              extra: { rating: int(perf.rating), rd: int(perf.rd), prog: int(perf.prog) },
            }),
          ]),
        ),
        raw: user,
      });
    }

    const stats = await providers.chessCom(this.runtime).getStats(ref.id);
    const modes: Record<string, ModeStats> = {};
    let wins = 0;
    let losses = 0;
    let draws = 0;
    for (const [id, value] of Object.entries(stats)) {
      if (!id.startsWith("chess_")) continue;
      const entry = value as Record<string, Record<string, unknown>>;
      const record = entry.record ?? {};
      const win = int(record.win) ?? 0;
      const loss = int(record.loss) ?? 0;
      const draw = int(record.draw) ?? 0;
      wins += win;
      losses += loss;
      draws += draw;
      modes[id] = modeStats({
        id,
        wins: win,
        losses: loss,
        extra: {
          rating: int(entry.last?.rating),
          bestRating: int(entry.best?.rating),
          draws: draw,
        },
      });
    }

    return playerStats({
      ref,
      wins,
      losses,
      draws,
      modes,
      raw: stats,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);

    if (ref.providerId === "lichess") {
      const user = await providers.lichess(this.runtime).getPlayer(ref.id);
      const perfs = (user.perfs as Record<string, Record<string, unknown>>) ?? {};
      return Object.entries(perfs)
        .filter(([, perf]) => (int(perf.games) ?? 0) > 0)
        .map(([id, perf]) => ({
          ref,
          queue: id,
          tier: null,
          division: null,
          tierPoints: null,
          rating: int(perf.rating),
          position: null,
          percentilePermille: null,
          wins: null,
          losses: null,
          season: null,
          raw: perf,
        }));
    }

    const stats = await providers.chessCom(this.runtime).getStats(ref.id);
    return Object.entries(stats)
      .filter(([id]) => id.startsWith("chess_"))
      .map(([id, value]) => {
        const entry = value as Record<string, Record<string, unknown>>;
        return {
          ref,
          queue: id,
          tier: null,
          division: null,
          tierPoints: null,
          rating: int(entry.last?.rating),
          position: null,
          percentilePermille: null,
          wins: int(entry.record?.win),
          losses: int(entry.record?.loss),
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
    const limit = this.limit(options.limit);

    if (ref.providerId === "lichess") {
      const games = await providers.lichess(this.runtime).getGames(ref.id, { max: limit });
      return games.map((game) => {
        const players = (game.players as Record<string, Record<string, unknown>>) ?? {};
        const side = ["white", "black"].find(
          (colour) =>
            str((players[colour]?.user as Record<string, unknown> | undefined)?.id)?.toLowerCase() ===
            ref.id,
        );
        const winner = str(game.winner);
        return {
          matchId: String(game.id ?? ""),
          titleId: this.title.id,
          mode: str(game.perf ?? game.speed),
          map: null,
          startedAt: ts(game.createdAt),
          durationSeconds:
            int(game.lastMoveAt) !== null && int(game.createdAt) !== null
              ? Math.round(((int(game.lastMoveAt) as number) - (int(game.createdAt) as number)) / 1_000)
              : null,
          result: winner ? matchResult(winner === side) : "draw",
          playerStats: participantStats({
            extra: {
              colour: side ?? null,
              opening: str((game.opening as Record<string, unknown> | undefined)?.name),
              moves: int(game.turns),
            },
          }),
          raw: game,
        };
      });
    }

    const games = await providers.chessCom(this.runtime).getRecentGames(ref.id, limit);
    return games.map((game) => {
      const white = (game.white as Record<string, unknown>) ?? {};
      const black = (game.black as Record<string, unknown>) ?? {};
      const isWhite = str(white.username)?.toLowerCase() === ref.id;
      const mine = isWhite ? white : black;
      const outcome = str(mine.result);
      return {
        matchId: String(game.uuid ?? game.url ?? ""),
        titleId: this.title.id,
        mode: str(game.time_class),
        map: null,
        startedAt: ts(game.end_time),
        durationSeconds: null,
        result:
          outcome === "win"
            ? "win"
            : outcome === "agreed" || outcome === "repetition" || outcome === "stalemate" || outcome === "insufficient"
              ? "draw"
              : "loss",
        playerStats: participantStats({
          extra: {
            colour: isWhite ? "white" : "black",
            rating: int(mine.rating),
            eco: str(game.eco),
          },
        }),
        raw: game,
      };
    });
  }

  public override async getMatch(matchId: string): Promise<never> {
    this.require("getMatch");
    throw new ValidationError(
      `chess games are read from getMatchHistory rather than fetched individually (asked for ${matchId})`,
    );
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const queue = options.queue ?? "blitz";

    if (String(options.region ?? "").toLowerCase() === "lichess") {
      const users = await providers
        .lichess(this.runtime)
        .getTopPlayers(queue, this.limit(options.limit, 50));
      return users.map((user, index) => ({
        position: index + 1,
        playerId: str(user.id),
        displayName: str(user.username),
        rating: int((user.perfs as Record<string, Record<string, unknown>> | undefined)?.[queue]?.rating),
        tier: str(user.title),
        wins: null,
        losses: null,
        country: null,
        raw: user,
      }));
    }

    const boards = await providers.chessCom(this.runtime).getLeaderboards();
    const rows = asArray<Record<string, unknown>>(boards[`live_${queue}`] ?? boards[queue]);
    return rows.slice(0, this.limit(options.limit, 50)).map((row, index) => ({
      position: int(row.rank) ?? index + 1,
      playerId: str(row.username),
      displayName: str(row.username),
      rating: int(row.score),
      tier: str(row.title),
      wins: int((row.stats as Record<string, unknown> | undefined)?.win_count),
      losses: int((row.stats as Record<string, unknown> | undefined)?.loss_count),
      country: str(row.country)?.split("/").pop() ?? null,
      raw: row,
    }));
  }
}

// ---------------------------------------------------------------------------
// Minecraft (Hypixel)
// ---------------------------------------------------------------------------

/**
 * Minecraft, through Hypixel.
 *
 * Competitive Minecraft means Hypixel: BedWars, SkyWars, Duels and the events
 * built on them. Hypixel is keyed on UUID, so a name lookup costs one Mojang
 * call first - which is cached for a day, because a UUID never changes.
 */
export class MinecraftClient extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const raw = String(query.accountId ?? query.name ?? "");
    // A 32-character hex string is already a UUID; anything else is a name.
    const isUuid = /^[0-9a-fA-F-]{32,36}$/.test(raw);
    const resolved = isUuid
      ? { id: raw, name: str(query.name) ?? raw }
      : await providers.mojang(this.runtime).getUuid(raw);

    return this.ref({
      providerId: "hypixel",
      id: resolved.id,
      displayName: resolved.name,
      platform: "web",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.hypixel(this.runtime).getPlayer(ref.id);
    const guild = await providers.hypixel(this.runtime).getGuild(ref.id).catch(() => null);

    return {
      ref,
      displayName: str(player.displayname) ?? ref.displayName ?? ref.id,
      level: int(player.networkExp) !== null ? networkLevel(int(player.networkExp) as number) : null,
      avatarUrl: `https://crafatar.com/avatars/${ref.id}`,
      profileUrl: `https://plancke.io/hypixel/player/stats/${ref.id}`,
      createdAt: ts(player.firstLogin),
      lastSeenAt: ts(player.lastLogin),
      country: null,
      clan: str(guild?.name),
      isPrivate: false,
      raw: player,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.hypixel(this.runtime).getPlayer(ref.id);
    const stats = (player.stats as Record<string, Record<string, unknown>>) ?? {};

    const modes: Record<string, ModeStats> = {};

    const bedwars = stats.Bedwars;
    if (bedwars) {
      modes.bedwars = modeStats({
        id: "bedwars",
        label: "BedWars",
        wins: int(bedwars.wins_bedwars),
        losses: int(bedwars.losses_bedwars),
        kills: int(bedwars.kills_bedwars),
        deaths: int(bedwars.deaths_bedwars),
        extra: {
          finalKills: int(bedwars.final_kills_bedwars),
          finalDeaths: int(bedwars.final_deaths_bedwars),
          bedsBroken: int(bedwars.beds_broken_bedwars),
          stars: int(bedwars.Experience) !== null ? Math.floor((int(bedwars.Experience) as number) / 5000) : null,
        },
      });
    }

    const skywars = stats.SkyWars;
    if (skywars) {
      modes.skywars = modeStats({
        id: "skywars",
        label: "SkyWars",
        wins: int(skywars.wins),
        losses: int(skywars.losses),
        kills: int(skywars.kills),
        deaths: int(skywars.deaths),
        extra: { level: str(skywars.levelFormatted) },
      });
    }

    const duels = stats.Duels;
    if (duels) {
      modes.duels = modeStats({
        id: "duels",
        label: "Duels",
        wins: int(duels.wins),
        losses: int(duels.losses),
        kills: int(duels.kills),
        deaths: int(duels.deaths),
        extra: { bestWinstreak: int(duels.best_overall_winstreak) },
      });
    }

    return playerStats({
      ref,
      wins: sumModes(modes, "wins"),
      losses: sumModes(modes, "losses"),
      kills: sumModes(modes, "kills"),
      deaths: sumModes(modes, "deaths"),
      modes,
      raw: player,
    });
  }

  /** Hypixel's network level, which is the closest thing it has to a rank. */
  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers.hypixel(this.runtime).getPlayer(ref.id);
    const exp = int(player.networkExp);
    if (exp === null) return [];
    return [
      {
        ref,
        queue: "network",
        tier: str(player.newPackageRank ?? player.rank),
        division: null,
        tierPoints: networkLevel(exp),
        rating: exp,
        position: null,
        percentilePermille: null,
        wins: null,
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
    const boards = await providers.hypixel(this.runtime).getLeaderboards();
    const game = (options.queue ?? "BEDWARS").toUpperCase();
    const board = asArray<Record<string, unknown>>(boards[game])[0];
    const leaders = asArray<string>(board?.leaders);

    return leaders.slice(0, this.limit(options.limit, 100)).map((uuid, index) => ({
      position: index + 1,
      playerId: uuid,
      displayName: null,
      rating: null,
      tier: null,
      wins: null,
      losses: null,
      country: null,
      raw: { uuid, board: board?.title },
    }));
  }
}

/**
 * Hypixel's network level from raw experience.
 *
 * The formula is Hypixel's own and is documented on their API site; it is
 * reproduced rather than approximated so the number matches what a player sees
 * in game.
 */
function networkLevel(exp: number): number {
  return Math.floor((Math.sqrt(exp * 2 + 30625) / 50 - 2.5) * 100) / 100;
}

/** Fold one field across the mode breakdown, or `null` when none reported it. */
function sumModes(
  modes: Record<string, ModeStats>,
  field: "wins" | "losses" | "kills" | "deaths",
): number | null {
  let total = 0;
  let seen = false;
  for (const mode of Object.values(modes)) {
    const value = mode[field];
    if (typeof value === "number") {
      total += value;
      seen = true;
    }
  }
  return seen ? total : null;
}
