/**
 * The root client.
 *
 * Construct one and keep it: the cache, the rate limiter and every provider
 * live on it, so two clients means two of each and a Steam quota spent twice.
 *
 * There are two ways in, and they are the same objects underneath:
 *
 * ```ts
 * client.cs2                 // typed accessor, autocompletes
 * client.title("csgo")       // registry lookup, accepts ids and aliases
 * ```
 *
 * The accessors exist for the titles people reach for constantly. The registry
 * lookup exists because there are eighty titles and nobody wants eighty
 * properties - and because a Discord bot taking a title from user input needs
 * the string form anyway.
 */

import { createRuntime, type Runtime } from "./runtime.js";
import { createTitleClient, dedicatedTitleIds } from "./games/index.js";
import type { TitleClient } from "./title-client.js";
import {
  findTitle,
  getTitle,
  listTitles,
  searchTitles,
  titleCount,
  titlesByCapability,
  titlesByGenre,
  titlesByProvider,
  type TitleId,
} from "./titles.js";
import { findProvider, listProviders } from "./providers.js";
import * as providerFactories from "./providers/index.js";
import type {
  Capability,
  GameStatsClientOptions,
  Genre,
  ProviderDescriptor,
  TitleDescriptor,
} from "./types.js";

// Typed accessors, so the common titles autocomplete with their real class.
import type { CS2Client, DeadlockClient, Dota2Client, TeamFortress2Client } from "./games/valve.js";
import type {
  LeagueOfLegendsClient,
  LegendsOfRuneterraClient,
  TeamfightTacticsClient,
  ValorantClient,
} from "./games/riot.js";
import type {
  HearthstoneClient,
  HeroesOfTheStormClient,
  Overwatch2Client,
  StarCraft2Client,
  Warcraft3Client,
  WorldOfWarcraftClient,
} from "./games/blizzard.js";
import type {
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
} from "./games/shooters.js";
import type { RocketLeagueClient } from "./games/rocket-league.js";
import type {
  BrawlStarsClient,
  ClashOfClansClient,
  ClashRoyaleClient,
} from "./games/mobile.js";
import type { PaladinsClient, SmiteClient } from "./games/hirez.js";
import type {
  AgeOfEmpires2Client,
  AgeOfEmpires4Client,
  CompanyOfHeroes3Client,
} from "./games/strategy.js";
import type {
  BeatSaberClient,
  ChessClient,
  MinecraftClient,
  OsuClient,
} from "./games/skill.js";
import type {
  AlbionClient,
  GuildWars2Client,
  PathOfExileClient,
  WorldOfTanksClient,
  WorldOfWarshipsClient,
} from "./games/worlds.js";
import type {
  BrawlhallaClient,
  IRacingClient,
  TrackmaniaClient,
} from "./games/racing.js";

/** What {@link GameStatsClient.diagnostics} reports about one provider. */
export interface ProviderDiagnostic {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderDescriptor["kind"];
  /** True when a credential is configured, or the provider needs none. */
  readonly ready: boolean;
  /** The `apiKeys` field to set, when one is missing. */
  readonly missingKey: string | null;
  readonly docsUrl: string;
  /** Titles that would stop working without this provider. */
  readonly titles: readonly string[];
}

export class GameStatsClient {
  private readonly runtime: Runtime;
  private readonly options: GameStatsClientOptions;

  constructor(options: GameStatsClientOptions = {}) {
    this.options = options;
    this.runtime = createRuntime(options);
  }

  // -------------------------------------------------------------------------
  // Generic access
  // -------------------------------------------------------------------------

  /**
   * The client for any registered title, by id or alias.
   *
   * `client.title("csgo")`, `client.title("CS:GO")` and `client.cs2` all return
   * the same object. An unknown id throws `UnknownTitleError` with the closest
   * matches in the message rather than returning `undefined`.
   */
  public title(idOrAlias: TitleId | (string & Record<never, never>)): TitleClient {
    const descriptor = getTitle(idOrAlias);
    return createTitleClient(descriptor.id, this.runtime);
  }

  /** The client for a title, or `undefined` when the id is unknown. */
  public tryTitle(idOrAlias: string): TitleClient | undefined {
    const descriptor = findTitle(idOrAlias);
    return descriptor ? createTitleClient(descriptor.id, this.runtime) : undefined;
  }

  /** Every registered title descriptor. */
  public titles(): readonly TitleDescriptor[] {
    return listTitles();
  }

  /** How many titles the registry holds. */
  public titleCount(): number {
    return titleCount();
  }

  /** Free-text search across ids, names and aliases. For autocomplete handlers. */
  public search(query: string, limit = 10): readonly TitleDescriptor[] {
    return searchTitles(query, limit);
  }

  /** Titles of one genre. */
  public byGenre(genre: Genre): readonly TitleDescriptor[] {
    return titlesByGenre(genre);
  }

  /** Titles that support a capability - "which of these have real ranks?". */
  public byCapability(capability: Capability): readonly TitleDescriptor[] {
    return titlesByCapability(capability);
  }

  /** Titles served by a provider - "what breaks if Riot goes down?". */
  public byProvider(providerId: string): readonly TitleDescriptor[] {
    return titlesByProvider(providerId);
  }

  /** Every provider descriptor. */
  public providers(): readonly ProviderDescriptor[] {
    return listProviders();
  }

  /** The raw provider clients, for the endpoints the canonical model does not model. */
  public get raw(): typeof providerFactories {
    return providerFactories;
  }

  /** The runtime, for advanced use: the limiter snapshot, the cache, the logger. */
  public get internals(): Runtime {
    return this.runtime;
  }

  /** The options this client was constructed with. */
  public getOptions(): Readonly<GameStatsClientOptions> {
    return this.options;
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /**
   * What is configured and what is not.
   *
   * The answer to "why is this title returning nothing?" almost always. Run it
   * at startup and log the not-ready rows: a missing key found at boot is a
   * five-minute fix, and the same key found at 3am is an incident.
   */
  public diagnostics(): readonly ProviderDiagnostic[] {
    return this.providers().map((provider) => {
      const key = provider.keyName;
      const configured = key ? Boolean(this.runtime.apiKeys[key]) : true;
      // A provider whose key only raises the quota counts as ready without one;
      // reporting OpenDota as broken because nobody signed up for an optional
      // key would bury the rows that actually need attention.
      const optional = provider.auth === "none" || provider.optionalAuth === true;
      return {
        id: provider.id,
        label: provider.label,
        kind: provider.kind,
        ready: optional || configured,
        missingKey: configured || optional ? null : key,
        docsUrl: provider.docsUrl,
        titles: titlesByProvider(provider.id).map((title) => title.id),
      };
    });
  }

  /**
   * Titles this configuration can serve for what they are *for*.
   *
   * The test is deliberately stricter than "any provider is ready". Every title
   * in the registry lists Liquipedia, which needs no key, so a loose test would
   * report every title as usable with no credentials at all - technically true
   * and useless as a deployment check.
   *
   * So a title that has a player API counts as usable only when a provider that
   * serves *player data* is ready; a title that has none counts as usable when
   * any of its esports providers is. It still says nothing about whether that
   * provider is up - only about whether this process could talk to it.
   */
  public usableTitles(): readonly TitleDescriptor[] {
    const ready = new Set(
      this.diagnostics()
        .filter((entry) => entry.ready)
        .map((entry) => entry.id),
    );
    return this.titles().filter((title) => {
      const needsPlayerData = title.capabilities.includes("resolvePlayer");
      const relevant = needsPlayerData
        ? title.providers.filter((id) => {
            const kind = findProvider(id)?.kind;
            return kind === "first-party" || kind === "community";
          })
        : title.providers;
      return relevant.some((providerId) => ready.has(providerId));
    });
  }

  /** Titles this package ships a bespoke client for, rather than esports only. */
  public dedicatedTitles(): readonly string[] {
    return dedicatedTitleIds();
  }

  /** Rate-limiter state per provider. For a `/debug` command or a metric. */
  public rateLimitSnapshot(): Record<string, { tokens: number; blockedForMs: number }> {
    return this.runtime.limiter.snapshot();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Drop every cached entry under this client's prefix. */
  public async clearCache(): Promise<void> {
    await this.runtime.cache.clear();
  }

  /**
   * Release resources.
   *
   * Closes the Redis connection when one was opened. Safe to call more than
   * once; a process that forgets it will keep a socket open until it exits.
   */
  public async destroy(): Promise<void> {
    await this.runtime.cache.disconnect();
    this.runtime.state.clear();
  }

  // -------------------------------------------------------------------------
  // Typed accessors
  // -------------------------------------------------------------------------

  /** Counter-Strike 2. */
  public get cs2(): CS2Client {
    return this.title("cs2") as CS2Client;
  }
  /** Dota 2. */
  public get dota2(): Dota2Client {
    return this.title("dota2") as Dota2Client;
  }
  /** Team Fortress 2. */
  public get tf2(): TeamFortress2Client {
    return this.title("team-fortress-2") as TeamFortress2Client;
  }
  /** Deadlock. */
  public get deadlock(): DeadlockClient {
    return this.title("deadlock") as DeadlockClient;
  }
  /** League of Legends. */
  public get lol(): LeagueOfLegendsClient {
    return this.title("league-of-legends") as LeagueOfLegendsClient;
  }
  /** Teamfight Tactics. */
  public get tft(): TeamfightTacticsClient {
    return this.title("teamfight-tactics") as TeamfightTacticsClient;
  }
  /** VALORANT. */
  public get valorant(): ValorantClient {
    return this.title("valorant") as ValorantClient;
  }
  /** Legends of Runeterra. */
  public get runeterra(): LegendsOfRuneterraClient {
    return this.title("legends-of-runeterra") as LegendsOfRuneterraClient;
  }
  /** Overwatch 2. */
  public get overwatch(): Overwatch2Client {
    return this.title("overwatch-2") as Overwatch2Client;
  }
  /** StarCraft II. */
  public get starcraft2(): StarCraft2Client {
    return this.title("starcraft-2") as StarCraft2Client;
  }
  /** Warcraft III. */
  public get warcraft3(): Warcraft3Client {
    return this.title("warcraft-3") as Warcraft3Client;
  }
  /** Heroes of the Storm. */
  public get hots(): HeroesOfTheStormClient {
    return this.title("heroes-of-the-storm") as HeroesOfTheStormClient;
  }
  /** World of Warcraft. */
  public get wow(): WorldOfWarcraftClient {
    return this.title("world-of-warcraft") as WorldOfWarcraftClient;
  }
  /** Hearthstone. */
  public get hearthstone(): HearthstoneClient {
    return this.title("hearthstone") as HearthstoneClient;
  }
  /** Apex Legends. */
  public get apex(): ApexLegendsClient {
    return this.title("apex-legends") as ApexLegendsClient;
  }
  /** Fortnite. */
  public get fortnite(): FortniteClient {
    return this.title("fortnite") as FortniteClient;
  }
  /** PUBG: Battlegrounds. */
  public get pubg(): PubgClient {
    return this.title("pubg") as PubgClient;
  }
  /** Rainbow Six Siege. */
  public get rainbowSix(): RainbowSixClient {
    return this.title("rainbow-six-siege") as RainbowSixClient;
  }
  /** Call of Duty. */
  public get callOfDuty(): CallOfDutyClient {
    return this.title("call-of-duty") as CallOfDutyClient;
  }
  /** Battlefield. */
  public get battlefield(): BattlefieldClient {
    return this.title("battlefield") as BattlefieldClient;
  }
  /** Splitgate. */
  public get splitgate(): SplitgateClient {
    return this.title("splitgate") as SplitgateClient;
  }
  /** Halo Infinite. */
  public get halo(): HaloInfiniteClient {
    return this.title("halo-infinite") as HaloInfiniteClient;
  }
  /** Destiny 2. */
  public get destiny2(): Destiny2Client {
    return this.title("destiny-2") as Destiny2Client;
  }
  /** The Finals. */
  public get theFinals(): TheFinalsClient {
    return this.title("the-finals") as TheFinalsClient;
  }
  /** Marvel Rivals. */
  public get marvelRivals(): MarvelRivalsClient {
    return this.title("marvel-rivals") as MarvelRivalsClient;
  }
  /** Rocket League. */
  public get rocketLeague(): RocketLeagueClient {
    return this.title("rocket-league") as RocketLeagueClient;
  }
  /** Clash Royale. */
  public get clashRoyale(): ClashRoyaleClient {
    return this.title("clash-royale") as ClashRoyaleClient;
  }
  /** Clash of Clans. */
  public get clashOfClans(): ClashOfClansClient {
    return this.title("clash-of-clans") as ClashOfClansClient;
  }
  /** Brawl Stars. */
  public get brawlStars(): BrawlStarsClient {
    return this.title("brawl-stars") as BrawlStarsClient;
  }
  /** SMITE. */
  public get smite(): SmiteClient {
    return this.title("smite") as SmiteClient;
  }
  /** Paladins. */
  public get paladins(): PaladinsClient {
    return this.title("paladins") as PaladinsClient;
  }
  /** Age of Empires II: Definitive Edition. */
  public get aoe2(): AgeOfEmpires2Client {
    return this.title("age-of-empires-2") as AgeOfEmpires2Client;
  }
  /** Age of Empires IV. */
  public get aoe4(): AgeOfEmpires4Client {
    return this.title("age-of-empires-4") as AgeOfEmpires4Client;
  }
  /** Company of Heroes 3. */
  public get coh3(): CompanyOfHeroes3Client {
    return this.title("company-of-heroes-3") as CompanyOfHeroes3Client;
  }
  /** osu!. */
  public get osu(): OsuClient {
    return this.title("osu") as OsuClient;
  }
  /** Beat Saber. */
  public get beatSaber(): BeatSaberClient {
    return this.title("beat-saber") as BeatSaberClient;
  }
  /** Chess, on Chess.com or Lichess. */
  public get chess(): ChessClient {
    return this.title("chess") as ChessClient;
  }
  /** Minecraft, through Hypixel. */
  public get minecraft(): MinecraftClient {
    return this.title("minecraft") as MinecraftClient;
  }
  /** Brawlhalla. */
  public get brawlhalla(): BrawlhallaClient {
    return this.title("brawlhalla") as BrawlhallaClient;
  }
  /** iRacing. */
  public get iracing(): IRacingClient {
    return this.title("iracing") as IRacingClient;
  }
  /** Trackmania. */
  public get trackmania(): TrackmaniaClient {
    return this.title("trackmania") as TrackmaniaClient;
  }
  /** Guild Wars 2. */
  public get guildWars2(): GuildWars2Client {
    return this.title("guild-wars-2") as GuildWars2Client;
  }
  /** Path of Exile. */
  public get pathOfExile(): PathOfExileClient {
    return this.title("path-of-exile") as PathOfExileClient;
  }
  /** Albion Online. */
  public get albion(): AlbionClient {
    return this.title("albion-online") as AlbionClient;
  }
  /** World of Tanks. */
  public get worldOfTanks(): WorldOfTanksClient {
    return this.title("world-of-tanks") as WorldOfTanksClient;
  }
  /** World of Warships. */
  public get worldOfWarships(): WorldOfWarshipsClient {
    return this.title("world-of-warships") as WorldOfWarshipsClient;
  }

  // The fighting games, the mobile MOBAs and the sports titles have no player
  // API, so they get no accessor - `client.title("tekken-8")` is the way in,
  // and its esports surface is the whole of what exists.
}
