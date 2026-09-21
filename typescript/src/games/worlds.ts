/**
 * The persistent-world and vehicle titles.
 *
 * Guild Wars 2, Path of Exile, Albion Online, World of Tanks and World of
 * Warships. The competitive content here is not matchmaking - it is a PvP
 * season, a race ladder, a guild war or a clan campaign - so each client says
 * plainly which of those it is reporting.
 */

import { TitleClient, isPlayerRef } from "../title-client.js";
import * as providers from "../providers/index.js";
import type { WargamingGame } from "../providers/wargaming.js";
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
// Guild Wars 2
// ---------------------------------------------------------------------------

/**
 * Guild Wars 2.
 *
 * Structured PvP. The API is account-scoped through the caller's own key, so
 * there is no "look up another player" - `resolvePlayer` describes the account
 * the configured key belongs to, and a caller asking about somebody else gets
 * a clear error rather than that person's data.
 */
export class GuildWars2Client extends TitleClient {
  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    const account = await providers.guildWars2(this.runtime).getAccount();
    const name = str(account.name) ?? "";
    const asked = str(query.name ?? query.accountId);
    if (asked && asked.toLowerCase() !== name.toLowerCase()) {
      throw new ValidationError(
        `Guild Wars 2 only exposes the account its API key belongs to (${name}), not "${asked}"`,
      );
    }
    return this.ref({
      providerId: "guild-wars-2",
      id: String(account.id ?? name),
      displayName: name,
      platform: "web",
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const account = await providers.guildWars2(this.runtime).getAccount();
    return {
      ref,
      displayName: str(account.name) ?? ref.id,
      level: null,
      avatarUrl: null,
      profileUrl: null,
      createdAt: ts(account.created),
      lastSeenAt: ts(account.last_modified),
      country: null,
      clan: null,
      isPrivate: false,
      raw: account,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const stats = await providers.guildWars2(this.runtime).getPvpStats();
    const aggregate = (stats.aggregate as Record<string, unknown>) ?? {};
    const professions = (stats.professions as Record<string, Record<string, unknown>>) ?? {};

    const modes: Record<string, ModeStats> = {};
    for (const [profession, row] of Object.entries(professions)) {
      modes[profession] = modeStats({
        id: profession,
        wins: int(row.wins),
        losses: int(row.losses),
        extra: { byebyes: int(row.byes), forfeits: int(row.forfeits), desertions: int(row.desertions) },
      });
    }

    return playerStats({
      ref,
      wins: int(aggregate.wins),
      losses: int(aggregate.losses),
      modes,
      raw: stats,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const standings = await providers.guildWars2(this.runtime).getPvpStandings();

    return standings.map((standing) => {
      const current = (standing.current as Record<string, unknown>) ?? {};
      return {
        ref,
        queue: str(standing.season_id) ?? "pvp",
        tier: str(current.tier),
        division: str(current.division),
        tierPoints: int(current.points),
        rating: int(current.rating),
        position: null,
        percentilePermille: null,
        wins: null,
        losses: null,
        season: str(standing.season_id),
        raw: standing,
      };
    });
  }

  /** The last ten PvP games, which is all the API keeps. */
  public override async getMatchHistory(
    query: PlayerQuery | PlayerRef,
    options: MatchHistoryOptions = {},
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    // The games endpoint takes no id - it is scoped to the key's own account -
    // so resolving is purely the check that the caller asked about that account.
    if (!isPlayerRef(query)) await this.resolvePlayer(query);
    const games = await providers.guildWars2(this.runtime).getPvpGames();

    return games.slice(0, this.limit(options.limit, 10)).map((game) => {
      const scores = (game.scores as Record<string, unknown>) ?? {};
      return {
        matchId: String(game.id ?? ""),
        titleId: this.title.id,
        mode: str(game.rating_type ?? "pvp"),
        map: str(game.map_id),
        startedAt: ts(game.started),
        durationSeconds:
          ts(game.ended) !== null && ts(game.started) !== null
            ? Math.round(((ts(game.ended) as number) - (ts(game.started) as number)) / 1_000)
            : null,
        result: matchResult(str(game.result) === "Victory"),
        playerStats: participantStats({
          extra: {
            profession: str(game.profession),
            team: str(game.team),
            redScore: int(scores.red),
            blueScore: int(scores.blue),
            ratingChange: int(game.rating_change),
          },
        }),
        raw: game,
      };
    });
  }

  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const season = options.season;
    if (!season) {
      throw new ValidationError(
        "Guild Wars 2 leaderboards are per season - pass options.season with a season id",
      );
    }
    const rows = await providers
      .guildWars2(this.runtime)
      .getPvpLeaderboard(season, options.queue ?? "legendary", options.region ?? "global");

    return rows.slice(0, this.limit(options.limit, 100)).map((row, index) => ({
      position: int(row.rank) ?? index + 1,
      playerId: str(row.id),
      displayName: str(row.name),
      rating: int(asArray<Record<string, unknown>>(row.scores)[0]?.value),
      tier: null,
      wins: null,
      losses: null,
      country: null,
      raw: row,
    }));
  }
}

// ---------------------------------------------------------------------------
// Path of Exile
// ---------------------------------------------------------------------------

/**
 * Path of Exile.
 *
 * Race ladders only. GGG publishes no per-character endpoint without a session
 * cookie, so this title declares `getLeaderboard` and the esports capabilities
 * and nothing else - which is the whole of what the public API offers.
 */
export class PathOfExileClient extends TitleClient {
  public override async getLeaderboard(
    options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    const poe = providers.pathOfExile(this.runtime);
    const league = options.season ?? options.queue;

    if (!league) {
      // Without a league the ladder is meaningless, so the current ones are
      // named in the error rather than one being picked arbitrarily.
      const leagues = await poe.getLeagues();
      const names = leagues.map((entry) => str(entry.id)).filter(Boolean).slice(0, 8);
      throw new ValidationError(
        `Path of Exile ladders are per league - pass options.season. Current leagues: ${names.join(", ")}`,
      );
    }

    const entries = await poe.getLadder(league, {
      limit: this.limit(options.limit, 50),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
    });

    return entries.map((entry, index) => {
      const character = (entry.character as Record<string, unknown>) ?? {};
      const account = (entry.account as Record<string, unknown>) ?? {};
      return {
        position: int(entry.rank) ?? index + 1,
        playerId: str(account.name),
        displayName: str(character.name),
        rating: int(character.level),
        tier: str(character.class),
        wins: null,
        losses: null,
        country: null,
        raw: entry,
      };
    });
  }

  public override async getMetadata(kind = "leagues"): Promise<unknown> {
    this.require("getMetadata");
    if (kind !== "leagues") {
      throw new ValidationError(`Path of Exile metadata "${kind}" is not available - try "leagues"`);
    }
    return providers.pathOfExile(this.runtime).getLeagues();
  }
}

// ---------------------------------------------------------------------------
// Albion Online
// ---------------------------------------------------------------------------

/**
 * Albion Online.
 *
 * The competitive game is guild-versus-guild, so "match history" here means
 * kills and deaths - the only per-event record Albion exposes for an individual.
 */
export class AlbionClient extends TitleClient {
  private serverRegion(value: string | null | undefined): string {
    return value ?? "europe";
  }

  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const region = this.serverRegion(query.region);
    const term = String(query.name ?? query.accountId ?? "");
    const results = await providers.albion(this.runtime).search(term, region);
    const exact =
      results.players?.find((player) => str(player.Name)?.toLowerCase() === term.toLowerCase()) ??
      results.players?.[0];
    if (!exact) throw new NotFoundError("albion", `Albion player "${term}"`, this.title.id);

    return this.ref({
      providerId: "albion",
      id: String(exact.Id ?? ""),
      displayName: str(exact.Name),
      region,
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers
      .albion(this.runtime)
      .getPlayer(ref.id, this.serverRegion(ref.region));

    return {
      ref,
      displayName: str(player.Name) ?? ref.id,
      level: null,
      avatarUrl: null,
      profileUrl: null,
      createdAt: null,
      lastSeenAt: null,
      country: null,
      clan: str(player.GuildName),
      isPrivate: false,
      raw: player,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers
      .albion(this.runtime)
      .getPlayer(ref.id, this.serverRegion(ref.region));
    const lifetime = (player.LifetimeStatistics as Record<string, unknown>) ?? {};

    return playerStats({
      ref,
      kills: int(player.KillFame),
      deaths: int(player.DeathFame),
      modes: {
        pve: modeStats({
          id: "pve",
          label: "PvE",
          extra: { fame: int((lifetime.PvE as Record<string, unknown> | undefined)?.Total) },
        }),
        gathering: modeStats({
          id: "gathering",
          label: "Gathering",
          extra: {
            fame: int(
              (
                (lifetime.Gathering as Record<string, unknown> | undefined)?.All as
                  | Record<string, unknown>
                  | undefined
              )?.Total,
            ),
          },
        }),
        crafting: modeStats({
          id: "crafting",
          label: "Crafting",
          extra: { fame: int((lifetime.Crafting as Record<string, unknown> | undefined)?.Total) },
        }),
      },
      raw: player,
    });
  }

  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const player = await providers
      .albion(this.runtime)
      .getPlayer(ref.id, this.serverRegion(ref.region));
    return [
      {
        ref,
        queue: "fame",
        tier: null,
        division: null,
        tierPoints: null,
        rating: int(player.KillFame),
        position: null,
        percentilePermille: null,
        wins: null,
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
    const kills = await providers
      .albion(this.runtime)
      .getPlayerKills(ref.id, this.serverRegion(ref.region));

    return kills.slice(0, this.limit(options.limit)).map((event) => {
      const killer = (event.Killer as Record<string, unknown>) ?? {};
      return {
        matchId: String(event.EventId ?? ""),
        titleId: this.title.id,
        mode: "pvp",
        map: null,
        startedAt: ts(event.TimeStamp),
        durationSeconds: null,
        result: matchResult(String(killer.Id) === ref.id),
        playerStats: participantStats({
          extra: {
            fame: int(event.TotalVictimKillFame),
            participants: asArray(event.Participants).length,
          },
        }),
        raw: event,
      };
    });
  }

  public override async getLeaderboard(
    _options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    throw new NotFoundError(
      "albion",
      "Albion ladder (the game info API publishes guild rankings, not a player ladder)",
      this.title.id,
    );
  }
}

// ---------------------------------------------------------------------------
// Wargaming: World of Tanks and World of Warships
// ---------------------------------------------------------------------------

/** Shared behaviour for the two Wargaming titles. */
abstract class WargamingTitleClient extends TitleClient {
  protected abstract game(): WargamingGame;

  private wgRegion(value: string | null | undefined): string {
    return value ?? "eu";
  }

  public override async resolvePlayer(query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    this.requireIdentifier(query);
    const region = this.wgRegion(query.region);
    const wargaming = providers.wargaming(this.runtime);

    if (query.accountId) {
      const account = await wargaming.getAccountInfo(this.game(), region, String(query.accountId));
      return this.ref({
        providerId: "wargaming",
        id: String(account.account_id),
        displayName: account.nickname,
        region,
      });
    }
    const found = await wargaming.findAccount(this.game(), region, String(query.name));
    return this.ref({
      providerId: "wargaming",
      id: String(found.account_id),
      displayName: found.nickname,
      region,
    });
  }

  public override async getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const account = await providers
      .wargaming(this.runtime)
      .getAccountInfo(this.game(), this.wgRegion(ref.region), ref.id);

    return {
      ref,
      displayName: account.nickname,
      level: null,
      avatarUrl: null,
      profileUrl: null,
      createdAt: ts(account.created_at),
      lastSeenAt: ts(account.last_battle_time),
      country: null,
      clan: account.clan_id ? String(account.clan_id) : null,
      isPrivate: false,
      raw: account,
    };
  }

  public override async getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const account = await providers
      .wargaming(this.runtime)
      .getAccountInfo(this.game(), this.wgRegion(ref.region), ref.id);
    const all = account.statistics?.all;

    const modes: Record<string, ModeStats> = {};
    for (const [mode, stats] of Object.entries(account.statistics ?? {})) {
      if (!stats || typeof stats !== "object") continue;
      modes[mode] = modeStats({
        id: mode,
        matchesPlayed: stats.battles,
        wins: stats.wins,
        losses: stats.losses,
        kills: stats.frags,
        extra: {
          damageDealt: stats.damage_dealt,
          survived: stats.survived_battles,
          experience: stats.xp,
          spotted: stats.spotted,
        },
      });
    }

    return playerStats({
      ref,
      matchesPlayed: all?.battles ?? null,
      wins: all?.wins ?? null,
      losses: all?.losses ?? null,
      draws: all?.draws ?? null,
      kills: all?.frags ?? null,
      modes,
      raw: account,
    });
  }

  /** Wargaming's global rating - the closest thing either game has to a rank. */
  public override async getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    const ref = isPlayerRef(query) ? query : await this.resolvePlayer(query);
    const account = await providers
      .wargaming(this.runtime)
      .getAccountInfo(this.game(), this.wgRegion(ref.region), ref.id);
    const all = account.statistics?.all;

    return [
      {
        ref,
        queue: "global",
        tier: null,
        division: null,
        tierPoints: null,
        rating: account.global_rating ?? null,
        position: null,
        percentilePermille: null,
        wins: all?.wins ?? null,
        losses: all?.losses ?? null,
        season: null,
        raw: account,
      },
    ];
  }

  public override async getLeaderboard(
    _options: LeaderboardOptions = {},
  ): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    throw new NotFoundError(
      "wargaming",
      "player ladder (Wargaming publishes clan ratings rather than a player leaderboard)",
      this.title.id,
    );
  }

  public override async getMetadata(): Promise<unknown> {
    this.require("getMetadata");
    return providers
      .wargaming(this.runtime)
      .getVehicleEncyclopedia(this.game(), "eu");
  }
}

/** World of Tanks. */
export class WorldOfTanksClient extends WargamingTitleClient {
  protected game(): WargamingGame {
    return "worldoftanks";
  }
}

/** World of Warships. */
export class WorldOfWarshipsClient extends WargamingTitleClient {
  protected game(): WargamingGame {
    return "worldofwarships";
  }
}
