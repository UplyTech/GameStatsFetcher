/**
 * Title client construction.
 *
 * The table below is the whole of the wiring: a title id maps to the class that
 * knows how to serve it, and everything absent from the table falls back to the
 * plain {@link TitleClient} - which is not a stub. A fallback title still has
 * the complete esports surface, served by whichever provider its registry entry
 * names. That is how Tekken 8, Mobile Legends and EA Sports FC work here
 * without a line of bespoke code each.
 */

import { TitleClient, translateShapeErrors } from "../title-client.js";
import type { Runtime } from "../runtime.js";
import { getTitle } from "../titles.js";
import type { TitleDescriptor } from "../types.js";

import {
  CS2Client,
  DeadlockClient,
  Dota2Client,
  SteamStatsClient,
  TeamFortress2Client,
} from "./valve.js";
import {
  LeagueOfLegendsClient,
  LegendsOfRuneterraClient,
  TeamfightTacticsClient,
  ValorantClient,
} from "./riot.js";
import {
  HearthstoneClient,
  HeroesOfTheStormClient,
  Overwatch2Client,
  StarCraft2Client,
  Warcraft3Client,
  WorldOfWarcraftClient,
} from "./blizzard.js";
import {
  ApexLegendsClient,
  BattlefieldClient,
  CallOfDutyClient,
  Destiny2Client,
  FortniteClient,
  HaloInfiniteClient,
  MarvelRivalsClient,
  PubgClient,
  RainbowSixClient,
  SplitgateClient,
  TheFinalsClient,
} from "./shooters.js";
import { RocketLeagueClient } from "./rocket-league.js";
import { BrawlStarsClient, ClashOfClansClient, ClashRoyaleClient } from "./mobile.js";
import { PaladinsClient, SmiteClient } from "./hirez.js";
import {
  AgeOfEmpires2Client,
  AgeOfEmpires4Client,
  CompanyOfHeroes3Client,
} from "./strategy.js";
import { BeatSaberClient, ChessClient, MinecraftClient, OsuClient } from "./skill.js";
import {
  AlbionClient,
  GuildWars2Client,
  PathOfExileClient,
  WorldOfTanksClient,
  WorldOfWarshipsClient,
} from "./worlds.js";
import { BrawlhallaClient, IRacingClient, TrackmaniaClient } from "./racing.js";
import {
  DiabloThreeClient,
  EveOnlineClient,
  OldSchoolRuneScapeClient,
  RuneScapeClient3,
} from "./persistent.js";

export * from "./valve.js";
export * from "./riot.js";
export * from "./blizzard.js";
export * from "./shooters.js";
export * from "./rocket-league.js";
export * from "./mobile.js";
export * from "./hirez.js";
export * from "./strategy.js";
export * from "./skill.js";
export * from "./worlds.js";
export * from "./persistent.js";
export * from "./racing.js";

type TitleClientFactory = new (title: TitleDescriptor, runtime: Runtime) => TitleClient;

/** Title id to the class that serves it. Absent means "esports only". */
const CLIENTS: Readonly<Record<string, TitleClientFactory>> = {
  // Valve
  cs2: CS2Client,
  dota2: Dota2Client,
  "team-fortress-2": TeamFortress2Client,
  deadlock: DeadlockClient,

  // Riot
  "league-of-legends": LeagueOfLegendsClient,
  "teamfight-tactics": TeamfightTacticsClient,
  valorant: ValorantClient,
  "legends-of-runeterra": LegendsOfRuneterraClient,

  // Blizzard
  "overwatch-2": Overwatch2Client,
  "starcraft-2": StarCraft2Client,
  "warcraft-3": Warcraft3Client,
  "heroes-of-the-storm": HeroesOfTheStormClient,
  "world-of-warcraft": WorldOfWarcraftClient,
  hearthstone: HearthstoneClient,

  // Shooters
  "apex-legends": ApexLegendsClient,
  fortnite: FortniteClient,
  pubg: PubgClient,
  "rainbow-six-siege": RainbowSixClient,
  "call-of-duty": CallOfDutyClient,
  battlefield: BattlefieldClient,
  splitgate: SplitgateClient,
  "halo-infinite": HaloInfiniteClient,
  "destiny-2": Destiny2Client,
  "the-finals": TheFinalsClient,
  "marvel-rivals": MarvelRivalsClient,

  // Sports and cars
  "rocket-league": RocketLeagueClient,
  iracing: IRacingClient,
  trackmania: TrackmaniaClient,

  // Supercell
  "clash-royale": ClashRoyaleClient,
  "clash-of-clans": ClashOfClansClient,
  "brawl-stars": BrawlStarsClient,

  // Hi-Rez
  smite: SmiteClient,
  paladins: PaladinsClient,

  // Strategy
  "age-of-empires-2": AgeOfEmpires2Client,
  "age-of-empires-4": AgeOfEmpires4Client,
  "company-of-heroes-3": CompanyOfHeroes3Client,

  // Skill and mind sports
  osu: OsuClient,
  "beat-saber": BeatSaberClient,
  chess: ChessClient,
  minecraft: MinecraftClient,
  brawlhalla: BrawlhallaClient,

  // Persistent worlds and vehicles
  "guild-wars-2": GuildWars2Client,
  "path-of-exile": PathOfExileClient,
  "albion-online": AlbionClient,
  "world-of-tanks": WorldOfTanksClient,
  "world-of-warships": WorldOfWarshipsClient,

  // Worlds where progress is the rank: no matchmaking, and a first-party API
  // that answers "how am I doing" anyway.
  "old-school-runescape": OldSchoolRuneScapeClient,
  runescape: RuneScapeClient3,
  "eve-online": EveOnlineClient,
  "diablo-3": DiabloThreeClient,

  // Steam career totals and nothing more
  rust: SteamStatsClient,
  "war-thunder": SteamStatsClient,
  "naraka-bladepoint": SteamStatsClient,
  "dead-by-daylight": SteamStatsClient,
};

/**
 * Build the client for a title.
 *
 * Memoised per runtime, so `client.cs2` and `client.title("csgo")` are the same
 * object and share its provider instances.
 */
export function createTitleClient(titleId: string, runtime: Runtime): TitleClient {
  const key = `title:${titleId}`;
  const existing = runtime.state.get(key) as TitleClient | undefined;
  if (existing) return existing;

  const descriptor = getTitle(titleId);
  const Factory = CLIENTS[descriptor.id] ?? TitleClient;
  // Wrap before constructing, so no client ever exists with an unwrapped
  // method. Idempotent, and cheap after the first title of each class.
  translateShapeErrors(Factory);
  const client = new Factory(descriptor, runtime);
  runtime.state.set(key, client);
  // Aliases resolve to the same instance, so `client.title("csgo")` twice does
  // not build two clients.
  runtime.state.set(`title:${descriptor.id}`, client);
  return client;
}

/** True when this package ships a bespoke client rather than the esports-only one. */
export function hasDedicatedClient(titleId: string): boolean {
  return titleId in CLIENTS;
}

/** Every title id with a bespoke client. Used by the docs and the tests. */
export function dedicatedTitleIds(): readonly string[] {
  return Object.keys(CLIENTS);
}
