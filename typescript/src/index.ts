/**
 * @uplytech/game-stats-fetcher
 *
 * One client for every esports title. Players, ranks, matches, leaderboards and
 * the professional circuit behind them - normalised across forty-odd real game
 * APIs and eight esports data providers.
 *
 * ```ts
 * import { GameStatsClient } from "@uplytech/game-stats-fetcher";
 *
 * const client = new GameStatsClient({
 *   apiKeys: { riot: process.env.RIOT_API_KEY, steam: process.env.STEAM_API_KEY },
 * });
 *
 * const ranks = await client.lol.getRank({ name: "Faker#KR1", region: "kr" });
 * const fixtures = await client.title("tekken-8").getEsportsMatches({ status: "scheduled" });
 * ```
 */

export { GameStatsClient, type ProviderDiagnostic } from "./client.js";
export { TitleClient, isPlayerRef } from "./title-client.js";
export { EsportsLayer } from "./esports.js";

// The domain model. Every method in the package returns one of these shapes.
export type {
  ApiKeys,
  CacheConfig,
  CacheDriver,
  Capability,
  EsportsMatch,
  EsportsMatchStatus,
  EsportsOpponent,
  EsportsPlayer,
  EsportsQueryOptions,
  EsportsStanding,
  EsportsStream,
  EsportsTeam,
  EsportsTournament,
  EsportsTournamentRef,
  Fetched,
  GameStatsClientOptions,
  Genre,
  LeaderboardEntry,
  LeaderboardOptions,
  LoggerLike,
  LogLevel,
  MatchDetail,
  MatchHistoryOptions,
  MatchParticipant,
  MatchParticipantStats,
  MatchResult,
  MatchRound,
  MatchSummary,
  MatchTeam,
  ModeStats,
  Platform,
  PlayerProfile,
  PlayerQuery,
  PlayerRef,
  PlayerStats,
  PrizeEarnings,
  PrizeEarningsByTitle,
  ProviderDescriptor,
  RankInfo,
  RateLimitConfig,
  RedisCacheConfig,
  RetryConfig,
  TitleDescriptor,
  TitleStatus,
} from "./types.js";

// The error hierarchy. Catch `GameStatsError` for everything, or narrow.
export {
  AllProvidersFailedError,
  AuthenticationError,
  CacheError,
  GameStatsError,
  HttpError,
  IdentifierError,
  LocalRateLimitError,
  MissingCredentialError,
  NetworkError,
  NotFoundError,
  ParseError,
  PrivateProfileError,
  RateLimitError,
  TimeoutError,
  UnknownProviderError,
  UnknownTitleError,
  UnsupportedCapabilityError,
  ValidationError,
  isRetryableWithFallback,
} from "./errors.js";

// The registries. Useful without a client - for a docs page, a config check or
// a slash-command autocomplete handler.
export {
  findTitle,
  getTitle,
  listTitles,
  registerTitle,
  searchTitles,
  suggestTitles,
  supports,
  titleCount,
  titlesByCapability,
  titlesByGenre,
  titlesByPlatform,
  titlesByProvider,
  type TitleId,
} from "./titles.js";

export {
  ESPORTS_CAPABILITY_PROVIDERS,
  esportsProvidersFor,
  findProvider,
  getProvider,
  listProviders,
  providersByKind,
  rateLimitTable,
  registerProvider,
} from "./providers.js";

// Identifier plumbing. Exported because callers store these and need the same
// conversions this package uses.
export {
  dashUuid,
  encodeSupercellTag,
  expandRiotQuery,
  formatRiotId,
  isSteamId64,
  normaliseSupercellTag,
  parseRiotId,
  pickIdentifier,
  toBattleTagPath,
  toSteamAccountId,
  toSteamId2,
  toSteamId3,
  toSteamId64,
  undashUuid,
  type RiotId,
} from "./identity.js";

// Normalisation helpers, for callers extending the package with their own
// providers and wanting the same conventions.
export {
  asArray,
  bool,
  clamp,
  emptyParticipantStats,
  int,
  kd,
  matchResult,
  modeStats,
  num,
  participantStats,
  permille,
  pick,
  playerStats,
  str,
  sum,
  toMinorUnits,
  ts,
  winRate,
} from "./normalize.js";

// Cache and limiter, for callers who want to share them with their own code.
export {
  MemoryCache,
  NullCache,
  RedisCache,
  createCache,
  resolveTtl,
  type CacheAdapter,
  type RedisLike,
} from "./cache.js";
export { TokenBucketRateLimiter } from "./rate-limiter.js";
export { HttpClient, appendQuery, parseRetryAfter, type RequestSpec } from "./http.js";
export { createRuntime, normaliseLogger, silentLogger, type Runtime } from "./runtime.js";

export {
  DEFAULT_RATE_LIMIT,
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TTL_SECONDS,
  DEFAULT_USER_AGENT,
  MAX_PAGE_SIZE,
  PERMILLE,
  STEAM_APP_IDS,
  TTL,
  VERSION,
} from "./constants.js";

// Provider clients, for the endpoints the canonical model deliberately does not
// model - Dota 2 replay parsing, Ballchasing uploads, the Destiny manifest.
export * as providers from "./providers/index.js";

// Title clients, for callers who construct one directly rather than through the
// root client.
export {
  createTitleClient,
  dedicatedTitleIds,
  hasDedicatedClient,
} from "./games/index.js";

export * from "./games/valve.js";
export * from "./games/riot.js";
export * from "./games/blizzard.js";
export * from "./games/shooters.js";
export * from "./games/rocket-league.js";
export * from "./games/mobile.js";
export * from "./games/hirez.js";
export * from "./games/strategy.js";
export * from "./games/skill.js";
export * from "./games/worlds.js";
export * from "./games/racing.js";

// No default export, deliberately. Mixing a default with named exports makes a
// CommonJS consumer write `require("...").default`, which is a papercut nobody
// expects. Import the named class:
//
//   import { GameStatsClient } from "@uplytech/game-stats-fetcher";
//   const { GameStatsClient } = require("@uplytech/game-stats-fetcher");
