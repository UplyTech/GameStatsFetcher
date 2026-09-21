/**
 * The cross-title esports layer.
 *
 * Every title in the registry gets the same six esports methods, whatever data
 * exists behind them. Which provider actually answers is decided here, from
 * three things in order:
 *
 * 1. an explicit `provider` in the call options,
 * 2. the title's own `providers` list, best first,
 * 3. whether the credential for that provider was configured.
 *
 * That last point matters more than it looks. A caller with a PandaScore token
 * and no start.gg token gets PandaScore for Street Fighter 6; a caller with
 * only start.gg gets start.gg. Neither has to know which one this package
 * prefers, and neither gets a confusing "missing credential" for a provider
 * they never intended to use.
 */

import type {
  EsportsMatch,
  EsportsMatchStatus,
  EsportsOpponent,
  EsportsPlayer,
  EsportsQueryOptions,
  EsportsStanding,
  EsportsStream,
  EsportsTeam,
  EsportsTournament,
  PrizeEarnings,
  PrizeEarningsByTitle,
  TitleDescriptor,
} from "./types.js";
import type { Runtime } from "./runtime.js";
import * as providers from "./providers/index.js";
import { esportsProvidersFor } from "./providers.js";
import type { PandaScoreMatch } from "./providers/esports-data.js";
import { AllProvidersFailedError, GameStatsError, UnsupportedCapabilityError } from "./errors.js";
import { asArray, int, num, str, ts } from "./normalize.js";
import { findTitle } from "./titles.js";

/**
 * The providers that could serve one capability for one title, best first.
 *
 * The table lives in `providers.ts` because the title registry consumes it too:
 * a title's declared esports capabilities are intersected with it at load, so
 * the registry cannot promise something no provider for that title can do.
 */
export function providersFor(title: TitleDescriptor, capability: string): readonly string[] {
  return esportsProvidersFor(title.providers, capability) ?? [];
}

export class EsportsLayer {
  private readonly runtime: Runtime;
  private readonly title: TitleDescriptor;

  constructor(runtime: Runtime, title: TitleDescriptor) {
    this.runtime = runtime;
    this.title = title;
  }

  // -------------------------------------------------------------------------
  // Provider selection
  // -------------------------------------------------------------------------

  /**
   * The providers worth trying for this title, in order.
   *
   * A provider that needs a key nobody configured is dropped rather than tried
   * and failed: it would cost a round trip to learn what the registry already
   * knows.
   */
  private candidates(capability: string, explicit?: string): string[] {
    if (explicit) return [explicit];
    return providersFor(this.title, capability).filter((id) => this.hasCredentials(id));
  }

  private hasCredentials(providerId: string): boolean {
    const provider = this.build(providerId);
    return provider?.hasCredentials() ?? false;
  }

  /** Construct one provider, or `undefined` when this package has no client. */
  private build(providerId: string): providers.ProviderClient | undefined {
    switch (providerId) {
      case "pandascore":
        return providers.pandascore(this.runtime);
      case "abios":
        return providers.abios(this.runtime);
      case "startgg":
        return providers.startgg(this.runtime);
      case "octane":
        return providers.octane(this.runtime);
      case "opendota":
        return providers.opendota(this.runtime);
      case "faceit":
        return providers.faceit(this.runtime);
      case "toornament":
        return providers.toornament(this.runtime);
      case "challonge":
        return providers.challonge(this.runtime);
      case "liquipedia":
        return providers.liquipedia(this.runtime);
      case "esports-earnings":
        return providers.esportsEarnings(this.runtime);
      default:
        return undefined;
    }
  }

  /**
   * Run `attempt` against each candidate until one succeeds.
   *
   * Every failure is kept, because the first is rarely the interesting one:
   * "no key" then "429" then "500" is three separate things to fix, and an
   * error that reported only the last would hide two of them.
   */
  private async race<T>(
    capability: string,
    explicit: string | undefined,
    attempt: (providerId: string) => Promise<T>,
  ): Promise<T> {
    const candidates = this.candidates(capability, explicit);
    if (candidates.length === 0) {
      const able = providersFor(this.title, capability);
      throw new UnsupportedCapabilityError(
        this.title.id,
        able.length === 0
          ? `${capability} (no provider for this title serves it - it is covered by ${this.title.providers.join(", ")})`
          : `${capability} (${able.join(" or ")} could serve it, but no credential is configured)`,
        this.title.capabilities,
      );
    }

    const failures: { provider: string; error: GameStatsError }[] = [];
    for (const providerId of candidates) {
      try {
        return await attempt(providerId);
      } catch (error) {
        const wrapped =
          error instanceof GameStatsError
            ? error
            : new GameStatsError(String(error), { code: "UNKNOWN", provider: providerId });
        failures.push({ provider: providerId, error: wrapped });
        // Without fallback the first provider's failure is the answer: silently
        // switching sources changes whose terms of service apply.
        if (!this.runtime.fallback) throw wrapped;
      }
    }
    throw new AllProvidersFailedError(this.title.id, capability, failures);
  }

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /** Professional fixtures for this title. */
  public async getMatches(options: EsportsQueryOptions = {}): Promise<EsportsMatch[]> {
    return this.race("getEsportsMatches", options.provider, async (providerId) => {
      switch (providerId) {
        case "pandascore": {
          const raw = await providers.pandascore(this.runtime).getMatches(this.title.id, {
            ...(bucketFor(options.status) ? { bucket: bucketFor(options.status) } : {}),
            page: options.page ?? 1,
            perPage: options.limit ?? 50,
            ...(options.since !== undefined ? { since: options.since } : {}),
            ...(options.until !== undefined ? { until: options.until } : {}),
          });
          return raw.map((match) => this.fromPandaScore(match));
        }
        case "octane": {
          const raw = await providers.octane(this.runtime).getMatches({
            page: options.page ?? 1,
            perPage: options.limit ?? 50,
          });
          return raw.map((match) => this.fromOctane(match));
        }
        case "startgg": {
          // start.gg has no fixture list at title level - matches live inside
          // an event, so the entry point is the tournament list.
          const tournaments = await providers
            .startgg(this.runtime)
            .getTournaments(this.title.id, this.title.name, {
              page: options.page ?? 1,
              perPage: Math.min(options.limit ?? 10, 25),
              ...(options.since !== undefined ? { since: options.since } : {}),
              ...(options.until !== undefined ? { until: options.until } : {}),
            });
          const matches: EsportsMatch[] = [];
          for (const tournament of tournaments.slice(0, 3)) {
            const events = asArray<{ id: number; name?: string }>(tournament.events);
            const event = events[0];
            if (!event) continue;
            const sets = await providers
              .startgg(this.runtime)
              .getEventSets(event.id, this.title.id, { perPage: 20 });
            for (const set of sets) {
              matches.push(this.fromStartGgSet(set, tournament));
            }
          }
          return matches;
        }
        case "opendota": {
          const raw = await providers.opendota(this.runtime).getProMatches();
          return raw.slice(0, options.limit ?? 50).map((match) => this.fromOpenDotaPro(match));
        }
        case "abios": {
          const abios = providers.abios(this.runtime);
          const gameId = await abios.gameId(this.title.id, this.title.name);
          const raw = await abios.getSeries(gameId, {
            take: options.limit ?? 50,
            ...(options.since !== undefined ? { since: options.since } : {}),
          });
          return raw.map((series) => this.fromAbios(series));
        }
        default:
          throw new UnsupportedCapabilityError(
            this.title.id,
            `getEsportsMatches via ${providerId}`,
            this.title.capabilities,
          );
      }
    });
  }

  /** Tournaments and events. */
  public async getTournaments(options: EsportsQueryOptions = {}): Promise<EsportsTournament[]> {
    return this.race("getEsportsTournaments", options.provider, async (providerId) => {
      switch (providerId) {
        case "pandascore": {
          const raw = await providers.pandascore(this.runtime).getTournaments(this.title.id, {
            ...(bucketFor(options.status) ? { bucket: bucketFor(options.status) } : {}),
            page: options.page ?? 1,
            perPage: options.limit ?? 50,
          });
          return raw.map((tournament) => this.tournamentFromPandaScore(tournament));
        }
        case "startgg": {
          const raw = await providers
            .startgg(this.runtime)
            .getTournaments(this.title.id, this.title.name, {
              page: options.page ?? 1,
              perPage: options.limit ?? 25,
              ...(options.since !== undefined ? { since: options.since } : {}),
              ...(options.until !== undefined ? { until: options.until } : {}),
              upcoming: options.status === "scheduled",
            });
          return raw.map((tournament) => this.tournamentFromStartGg(tournament));
        }
        case "octane": {
          const raw = await providers.octane(this.runtime).getEvents({
            page: options.page ?? 1,
            perPage: options.limit ?? 50,
          });
          return raw.map((event) => this.tournamentFromOctane(event));
        }
        case "toornament": {
          const raw = await providers.toornament(this.runtime).getTournaments();
          return raw.map((tournament) => this.tournamentFromToornament(tournament));
        }
        case "liquipedia": {
          const pages = await providers
            .liquipedia(this.runtime)
            .getCategoryMembers(this.title.id, "Tournaments", options.limit ?? 50);
          return pages.map((page) => this.tournamentFromLiquipedia(page));
        }
        default:
          throw new UnsupportedCapabilityError(
            this.title.id,
            `getEsportsTournaments via ${providerId}`,
            this.title.capabilities,
          );
      }
    });
  }

  /** Professional rosters. */
  public async getTeams(options: EsportsQueryOptions = {}): Promise<EsportsTeam[]> {
    return this.race("getEsportsTeams", options.provider, async (providerId) => {
      switch (providerId) {
        case "pandascore": {
          const raw = await providers.pandascore(this.runtime).getTeams(this.title.id, {
            page: options.page ?? 1,
            perPage: options.limit ?? 50,
          });
          return raw.map((team) => this.teamFromPandaScore(team));
        }
        case "octane": {
          const raw = await providers.octane(this.runtime).getTeams();
          return raw.slice(0, options.limit ?? 50).map((team) => this.teamFromOctane(team));
        }
        case "opendota": {
          const raw = await providers.opendota(this.runtime).getTeams();
          return raw.slice(0, options.limit ?? 50).map((team) => this.teamFromOpenDota(team));
        }
        case "abios": {
          const abios = providers.abios(this.runtime);
          const gameId = await abios.gameId(this.title.id, this.title.name);
          const raw = await abios.getTeams(gameId, options.limit ?? 50);
          return raw.map((team) => this.teamFromAbios(team));
        }
        default:
          throw new UnsupportedCapabilityError(
            this.title.id,
            `getEsportsTeams via ${providerId}`,
            this.title.capabilities,
          );
      }
    });
  }

  /** Professional players. */
  public async getPlayers(options: EsportsQueryOptions = {}): Promise<EsportsPlayer[]> {
    return this.race("getEsportsPlayers", options.provider, async (providerId) => {
      switch (providerId) {
        case "pandascore": {
          const raw = await providers.pandascore(this.runtime).getPlayers(this.title.id, {
            page: options.page ?? 1,
            perPage: options.limit ?? 50,
          });
          return raw.map((player) => this.playerFromPandaScore(player));
        }
        case "octane": {
          const raw = await providers.octane(this.runtime).getPlayers();
          return raw.slice(0, options.limit ?? 50).map((player) => this.playerFromOctane(player));
        }
        case "opendota": {
          const raw = await providers.opendota(this.runtime).getProPlayers();
          return raw
            .slice(0, options.limit ?? 50)
            .map((player) => this.playerFromOpenDota(player));
        }
        case "abios": {
          const abios = providers.abios(this.runtime);
          const gameId = await abios.gameId(this.title.id, this.title.name);
          const raw = await abios.getPlayers(gameId, options.limit ?? 50);
          return raw.map((player) => this.playerFromAbios(player));
        }
        default:
          throw new UnsupportedCapabilityError(
            this.title.id,
            `getEsportsPlayers via ${providerId}`,
            this.title.capabilities,
          );
      }
    });
  }

  /** Standings for one tournament or event. */
  public async getStandings(
    tournamentId: string,
    options: EsportsQueryOptions = {},
  ): Promise<EsportsStanding[]> {
    return this.race("getStandings", options.provider, async (providerId) => {
      switch (providerId) {
        case "pandascore": {
          const raw = await providers
            .pandascore(this.runtime)
            .getStandings(tournamentId, this.title.id);
          return raw.map((row, index) => ({
            position: int(row.rank) ?? index + 1,
            teamId: str((row.team as Record<string, unknown> | undefined)?.id),
            teamName: str((row.team as Record<string, unknown> | undefined)?.name),
            wins: int(row.wins),
            losses: int(row.losses),
            draws: int(row.ties),
            points: int(row.points),
            raw: row,
          }));
        }
        case "startgg": {
          const raw = await providers
            .startgg(this.runtime)
            .getEventStandings(tournamentId, this.title.id, {
              perPage: options.limit ?? 32,
            });
          return raw.map((row, index) => {
            const entrant = row.entrant as Record<string, unknown> | undefined;
            return {
              position: int(row.placement) ?? index + 1,
              teamId: str(entrant?.id),
              teamName: str(entrant?.name),
              wins: null,
              losses: null,
              draws: null,
              points: null,
              raw: row,
            };
          });
        }
        case "challonge": {
          const raw = await providers.challonge(this.runtime).getParticipants(tournamentId);
          return raw.map((row, index) => ({
            position: int(row.final_rank) ?? index + 1,
            teamId: str(row.id),
            teamName: str(row.name),
            wins: null,
            losses: null,
            draws: null,
            points: null,
            raw: row,
          }));
        }
        default:
          throw new UnsupportedCapabilityError(
            this.title.id,
            `getStandings via ${providerId}`,
            this.title.capabilities,
          );
      }
    });
  }

  /**
   * Career prize money.
   *
   * Always Esports Earnings, whatever the title - it is the only source that
   * covers the whole industry, and there is nothing to choose between.
   */
  public async getEarnings(handle: string): Promise<PrizeEarnings> {
    const provider = providers.esportsEarnings(this.runtime);
    const matches = await provider.lookupPlayerByName(handle);
    const first = matches[0];
    if (!first) {
      const { NotFoundError } = await import("./errors.js");
      throw new NotFoundError("esports-earnings", `player "${handle}"`, this.title.id);
    }
    const playerId = String(first.PlayerId ?? first.playerid ?? "");
    const detail = await provider.lookupPlayerById(playerId);
    const byGame = await provider.lookupPlayerGames(playerId);

    const byTitle: PrizeEarningsByTitle[] = byGame.map((row) => ({
      titleId: findTitle(String(row.GameName ?? ""))?.id ?? null,
      titleName: String(row.GameName ?? "unknown"),
      // Esports Earnings reports whole dollars; the model stores cents.
      totalUsdCents: Math.round((num(row.TotalUSDPrize) ?? 0) * 100),
      tournaments: int(row.TotalTournaments),
    }));

    return {
      playerId,
      handle: String(detail.CurrentHandle ?? first.CurrentHandle ?? handle),
      name:
        str([detail.NameFirst, detail.NameLast].filter(Boolean).join(" ")) ?? null,
      country: str(detail.CountryCode),
      totalUsdCents: Math.round((num(detail.TotalUSDPrize) ?? 0) * 100),
      byTitle,
      raw: { player: detail, games: byGame },
    };
  }

  // -------------------------------------------------------------------------
  // Normalisers
  // -------------------------------------------------------------------------

  private fromPandaScore(match: PandaScoreMatch): EsportsMatch {
    const opponents: EsportsOpponent[] = (match.opponents ?? []).map((entry) => {
      const opponent = entry.opponent ?? {};
      const result = (match.results ?? []).find(
        (row) => row.team_id === opponent.id || row.player_id === opponent.id,
      );
      return {
        id: String(opponent.id ?? ""),
        name: opponent.name ?? "unknown",
        acronym: opponent.acronym ?? null,
        logoUrl: opponent.image_url ?? null,
        score: result?.score ?? null,
        kind: entry.type === "Player" ? "player" : "team",
      };
    });

    const streams: EsportsStream[] = (match.streams_list ?? [])
      .filter((stream) => typeof stream.raw_url === "string")
      .map((stream) => ({
        url: stream.raw_url as string,
        language: stream.language ?? null,
        official: stream.official ?? false,
      }));

    return {
      id: String(match.id),
      titleId: this.title.id,
      name: match.name ?? null,
      status: normaliseStatus(match.status),
      scheduledAt: ts(match.scheduled_at),
      startedAt: ts(match.begin_at),
      endedAt: ts(match.end_at),
      bestOf: match.number_of_games ?? null,
      opponents,
      winnerId: match.winner_id !== null && match.winner_id !== undefined ? String(match.winner_id) : null,
      tournament: match.tournament?.id
        ? {
            id: String(match.tournament.id),
            name: match.tournament.name ?? match.league?.name ?? "unknown",
            slug: match.tournament.slug ?? null,
          }
        : null,
      streams,
      providerId: "pandascore",
      raw: match,
    };
  }

  private fromOctane(match: Record<string, unknown>): EsportsMatch {
    const blue = match.blue as Record<string, unknown> | undefined;
    const orange = match.orange as Record<string, unknown> | undefined;
    const side = (entry: Record<string, unknown> | undefined): EsportsOpponent | null => {
      if (!entry) return null;
      const team = (entry.team as Record<string, unknown> | undefined)?.team as
        | Record<string, unknown>
        | undefined;
      return {
        id: String(team?._id ?? ""),
        name: String(team?.name ?? "unknown"),
        acronym: str(team?.slug),
        logoUrl: str(team?.image),
        score: int(entry.score),
        kind: "team",
      };
    };
    const opponents = [side(blue), side(orange)].filter((entry): entry is EsportsOpponent => entry !== null);
    const event = match.event as Record<string, unknown> | undefined;

    return {
      id: String(match._id ?? match.id ?? ""),
      titleId: this.title.id,
      name: str(event?.name),
      status: match.blue && match.orange ? "finished" : "scheduled",
      scheduledAt: ts(match.date),
      startedAt: ts(match.date),
      endedAt: null,
      bestOf: int((match.format as Record<string, unknown> | undefined)?.length),
      opponents,
      winnerId:
        opponents.length === 2 && opponents[0] && opponents[1]
          ? (opponents[0].score ?? 0) > (opponents[1].score ?? 0)
            ? opponents[0].id
            : opponents[1].id
          : null,
      tournament: event?._id
        ? { id: String(event._id), name: String(event.name ?? "unknown"), slug: str(event.slug) }
        : null,
      streams: [],
      providerId: "octane",
      raw: match,
    };
  }

  private fromStartGgSet(
    set: Record<string, unknown>,
    tournament: Record<string, unknown>,
  ): EsportsMatch {
    const slots = asArray<Record<string, unknown>>(set.slots);
    const opponents: EsportsOpponent[] = slots.map((slot) => {
      const entrant = slot.entrant as Record<string, unknown> | undefined;
      const standing = slot.standing as Record<string, unknown> | undefined;
      const score = ((standing?.stats as Record<string, unknown> | undefined)?.score as
        | Record<string, unknown>
        | undefined)?.value;
      return {
        id: String(entrant?.id ?? ""),
        name: String(entrant?.name ?? "TBD"),
        acronym: null,
        logoUrl: null,
        score: int(score),
        // Fighting games are 1v1, so an entrant is a person, not an org.
        kind: "player",
      };
    });

    return {
      id: String(set.id ?? ""),
      titleId: this.title.id,
      name: str(set.fullRoundText),
      status: set.completedAt ? "finished" : set.startedAt ? "live" : "scheduled",
      scheduledAt: ts(set.startedAt),
      startedAt: ts(set.startedAt),
      endedAt: ts(set.completedAt),
      bestOf: null,
      opponents,
      winnerId: set.winnerId !== null && set.winnerId !== undefined ? String(set.winnerId) : null,
      tournament: tournament.id
        ? {
            id: String(tournament.id),
            name: String(tournament.name ?? "unknown"),
            slug: str(tournament.slug),
          }
        : null,
      streams: [],
      providerId: "startgg",
      raw: { set, tournament },
    };
  }

  private fromOpenDotaPro(match: Record<string, unknown>): EsportsMatch {
    const radiantWin = match.radiant_win === true;
    const opponents: EsportsOpponent[] = [
      {
        id: String(match.radiant_team_id ?? "radiant"),
        name: String(match.radiant_name ?? "Radiant"),
        acronym: null,
        logoUrl: null,
        score: int(match.radiant_score),
        kind: "team",
      },
      {
        id: String(match.dire_team_id ?? "dire"),
        name: String(match.dire_name ?? "Dire"),
        acronym: null,
        logoUrl: null,
        score: int(match.dire_score),
        kind: "team",
      },
    ];
    return {
      id: String(match.match_id ?? ""),
      titleId: this.title.id,
      name: str(match.league_name),
      status: "finished",
      scheduledAt: ts(match.start_time),
      startedAt: ts(match.start_time),
      endedAt: null,
      bestOf: null,
      opponents,
      winnerId: radiantWin ? opponents[0]?.id ?? null : opponents[1]?.id ?? null,
      tournament: match.leagueid
        ? {
            id: String(match.leagueid),
            name: String(match.league_name ?? "unknown"),
            slug: null,
          }
        : null,
      streams: [],
      providerId: "opendota",
      raw: match,
    };
  }

  private fromAbios(series: Record<string, unknown>): EsportsMatch {
    const participants = asArray<Record<string, unknown>>(series.participants);
    const opponents: EsportsOpponent[] = participants.map((participant) => {
      const roster = participant.roster as Record<string, unknown> | undefined;
      const team = roster?.team as Record<string, unknown> | undefined;
      return {
        id: String(team?.id ?? roster?.id ?? ""),
        name: String(team?.name ?? "unknown"),
        acronym: str(team?.short_name),
        logoUrl: str((team?.images as Record<string, unknown> | undefined)?.default),
        score: int(participant.score),
        kind: "team",
      };
    });
    return {
      id: String(series.id ?? ""),
      titleId: this.title.id,
      name: str(series.title),
      status: normaliseStatus(str(series.lifecycle)),
      scheduledAt: ts(series.start),
      startedAt: ts(series.start),
      endedAt: ts(series.end),
      bestOf: int(series.best_of),
      opponents,
      winnerId: str((series.winner as Record<string, unknown> | undefined)?.id),
      tournament: null,
      streams: [],
      providerId: "abios",
      raw: series,
    };
  }

  private tournamentFromPandaScore(row: Record<string, unknown>): EsportsTournament {
    const league = row.league as Record<string, unknown> | undefined;
    return {
      id: String(row.id ?? ""),
      name: String(row.name ?? league?.name ?? "unknown"),
      slug: str(row.slug),
      titleId: this.title.id,
      tier: str(row.tier),
      beginAt: ts(row.begin_at),
      endAt: ts(row.end_at),
      prizePoolMinor: parsePrizePool(str(row.prizepool)),
      prizePoolCurrency: parsePrizeCurrency(str(row.prizepool)),
      region: str(row.region),
      online: typeof row.live_supported === "boolean" ? null : null,
      providerId: "pandascore",
      raw: row,
    };
  }

  private tournamentFromStartGg(row: Record<string, unknown>): EsportsTournament {
    return {
      id: String(row.id ?? ""),
      name: String(row.name ?? "unknown"),
      slug: str(row.slug),
      titleId: this.title.id,
      tier: null,
      beginAt: ts(row.startAt),
      endAt: ts(row.endAt),
      prizePoolMinor: null,
      prizePoolCurrency: null,
      region: str(row.countryCode),
      online: typeof row.isOnline === "boolean" ? row.isOnline : null,
      providerId: "startgg",
      raw: row,
    };
  }

  private tournamentFromOctane(row: Record<string, unknown>): EsportsTournament {
    return {
      id: String(row._id ?? ""),
      name: String(row.name ?? "unknown"),
      slug: str(row.slug),
      titleId: this.title.id,
      tier: str(row.tier),
      beginAt: ts(row.startDate),
      endAt: ts(row.endDate),
      prizePoolMinor: (() => {
        const prize = row.prize as Record<string, unknown> | undefined;
        const amount = num(prize?.amount);
        return amount === null ? null : Math.round(amount * 100);
      })(),
      prizePoolCurrency: str((row.prize as Record<string, unknown> | undefined)?.currency),
      region: str(row.region),
      online: typeof row.lan === "boolean" ? !row.lan : null,
      providerId: "octane",
      raw: row,
    };
  }

  private tournamentFromToornament(row: Record<string, unknown>): EsportsTournament {
    return {
      id: String(row.id ?? ""),
      name: String(row.name ?? row.full_name ?? "unknown"),
      slug: null,
      titleId: this.title.id,
      tier: null,
      beginAt: ts(row.scheduled_date_start),
      endAt: ts(row.scheduled_date_end),
      prizePoolMinor: null,
      prizePoolCurrency: null,
      region: str(row.country),
      online: row.online === true ? true : row.online === false ? false : null,
      providerId: "toornament",
      raw: row,
    };
  }

  private tournamentFromLiquipedia(row: { title: string; pageid: number }): EsportsTournament {
    return {
      id: String(row.pageid),
      name: row.title,
      slug: row.title.replace(/ /g, "_"),
      titleId: this.title.id,
      tier: null,
      beginAt: null,
      endAt: null,
      prizePoolMinor: null,
      prizePoolCurrency: null,
      region: null,
      online: null,
      providerId: "liquipedia",
      raw: row,
    };
  }

  private teamFromPandaScore(row: Record<string, unknown>): EsportsTeam {
    return {
      id: String(row.id ?? ""),
      titleId: this.title.id,
      name: String(row.name ?? "unknown"),
      acronym: str(row.acronym),
      logoUrl: str(row.image_url),
      country: str(row.location),
      players: asArray<Record<string, unknown>>(row.players).map((player) =>
        this.playerFromPandaScore(player, String(row.id ?? "")),
      ),
      providerId: "pandascore",
      raw: row,
    };
  }

  private teamFromOctane(row: Record<string, unknown>): EsportsTeam {
    return {
      id: String(row._id ?? ""),
      titleId: this.title.id,
      name: String(row.name ?? "unknown"),
      acronym: str(row.slug),
      logoUrl: str(row.image),
      country: str((row.location as Record<string, unknown> | undefined)?.nationality),
      players: [],
      providerId: "octane",
      raw: row,
    };
  }

  private teamFromOpenDota(row: Record<string, unknown>): EsportsTeam {
    return {
      id: String(row.team_id ?? ""),
      titleId: this.title.id,
      name: String(row.name ?? "unknown"),
      acronym: str(row.tag),
      logoUrl: str(row.logo_url),
      country: null,
      players: [],
      providerId: "opendota",
      raw: row,
    };
  }

  private teamFromAbios(row: Record<string, unknown>): EsportsTeam {
    return {
      id: String(row.id ?? ""),
      titleId: this.title.id,
      name: String(row.name ?? "unknown"),
      acronym: str(row.short_name),
      logoUrl: str((row.images as Record<string, unknown> | undefined)?.default),
      country: str((row.country as Record<string, unknown> | undefined)?.name),
      players: [],
      providerId: "abios",
      raw: row,
    };
  }

  private playerFromPandaScore(row: Record<string, unknown>, teamId?: string): EsportsPlayer {
    return {
      id: String(row.id ?? ""),
      titleId: this.title.id,
      nickname: String(row.name ?? row.slug ?? "unknown"),
      firstName: str(row.first_name),
      lastName: str(row.last_name),
      country: str(row.nationality),
      role: str(row.role),
      teamId: teamId ?? str((row.current_team as Record<string, unknown> | undefined)?.id),
      providerId: "pandascore",
      raw: row,
    };
  }

  private playerFromOctane(row: Record<string, unknown>): EsportsPlayer {
    return {
      id: String(row._id ?? ""),
      titleId: this.title.id,
      nickname: String(row.tag ?? "unknown"),
      firstName: str((row.name as Record<string, unknown> | undefined)?.first),
      lastName: str((row.name as Record<string, unknown> | undefined)?.last),
      country: str((row.country as string | undefined) ?? null),
      role: null,
      teamId: str((row.team as Record<string, unknown> | undefined)?._id),
      providerId: "octane",
      raw: row,
    };
  }

  private playerFromOpenDota(row: Record<string, unknown>): EsportsPlayer {
    return {
      id: String(row.account_id ?? ""),
      titleId: this.title.id,
      nickname: String(row.name ?? row.personaname ?? "unknown"),
      firstName: null,
      lastName: null,
      country: str(row.loccountrycode),
      role: null,
      teamId: str(row.team_id),
      providerId: "opendota",
      raw: row,
    };
  }

  private playerFromAbios(row: Record<string, unknown>): EsportsPlayer {
    return {
      id: String(row.id ?? ""),
      titleId: this.title.id,
      nickname: String(row.nick_name ?? row.name ?? "unknown"),
      firstName: str(row.first_name),
      lastName: str(row.last_name),
      country: str((row.country as Record<string, unknown> | undefined)?.name),
      role: str(row.role),
      teamId: str((row.team as Record<string, unknown> | undefined)?.id),
      providerId: "abios",
      raw: row,
    };
  }
}

/** Map a canonical status onto PandaScore's bucket endpoints. */
function bucketFor(
  status: EsportsMatchStatus | undefined,
): "running" | "upcoming" | "past" | undefined {
  switch (status) {
    case "live":
      return "running";
    case "scheduled":
      return "upcoming";
    case "finished":
      return "past";
    default:
      return undefined;
  }
}

/** Every provider spells match status differently. This is the one vocabulary. */
function normaliseStatus(status: string | null | undefined): EsportsMatchStatus {
  switch ((status ?? "").toLowerCase()) {
    case "running":
    case "live":
    case "started":
      return "live";
    case "finished":
    case "over":
    case "ended":
    case "completed":
      return "finished";
    case "not_started":
    case "upcoming":
    case "scheduled":
    case "unscheduled":
      return "scheduled";
    case "postponed":
    case "delayed":
      return "postponed";
    case "canceled":
    case "cancelled":
      return "cancelled";
    default:
      return "unknown";
  }
}

/**
 * PandaScore reports a prize pool as free text: `"1000000 United States Dollar"`.
 *
 * The number becomes minor units; anything unparseable becomes `null` rather
 * than a guess, because a wrong prize pool is worse than a missing one.
 */
function parsePrizePool(value: string | null): number | null {
  if (!value) return null;
  const match = /([0-9][0-9.,]*)/.exec(value);
  if (!match?.[1]) return null;
  const amount = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

/** The currency half of the same free-text field, as an ISO code where known. */
function parsePrizeCurrency(value: string | null): string | null {
  if (!value) return null;
  const text = value.toLowerCase();
  if (text.includes("united states dollar") || text.includes("usd")) return "USD";
  if (text.includes("euro") || text.includes("eur")) return "EUR";
  if (text.includes("pound")) return "GBP";
  if (text.includes("yuan") || text.includes("renminbi")) return "CNY";
  if (text.includes("won")) return "KRW";
  if (text.includes("yen")) return "JPY";
  return null;
}
