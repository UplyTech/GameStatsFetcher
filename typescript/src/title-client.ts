/**
 * The base every title client extends - and, for the titles with no player
 * API, the whole implementation.
 *
 * The shape here is what makes "one client for every esports title" true rather
 * than a slogan. Every title exposes the same fourteen methods. A title that
 * cannot serve one of them throws {@link UnsupportedCapabilityError} naming
 * what it *can* do, and `title.capabilities` says so in advance so a caller can
 * branch before making the call rather than after catching it.
 *
 * ## Why unsupported throws instead of returning empty
 *
 * An empty array is a legitimate answer to "what matches has this player
 * played". If `getMatchHistory` returned one for Tekken 8 - which has no player
 * API at all - the caller could not tell the difference between a quiet week
 * and a question the title cannot answer. That distinction is worth an
 * exception.
 */

import type {
  Capability,
  EsportsMatch,
  EsportsPlayer,
  EsportsQueryOptions,
  EsportsStanding,
  EsportsTeam,
  EsportsTournament,
  LeaderboardEntry,
  LeaderboardOptions,
  MatchDetail,
  MatchHistoryOptions,
  MatchSummary,
  PlayerProfile,
  PlayerQuery,
  PlayerRef,
  PlayerStats,
  PrizeEarnings,
  RankInfo,
  TitleDescriptor,
} from "./types.js";
import type { Runtime } from "./runtime.js";
import { EsportsLayer } from "./esports.js";
import {
  GameStatsError,
  IdentifierError,
  ParseError,
  UnsupportedCapabilityError,
  ValidationError,
} from "./errors.js";
import { clamp } from "./normalize.js";
import { MAX_PAGE_SIZE } from "./constants.js";

/**
 * The fourteen methods a caller can reach. Every one of them talks to an
 * upstream this package does not control, so every one of them is wrapped.
 */
const CANONICAL_METHODS = [
  "resolvePlayer",
  "getPlayer",
  "getPlayerStats",
  "getRank",
  "getMatchHistory",
  "getMatch",
  "getLeaderboard",
  "getMetadata",
  "getEsportsMatches",
  "getEsportsTournaments",
  "getEsportsTeams",
  "getEsportsPlayers",
  "getStandings",
  "getEarnings",
] as const;

/** Prototypes already wrapped, so a second title client does not double-wrap. */
const translated = new WeakSet<object>();

/**
 * Wrap a title client's methods so a malformed payload leaves as a `ParseError`.
 *
 * Sixty-odd title clients map several hundred upstream payloads between them,
 * and each mapper is written against the shape its provider documents. When a
 * provider drifts - or answers an array endpoint with `{"error": ...}`, or is
 * impersonated, or sits behind a proxy that returned an HTML error page with a
 * 200 - the mapper meets something it was not written for. What escaped before
 * this wrapper existed was `TypeError: rows.map is not a function`: an error
 * naming neither the title nor the call, and not a `GameStatsError`, so an
 * application that carefully wrapped every call in `catch (e) { if (e
 * instanceof GameStatsError) ... }` still fell over. A crash in somebody's
 * Discord bot, from a change on a server neither of us runs.
 *
 * The cost is real and worth stating: a genuine bug *inside* a mapper - reading
 * a field off something this package built wrong - now surfaces as a ParseError
 * too, which reads like the upstream's fault when it is ours. Two things keep
 * that survivable. The original error is kept as `cause`, so the stack still
 * points at the line that broke. And the suite exercises every mapper against a
 * realistic payload, so a mapper that cannot map its own provider fails in CI
 * rather than in production wearing a disguise.
 *
 * Applied to the prototype chain rather than to each instance: the subclass's
 * overrides and the base's esports methods both live there, one wrap covers
 * every client of that title, and `instanceof` keeps working - which a Proxy
 * around the instance would have put at risk.
 */
export function translateShapeErrors(constructor: typeof TitleClient): void {
  let prototype: object | null = constructor.prototype as object;
  while (prototype && prototype !== Object.prototype) {
    if (!translated.has(prototype)) {
      translated.add(prototype);
      for (const name of CANONICAL_METHODS) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        if (!descriptor || typeof descriptor.value !== "function") continue;
        const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;
        Object.defineProperty(prototype, name, {
          ...descriptor,
          value: async function wrapped(this: TitleClient, ...args: unknown[]): Promise<unknown> {
            try {
              return await original.apply(this, args);
            } catch (error) {
              // Everything this package throws deliberately - unsupported, not
              // found, rate limited, a validation failure - passes through
              // untouched. Only the accidents are translated.
              if (error instanceof GameStatsError) throw error;
              if (
                error instanceof TypeError ||
                error instanceof RangeError ||
                error instanceof SyntaxError
              ) {
                throw new ParseError(
                  this.title.id,
                  `${name} received data it could not map (${error.name}: ${error.message})`,
                  error,
                );
              }
              throw error;
            }
          },
        });
      }
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
}

export class TitleClient {
  /** The registry entry for this title. Public - callers branch on it. */
  public readonly title: TitleDescriptor;
  protected readonly runtime: Runtime;
  protected readonly esports: EsportsLayer;

  constructor(title: TitleDescriptor, runtime: Runtime) {
    this.title = title;
    this.runtime = runtime;
    this.esports = new EsportsLayer(runtime, title);
  }

  /** The title id, for logging and cache keys. */
  public get id(): string {
    return this.title.id;
  }

  /** Whether this title supports a method. Cheaper than catching the error. */
  public supports(capability: Capability): boolean {
    return this.title.capabilities.includes(capability);
  }

  /** Throw unless the capability is declared. Called at the top of every method. */
  protected require(capability: Capability): void {
    if (!this.supports(capability)) {
      throw new UnsupportedCapabilityError(
        this.title.id,
        capability,
        this.title.capabilities,
      );
    }
  }

  /** Clamp a caller-supplied page size to something the upstreams will accept. */
  protected limit(value: number | undefined, fallback = 20): number {
    return clamp(value ?? fallback, 1, MAX_PAGE_SIZE);
  }

  /** Throw when a query supplies none of the identifiers this title accepts. */
  protected requireIdentifier(query: PlayerQuery): void {
    const accepted = this.title.identifiers;
    if (accepted.length === 0) {
      throw new UnsupportedCapabilityError(
        this.title.id,
        "resolvePlayer",
        this.title.capabilities,
      );
    }
    const supplied = accepted.some((key) => {
      const value = query[key];
      return value !== undefined && value !== null && String(value).trim().length > 0;
    });
    if (!supplied) throw new IdentifierError(this.title.id, accepted as readonly string[]);
  }

  /** Build a {@link PlayerRef} without repeating the boilerplate. */
  protected ref(input: {
    providerId: string;
    id: string;
    displayName?: string | null;
    platform?: PlayerRef["platform"];
    region?: string | null;
  }): PlayerRef {
    return {
      titleId: this.title.id,
      providerId: input.providerId,
      id: input.id,
      displayName: input.displayName ?? null,
      platform: input.platform ?? null,
      region: input.region ?? null,
    };
  }

  /**
   * Validate a region against the registry, or fall back to the first one.
   *
   * Titles that are not regionalised declare an empty list and pass through
   * whatever they were given.
   */
  protected region(value: string | undefined, fallback?: string): string {
    const allowed = this.title.regions;
    if (allowed.length === 0) return value ?? fallback ?? "";
    if (value === undefined) {
      const chosen = fallback ?? allowed[0];
      if (!chosen) throw new ValidationError(`${this.title.id} needs a region`);
      return chosen;
    }
    const normalised = value.toLowerCase();
    if (!allowed.includes(normalised)) {
      throw new ValidationError(
        `unknown region "${value}" for ${this.title.id}. Expected one of: ${allowed.join(", ")}`,
      );
    }
    return normalised;
  }

  // -------------------------------------------------------------------------
  // Player surface - overridden by the titles that have one
  // -------------------------------------------------------------------------

  /** Turn a query into a stable {@link PlayerRef}. */
  public async resolvePlayer(_query: PlayerQuery): Promise<PlayerRef> {
    this.require("resolvePlayer");
    throw new UnsupportedCapabilityError(
      this.title.id,
      "resolvePlayer",
      this.title.capabilities,
    );
  }

  /** Public profile. */
  public async getPlayer(_query: PlayerQuery | PlayerRef): Promise<PlayerProfile> {
    this.require("getPlayer");
    throw new UnsupportedCapabilityError(this.title.id, "getPlayer", this.title.capabilities);
  }

  /** Career statistics. */
  public async getPlayerStats(_query: PlayerQuery | PlayerRef): Promise<PlayerStats> {
    this.require("getPlayerStats");
    throw new UnsupportedCapabilityError(
      this.title.id,
      "getPlayerStats",
      this.title.capabilities,
    );
  }

  /**
   * Competitive standing, one entry per queue.
   *
   * A list rather than a single value: League of Legends has solo and flex,
   * Rocket League has five playlists, and picking one for the caller would be
   * a guess.
   */
  public async getRank(_query: PlayerQuery | PlayerRef): Promise<RankInfo[]> {
    this.require("getRank");
    throw new UnsupportedCapabilityError(this.title.id, "getRank", this.title.capabilities);
  }

  /** Recent matches, newest first. */
  public async getMatchHistory(
    _query: PlayerQuery | PlayerRef,
    _options?: MatchHistoryOptions,
  ): Promise<MatchSummary[]> {
    this.require("getMatchHistory");
    throw new UnsupportedCapabilityError(
      this.title.id,
      "getMatchHistory",
      this.title.capabilities,
    );
  }

  /** One match in full. */
  public async getMatch(_matchId: string, _context?: PlayerRef): Promise<MatchDetail> {
    this.require("getMatch");
    throw new UnsupportedCapabilityError(this.title.id, "getMatch", this.title.capabilities);
  }

  /** A page of the ladder. */
  public async getLeaderboard(_options?: LeaderboardOptions): Promise<LeaderboardEntry[]> {
    this.require("getLeaderboard");
    throw new UnsupportedCapabilityError(
      this.title.id,
      "getLeaderboard",
      this.title.capabilities,
    );
  }

  /** Static game data: heroes, agents, maps, cards. */
  public async getMetadata(_kind?: string): Promise<unknown> {
    this.require("getMetadata");
    throw new UnsupportedCapabilityError(this.title.id, "getMetadata", this.title.capabilities);
  }

  // -------------------------------------------------------------------------
  // Esports surface - identical for every title, served by the esports layer
  // -------------------------------------------------------------------------

  /** Professional fixtures. */
  public async getEsportsMatches(options: EsportsQueryOptions = {}): Promise<EsportsMatch[]> {
    this.require("getEsportsMatches");
    return this.esports.getMatches(options);
  }

  /** Tournaments and events. */
  public async getEsportsTournaments(
    options: EsportsQueryOptions = {},
  ): Promise<EsportsTournament[]> {
    this.require("getEsportsTournaments");
    return this.esports.getTournaments(options);
  }

  /** Professional rosters. */
  public async getEsportsTeams(options: EsportsQueryOptions = {}): Promise<EsportsTeam[]> {
    this.require("getEsportsTeams");
    return this.esports.getTeams(options);
  }

  /** Professional players. */
  public async getEsportsPlayers(options: EsportsQueryOptions = {}): Promise<EsportsPlayer[]> {
    this.require("getEsportsPlayers");
    return this.esports.getPlayers(options);
  }

  /** Standings for one tournament. */
  public async getStandings(
    tournamentId: string,
    options: EsportsQueryOptions = {},
  ): Promise<EsportsStanding[]> {
    this.require("getStandings");
    return this.esports.getStandings(tournamentId, options);
  }

  /** Career prize money for a professional handle. */
  public async getEarnings(handle: string): Promise<PrizeEarnings> {
    this.require("getEarnings");
    return this.esports.getEarnings(handle);
  }
}

/**
 * Narrow a `PlayerQuery | PlayerRef` union.
 *
 * Every player method accepts both, so a caller can pass a query the first time
 * and re-use the ref afterwards - which saves the resolve call that most of
 * these APIs charge for.
 */
export function isPlayerRef(value: PlayerQuery | PlayerRef): value is PlayerRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "titleId" in value &&
    "providerId" in value &&
    "id" in value
  );
}
