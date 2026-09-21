/**
 * The title registry: every esports title this package can fetch data for.
 *
 * One entry per title, and the entry is the contract. `capabilities` says what
 * the title can actually do, and the client enforces it - a method that is not
 * listed throws {@link UnsupportedCapabilityError} instead of returning an
 * empty array. That is the whole point of the registry: a caller can ask, in
 * code, whether Tekken 8 has solo-queue ranks (it does not) rather than finding
 * out from an empty dashboard three weeks later.
 *
 * ## Why some titles have fewer capabilities than others
 *
 * There are three tiers here, and they are a fact about the industry rather
 * than a gap in this package:
 *
 * 1. **A first-party player API.** Riot, Valve, Blizzard, Supercell, Krafton
 *    and a handful of others publish one. These titles support everything.
 * 2. **A community player API.** No official endpoint, but somebody credible
 *    runs one: OpenDota, OverFast, ApexLegendsAPI, SC2Pulse, W3Champions.
 *    Practically as complete, with a different operator to depend on.
 * 3. **Esports data only.** Bandai Namco publishes no Tekken player API, and
 *    neither does Moonton for Mobile Legends. What exists is the professional
 *    circuit - brackets on start.gg, fixtures on PandaScore, prize money on
 *    Esports Earnings - so those titles carry the esports capabilities and not
 *    the player ones.
 *
 * A title is only in this list if at least one *real, currently reachable* API
 * serves it. Nothing here is aspirational, and no endpoint was invented to make
 * the table look complete.
 */

import type { Capability, Platform, TitleDescriptor } from "./types.js";
import { UnknownTitleError } from "./errors.js";
import { esportsProvidersFor } from "./providers.js";

/** The full player-facing surface, for titles whose API exposes all of it. */
const PLAYER_CAPS = [
  "resolvePlayer",
  "getPlayer",
  "getPlayerStats",
  "getRank",
  "getMatchHistory",
  "getMatch",
  "getLeaderboard",
] as const;

/** Player data without a per-match record - common for the mobile titles. */
const PLAYER_NO_MATCH = [
  "resolvePlayer",
  "getPlayer",
  "getPlayerStats",
  "getRank",
  "getLeaderboard",
] as const;

/** Career numbers with no ladder attached. */
const PLAYER_STATS_ONLY = ["resolvePlayer", "getPlayer", "getPlayerStats"] as const;

/** The professional circuit. Available for every title in the registry. */
const ESPORTS_CAPS = [
  "getEsportsMatches",
  "getEsportsTournaments",
  "getEsportsTeams",
  "getEsportsPlayers",
  "getStandings",
  "getEarnings",
] as const;

/** Riot's platform routing values. Used by four titles, so it lives here once. */
const RIOT_PLATFORMS = [
  "br1",
  "eun1",
  "euw1",
  "jp1",
  "kr",
  "la1",
  "la2",
  "na1",
  "oc1",
  "tr1",
  "ru",
  "ph2",
  "sg2",
  "th2",
  "tw2",
  "vn2",
] as const;

/** Riot's regional clusters, used for account and match routing. */
const RIOT_REGIONS = ["americas", "europe", "asia", "sea"] as const;

const TITLE_LIST = [
  // -------------------------------------------------------------------------
  // Valve
  // -------------------------------------------------------------------------
  {
    id: "cs2",
    name: "Counter-Strike 2",
    aliases: ["cs", "csgo", "cs:go", "counter-strike", "counterstrike", "cs-go"],
    genre: "tactical-shooter",
    publisher: "Valve",
    releaseYear: 2023,
    status: "active",
    // Steam knows the account, FACEIT knows the competitive record. Valve
    // publishes no matchmaking rank at all, so FACEIT level is what a caller
    // actually gets when they ask for a rank.
    providers: ["steam", "faceit", "pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_CAPS, ...ESPORTS_CAPS],
    identifiers: ["steamId", "name"],
    regions: [],
    platforms: ["steam"],
  },
  {
    id: "dota2",
    name: "Dota 2",
    aliases: ["dota", "dota-2"],
    genre: "moba",
    publisher: "Valve",
    releaseYear: 2013,
    status: "active",
    providers: ["opendota", "stratz", "steam", "faceit", "pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_CAPS, ...ESPORTS_CAPS, "getMetadata"],
    identifiers: ["steamId", "accountId", "name"],
    regions: [],
    platforms: ["steam"],
  },
  {
    id: "team-fortress-2",
    name: "Team Fortress 2",
    aliases: ["tf2", "team-fortress"],
    genre: "fps",
    publisher: "Valve",
    releaseYear: 2007,
    status: "legacy",
    providers: ["steam", "logstf", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_STATS_ONLY, "getMatchHistory", "getMatch", ...ESPORTS_CAPS],
    identifiers: ["steamId", "name"],
    regions: [],
    platforms: ["steam"],
  },
  {
    id: "deadlock",
    name: "Deadlock",
    aliases: ["neon-prime", "citadel"],
    genre: "moba",
    publisher: "Valve",
    releaseYear: 2024,
    status: "emerging",
    providers: ["deadlock-api", "liquipedia"],
    capabilities: [...PLAYER_CAPS, "getEsportsMatches", "getEsportsTournaments"],
    identifiers: ["steamId", "accountId"],
    regions: [],
    platforms: ["steam"],
  },

  // -------------------------------------------------------------------------
  // Riot Games
  // -------------------------------------------------------------------------
  {
    id: "league-of-legends",
    name: "League of Legends",
    aliases: ["lol", "league"],
    genre: "moba",
    publisher: "Riot Games",
    releaseYear: 2009,
    status: "active",
    providers: ["riot", "pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_CAPS, ...ESPORTS_CAPS, "getMetadata"],
    identifiers: ["puuid", "gameName", "tagLine", "name"],
    regions: [...RIOT_PLATFORMS],
    platforms: ["riot"],
  },
  {
    id: "teamfight-tactics",
    name: "Teamfight Tactics",
    aliases: ["tft"],
    genre: "auto-battler",
    publisher: "Riot Games",
    releaseYear: 2019,
    status: "active",
    providers: ["riot", "pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_CAPS, ...ESPORTS_CAPS],
    identifiers: ["puuid", "gameName", "tagLine", "name"],
    regions: [...RIOT_PLATFORMS],
    platforms: ["riot"],
  },
  {
    id: "valorant",
    name: "VALORANT",
    aliases: ["val"],
    genre: "tactical-shooter",
    publisher: "Riot Games",
    releaseYear: 2020,
    status: "active",
    // Riot's own VAL endpoints need an approved production key. HenrikDev is
    // listed second because it serves the same data to an unapproved caller.
    providers: ["riot", "henrikdev", "tracker", "faceit", "pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_CAPS, ...ESPORTS_CAPS, "getMetadata"],
    identifiers: ["puuid", "gameName", "tagLine"],
    regions: ["eu", "na", "ap", "kr", "latam", "br"],
    platforms: ["riot"],
  },
  {
    id: "legends-of-runeterra",
    name: "Legends of Runeterra",
    aliases: ["lor", "runeterra"],
    genre: "card",
    publisher: "Riot Games",
    releaseYear: 2020,
    status: "legacy",
    providers: ["riot", "liquipedia", "esports-earnings"],
    capabilities: ["resolvePlayer", "getRank", "getLeaderboard", ...ESPORTS_CAPS],
    identifiers: ["puuid", "gameName", "tagLine"],
    regions: [...RIOT_REGIONS],
    platforms: ["riot"],
  },
  {
    id: "wild-rift",
    name: "League of Legends: Wild Rift",
    aliases: ["wildrift", "lolm", "wr"],
    genre: "moba",
    publisher: "Riot Games",
    releaseYear: 2020,
    status: "active",
    providers: ["pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["android", "ios"],
  },

  // -------------------------------------------------------------------------
  // Blizzard
  // -------------------------------------------------------------------------
  {
    id: "overwatch-2",
    name: "Overwatch 2",
    aliases: ["ow", "ow2", "overwatch"],
    genre: "hero-shooter",
    publisher: "Blizzard Entertainment",
    releaseYear: 2022,
    status: "active",
    providers: ["overfast", "pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_NO_MATCH, ...ESPORTS_CAPS, "getMetadata"],
    identifiers: ["battleTag", "name"],
    regions: ["eu", "us", "asia"],
    platforms: ["battlenet", "xbox", "playstation", "nintendo"],
  },
  {
    id: "starcraft-2",
    name: "StarCraft II",
    aliases: ["sc2", "starcraft-ii"],
    genre: "rts",
    publisher: "Blizzard Entertainment",
    releaseYear: 2010,
    status: "active",
    providers: ["sc2pulse", "blizzard", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_NO_MATCH, "getMatchHistory", ...ESPORTS_CAPS],
    identifiers: ["battleTag", "name", "accountId"],
    regions: ["us", "eu", "kr", "tw"],
    platforms: ["battlenet"],
  },
  {
    id: "starcraft-brood-war",
    name: "StarCraft: Brood War",
    aliases: ["bw", "brood-war", "starcraft-1", "sc-bw"],
    genre: "rts",
    publisher: "Blizzard Entertainment",
    releaseYear: 1998,
    status: "legacy",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["battlenet"],
  },
  {
    id: "warcraft-3",
    name: "Warcraft III",
    aliases: ["wc3", "warcraft-iii", "w3", "reforged"],
    genre: "rts",
    publisher: "Blizzard Entertainment",
    releaseYear: 2002,
    status: "legacy",
    providers: ["w3champions", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_NO_MATCH, "getMatchHistory", ...ESPORTS_CAPS],
    identifiers: ["battleTag", "name"],
    regions: ["eu", "us", "kr"],
    platforms: ["battlenet"],
  },
  {
    id: "hearthstone",
    name: "Hearthstone",
    aliases: ["hs"],
    genre: "card",
    publisher: "Blizzard Entertainment",
    releaseYear: 2014,
    status: "active",
    // Blizzard's Hearthstone API is card and metadata only - there has never
    // been a public player profile endpoint.
    providers: ["blizzard", "liquipedia", "esports-earnings"],
    capabilities: ["getMetadata", ...ESPORTS_CAPS],
    identifiers: [],
    regions: ["us", "eu", "kr"],
    platforms: ["battlenet", "android", "ios"],
  },
  {
    id: "heroes-of-the-storm",
    name: "Heroes of the Storm",
    aliases: ["hots", "heroes"],
    genre: "moba",
    publisher: "Blizzard Entertainment",
    releaseYear: 2015,
    status: "legacy",
    providers: ["heroesprofile", "liquipedia", "esports-earnings"],
    // No ladder: Heroes Profile is replay-derived and publishes none.
    capabilities: ["resolvePlayer", "getPlayer", "getPlayerStats", "getRank", "getMatchHistory", ...ESPORTS_CAPS],
    identifiers: ["battleTag", "name"],
    regions: ["us", "eu", "kr"],
    platforms: ["battlenet"],
  },
  {
    id: "world-of-warcraft",
    name: "World of Warcraft",
    aliases: ["wow"],
    genre: "mmo",
    publisher: "Blizzard Entertainment",
    releaseYear: 2004,
    status: "active",
    providers: ["blizzard", "raiderio", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_NO_MATCH, ...ESPORTS_CAPS],
    identifiers: ["name", "region"],
    regions: ["us", "eu", "kr", "tw", "cn"],
    platforms: ["battlenet"],
  },

  // -------------------------------------------------------------------------
  // Bungie / Microsoft / Sony / Nintendo
  // -------------------------------------------------------------------------
  {
    id: "destiny-2",
    name: "Destiny 2",
    aliases: ["destiny", "d2"],
    genre: "fps",
    publisher: "Bungie",
    releaseYear: 2017,
    status: "active",
    providers: ["bungie", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_CAPS, "getEsportsTournaments", "getEarnings"],
    identifiers: ["membershipId", "name", "platform"],
    regions: [],
    platforms: ["steam", "xbox", "playstation", "epic"],
  },
  {
    id: "halo-infinite",
    name: "Halo Infinite",
    aliases: ["halo", "hi"],
    genre: "fps",
    publisher: "Xbox Game Studios",
    releaseYear: 2021,
    status: "active",
    providers: ["halodotapi", "tracker", "liquipedia", "esports-earnings"],
    // No ladder: 343 publishes none, and neither does HaloDotAPI.
    capabilities: ["resolvePlayer", "getPlayer", "getPlayerStats", "getRank", "getMatchHistory", "getMatch", ...ESPORTS_CAPS],
    identifiers: ["name"],
    regions: [],
    platforms: ["xbox", "steam"],
  },
  {
    id: "splatoon-3",
    name: "Splatoon 3",
    aliases: ["splatoon", "splat3"],
    genre: "tactical-shooter",
    publisher: "Nintendo",
    releaseYear: 2022,
    status: "active",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["nintendo"],
  },
  {
    id: "pokemon-unite",
    name: "Pokémon UNITE",
    aliases: ["unite", "pokemon-unite"],
    genre: "moba",
    publisher: "The Pokémon Company",
    releaseYear: 2021,
    status: "active",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["nintendo", "android", "ios"],
  },
  {
    id: "gran-turismo-7",
    name: "Gran Turismo 7",
    aliases: ["gt7", "gran-turismo"],
    genre: "racing",
    publisher: "Sony Interactive Entertainment",
    releaseYear: 2022,
    status: "active",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["playstation"],
  },

  // -------------------------------------------------------------------------
  // EA / Respawn / Activision / Ubisoft
  // -------------------------------------------------------------------------
  {
    id: "apex-legends",
    name: "Apex Legends",
    aliases: ["apex"],
    genre: "battle-royale",
    publisher: "Electronic Arts",
    releaseYear: 2019,
    status: "active",
    providers: ["apex-legends-api", "tracker", "faceit", "pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_NO_MATCH, ...ESPORTS_CAPS],
    identifiers: ["name", "platform", "accountId"],
    regions: [],
    platforms: ["origin", "steam", "xbox", "playstation", "nintendo"],
  },
  {
    id: "call-of-duty",
    name: "Call of Duty",
    aliases: ["cod", "warzone", "modern-warfare", "black-ops", "cdl"],
    genre: "fps",
    publisher: "Activision",
    releaseYear: 2003,
    status: "active",
    providers: ["tracker", "pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_STATS_ONLY, ...ESPORTS_CAPS],
    identifiers: ["name", "platform"],
    regions: [],
    platforms: ["battlenet", "steam", "xbox", "playstation"],
  },
  {
    id: "battlefield",
    name: "Battlefield",
    aliases: ["bf", "bf2042", "battlefield-2042"],
    genre: "fps",
    publisher: "Electronic Arts",
    releaseYear: 2002,
    status: "legacy",
    providers: ["tracker", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_STATS_ONLY, ...ESPORTS_CAPS],
    identifiers: ["name", "platform"],
    regions: [],
    platforms: ["origin", "steam", "xbox", "playstation"],
  },
  {
    id: "ea-fc",
    name: "EA Sports FC",
    aliases: ["fifa", "fc25", "fc24", "ea-sports-fc", "fifa-online"],
    genre: "sports",
    publisher: "Electronic Arts",
    releaseYear: 1993,
    status: "active",
    providers: ["pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["origin", "steam", "xbox", "playstation"],
  },
  {
    id: "madden-nfl",
    name: "Madden NFL",
    aliases: ["madden"],
    genre: "sports",
    publisher: "Electronic Arts",
    releaseYear: 1988,
    status: "active",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["xbox", "playstation"],
  },
  {
    id: "rainbow-six-siege",
    name: "Tom Clancy's Rainbow Six Siege",
    aliases: ["r6", "r6s", "siege", "rainbow-six"],
    genre: "tactical-shooter",
    publisher: "Ubisoft",
    releaseYear: 2015,
    status: "active",
    providers: ["tracker", "pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_NO_MATCH, ...ESPORTS_CAPS],
    identifiers: ["name", "ubisoftId", "platform"],
    regions: ["emea", "ncsa", "apac"],
    platforms: ["ubisoft", "steam", "xbox", "playstation"],
  },

  // -------------------------------------------------------------------------
  // Epic / Krafton / NetEase / Embark
  // -------------------------------------------------------------------------
  {
    id: "fortnite",
    name: "Fortnite",
    aliases: ["fn", "fortnite-br"],
    genre: "battle-royale",
    publisher: "Epic Games",
    releaseYear: 2017,
    status: "active",
    providers: ["fortnite-api", "tracker", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_NO_MATCH, ...ESPORTS_CAPS, "getMetadata"],
    identifiers: ["name", "epicId", "platform"],
    regions: ["eu", "na-east", "na-west", "na-central", "oce", "asia", "brazil", "me"],
    platforms: ["epic", "steam", "xbox", "playstation", "nintendo", "android", "ios"],
  },
  {
    id: "fall-guys",
    name: "Fall Guys",
    aliases: ["fallguys"],
    genre: "party",
    publisher: "Epic Games",
    releaseYear: 2020,
    status: "active",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["epic", "steam", "xbox", "playstation", "nintendo"],
  },
  {
    id: "rocket-league",
    name: "Rocket League",
    aliases: ["rl", "rlcs"],
    genre: "sports",
    publisher: "Psyonix",
    releaseYear: 2015,
    status: "active",
    // Psyonix publishes nothing. Ballchasing knows uploaded replays, Octane
    // knows the professional circuit, Tracker knows the ladder.
    providers: ["ballchasing", "octane", "tracker", "pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_CAPS, ...ESPORTS_CAPS],
    identifiers: ["steamId", "epicId", "name", "platform"],
    regions: [],
    platforms: ["steam", "epic", "xbox", "playstation", "nintendo"],
  },
  {
    id: "pubg",
    name: "PUBG: Battlegrounds",
    aliases: ["pubg-pc", "playerunknowns-battlegrounds", "battlegrounds"],
    genre: "battle-royale",
    publisher: "Krafton",
    releaseYear: 2017,
    status: "active",
    providers: ["pubg", "pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_CAPS, ...ESPORTS_CAPS],
    identifiers: ["name", "accountId", "platform"],
    regions: ["steam", "kakao", "psn", "xbox", "stadia", "console"],
    platforms: ["steam", "kakao", "xbox", "playstation"],
  },
  {
    id: "pubg-mobile",
    name: "PUBG Mobile",
    aliases: ["pubgm", "bgmi"],
    genre: "battle-royale",
    publisher: "Krafton",
    releaseYear: 2018,
    status: "active",
    providers: ["pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["android", "ios"],
  },
  {
    id: "naraka-bladepoint",
    name: "Naraka: Bladepoint",
    aliases: ["naraka"],
    genre: "battle-royale",
    publisher: "NetEase",
    releaseYear: 2021,
    status: "active",
    providers: ["steam", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_STATS_ONLY, ...ESPORTS_CAPS],
    identifiers: ["steamId"],
    regions: [],
    platforms: ["steam", "xbox", "playstation"],
  },
  {
    id: "marvel-rivals",
    name: "Marvel Rivals",
    aliases: ["rivals", "mr"],
    genre: "hero-shooter",
    publisher: "NetEase",
    releaseYear: 2024,
    status: "emerging",
    providers: ["marvel-rivals", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_CAPS, "getEsportsMatches", "getEsportsTournaments", "getEarnings"],
    identifiers: ["name", "accountId"],
    regions: [],
    platforms: ["steam", "xbox", "playstation"],
  },
  {
    id: "the-finals",
    name: "The Finals",
    aliases: ["finals", "thefinals"],
    genre: "fps",
    publisher: "Nexon",
    releaseYear: 2023,
    status: "emerging",
    providers: ["the-finals-api", "liquipedia"],
    capabilities: ["resolvePlayer", "getPlayer", "getRank", "getLeaderboard", "getEsportsTournaments"],
    identifiers: ["name", "steamId", "epicId"],
    regions: [],
    platforms: ["steam", "xbox", "playstation"],
  },
  {
    id: "splitgate",
    name: "Splitgate",
    aliases: ["splitgate-2"],
    genre: "fps",
    publisher: "1047 Games",
    releaseYear: 2019,
    status: "emerging",
    providers: ["tracker", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_STATS_ONLY, ...ESPORTS_CAPS],
    identifiers: ["name", "platform"],
    regions: [],
    platforms: ["steam", "xbox", "playstation"],
  },
  {
    id: "escape-from-tarkov",
    name: "Escape from Tarkov: Arena",
    aliases: ["tarkov", "eft", "tarkov-arena"],
    genre: "fps",
    publisher: "Battlestate Games",
    releaseYear: 2023,
    status: "emerging",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["web"],
  },
  {
    id: "quake-champions",
    name: "Quake Champions",
    aliases: ["quake", "qc"],
    genre: "fps",
    publisher: "Bethesda Softworks",
    releaseYear: 2017,
    status: "legacy",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["steam"],
  },
  {
    id: "crossfire",
    name: "CrossFire",
    aliases: ["cf", "crossfire-cfs"],
    genre: "fps",
    publisher: "Smilegate",
    releaseYear: 2007,
    status: "active",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["web"],
  },
  {
    id: "point-blank",
    name: "Point Blank",
    aliases: ["pb"],
    genre: "fps",
    publisher: "Zepetto",
    releaseYear: 2008,
    status: "legacy",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["web"],
  },
  {
    id: "rust",
    name: "Rust",
    aliases: [],
    genre: "sandbox",
    publisher: "Facepunch Studios",
    releaseYear: 2018,
    status: "active",
    providers: ["steam", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_STATS_ONLY, "getEsportsTournaments", "getEarnings"],
    identifiers: ["steamId", "name"],
    regions: [],
    platforms: ["steam"],
  },
  {
    id: "dead-by-daylight",
    name: "Dead by Daylight",
    aliases: ["dbd"],
    genre: "party",
    publisher: "Behaviour Interactive",
    releaseYear: 2016,
    status: "active",
    providers: ["steam", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_STATS_ONLY, "getEsportsTournaments", "getEarnings"],
    identifiers: ["steamId", "name"],
    regions: [],
    platforms: ["steam", "xbox", "playstation", "nintendo"],
  },

  // -------------------------------------------------------------------------
  // Hi-Rez / Supercell / Tencent / Garena / Moonton
  // -------------------------------------------------------------------------
  {
    id: "smite",
    name: "SMITE",
    aliases: ["smite-2"],
    genre: "moba",
    publisher: "Hi-Rez Studios",
    releaseYear: 2014,
    status: "active",
    providers: ["hirez", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_CAPS, ...ESPORTS_CAPS, "getMetadata"],
    identifiers: ["name", "accountId", "platform"],
    regions: [],
    platforms: ["steam", "xbox", "playstation", "nintendo"],
  },
  {
    id: "paladins",
    name: "Paladins",
    aliases: [],
    genre: "hero-shooter",
    publisher: "Hi-Rez Studios",
    releaseYear: 2016,
    status: "legacy",
    providers: ["hirez", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_CAPS, ...ESPORTS_CAPS, "getMetadata"],
    identifiers: ["name", "accountId", "platform"],
    regions: [],
    platforms: ["steam", "xbox", "playstation", "nintendo"],
  },
  {
    id: "clash-royale",
    name: "Clash Royale",
    aliases: ["cr"],
    genre: "card",
    publisher: "Supercell",
    releaseYear: 2016,
    status: "active",
    providers: ["supercell-clash-royale", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_CAPS, ...ESPORTS_CAPS, "getMetadata"],
    identifiers: ["playerTag"],
    regions: [],
    platforms: ["android", "ios"],
  },
  {
    id: "clash-of-clans",
    name: "Clash of Clans",
    aliases: ["coc"],
    genre: "rts",
    publisher: "Supercell",
    releaseYear: 2012,
    status: "active",
    providers: ["supercell-clash-of-clans", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_NO_MATCH, ...ESPORTS_CAPS],
    identifiers: ["playerTag"],
    regions: [],
    platforms: ["android", "ios"],
  },
  {
    id: "brawl-stars",
    name: "Brawl Stars",
    aliases: ["bs", "brawlstars"],
    genre: "hero-shooter",
    publisher: "Supercell",
    releaseYear: 2018,
    status: "active",
    providers: ["supercell-brawl-stars", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_CAPS, ...ESPORTS_CAPS, "getMetadata"],
    identifiers: ["playerTag"],
    regions: [],
    platforms: ["android", "ios"],
  },
  {
    id: "mobile-legends",
    name: "Mobile Legends: Bang Bang",
    aliases: ["mlbb", "ml", "mobile-legends-bang-bang"],
    genre: "moba",
    publisher: "Moonton",
    releaseYear: 2016,
    status: "active",
    providers: ["pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["android", "ios"],
  },
  {
    id: "honor-of-kings",
    name: "Honor of Kings",
    aliases: ["hok", "kings-of-glory", "wangzhe"],
    genre: "moba",
    publisher: "Tencent",
    releaseYear: 2015,
    status: "active",
    providers: ["pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["android", "ios"],
  },
  {
    id: "arena-of-valor",
    name: "Arena of Valor",
    aliases: ["aov"],
    genre: "moba",
    publisher: "Tencent",
    releaseYear: 2016,
    status: "legacy",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["android", "ios", "nintendo"],
  },
  {
    id: "free-fire",
    name: "Garena Free Fire",
    aliases: ["ff", "freefire"],
    genre: "battle-royale",
    publisher: "Garena",
    releaseYear: 2017,
    status: "active",
    providers: ["pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["android", "ios"],
  },

  // -------------------------------------------------------------------------
  // Fighting games - the circuit lives on start.gg
  // -------------------------------------------------------------------------
  {
    id: "street-fighter-6",
    name: "Street Fighter 6",
    aliases: ["sf6", "street-fighter"],
    genre: "fighting",
    publisher: "Capcom",
    releaseYear: 2023,
    status: "active",
    providers: ["startgg", "pandascore", "liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["steam", "xbox", "playstation"],
  },
  {
    id: "tekken-8",
    name: "Tekken 8",
    aliases: ["tekken", "t8"],
    genre: "fighting",
    publisher: "Bandai Namco",
    releaseYear: 2024,
    status: "active",
    providers: ["startgg", "liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["steam", "xbox", "playstation"],
  },
  {
    id: "super-smash-bros-ultimate",
    name: "Super Smash Bros. Ultimate",
    aliases: ["ssbu", "smash-ultimate", "ultimate"],
    genre: "fighting",
    publisher: "Nintendo",
    releaseYear: 2018,
    status: "active",
    providers: ["startgg", "liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["nintendo"],
  },
  {
    id: "super-smash-bros-melee",
    name: "Super Smash Bros. Melee",
    aliases: ["melee", "ssbm"],
    genre: "fighting",
    publisher: "Nintendo",
    releaseYear: 2001,
    status: "active",
    providers: ["startgg", "liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["nintendo"],
  },
  {
    id: "mortal-kombat-1",
    name: "Mortal Kombat 1",
    aliases: ["mk1", "mortal-kombat"],
    genre: "fighting",
    publisher: "Warner Bros. Games",
    releaseYear: 2023,
    status: "active",
    providers: ["startgg", "liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["steam", "xbox", "playstation", "nintendo"],
  },
  {
    id: "guilty-gear-strive",
    name: "Guilty Gear -Strive-",
    aliases: ["ggst", "strive", "guilty-gear"],
    genre: "fighting",
    publisher: "Arc System Works",
    releaseYear: 2021,
    status: "active",
    providers: ["startgg", "liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["steam", "xbox", "playstation"],
  },
  {
    id: "dragon-ball-fighterz",
    name: "Dragon Ball FighterZ",
    aliases: ["dbfz"],
    genre: "fighting",
    publisher: "Bandai Namco",
    releaseYear: 2018,
    status: "active",
    providers: ["startgg", "liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["steam", "xbox", "playstation", "nintendo"],
  },
  {
    id: "king-of-fighters-15",
    name: "The King of Fighters XV",
    aliases: ["kof15", "kofxv", "kof"],
    genre: "fighting",
    publisher: "SNK",
    releaseYear: 2022,
    status: "active",
    providers: ["startgg", "liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["steam", "xbox", "playstation"],
  },
  {
    id: "granblue-fantasy-versus-rising",
    name: "Granblue Fantasy Versus: Rising",
    aliases: ["gbvsr", "granblue"],
    genre: "fighting",
    publisher: "Cygames",
    releaseYear: 2023,
    status: "active",
    providers: ["startgg", "liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["steam", "playstation"],
  },
  {
    id: "brawlhalla",
    name: "Brawlhalla",
    aliases: [],
    genre: "fighting",
    publisher: "Ubisoft",
    releaseYear: 2017,
    status: "active",
    providers: ["brawlhalla", "startgg", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_NO_MATCH, ...ESPORTS_CAPS, "getMetadata"],
    identifiers: ["steamId", "accountId", "name"],
    regions: [],
    platforms: ["steam", "xbox", "playstation", "nintendo"],
  },

  // -------------------------------------------------------------------------
  // Racing and sim
  // -------------------------------------------------------------------------
  {
    id: "iracing",
    name: "iRacing",
    aliases: ["ir"],
    genre: "racing",
    publisher: "iRacing.com Motorsport Simulations",
    releaseYear: 2008,
    status: "active",
    providers: ["iracing", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_CAPS, "getEsportsTournaments", "getEarnings"],
    identifiers: ["accountId", "name"],
    regions: [],
    platforms: ["web"],
  },
  {
    id: "trackmania",
    name: "Trackmania",
    aliases: ["tm", "trackmania-2020"],
    genre: "racing",
    publisher: "Ubisoft Nadeo",
    releaseYear: 2020,
    status: "active",
    providers: ["trackmania-io", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_NO_MATCH, ...ESPORTS_CAPS],
    identifiers: ["accountId", "name"],
    regions: [],
    platforms: ["ubisoft", "epic", "steam"],
  },
  {
    id: "f1",
    name: "F1 (EA Sports)",
    aliases: ["f1-esports", "formula-1", "f1-24", "f1-25"],
    genre: "racing",
    publisher: "Electronic Arts",
    releaseYear: 2010,
    status: "active",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["steam", "xbox", "playstation"],
  },
  {
    id: "assetto-corsa-competizione",
    name: "Assetto Corsa Competizione",
    aliases: ["acc", "assetto-corsa"],
    genre: "racing",
    publisher: "505 Games",
    releaseYear: 2018,
    status: "active",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["steam", "xbox", "playstation"],
  },
  {
    id: "nba-2k",
    name: "NBA 2K",
    aliases: ["2k", "nba2k", "nba-2k-league"],
    genre: "sports",
    publisher: "2K Games",
    releaseYear: 1999,
    status: "active",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["steam", "xbox", "playstation"],
  },
  {
    id: "efootball",
    name: "eFootball",
    aliases: ["pes", "pro-evolution-soccer", "winning-eleven"],
    genre: "sports",
    publisher: "Konami",
    releaseYear: 1995,
    status: "active",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["steam", "xbox", "playstation", "android", "ios"],
  },

  // -------------------------------------------------------------------------
  // Strategy, cards, MMO
  // -------------------------------------------------------------------------
  {
    id: "age-of-empires-2",
    name: "Age of Empires II: Definitive Edition",
    aliases: ["aoe2", "aoe2de", "age-of-empires-ii"],
    genre: "rts",
    publisher: "Xbox Game Studios",
    releaseYear: 1999,
    status: "active",
    providers: ["relic", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_NO_MATCH, "getMatchHistory", ...ESPORTS_CAPS],
    identifiers: ["steamId", "name", "accountId"],
    regions: [],
    platforms: ["steam", "xbox"],
  },
  {
    id: "age-of-empires-4",
    name: "Age of Empires IV",
    aliases: ["aoe4", "age-of-empires-iv"],
    genre: "rts",
    publisher: "Xbox Game Studios",
    releaseYear: 2021,
    status: "active",
    providers: ["aoe4world", "relic", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_CAPS, ...ESPORTS_CAPS],
    identifiers: ["steamId", "name", "accountId"],
    regions: [],
    platforms: ["steam", "xbox"],
  },
  {
    id: "company-of-heroes-3",
    name: "Company of Heroes 3",
    aliases: ["coh3", "company-of-heroes"],
    genre: "rts",
    publisher: "Sega",
    releaseYear: 2023,
    status: "active",
    providers: ["relic", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_NO_MATCH, "getMatchHistory", "getEsportsTournaments", "getEarnings"],
    identifiers: ["steamId", "name"],
    regions: [],
    platforms: ["steam"],
  },
  {
    id: "magic-the-gathering-arena",
    name: "Magic: The Gathering Arena",
    aliases: ["mtga", "mtg-arena", "magic"],
    genre: "card",
    publisher: "Wizards of the Coast",
    releaseYear: 2018,
    status: "active",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["web"],
  },
  {
    id: "gwent",
    name: "Gwent: The Witcher Card Game",
    aliases: ["gwent-witcher"],
    genre: "card",
    publisher: "CD Projekt",
    releaseYear: 2018,
    status: "legacy",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["web", "android", "ios"],
  },
  {
    id: "shadowverse",
    name: "Shadowverse",
    aliases: ["sv", "shadowverse-worlds-beyond"],
    genre: "card",
    publisher: "Cygames",
    releaseYear: 2016,
    status: "active",
    providers: ["liquipedia", "esports-earnings"],
    capabilities: [...ESPORTS_CAPS],
    identifiers: [],
    regions: [],
    platforms: ["steam", "android", "ios"],
  },
  {
    id: "world-of-tanks",
    name: "World of Tanks",
    aliases: ["wot"],
    genre: "vehicle-combat",
    publisher: "Wargaming",
    releaseYear: 2010,
    status: "active",
    providers: ["wargaming", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_NO_MATCH, ...ESPORTS_CAPS, "getMetadata"],
    identifiers: ["name", "accountId"],
    regions: ["eu", "na", "asia"],
    platforms: ["web"],
  },
  {
    id: "world-of-warships",
    name: "World of Warships",
    aliases: ["wows"],
    genre: "vehicle-combat",
    publisher: "Wargaming",
    releaseYear: 2015,
    status: "active",
    providers: ["wargaming", "liquipedia"],
    capabilities: [...PLAYER_NO_MATCH, "getEsportsTournaments", "getMetadata"],
    identifiers: ["name", "accountId"],
    regions: ["eu", "na", "asia"],
    platforms: ["web"],
  },
  {
    id: "war-thunder",
    name: "War Thunder",
    aliases: ["wt"],
    genre: "vehicle-combat",
    publisher: "Gaijin Entertainment",
    releaseYear: 2012,
    status: "active",
    providers: ["steam", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_STATS_ONLY, "getEsportsTournaments", "getEarnings"],
    identifiers: ["steamId"],
    regions: [],
    platforms: ["steam", "xbox", "playstation"],
  },
  {
    id: "guild-wars-2",
    name: "Guild Wars 2",
    aliases: ["gw2"],
    genre: "mmo",
    publisher: "ArenaNet",
    releaseYear: 2012,
    status: "active",
    providers: ["guild-wars-2", "liquipedia"],
    capabilities: [...PLAYER_NO_MATCH, "getMatchHistory", "getEsportsTournaments"],
    identifiers: ["accountId", "name"],
    regions: [],
    platforms: ["web", "steam"],
  },
  {
    id: "path-of-exile",
    name: "Path of Exile",
    aliases: ["poe", "path-of-exile-2"],
    genre: "mmo",
    publisher: "Grinding Gear Games",
    releaseYear: 2013,
    status: "active",
    providers: ["path-of-exile", "liquipedia", "esports-earnings"],
    capabilities: ["getLeaderboard", "getEsportsTournaments", "getEarnings", "getMetadata"],
    identifiers: ["name"],
    regions: [],
    platforms: ["steam", "xbox", "playstation", "epic"],
  },
  {
    id: "albion-online",
    name: "Albion Online",
    aliases: ["albion", "ao"],
    genre: "mmo",
    publisher: "Sandbox Interactive",
    releaseYear: 2017,
    status: "active",
    providers: ["albion", "liquipedia"],
    capabilities: [...PLAYER_NO_MATCH, "getMatchHistory", "getEsportsTournaments"],
    identifiers: ["name", "accountId"],
    regions: ["europe", "americas", "asia"],
    platforms: ["web", "steam", "android", "ios"],
  },
  // -------------------------------------------------------------------------
  // Worlds where progress is the rank
  //
  // No matchmaking, and for three of the four no esports circuit either. They
  // are here because the package's rule is "if it has a real API, it belongs
  // here" — and a RuneScape player asking for their Slayer rank is asking the
  // same question as a Valorant player asking for theirs.
  //
  // Their esports capabilities are deliberately thin: the registry computes
  // them from what the esports providers actually cover, and Liquipedia does
  // not run a RuneScape portal. Declaring the full set and letting it be
  // narrowed would leave the reader guessing which half was real.
  // -------------------------------------------------------------------------
  {
    id: "old-school-runescape",
    name: "Old School RuneScape",
    aliases: ["osrs", "old-school", "runescape-oldschool", "2007scape"],
    genre: "mmo",
    publisher: "Jagex",
    releaseYear: 2013,
    status: "active",
    providers: ["jagex"],
    // No match history: the hiscores are a ladder, not a log. No leaderboard
    // either — the ranked pages are HTML, and this package does not scrape.
    capabilities: ["resolvePlayer", "getPlayer", "getPlayerStats", "getRank"],
    identifiers: ["name"],
    regions: [],
    platforms: ["web", "android", "ios"],
  },
  {
    id: "runescape",
    name: "RuneScape",
    aliases: ["rs3", "runescape-3"],
    genre: "mmo",
    publisher: "Jagex",
    releaseYear: 2001,
    status: "active",
    providers: ["jagex"],
    capabilities: ["resolvePlayer", "getPlayer", "getPlayerStats", "getRank"],
    identifiers: ["name"],
    regions: [],
    platforms: ["web", "android", "ios"],
  },
  {
    id: "eve-online",
    name: "EVE Online",
    aliases: ["eve"],
    genre: "mmo",
    publisher: "CCP Games",
    releaseYear: 2003,
    status: "active",
    providers: ["eve-esi"],
    // Security status is the rank. There is no ladder to page through, so no
    // `getLeaderboard`; `getMetadata` is the server status endpoint.
    capabilities: ["resolvePlayer", "getPlayer", "getPlayerStats", "getRank", "getMetadata"],
    identifiers: ["name", "accountId"],
    regions: [],
    platforms: ["web"],
  },
  {
    id: "diablo-3",
    name: "Diablo III",
    aliases: ["d3", "diablo-iii"],
    genre: "action-rpg",
    publisher: "Blizzard Entertainment",
    releaseYear: 2012,
    status: "active",
    providers: ["blizzard"],
    // Greater Rift records are a real seasonal ladder, so this one does have a
    // leaderboard. Diablo IV has no player API at all and is therefore absent.
    capabilities: [
      "resolvePlayer",
      "getPlayer",
      "getPlayerStats",
      "getRank",
      "getLeaderboard",
      "getMetadata",
    ],
    identifiers: ["battleTag"],
    regions: ["us", "eu", "kr", "tw"],
    platforms: ["battlenet"],
  },

  // -------------------------------------------------------------------------
  // Skill, rhythm and mind sports
  // -------------------------------------------------------------------------
  {
    id: "osu",
    name: "osu!",
    aliases: ["osu!", "osu-standard", "osu-mania"],
    genre: "rhythm",
    publisher: "ppy",
    releaseYear: 2007,
    status: "active",
    providers: ["osu", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_CAPS, ...ESPORTS_CAPS],
    identifiers: ["name", "accountId"],
    regions: [],
    platforms: ["web"],
  },
  {
    id: "beat-saber",
    name: "Beat Saber",
    aliases: ["bs-vr", "beatsaber"],
    genre: "rhythm",
    publisher: "Beat Games",
    releaseYear: 2018,
    status: "active",
    providers: ["scoresaber", "beatleader", "liquipedia"],
    capabilities: [...PLAYER_NO_MATCH, "getEsportsTournaments"],
    identifiers: ["steamId", "accountId", "name"],
    regions: [],
    platforms: ["steam", "web"],
  },
  {
    id: "chess",
    name: "Chess",
    aliases: ["chess-com", "lichess", "schach"],
    genre: "mind-sport",
    publisher: "Chess.com / Lichess",
    releaseYear: 1475,
    status: "active",
    providers: ["chess-com", "lichess", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_CAPS, ...ESPORTS_CAPS],
    identifiers: ["name"],
    regions: [],
    platforms: ["web"],
  },
  {
    id: "minecraft",
    name: "Minecraft",
    aliases: ["mc", "hypixel", "mcc"],
    genre: "sandbox",
    publisher: "Mojang Studios",
    releaseYear: 2011,
    status: "active",
    providers: ["hypixel", "mojang", "liquipedia", "esports-earnings"],
    capabilities: [...PLAYER_NO_MATCH, ...ESPORTS_CAPS],
    identifiers: ["name", "accountId"],
    regions: [],
    platforms: ["web"],
  },
] as const satisfies readonly TitleDescriptor[];

/**
 * Every registered title id, as a union.
 *
 * This is what makes `client.title("valorant")` autocomplete and
 * `client.title("valorent")` a compile error rather than a runtime one.
 */
export type TitleId = (typeof TITLE_LIST)[number]["id"];

/**
 * Intersect a title's declared esports capabilities with what its providers
 * can actually serve.
 *
 * The entries above declare the esports surface generously, because "this is an
 * esports title" is the interesting fact about it. What a caller needs, though,
 * is what will actually answer - and that depends on which providers cover the
 * title. Tekken 8 is served by start.gg, which has brackets and placements but
 * no rosters, so `getEsportsTeams` is removed here rather than being declared
 * and then throwing at the call site.
 *
 * Doing this at load rather than by hand is what keeps the registry a contract:
 * adding a provider to a title widens its capabilities automatically, and
 * nobody has to remember to widen them separately.
 */
function reconcile(title: TitleDescriptor): TitleDescriptor {
  const capabilities = title.capabilities.filter((capability) => {
    const able = esportsProvidersFor(title.providers, capability);
    // `null` means the capability is not an esports one, so it is left alone.
    return able === null || able.length > 0;
  });
  return capabilities.length === title.capabilities.length
    ? title
    : { ...title, capabilities };
}

/** Built once. Mutable only through `registerTitle`. */
const TITLES = new Map<string, TitleDescriptor>(
  TITLE_LIST.map((title) => [title.id, reconcile(title as TitleDescriptor)]),
);

/** Alias to canonical id, so `findTitle("csgo")` lands on `cs2`. */
const ALIASES = new Map<string, string>();
for (const title of TITLE_LIST) {
  ALIASES.set(normalise(title.id), title.id);
  ALIASES.set(normalise(title.name), title.id);
  for (const alias of title.aliases) ALIASES.set(normalise(alias), title.id);
}

/** Every title, in registration order. */
export function listTitles(): readonly TitleDescriptor[] {
  return [...TITLES.values()];
}

/** How many titles the registry holds. */
export function titleCount(): number {
  return TITLES.size;
}

/**
 * Resolve an id, a name or an alias to a descriptor.
 *
 * Case and punctuation insensitive: `"CS:GO"`, `"csgo"` and `"cs go"` all find
 * Counter-Strike 2. Returns `undefined` rather than throwing, for the callers
 * doing a lookup where a miss is a normal answer.
 */
export function findTitle(idOrAlias: string): TitleDescriptor | undefined {
  const canonical = ALIASES.get(normalise(idOrAlias));
  return canonical ? TITLES.get(canonical) : undefined;
}

/** Resolve, or throw with the closest matches in the message. */
export function getTitle(idOrAlias: string): TitleDescriptor {
  const found = findTitle(idOrAlias);
  if (found) return found;
  throw new UnknownTitleError(idOrAlias, suggestTitles(idOrAlias, 3));
}

/** True when the title supports the capability. The check the client runs. */
export function supports(title: TitleDescriptor, capability: Capability): boolean {
  return title.capabilities.includes(capability);
}

/** Titles of one genre. */
export function titlesByGenre(genre: TitleDescriptor["genre"]): readonly TitleDescriptor[] {
  return listTitles().filter((title) => title.genre === genre);
}

/** Titles served by a provider. Answers "what breaks if Riot goes down?". */
export function titlesByProvider(providerId: string): readonly TitleDescriptor[] {
  return listTitles().filter((title) => title.providers.includes(providerId));
}

/** Titles supporting a capability. Answers "which of these have real ranks?". */
export function titlesByCapability(capability: Capability): readonly TitleDescriptor[] {
  return listTitles().filter((title) => title.capabilities.includes(capability));
}

/** Titles playable on a platform. */
export function titlesByPlatform(platform: Platform): readonly TitleDescriptor[] {
  return listTitles().filter((title) => title.platforms.includes(platform));
}

/**
 * Free-text search across ids, names and aliases.
 *
 * Substring first, then a prefix-distance fallback so a typo still finds
 * something. Deliberately simple - this is for a Discord autocomplete handler,
 * not for a search engine.
 */
export function searchTitles(query: string, limit = 10): readonly TitleDescriptor[] {
  const needle = normalise(query);
  if (needle.length === 0) return listTitles().slice(0, limit);

  const scored: { title: TitleDescriptor; score: number }[] = [];
  for (const title of TITLES.values()) {
    const haystacks = [title.id, title.name, ...title.aliases].map(normalise);
    let best = Number.POSITIVE_INFINITY;
    for (const hay of haystacks) {
      if (hay === needle) best = Math.min(best, 0);
      else if (hay.startsWith(needle)) best = Math.min(best, 1);
      else if (hay.includes(needle)) best = Math.min(best, 2);
      else best = Math.min(best, 3 + distance(needle, hay));
    }
    // 3 + distance means an unrelated title scores at least 4; anything above
    // 6 is noise a user would not recognise as a match.
    if (best <= 6) scored.push({ title, score: best });
  }
  scored.sort((a, b) => a.score - b.score || a.title.id.localeCompare(b.title.id));
  return scored.slice(0, limit).map((entry) => entry.title);
}

/** The "did you mean" list on {@link UnknownTitleError}. */
export function suggestTitles(query: string, limit = 3): readonly string[] {
  return searchTitles(query, limit).map((title) => title.id);
}

/**
 * Add a title at runtime.
 *
 * For a title this package does not ship yet, or a private one. The id must be
 * new: replacing a built-in title would silently change what an existing call
 * returns.
 */
export function registerTitle(descriptor: TitleDescriptor): void {
  if (TITLES.has(descriptor.id)) {
    throw new Error(`title "${descriptor.id}" is already registered - pick a different id`);
  }
  // Reconciled like a built-in, so a registered title cannot promise an esports
  // capability its providers do not serve either.
  TITLES.set(descriptor.id, reconcile(descriptor));
  ALIASES.set(normalise(descriptor.id), descriptor.id);
  ALIASES.set(normalise(descriptor.name), descriptor.id);
  for (const alias of descriptor.aliases) ALIASES.set(normalise(alias), descriptor.id);
}

/** Lower-case and strip everything that is not a letter or a digit. */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Levenshtein distance, capped.
 *
 * Two rows rather than a full matrix: the longest string here is about thirty
 * characters and this runs on every keystroke of an autocomplete.
 */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}
