/**
 * Rocket League.
 *
 * The most assembled title in the package, because Psyonix publishes nothing at
 * all. Three sources, each answering a different question:
 *
 * - **Tracker** knows the ladder, which is the only place an MMR exists.
 * - **Ballchasing** knows uploaded replays - complete for players who upload,
 *   empty for everyone else. That distinction is surfaced rather than hidden:
 *   an empty history here means "nothing was uploaded", not "no games played",
 *   and a caller showing it to a user should say so.
 * - **Octane.gg** knows the professional circuit, through the esports layer.
 */

import { TitleClient, isPlayerRef } from "../title-client.js";
import * as providers from "../providers/index.js";
import { toSteamId64 } from "../identity.js";
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

/** Playlist ids, as Rocket League numbers them. */
const PLAYLISTS: Readonly<Record<string, string>> = {
  "10": "Ranked Duel 1v1",
  "11": "Ranked Doubles 2v2",
  "13": "Ranked Standard 3v3",
  "27": "Hoops",
  "28": "Rumble",
  "29": "Dropshot",
  "30": "Snow Day",
};

export class RocketLeagueClient extends TitleClient {
  /** Ballchasing's `platform:id` form. */
  private ballchasingId(ref: PlayerRef): string | null {
    if (ref.platform === "steam") return `steam:${ref.id}`;
    if (ref.platform === "epic") return `epic:${ref.id}`;
    if (ref.platform === "xbox") return `xbox:${ref.id}`;
    if (ref.platform === "playstation") return `ps4:${ref.id}`;
    return null;
  }

  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);

    if (query.steamId) {
      const steamId = toSteamId64(query.steamId);
      return this.ref({
        providerId: "tracker",
        id: steamId,
        displayName: str(query.name),
        platform: "steam",
      });
    }
    const name = String(query.name ?? query.epicId ?? "");
    if (!name) throw new ValidationError("Rocket League needs a name, Steam id or Epic id");
    return this.ref({
      providerId: "tracker",
      id: name,
      displayName: name,
      platform: (query.platform ?? "epic") as Platform,
    });
  }

  private trackerPlatform(ref: PlayerRef): string {
    switch (ref.platform) {
      case "steam":
        return "steam";
      case "xbox":
        return "xbl";
      case "playstation":
        return "psn";
      default:
        return "epic";
    }
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const profile = await providers
      .tracker(this.runtime)
      .getProfile(this.title.id, this.trackerPlatform(ref), ref.id);

    return {
      ref,
      displayName: profile.platformInfo?.platformUserHandle ?? ref.id,
      level: null,
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
    const profile = await tracker.getProfile(this.title.id, this.trackerPlatform(ref), ref.id);
    const overview = tracker.segment(profile, "overview");
    const stats = tracker.flattenStats(overview);

    const modes: Record<string, ModeStats> = {};
    for (const segment of profile.segments ?? []) {
      if (segment.type !== "playlist") continue;
      const key = String(segment.attributes?.playlistId ?? segment.metadata?.name ?? "unknown");
      const flat = tracker.flattenStats(segment);
      modes[key] = modeStats({
        id: key,
        label: PLAYLISTS[key] ?? String(segment.metadata?.name ?? key),
        wins: flat.matchesWon ?? null,
        losses: flat.matchesLost ?? null,
        matchesPlayed: flat.matchesPlayed ?? null,
        extra: { mmr: flat.rating ?? null, tier: flat.tier ?? null, division: flat.division ?? null },
      });
    }

    return playerStats({
      ref,
      wins: stats.wins ?? null,
      matchesPlayed: stats.matchesPlayed ?? null,
      timePlayedSeconds: stats.timePlayed ?? null,
      modes,
      raw: profile,
    });
  }

  /** One rank per playlist - Rocket League ranks each separately. */
  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const tracker = providers.tracker(this.runtime);
    const profile = await tracker.getProfile(this.title.id, this.trackerPlatform(ref), ref.id);

    return (profile.segments ?? [])
      .filter((segment) => segment.type === "playlist")
      .map((segment) => {
        const rating = segment.stats?.rating;
        const tier = segment.stats?.tier;
        const division = segment.stats?.division;
        const playlistId = String(segment.attributes?.playlistId ?? "");
        return {
          ref,
          queue: PLAYLISTS[playlistId] ?? String(segment.metadata?.name ?? playlistId),
          tier: str(tier?.metadata?.name),
          division: str(division?.metadata?.name),
          tierPoints: null,
          rating: num(rating?.value),
          position: rating?.rank ?? null,
          percentilePermille:
            rating?.percentile !== null && rating?.percentile !== undefined
              ? Math.round(rating.percentile * 10)
              : null,
          wins: num(segment.stats?.matchesWon?.value),
          losses: num(segment.stats?.matchesLost?.value),
          season: null,
          raw: segment,
        };
      });
  }

  /**
   * Uploaded replays.
   *
   * Ballchasing sees only what somebody chose to upload, so this is a partial
   * record by construction - and the honest one, because no complete record
   * exists anywhere.
   */
  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const playerId = this.ballchasingId(ref);

    const replays = await providers.ballchasing(this.runtime).listReplays({
      ...(playerId ? { playerId } : { playerName: ref.displayName ?? ref.id }),
      count: this.limit(options.limit),
      ...(options.mode ? { playlist: options.mode } : {}),
    });

    return replays.map((replay) => {
      const blue = replay.blue as Record<string, unknown> | undefined;
      const orange = replay.orange as Record<string, unknown> | undefined;
      const blueGoals = int(blue?.goals) ?? 0;
      const orangeGoals = int(orange?.goals) ?? 0;
      return {
        matchId: String(replay.id ?? ""),
        titleId: this.title.id,
        mode: str(replay.playlist_name ?? replay.playlist_id),
        map: str(replay.map_name ?? replay.map_code),
        startedAt: ts(replay.date),
        durationSeconds: int(replay.duration),
        // Which side the queried player was on is not on the list row, so the
        // summary reports the scoreline and leaves the verdict to getMatch.
        result: "unknown",
        playerStats: participantStats({
          extra: { blueGoals, orangeGoals },
        }),
        raw: replay,
      };
    });
  }

  public override async getMatch(matchId: string, context?: PlayerRef): Promise<MatchDetail> {
    this.require("getMatch");
    const replay = await providers.ballchasing(this.runtime).getReplay(matchId);
    const sides = ["blue", "orange"] as const;

    const participants = sides.flatMap((side) => {
      const team = replay[side] as Record<string, unknown> | undefined;
      return asArray<Record<string, unknown>>(team?.players).map((player) => {
        const stats = (player.stats as Record<string, unknown>) ?? {};
        const core = (stats.core as Record<string, unknown>) ?? {};
        return {
          playerId: String(
            (player.id as Record<string, unknown> | undefined)?.id ?? player.name ?? "",
          ),
          displayName: str(player.name),
          teamId: side,
          character: str(player.car_name),
          stats: participantStats({
            score: int(core.score),
            extra: {
              goals: int(core.goals),
              assists: int(core.assists),
              saves: int(core.saves),
              shots: int(core.shots),
              mvp: player.mvp === true ? 1 : 0,
              shootingPercentage: num(core.shooting_percentage),
            },
          }),
          raw: player,
        };
      });
    });

    const blueGoals = int((replay.blue as Record<string, unknown> | undefined)?.goals);
    const orangeGoals = int((replay.orange as Record<string, unknown> | undefined)?.goals);
    const mine = context
      ? participants.find(
          (participant) =>
            participant.displayName?.toLowerCase() ===
            (context.displayName ?? context.id).toLowerCase(),
        )
      : undefined;

    return {
      matchId,
      titleId: this.title.id,
      mode: str(replay.playlist_name ?? replay.playlist_id),
      map: str(replay.map_name ?? replay.map_code),
      startedAt: ts(replay.date),
      durationSeconds: int(replay.duration),
      result:
        mine && blueGoals !== null && orangeGoals !== null
          ? matchResult(
              mine.teamId === "blue" ? blueGoals > orangeGoals : orangeGoals > blueGoals,
              blueGoals === orangeGoals,
            )
          : "unknown",
      playerStats: mine?.stats ?? null,
      teams: sides.map((side) => {
        const goals = side === "blue" ? blueGoals : orangeGoals;
        const other = side === "blue" ? orangeGoals : blueGoals;
        return {
          id: side,
          name: side === "blue" ? "Blue" : "Orange",
          won: goals !== null && other !== null ? goals > other : null,
          score: goals,
          roundsWon: null,
        };
      }),
      participants,
      rounds: [],
      patch: null,
      raw: replay,
    };
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const rows = await providers
      .tracker(this.runtime)
      .getLeaderboard(this.title.id, options.queue ?? "Rating", {
        take: this.limit(options.limit, 50),
        ...(options.offset !== undefined ? { skip: options.offset } : {}),
      });
    return rows.map((row, index) => ({
      position: int(row.rank) ?? index + 1,
      playerId: str((row.owner as Record<string, unknown> | undefined)?.id),
      displayName: str(
        ((row.owner as Record<string, unknown> | undefined)?.metadata as
          | Record<string, unknown>
          | undefined)?.platformUserHandle,
      ),
      rating: num(row.value),
      tier: null,
      wins: null,
      losses: null,
      country: null,
      raw: row,
    }));
  }
}
