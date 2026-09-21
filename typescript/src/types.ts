/**
 * The canonical domain model of @uplytech/game-stats-fetcher.
 *
 * Forty-odd game APIs disagree about almost everything: what a player is
 * called, whether a rank is a number or a string, whether a match knows who
 * won. This file is the one place where that stops. Every title client maps
 * its upstream payload onto the shapes below, and every caller reads the same
 * shapes no matter which title they asked about.
 *
 * Two rules keep the model honest:
 *
 * 1. **Nothing is invented.** A field the upstream API does not provide is
 *    `null`, never a plausible-looking default. A `null` rank means "this API
 *    does not tell us", and a caller can act on that; a `0` would be a lie.
 * 2. **The raw payload always survives.** Normalisation loses detail by
 *    definition, so every normalised object carries the untouched upstream
 *    response in `raw`. Callers who need the one field we did not model are
 *    never blocked on a release of this package.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Platform a player account lives on. */
export type Platform =
  | "steam"
  | "epic"
  | "riot"
  | "battlenet"
  | "xbox"
  | "playstation"
  | "nintendo"
  | "origin"
  | "ubisoft"
  | "android"
  | "ios"
  | "kakao"
  | "web";

/**
 * How a caller asks for a player.
 *
 * Different titles accept different things, and most accept several. The
 * resolver takes whatever is present and turns it into a {@link PlayerRef}; a
 * title that cannot work with any of the supplied fields says so with an
 * `IdentifierError` rather than guessing.
 */
export interface PlayerQuery {
  /** SteamID64 as a decimal string. Steam-backed titles. */
  readonly steamId?: string;
  /** Riot PUUID. Preferred for every Riot title - it never changes. */
  readonly puuid?: string;
  /** Riot ID game name (the part before the hash). */
  readonly gameName?: string;
  /** Riot ID tag line (the part after the hash), without the hash. */
  readonly tagLine?: string;
  /** Display name / gamertag / in-game name, for titles that search by it. */
  readonly name?: string;
  /** Battle.net BattleTag, e.g. `Player#1234`. */
  readonly battleTag?: string;
  /** Supercell player tag, e.g. `#2PP`. The leading hash is optional. */
  readonly playerTag?: string;
  /** Epic Games account id. */
  readonly epicId?: string;
  /** Ubisoft profile id. */
  readonly ubisoftId?: string;
  /** Bungie membership id. */
  readonly membershipId?: string;
  /** Numeric account id, for APIs that use one (osu!, Wargaming, iRacing). */
  readonly accountId?: string | number;
  /** Platform to search on, where the API needs one. */
  readonly platform?: Platform;
  /** Region / shard / realm, where the API is regionalised. */
  readonly region?: string;
  /** Anything else the specific title client documents. */
  readonly extra?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * A resolved, canonical handle on one player of one title.
 *
 * This is what every `resolvePlayer()` returns and what every other player
 * method accepts. Resolving once and re-using the ref saves the lookup call
 * that most APIs charge for.
 */
export interface PlayerRef {
  /** The title this ref belongs to. A ref is never portable between titles. */
  readonly titleId: string;
  /** The provider that resolved it. */
  readonly providerId: string;
  /** The identifier the provider's own endpoints expect. */
  readonly id: string;
  /** Human-readable name at resolve time. Display only - names change. */
  readonly displayName: string | null;
  /** Platform the account lives on, when the API distinguishes them. */
  readonly platform: Platform | null;
  /** Region / shard the account belongs to, when the API is regionalised. */
  readonly region: string | null;
}

// ---------------------------------------------------------------------------
// Player data
// ---------------------------------------------------------------------------

/** A player's public profile, as far as the title's API exposes one. */
export interface PlayerProfile {
  readonly ref: PlayerRef;
  readonly displayName: string;
  /** Account level / renown / summoner level. `null` when the title has none. */
  readonly level: number | null;
  /** Avatar URL, when the API serves one. */
  readonly avatarUrl: string | null;
  /** Profile page on the provider's own site. */
  readonly profileUrl: string | null;
  /** Account creation time, epoch milliseconds. */
  readonly createdAt: number | null;
  /** Last seen / last login, epoch milliseconds. */
  readonly lastSeenAt: number | null;
  /** ISO-3166 alpha-2 country code, when public. */
  readonly country: string | null;
  /** Clan / team / guild name, when the API exposes one. */
  readonly clan: string | null;
  /** True when the profile is private and the numbers below will be thin. */
  readonly isPrivate: boolean;
  readonly raw: unknown;
}

/**
 * Normalised career statistics.
 *
 * The fields every competitive title has - and then `modes` for the ones that
 * split their stats by playlist, queue or character, which is most of them.
 */
export interface PlayerStats {
  readonly ref: PlayerRef;
  /** Total matches with a recorded result. */
  readonly matchesPlayed: number | null;
  readonly wins: number | null;
  readonly losses: number | null;
  readonly draws: number | null;
  /** Win rate in permille (0..1000), computed only from the numbers above. */
  readonly winRatePermille: number | null;
  readonly kills: number | null;
  readonly deaths: number | null;
  readonly assists: number | null;
  /** K/D in permille: 1500 = 1.5. Integer, so it cannot drift. */
  readonly kdPermille: number | null;
  /** Total time played, in seconds. */
  readonly timePlayedSeconds: number | null;
  /** Per-mode / per-playlist / per-character breakdown, keyed by mode id. */
  readonly modes: Readonly<Record<string, ModeStats>>;
  readonly raw: unknown;
}

/** Statistics for one playlist, queue, hero, agent, legend or character. */
export interface ModeStats {
  readonly id: string;
  readonly label: string;
  readonly matchesPlayed: number | null;
  readonly wins: number | null;
  readonly losses: number | null;
  readonly winRatePermille: number | null;
  readonly kills: number | null;
  readonly deaths: number | null;
  readonly assists: number | null;
  /** Whatever else the mode reports - MMR, accuracy, goals, headshot rate. */
  readonly extra: Readonly<Record<string, number | string | null>>;
}

/**
 * A player's competitive standing in one queue.
 *
 * Ranks are the single most inconsistent concept across game APIs: a tier name
 * here, an integer MMR there, a percentile somewhere else. All three are
 * modelled, and a title fills in what it actually knows.
 */
export interface RankInfo {
  readonly ref: PlayerRef;
  /** Queue / playlist this rank belongs to, e.g. `RANKED_SOLO_5x5`. */
  readonly queue: string;
  /** Human label, e.g. `Diamond 2`, `Global Elite`, `Level 10`. */
  readonly tier: string | null;
  /** Division within the tier, where the title has one. */
  readonly division: string | null;
  /** Points inside the tier: LP, RR, stars. */
  readonly tierPoints: number | null;
  /** Raw skill rating, where the API exposes a number: MMR, Elo, SR. */
  readonly rating: number | null;
  /** Absolute ladder position, where the title publishes one. */
  readonly position: number | null;
  /** Top-x permille of the ladder. 5 = top 0.5 %. */
  readonly percentilePermille: number | null;
  readonly wins: number | null;
  readonly losses: number | null;
  /** Season / act / split identifier the rank was earned in. */
  readonly season: string | null;
  readonly raw: unknown;
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

/** How a match ended for the player it was fetched for. */
export type MatchResult = "win" | "loss" | "draw" | "unknown";

/** One row of a player's match history. */
export interface MatchSummary {
  readonly matchId: string;
  readonly titleId: string;
  /** Queue / playlist / mode, in the title's own vocabulary. */
  readonly mode: string | null;
  /** Map, arena, track or stage. */
  readonly map: string | null;
  /** Match start, epoch milliseconds. */
  readonly startedAt: number | null;
  readonly durationSeconds: number | null;
  /** Result from the perspective of the queried player. */
  readonly result: MatchResult;
  /** The queried player's row, when the history endpoint includes it. */
  readonly playerStats: MatchParticipantStats | null;
  readonly raw: unknown;
}

/** Everything a title knows about a single match. */
export interface MatchDetail extends MatchSummary {
  readonly teams: readonly MatchTeam[];
  readonly participants: readonly MatchParticipant[];
  /** Per-round or per-map detail, for titles that have rounds. */
  readonly rounds: readonly MatchRound[];
  /** Game version / patch the match was played on. */
  readonly patch: string | null;
}

export interface MatchTeam {
  readonly id: string;
  readonly name: string | null;
  readonly won: boolean | null;
  readonly score: number | null;
  readonly roundsWon: number | null;
}

export interface MatchParticipant {
  readonly playerId: string;
  readonly displayName: string | null;
  readonly teamId: string | null;
  /** Champion, agent, hero, legend, operator, car - whatever the title calls it. */
  readonly character: string | null;
  readonly stats: MatchParticipantStats;
  readonly raw: unknown;
}

export interface MatchParticipantStats {
  readonly kills: number | null;
  readonly deaths: number | null;
  readonly assists: number | null;
  readonly score: number | null;
  readonly damageDealt: number | null;
  readonly damageTaken: number | null;
  readonly healing: number | null;
  readonly placement: number | null;
  /** Title-specific numbers that do not fit above: CS, MVPs, goals, saves. */
  readonly extra: Readonly<Record<string, number | string | null>>;
}

export interface MatchRound {
  readonly index: number;
  readonly winningTeamId: string | null;
  readonly durationSeconds: number | null;
  readonly raw: unknown;
}

/** Options accepted by every `getMatchHistory()`. */
export interface MatchHistoryOptions {
  /** How many matches to return. Clamped to what the upstream allows. */
  readonly limit?: number;
  /** Skip this many, for the APIs that page. */
  readonly offset?: number;
  /** Only matches at or after this epoch-milliseconds timestamp. */
  readonly since?: number;
  /** Only matches at or before this epoch-milliseconds timestamp. */
  readonly until?: number;
  /** Restrict to one queue / playlist, in the title's own vocabulary. */
  readonly mode?: string;
  /** Fetch full detail per match instead of the summary the list endpoint gives. */
  readonly hydrate?: boolean;
}

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  readonly position: number;
  readonly playerId: string | null;
  readonly displayName: string | null;
  readonly rating: number | null;
  readonly tier: string | null;
  readonly wins: number | null;
  readonly losses: number | null;
  readonly country: string | null;
  readonly raw: unknown;
}

export interface LeaderboardOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly region?: string;
  readonly platform?: Platform;
  /** Queue / playlist, where the title has more than one ladder. */
  readonly queue?: string;
  /** Season / act, where the API lets you pick a past one. */
  readonly season?: string;
}

// ---------------------------------------------------------------------------
// The esports layer
// ---------------------------------------------------------------------------

/** State of a professional fixture. */
export type EsportsMatchStatus =
  | "scheduled"
  | "live"
  | "finished"
  | "postponed"
  | "cancelled"
  | "unknown";

/** A professional fixture: two opponents, a time, and usually a tournament. */
export interface EsportsMatch {
  readonly id: string;
  readonly titleId: string;
  readonly name: string | null;
  readonly status: EsportsMatchStatus;
  readonly scheduledAt: number | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** Best-of, where the format is known. */
  readonly bestOf: number | null;
  readonly opponents: readonly EsportsOpponent[];
  readonly winnerId: string | null;
  readonly tournament: EsportsTournamentRef | null;
  /** Stream URLs, where the provider publishes them. */
  readonly streams: readonly EsportsStream[];
  readonly providerId: string;
  readonly raw: unknown;
}

export interface EsportsOpponent {
  readonly id: string;
  readonly name: string;
  readonly acronym: string | null;
  readonly logoUrl: string | null;
  readonly score: number | null;
  /** `team` for team titles, `player` for 1v1 titles like the fighting games. */
  readonly kind: "team" | "player";
}

export interface EsportsStream {
  readonly url: string;
  readonly language: string | null;
  readonly official: boolean;
}

export interface EsportsTournamentRef {
  readonly id: string;
  readonly name: string;
  readonly slug: string | null;
}

/** A professional event: a league split, a major, a weekly online cup. */
export interface EsportsTournament extends EsportsTournamentRef {
  readonly titleId: string;
  readonly tier: string | null;
  readonly beginAt: number | null;
  readonly endAt: number | null;
  /** Prize pool in the smallest unit of `prizePoolCurrency`, to avoid floats. */
  readonly prizePoolMinor: number | null;
  readonly prizePoolCurrency: string | null;
  readonly region: string | null;
  readonly online: boolean | null;
  readonly providerId: string;
  readonly raw: unknown;
}

/** A professional roster. */
export interface EsportsTeam {
  readonly id: string;
  readonly titleId: string;
  readonly name: string;
  readonly acronym: string | null;
  readonly logoUrl: string | null;
  readonly country: string | null;
  readonly players: readonly EsportsPlayer[];
  readonly providerId: string;
  readonly raw: unknown;
}

/** A professional player, as the esports providers see them. */
export interface EsportsPlayer {
  readonly id: string;
  readonly titleId: string;
  readonly nickname: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly country: string | null;
  readonly role: string | null;
  readonly teamId: string | null;
  readonly providerId: string;
  readonly raw: unknown;
}

/** One row of a tournament standing table. */
export interface EsportsStanding {
  readonly position: number;
  readonly teamId: string | null;
  readonly teamName: string | null;
  readonly wins: number | null;
  readonly losses: number | null;
  readonly draws: number | null;
  readonly points: number | null;
  readonly raw: unknown;
}

/** Career prize money, from Esports Earnings. */
export interface PrizeEarnings {
  readonly playerId: string;
  readonly handle: string;
  readonly name: string | null;
  readonly country: string | null;
  /** Total in USD cents. Integer, because money is never a float. */
  readonly totalUsdCents: number;
  readonly byTitle: readonly PrizeEarningsByTitle[];
  readonly raw: unknown;
}

export interface PrizeEarningsByTitle {
  readonly titleId: string | null;
  readonly titleName: string;
  readonly totalUsdCents: number;
  readonly tournaments: number | null;
}

export interface EsportsQueryOptions {
  readonly limit?: number;
  readonly page?: number;
  readonly since?: number;
  readonly until?: number;
  readonly status?: EsportsMatchStatus;
  /** Force one provider instead of the title's configured preference order. */
  readonly provider?: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** What a title client can actually do. Declared per title, enforced at runtime. */
export type Capability =
  | "resolvePlayer"
  | "getPlayer"
  | "getPlayerStats"
  | "getRank"
  | "getMatchHistory"
  | "getMatch"
  | "getLeaderboard"
  | "getEsportsMatches"
  | "getEsportsTournaments"
  | "getEsportsTeams"
  | "getEsportsPlayers"
  | "getStandings"
  | "getEarnings"
  | "getMetadata";

/** Broad genre, used for filtering the registry. */
export type Genre =
  | "fps"
  | "tactical-shooter"
  | "battle-royale"
  | "hero-shooter"
  | "moba"
  | "rts"
  | "card"
  | "fighting"
  | "sports"
  | "racing"
  | "mmo"
  | "rhythm"
  | "mind-sport"
  | "sandbox"
  | "vehicle-combat"
  | "auto-battler"
  | "party"
  // Diablo III. Not an MMO and not an RTS, and calling it either would make the
  // genre filter lie to anybody using it to group titles.
  | "action-rpg";

/** How current a title is on the professional circuit. */
export type TitleStatus = "active" | "legacy" | "emerging";

/** How a provider authenticates. Drives the key checks and the error messages. */
export type AuthKind =
  | "none"
  | "query-key"
  | "header-key"
  | "bearer"
  | "basic"
  | "oauth2-client-credentials"
  | "oauth2-user"
  | "signed-session"
  | "cookie-session";

/** One upstream API. */
export interface ProviderDescriptor {
  readonly id: string;
  readonly label: string;
  /** Who runs it. `first-party` means the game's publisher. */
  readonly kind: "first-party" | "community" | "esports-data" | "tournament-platform";
  readonly baseUrl: string;
  readonly auth: AuthKind;
  /**
   * True when the credential improves the service but is not required.
   *
   * OpenDota, Lichess and trackmania.io all answer without a key and raise the
   * quota with one. Without this flag a diagnostics run would report them as
   * broken for every caller who has not signed up for a key they do not need.
   */
  readonly optionalAuth?: boolean;
  /** Name of the key in {@link ApiKeys}. `null` when the provider needs none. */
  readonly keyName: string | null;
  /** Where to get a key. Printed in the error when one is missing. */
  readonly docsUrl: string;
  /** Sustained requests per second the provider tolerates. */
  readonly rps: number;
  /** Burst the provider tolerates. */
  readonly burst: number;
  /** True when the provider requires a descriptive User-Agent (Liquipedia does). */
  readonly requiresUserAgent: boolean;
  /** Free-form note about terms, quotas or gotchas. Surfaced in the docs. */
  readonly notes: string | null;
}

/** One esports title. */
export interface TitleDescriptor {
  readonly id: string;
  readonly name: string;
  /** Alternative spellings a caller might type. Used by `findTitle()`. */
  readonly aliases: readonly string[];
  readonly genre: Genre;
  readonly publisher: string;
  readonly releaseYear: number;
  readonly status: TitleStatus;
  /**
   * Providers this title can be served from, best first.
   *
   * The order is a preference, not a fallback chain by default - see
   * `fallback` in {@link GameStatsClientOptions}.
   */
  readonly providers: readonly string[];
  /** What the title client supports. Anything absent throws, it never returns empty. */
  readonly capabilities: readonly Capability[];
  /** Identifier kinds `resolvePlayer()` accepts, best first. */
  readonly identifiers: readonly (keyof PlayerQuery)[];
  /** Valid `region` values, when the title is regionalised. */
  readonly regions: readonly string[];
  /** Platforms the title's API distinguishes. */
  readonly platforms: readonly Platform[];
}

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export interface LoggerLike {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface RateLimitConfig {
  /** Sustained requests per second. */
  readonly rps: number;
  /** Burst capacity: the most tokens that can accumulate. */
  readonly burst: number;
}

/** Where cached responses go. `memory` needs nothing; `redis` needs `ioredis`. */
export type CacheDriver = "memory" | "redis" | "none";

export interface RedisCacheConfig {
  readonly host?: string;
  readonly port?: number;
  readonly password?: string;
  readonly db?: number;
  readonly tls?: boolean;
  /** Hand in a connected ioredis client instead of letting us build one. */
  readonly client?: unknown;
}

export interface CacheConfig {
  readonly driver?: CacheDriver;
  /** Prefix on every key, so several apps can share one Redis. */
  readonly keyPrefix?: string;
  /** Default TTL in seconds when a method does not specify one. */
  readonly defaultTtlSeconds?: number;
  /** Per-method TTL override, keyed by `"<titleId>:<method>"`. */
  readonly ttlOverrides?: Readonly<Record<string, number>>;
  /** Entries the in-memory driver keeps before evicting the oldest. */
  readonly maxEntries?: number;
  readonly redis?: RedisCacheConfig;
}

export interface RetryConfig {
  /** Attempts after the first. `0` disables retrying. */
  readonly attempts?: number;
  /** First backoff step in milliseconds; doubles each attempt. */
  readonly baseDelayMs?: number;
  /** Upper bound for a single backoff wait. */
  readonly maxDelayMs?: number;
  /** Status codes worth retrying. Defaults to 429 and the 5xx range. */
  readonly retryOn?: readonly number[];
  /** Respect a `Retry-After` header rather than the computed backoff. */
  readonly respectRetryAfter?: boolean;
}

/**
 * Every credential the package knows about.
 *
 * All of them are optional. A title whose provider needs a key it was not
 * given throws `MissingCredentialError` naming the key and the page it comes
 * from - it does not fail silently or return empty data.
 */
export interface ApiKeys {
  /** Steam Web API key. steamcommunity.com/dev/apikey */
  readonly steam?: string;
  /** Riot Games API key. developer.riotgames.com */
  readonly riot?: string;
  /** Blizzard client id and secret, joined by a colon. develop.battle.net */
  readonly blizzard?: string;
  /** Bungie API key. bungie.net/en/Application */
  readonly bungie?: string;
  /** PUBG developer key. developer.pubg.com */
  readonly pubg?: string;
  /** Supercell tokens. Three separate keys - the games do not share one. */
  readonly clashRoyale?: string;
  readonly clashOfClans?: string;
  readonly brawlStars?: string;
  /** Wargaming application id. developers.wargaming.net */
  readonly wargaming?: string;
  /** Hi-Rez dev id and auth key, joined by a colon. */
  readonly hirez?: string;
  /** FACEIT server-side API key. developers.faceit.com */
  readonly faceit?: string;
  /** Tracker Network key. tracker.gg/developers */
  readonly tracker?: string;
  /** PandaScore token. pandascore.co */
  readonly pandascore?: string;
  /** Abios client id and secret, joined by a colon. */
  readonly abios?: string;
  /** start.gg personal access token. start.gg/admin/profile/developer */
  readonly startgg?: string;
  /** Toornament API key. developer.toornament.com */
  readonly toornament?: string;
  /** Challonge API key. */
  readonly challonge?: string;
  /** Esports Earnings API key. esportsearnings.com/dev */
  readonly esportsEarnings?: string;
  /** STRATZ bearer token. stratz.com/api */
  readonly stratz?: string;
  /** Ballchasing.com token. */
  readonly ballchasing?: string;
  /** Hypixel API key. */
  readonly hypixel?: string;
  /** osu! OAuth client id and secret, joined by a colon. */
  readonly osu?: string;
  /** Halo (HaloDotAPI) key. */
  readonly halo?: string;
  /** fortnite-api.com key. */
  readonly fortnite?: string;
  /** ApexLegendsAPI (mozambiquehe.re) key. */
  readonly apex?: string;
  /** Brawlhalla API key. */
  readonly brawlhalla?: string;
  /** iRacing username and password, joined by a colon. */
  readonly iracing?: string;
  /** trackmania.io key. */
  readonly trackmania?: string;
  /** marvelrivalsapi.com key. */
  readonly marvelRivals?: string;
  /** Lichess personal access token. Optional - most endpoints are open. */
  readonly lichess?: string;
  /** Any provider added through `registerProvider()`. */
  readonly [custom: string]: string | undefined;
}

export interface GameStatsClientOptions {
  readonly apiKeys?: ApiKeys;
  readonly cache?: CacheConfig;
  readonly rateLimit?: Partial<RateLimitConfig>;
  readonly retry?: RetryConfig;
  /** Override the fetch implementation. The seam every test in this package uses. */
  readonly fetch?: typeof fetch;
  readonly logger?: LogLevel | LoggerLike;
  /**
   * Try the next provider in a title's list when the first one fails.
   *
   * Off by default: a silent switch to a community mirror changes which terms
   * of service a caller is operating under, and that should be a decision.
   */
  readonly fallback?: boolean;
  /** Abort a single upstream request after this many milliseconds. */
  readonly timeoutMs?: number;
  /**
   * User-Agent sent upstream. Liquipedia requires a descriptive one with
   * contact details and will block a generic string.
   */
  readonly userAgent?: string;
}

/** Envelope returned by the `fetch*` variants that report cache provenance. */
export interface Fetched<T> {
  readonly data: T;
  readonly provider: string;
  readonly cached: boolean;
  readonly fetchedAt: number;
}
