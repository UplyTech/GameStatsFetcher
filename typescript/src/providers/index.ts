/**
 * Provider construction.
 *
 * Every provider is built lazily and memoised on the runtime, so a client that
 * only touches Valorant never constructs the other forty - and two titles that
 * share a provider share the object, which is what makes one Steam quota be
 * spent once rather than twice.
 */

import type { Runtime } from "../runtime.js";
import { useProvider } from "./base.js";

import { SteamProvider } from "./steam.js";
import { RiotProvider } from "./riot.js";
import { BlizzardProvider } from "./blizzard.js";
import { JagexProvider } from "./jagex.js";
import { EveProvider } from "./eve.js";
import { BungieProvider } from "./bungie.js";
import { PubgProvider } from "./pubg.js";
import {
  BrawlStarsProvider,
  ClashOfClansProvider,
  ClashRoyaleProvider,
} from "./supercell.js";
import { WargamingProvider } from "./wargaming.js";
import { HiRezProvider } from "./hirez.js";
import { FaceitProvider } from "./faceit.js";
import { TrackerProvider } from "./tracker.js";
import { OpenDotaProvider, StratzProvider } from "./dota.js";
import { HenrikDevProvider } from "./henrikdev.js";
import {
  ApexProvider,
  DeadlockProvider,
  FortniteProvider,
  HaloProvider,
  MarvelRivalsProvider,
  OverFastProvider,
  TheFinalsProvider,
} from "./shooters.js";
import { BallchasingProvider, OctaneProvider } from "./rocket-league.js";
import {
  Aoe4WorldProvider,
  HeroesProfileProvider,
  RelicProvider,
  Sc2PulseProvider,
  W3ChampionsProvider,
} from "./strategy.js";
import {
  BeatLeaderProvider,
  ChessComProvider,
  LichessProvider,
  OsuProvider,
  ScoreSaberProvider,
} from "./skill.js";
import {
  AlbionProvider,
  GuildWars2Provider,
  HypixelProvider,
  LogsTfProvider,
  MojangProvider,
  PathOfExileProvider,
  RaiderIoProvider,
} from "./worlds.js";
import { BrawlhallaProvider, IRacingProvider, TrackmaniaProvider } from "./racing.js";
import {
  AbiosProvider,
  EsportsEarningsProvider,
  LiquipediaProvider,
  PandaScoreProvider,
} from "./esports-data.js";
import { ChallongeProvider, StartGgProvider, ToornamentProvider } from "./tournaments.js";

export { ProviderClient, useProvider } from "./base.js";

export * from "./steam.js";
export * from "./riot.js";
export * from "./blizzard.js";
export * from "./bungie.js";
export * from "./pubg.js";
export * from "./supercell.js";
export * from "./wargaming.js";
export * from "./hirez.js";
export * from "./faceit.js";
export * from "./tracker.js";
export * from "./dota.js";
export * from "./henrikdev.js";
export * from "./shooters.js";
export * from "./rocket-league.js";
export * from "./strategy.js";
export * from "./skill.js";
export * from "./worlds.js";
export * from "./racing.js";
export * from "./esports-data.js";
export * from "./tournaments.js";

export const steam = (rt: Runtime): SteamProvider =>
  useProvider(rt, "steam", (r) => new SteamProvider(r));
export const riot = (rt: Runtime): RiotProvider =>
  useProvider(rt, "riot", (r) => new RiotProvider(r));
export const blizzard = (rt: Runtime): BlizzardProvider =>
  useProvider(rt, "blizzard", (r) => new BlizzardProvider(r));
export const bungie = (rt: Runtime): BungieProvider =>
  useProvider(rt, "bungie", (r) => new BungieProvider(r));
export const pubg = (rt: Runtime): PubgProvider =>
  useProvider(rt, "pubg", (r) => new PubgProvider(r));
export const clashRoyale = (rt: Runtime): ClashRoyaleProvider =>
  useProvider(rt, "supercell-clash-royale", (r) => new ClashRoyaleProvider(r));
export const clashOfClans = (rt: Runtime): ClashOfClansProvider =>
  useProvider(rt, "supercell-clash-of-clans", (r) => new ClashOfClansProvider(r));
export const brawlStars = (rt: Runtime): BrawlStarsProvider =>
  useProvider(rt, "supercell-brawl-stars", (r) => new BrawlStarsProvider(r));
export const wargaming = (rt: Runtime): WargamingProvider =>
  useProvider(rt, "wargaming", (r) => new WargamingProvider(r));
export const hirez = (rt: Runtime): HiRezProvider =>
  useProvider(rt, "hirez", (r) => new HiRezProvider(r));
export const faceit = (rt: Runtime): FaceitProvider =>
  useProvider(rt, "faceit", (r) => new FaceitProvider(r));
export const tracker = (rt: Runtime): TrackerProvider =>
  useProvider(rt, "tracker", (r) => new TrackerProvider(r));
export const opendota = (rt: Runtime): OpenDotaProvider =>
  useProvider(rt, "opendota", (r) => new OpenDotaProvider(r));
export const stratz = (rt: Runtime): StratzProvider =>
  useProvider(rt, "stratz", (r) => new StratzProvider(r));
export const henrikdev = (rt: Runtime): HenrikDevProvider =>
  useProvider(rt, "henrikdev", (r) => new HenrikDevProvider(r));
export const overfast = (rt: Runtime): OverFastProvider =>
  useProvider(rt, "overfast", (r) => new OverFastProvider(r));
export const apex = (rt: Runtime): ApexProvider =>
  useProvider(rt, "apex-legends-api", (r) => new ApexProvider(r));
export const fortnite = (rt: Runtime): FortniteProvider =>
  useProvider(rt, "fortnite-api", (r) => new FortniteProvider(r));
export const halo = (rt: Runtime): HaloProvider =>
  useProvider(rt, "halodotapi", (r) => new HaloProvider(r));
export const theFinals = (rt: Runtime): TheFinalsProvider =>
  useProvider(rt, "the-finals-api", (r) => new TheFinalsProvider(r));
export const marvelRivals = (rt: Runtime): MarvelRivalsProvider =>
  useProvider(rt, "marvel-rivals", (r) => new MarvelRivalsProvider(r));
export const deadlock = (rt: Runtime): DeadlockProvider =>
  useProvider(rt, "deadlock-api", (r) => new DeadlockProvider(r));
export const ballchasing = (rt: Runtime): BallchasingProvider =>
  useProvider(rt, "ballchasing", (r) => new BallchasingProvider(r));
export const octane = (rt: Runtime): OctaneProvider =>
  useProvider(rt, "octane", (r) => new OctaneProvider(r));
export const sc2pulse = (rt: Runtime): Sc2PulseProvider =>
  useProvider(rt, "sc2pulse", (r) => new Sc2PulseProvider(r));
export const w3champions = (rt: Runtime): W3ChampionsProvider =>
  useProvider(rt, "w3champions", (r) => new W3ChampionsProvider(r));
export const relic = (rt: Runtime): RelicProvider =>
  useProvider(rt, "relic", (r) => new RelicProvider(r));
export const aoe4world = (rt: Runtime): Aoe4WorldProvider =>
  useProvider(rt, "aoe4world", (r) => new Aoe4WorldProvider(r));
export const heroesProfile = (rt: Runtime): HeroesProfileProvider =>
  useProvider(rt, "heroesprofile", (r) => new HeroesProfileProvider(r));
export const osu = (rt: Runtime): OsuProvider =>
  useProvider(rt, "osu", (r) => new OsuProvider(r));
export const scoresaber = (rt: Runtime): ScoreSaberProvider =>
  useProvider(rt, "scoresaber", (r) => new ScoreSaberProvider(r));
export const beatleader = (rt: Runtime): BeatLeaderProvider =>
  useProvider(rt, "beatleader", (r) => new BeatLeaderProvider(r));
export const chessCom = (rt: Runtime): ChessComProvider =>
  useProvider(rt, "chess-com", (r) => new ChessComProvider(r));
export const lichess = (rt: Runtime): LichessProvider =>
  useProvider(rt, "lichess", (r) => new LichessProvider(r));
export const mojang = (rt: Runtime): MojangProvider =>
  useProvider(rt, "mojang", (r) => new MojangProvider(r));
export const hypixel = (rt: Runtime): HypixelProvider =>
  useProvider(rt, "hypixel", (r) => new HypixelProvider(r));
export const guildWars2 = (rt: Runtime): GuildWars2Provider =>
  useProvider(rt, "guild-wars-2", (r) => new GuildWars2Provider(r));
export const pathOfExile = (rt: Runtime): PathOfExileProvider =>
  useProvider(rt, "path-of-exile", (r) => new PathOfExileProvider(r));
export const jagex = (rt: Runtime): JagexProvider =>
  useProvider(rt, "jagex", (r) => new JagexProvider(r));
export const eve = (rt: Runtime): EveProvider =>
  useProvider(rt, "eve-esi", (r) => new EveProvider(r));
export const albion = (rt: Runtime): AlbionProvider =>
  useProvider(rt, "albion", (r) => new AlbionProvider(r));
export const raiderio = (rt: Runtime): RaiderIoProvider =>
  useProvider(rt, "raiderio", (r) => new RaiderIoProvider(r));
export const logstf = (rt: Runtime): LogsTfProvider =>
  useProvider(rt, "logstf", (r) => new LogsTfProvider(r));
export const iracing = (rt: Runtime): IRacingProvider =>
  useProvider(rt, "iracing", (r) => new IRacingProvider(r));
export const trackmania = (rt: Runtime): TrackmaniaProvider =>
  useProvider(rt, "trackmania-io", (r) => new TrackmaniaProvider(r));
export const brawlhalla = (rt: Runtime): BrawlhallaProvider =>
  useProvider(rt, "brawlhalla", (r) => new BrawlhallaProvider(r));
export const pandascore = (rt: Runtime): PandaScoreProvider =>
  useProvider(rt, "pandascore", (r) => new PandaScoreProvider(r));
export const abios = (rt: Runtime): AbiosProvider =>
  useProvider(rt, "abios", (r) => new AbiosProvider(r));
export const esportsEarnings = (rt: Runtime): EsportsEarningsProvider =>
  useProvider(rt, "esports-earnings", (r) => new EsportsEarningsProvider(r));
export const liquipedia = (rt: Runtime): LiquipediaProvider =>
  useProvider(rt, "liquipedia", (r) => new LiquipediaProvider(r));
export const startgg = (rt: Runtime): StartGgProvider =>
  useProvider(rt, "startgg", (r) => new StartGgProvider(r));
export const toornament = (rt: Runtime): ToornamentProvider =>
  useProvider(rt, "toornament", (r) => new ToornamentProvider(r));
export const challonge = (rt: Runtime): ChallongeProvider =>
  useProvider(rt, "challonge", (r) => new ChallongeProvider(r));
