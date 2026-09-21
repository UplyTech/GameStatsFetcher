/**
 * The cross-title esports providers.
 *
 * These are what make a title like Tekken 8 or Mobile Legends usable in this
 * package at all. Bandai Namco and Moonton publish no player API, but the
 * professional circuit around those games is documented in structured form by
 * somebody - and that is a real API serving real data, not a substitute for one.
 *
 * | Provider | Answers |
 * |---|---|
 * | PandaScore | fixtures, teams, players, standings, live scores |
 * | Abios | the same, for callers who already have an Abios contract |
 * | Esports Earnings | career prize money, for every title that has paid any |
 * | Liquipedia | everything else, as wikitext |
 */

import { ProviderClient } from "./base.js";
import type { RequestSpec } from "../http.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

// ---------------------------------------------------------------------------
// PandaScore
// ---------------------------------------------------------------------------

/**
 * This package's title ids mapped onto PandaScore's videogame slugs.
 *
 * A title absent from this table has no PandaScore coverage, and asking for its
 * fixtures through this provider throws rather than returning an empty list -
 * an empty list would read as "no matches this week".
 */
export const PANDASCORE_SLUGS: Readonly<Record<string, string>> = {
  cs2: "csgo",
  dota2: "dota2",
  "league-of-legends": "lol",
  valorant: "valorant",
  "overwatch-2": "ow",
  "rainbow-six-siege": "r6siege",
  "rocket-league": "rl",
  "call-of-duty": "codmw",
  "apex-legends": "apex-legends",
  pubg: "pubg",
  "pubg-mobile": "pubgm",
  "mobile-legends": "mlbb",
  "honor-of-kings": "kog",
  "free-fire": "free-fire",
  "wild-rift": "lol-wild-rift",
  "ea-fc": "fifa",
  "starcraft-2": "starcraft-2",
  "starcraft-brood-war": "starcraft-brood-war",
  "street-fighter-6": "street-fighter",
  "teamfight-tactics": "lol",
  "halo-infinite": "halo",
  fortnite: "fortnite",
};

export interface PandaScoreOpponentEntry {
  type?: "Team" | "Player";
  opponent?: {
    id?: number;
    name?: string;
    acronym?: string | null;
    image_url?: string | null;
    slug?: string;
  };
}

export interface PandaScoreMatch {
  id: number;
  name?: string;
  slug?: string;
  status?: string;
  scheduled_at?: string | null;
  begin_at?: string | null;
  end_at?: string | null;
  number_of_games?: number;
  match_type?: string;
  winner_id?: number | null;
  opponents?: PandaScoreOpponentEntry[];
  results?: { team_id?: number; player_id?: number; score?: number }[];
  streams_list?: { raw_url?: string; language?: string; official?: boolean; main?: boolean }[];
  tournament?: { id?: number; name?: string; slug?: string };
  league?: { id?: number; name?: string; slug?: string };
  serie?: { id?: number; name?: string | null; full_name?: string };
  videogame?: { slug?: string; name?: string };
}

export class PandaScoreProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("pandascore", runtime);
  }

  /** The slug for a title, or a clear error naming what is covered. */
  public slug(titleId: string): string {
    const slug = PANDASCORE_SLUGS[titleId];
    if (!slug) {
      throw new ValidationError(
        `PandaScore does not cover "${titleId}". Covered titles: ${Object.keys(PANDASCORE_SLUGS).join(", ")}`,
      );
    }
    return slug;
  }

  /**
   * Fixtures.
   *
   * `bucket` picks the endpoint: `running` is live now, `upcoming` is scheduled,
   * `past` is finished, and no bucket returns everything ordered by date.
   */
  public async getMatches(
    titleId: string,
    options: {
      bucket?: "running" | "upcoming" | "past";
      page?: number;
      perPage?: number;
      since?: number;
      until?: number;
    } = {},
  ): Promise<PandaScoreMatch[]> {
    const slug = this.slug(titleId);
    const bucket = options.bucket ? `/${options.bucket}` : "";
    // Live fixtures move constantly; finished ones never change again.
    const ttl = options.bucket === "running" ? TTL.esportsMatchesLive : TTL.esportsMatches;
    return this.cached(
      [slug, "matches", options.bucket ?? "all", options.page ?? 1, options.perPage ?? 50],
      "getEsportsMatches",
      titleId,
      ttl ?? 300,
      async () => {
        const matches = await this.get<PandaScoreMatch[] | null>(
          `/${slug}/matches${bucket}`,
          {
            query: {
              page: options.page ?? 1,
              per_page: Math.min(options.perPage ?? 50, 100),
              "range[begin_at]": rangeFilter(options.since, options.until),
              sort: options.bucket === "past" ? "-begin_at" : "begin_at",
            },
            nullOn404: true,
          },
        );
        return matches ?? [];
      },
    );
  }

  /** One fixture in full, with games and per-map results. */
  public async getMatch(matchId: string, titleId: string): Promise<PandaScoreMatch> {
    return this.cached(
      ["match", matchId],
      "getMatch",
      titleId,
      TTL.match ?? 86_400,
      async () => {
        const match = await this.get<PandaScoreMatch | null>(`/matches/${matchId}`, {
          nullOn404: true,
        });
        if (!match) throw new NotFoundError(this.id, `match ${matchId}`, titleId);
        return match;
      },
    );
  }

  /** Tournaments, which PandaScore nests under leagues and series. */
  public async getTournaments(
    titleId: string,
    options: { bucket?: "running" | "upcoming" | "past"; page?: number; perPage?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const slug = this.slug(titleId);
    const bucket = options.bucket ? `/${options.bucket}` : "";
    return this.cached(
      [slug, "tournaments", options.bucket ?? "all", options.page ?? 1],
      "getEsportsTournaments",
      titleId,
      TTL.esportsTournaments ?? 1_800,
      async () => {
        const tournaments = await this.get<Record<string, unknown>[] | null>(
          `/${slug}/tournaments${bucket}`,
          {
            query: { page: options.page ?? 1, per_page: Math.min(options.perPage ?? 50, 100) },
            nullOn404: true,
          },
        );
        return tournaments ?? [];
      },
    );
  }

  /** Teams, with their current roster. */
  public async getTeams(
    titleId: string,
    options: { page?: number; perPage?: number; search?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    const slug = this.slug(titleId);
    return this.cached(
      [slug, "teams", options.page ?? 1, options.search ?? "-"],
      "getEsportsTeams",
      titleId,
      TTL.esportsTeams ?? 3_600,
      async () => {
        const teams = await this.get<Record<string, unknown>[] | null>(`/${slug}/teams`, {
          query: {
            page: options.page ?? 1,
            per_page: Math.min(options.perPage ?? 50, 100),
            "search[name]": options.search,
          },
          nullOn404: true,
        });
        return teams ?? [];
      },
    );
  }

  /** Professional players. */
  public async getPlayers(
    titleId: string,
    options: { page?: number; perPage?: number; search?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    const slug = this.slug(titleId);
    return this.cached(
      [slug, "players", options.page ?? 1, options.search ?? "-"],
      "getEsportsPlayers",
      titleId,
      TTL.esportsPlayers ?? 3_600,
      async () => {
        const players = await this.get<Record<string, unknown>[] | null>(`/${slug}/players`, {
          query: {
            page: options.page ?? 1,
            per_page: Math.min(options.perPage ?? 50, 100),
            "search[name]": options.search,
          },
          nullOn404: true,
        });
        return players ?? [];
      },
    );
  }

  /** Standings for one tournament. */
  public async getStandings(
    tournamentId: string,
    titleId: string,
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["standings", tournamentId],
      "getStandings",
      titleId,
      TTL.standings ?? 600,
      async () => {
        const standings = await this.get<Record<string, unknown>[] | null>(
          `/tournaments/${tournamentId}/standings`,
          { nullOn404: true },
        );
        return standings ?? [];
      },
    );
  }

  /** Leagues, the top level of PandaScore's hierarchy. */
  public async getLeagues(titleId: string, page = 1): Promise<Record<string, unknown>[]> {
    const slug = this.slug(titleId);
    const leagues = await this.get<Record<string, unknown>[] | null>(`/${slug}/leagues`, {
      query: { page, per_page: 100 },
      nullOn404: true,
    });
    return leagues ?? [];
  }
}

// ---------------------------------------------------------------------------
// Abios
// ---------------------------------------------------------------------------

/**
 * Abios Gaming (Atlas).
 *
 * A commercial alternative to PandaScore with broadly the same coverage.
 * Included because a caller who already pays for one should not have to pay for
 * the other; the normalised output is identical either way.
 */
export class AbiosProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("abios", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    const [clientId, secret] = this.requireKeyParts(2, "clientId:secret");
    return {
      ...spec,
      headers: {
        "Abios-Secret": secret as string,
        ...spec.headers,
      },
      query: { client_id: clientId, ...spec.query },
    };
  }

  /** The Abios game ids, discovered once rather than hard-coded. */
  public async getGames(): Promise<{ id: number; title?: string; slug?: string }[]> {
    return this.cached(["games"], "getMetadata", "esports", TTL.metadata ?? 3_600, async () => {
      const response = await this.get<{ data?: { id: number; title?: string; slug?: string }[] }>(
        "/games",
      );
      return response?.data ?? [];
    });
  }

  /** Resolve a title id onto an Abios game id by matching the slug or title. */
  public async gameId(titleId: string, titleName: string): Promise<number> {
    const games = await this.getGames();
    const normalise = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const wanted = [normalise(titleId), normalise(titleName)];
    const match = games.find(
      (game) =>
        wanted.includes(normalise(game.slug ?? "")) || wanted.includes(normalise(game.title ?? "")),
    );
    if (!match) throw new ValidationError(`Abios does not cover "${titleId}"`);
    return match.id;
  }

  /**
   * Fixtures ("series" in Abios vocabulary).
   *
   * No date filter. Abios has one, but this method used to accept `since` and
   * `until` and send neither - a parameter that silently does nothing is worse
   * than one that is absent, because a caller filtering by date would get every
   * fixture back and have no way to tell. Results are ordered newest first, so
   * paging is the honest way to bound them for now.
   */
  public async getSeries(
    gameId: number,
    options: { take?: number; skip?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ data?: Record<string, unknown>[] }>("/series", {
      query: {
        "filter[]": `games.id=${gameId}`,
        take: Math.min(options.take ?? 50, 50),
        skip: options.skip ?? 0,
        order: "start desc",
      },
      nullOn404: true,
    });
    return response?.data ?? [];
  }

  /** Tournaments. */
  public async getTournaments(gameId: number, take = 50): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ data?: Record<string, unknown>[] }>("/tournaments", {
      query: { "filter[]": `games.id=${gameId}`, take: Math.min(take, 50) },
      nullOn404: true,
    });
    return response?.data ?? [];
  }

  /** Teams. */
  public async getTeams(gameId: number, take = 50): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ data?: Record<string, unknown>[] }>("/teams", {
      query: { "filter[]": `game.id=${gameId}`, take: Math.min(take, 50) },
      nullOn404: true,
    });
    return response?.data ?? [];
  }

  /** Professional players. */
  public async getPlayers(gameId: number, take = 50): Promise<Record<string, unknown>[]> {
    const response = await this.get<{ data?: Record<string, unknown>[] }>("/players", {
      query: { "filter[]": `game.id=${gameId}`, take: Math.min(take, 50) },
      nullOn404: true,
    });
    return response?.data ?? [];
  }
}

// ---------------------------------------------------------------------------
// Esports Earnings
// ---------------------------------------------------------------------------

/**
 * Esports Earnings.
 *
 * Career prize money for every title that has ever paid any, which makes it the
 * one provider that genuinely covers the whole industry - including titles that
 * have no other structured data at all.
 *
 * Two conditions of use, both enforced here rather than left to the caller:
 * **at most one request per second** (the registry sets `rps: 1, burst: 1`), and
 * results are returned 100 at a time with an explicit `offset`.
 */
export class EsportsEarningsProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("esports-earnings", runtime);
  }

  protected override authQueryName(): string {
    return "apikey";
  }

  /** Search players by handle. */
  public async lookupPlayerByName(name: string): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["player-name", name.toLowerCase()],
      "getEarnings",
      "esports",
      TTL.earnings ?? 43_200,
      async () => {
        const players = await this.get<Record<string, unknown>[] | null>(
          "/LookupPlayerByName",
          { query: { format: "json", name }, nullOn404: true },
        );
        return players ?? [];
      },
    );
  }

  /** One player's totals, by their Esports Earnings id. */
  public async lookupPlayerById(playerId: string | number): Promise<Record<string, unknown>> {
    return this.cached(
      ["player", playerId],
      "getEarnings",
      "esports",
      TTL.earnings ?? 43_200,
      async () => {
        const player = await this.get<Record<string, unknown> | null>("/LookupPlayerById", {
          query: { format: "json", playerid: playerId },
          nullOn404: true,
        });
        if (!player || Object.keys(player).length === 0) {
          throw new NotFoundError(this.id, `player ${playerId}`);
        }
        return player;
      },
    );
  }

  /** Prize money split by game, for one player. */
  public async lookupPlayerTournaments(
    playerId: string | number,
    offset = 0,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.get<Record<string, unknown>[] | null>(
      "/LookupPlayerTournaments",
      { query: { format: "json", playerid: playerId, offset }, nullOn404: true },
    );
    return rows ?? [];
  }

  /** Earnings by game for one player - the breakdown a profile card wants. */
  public async lookupPlayerGames(playerId: string | number): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["player-games", playerId],
      "getEarnings",
      "esports",
      TTL.earnings ?? 43_200,
      async () => {
        const rows = await this.get<Record<string, unknown>[] | null>(
          "/LookupPlayerTournaments",
          { query: { format: "json", playerid: playerId, offset: 0 }, nullOn404: true },
        );
        return rows ?? [];
      },
    );
  }

  /** The highest-earning players overall, 100 at a time. */
  public async getHighestEarningPlayers(offset = 0): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["top-players", offset],
      "getEarnings",
      "esports",
      TTL.earnings ?? 43_200,
      async () => {
        const rows = await this.get<Record<string, unknown>[] | null>(
          "/LookupHighestEarningPlayers",
          { query: { format: "json", offset }, nullOn404: true },
        );
        return rows ?? [];
      },
    );
  }

  /** The highest-earning players for one game. */
  public async getHighestEarningPlayersForGame(
    gameId: string | number,
    offset = 0,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.get<Record<string, unknown>[] | null>(
      "/LookupHighestEarningPlayersByGame",
      { query: { format: "json", gameid: gameId, offset }, nullOn404: true },
    );
    return rows ?? [];
  }

  /** The game list, so a title can be matched onto an Esports Earnings id. */
  public async getGames(offset = 0): Promise<Record<string, unknown>[]> {
    return this.cached(["games", offset], "getMetadata", "esports", TTL.metadata ?? 3_600, async () => {
      const rows = await this.get<Record<string, unknown>[] | null>("/LookupGameById", {
        query: { format: "json", offset },
        nullOn404: true,
      });
      return rows ?? [];
    });
  }

  /** Overall totals for one game, including the number of tournaments. */
  public async getGameById(gameId: string | number): Promise<Record<string, unknown> | null> {
    return this.get<Record<string, unknown> | null>("/LookupGameById", {
      query: { format: "json", gameid: gameId },
      nullOn404: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Liquipedia
// ---------------------------------------------------------------------------

/**
 * Liquipedia, through the MediaWiki API.
 *
 * The catch-all. Every esports title has a Liquipedia wiki, including the ones
 * with no structured data anywhere else, so this is what keeps the registry
 * honest about coverage.
 *
 * What you get back is **wikitext**, not clean records - that is the trade-off
 * for universal coverage, and it is why the title clients above use Liquipedia
 * for tournament listings and not for player statistics.
 *
 * The terms of use are not optional and are enforced here:
 * - at most one request every two seconds (`rps: 0.5` in the registry),
 * - a User-Agent naming your application and a contact address,
 * - parsed results cached for 30 days.
 */
export class LiquipediaProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("liquipedia", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  /** Liquipedia's wiki name for a title, which is not always the title id. */
  public wiki(titleId: string): string {
    const overrides: Record<string, string> = {
      cs2: "counterstrike",
      dota2: "dota2",
      "league-of-legends": "leagueoflegends",
      "teamfight-tactics": "teamfighttactics",
      "legends-of-runeterra": "legendsofruneterra",
      "wild-rift": "wildrift",
      "overwatch-2": "overwatch",
      "starcraft-2": "starcraft2",
      "starcraft-brood-war": "starcraft",
      "warcraft-3": "warcraft",
      "heroes-of-the-storm": "heroes",
      "world-of-warcraft": "worldofwarcraft",
      "destiny-2": "destiny",
      "halo-infinite": "halo",
      "team-fortress-2": "teamfortress",
      "rainbow-six-siege": "rainbowsix",
      "apex-legends": "apexlegends",
      "call-of-duty": "callofduty",
      "rocket-league": "rocketleague",
      "pubg-mobile": "pubgmobile",
      "mobile-legends": "mobilelegends",
      "honor-of-kings": "honorofkings",
      "arena-of-valor": "arenaofvalor",
      "free-fire": "freefire",
      "ea-fc": "easportsfc",
      "street-fighter-6": "fighters",
      "tekken-8": "fighters",
      "super-smash-bros-ultimate": "smash",
      "super-smash-bros-melee": "smash",
      "mortal-kombat-1": "fighters",
      "guilty-gear-strive": "fighters",
      "dragon-ball-fighterz": "fighters",
      "king-of-fighters-15": "fighters",
      "granblue-fantasy-versus-rising": "fighters",
      "age-of-empires-2": "ageofempires",
      "age-of-empires-4": "ageofempires",
      "company-of-heroes-3": "companyofheroes",
      "magic-the-gathering-arena": "magic",
      "world-of-tanks": "worldoftanks",
      "world-of-warships": "worldofwarships",
      "war-thunder": "warthunder",
      "guild-wars-2": "guildwars",
      "path-of-exile": "pathofexile",
      "albion-online": "albion",
      "beat-saber": "beatsaber",
      "the-finals": "thefinals",
      "marvel-rivals": "marvelrivals",
      "escape-from-tarkov": "escapefromtarkov",
      "assetto-corsa-competizione": "simracing",
      "gran-turismo-7": "simracing",
      iracing: "simracing",
      f1: "simracing",
      "nba-2k": "sports",
      "madden-nfl": "sports",
      "quake-champions": "quake",
      "point-blank": "pointblank",
      "dead-by-daylight": "deadbydaylight",
      "fall-guys": "fallguys",
      "naraka-bladepoint": "naraka",
      "pokemon-unite": "pokemon",
      "splatoon-3": "splatoon",
      chess: "chess",
    };
    return overrides[titleId] ?? titleId.replace(/-/g, "");
  }

  /**
   * Search a wiki.
   *
   * `list=search` rather than `action=parse`, because search results are cheap
   * and parsing is the expensive call the terms of use ask you to cache.
   */
  public async search(
    titleId: string,
    query: string,
    limit = 10,
  ): Promise<{ title: string; snippet?: string }[]> {
    const wiki = this.wiki(titleId);
    return this.cached(
      [wiki, "search", query.toLowerCase(), limit],
      "getEsportsTournaments",
      titleId,
      // Deliberately long: the terms of use ask for aggressive caching.
      30 * 86_400,
      async () => {
        const response = await this.get<{
          query?: { search?: { title: string; snippet?: string }[] };
        }>(`/${wiki}/api.php`, {
          query: {
            action: "query",
            list: "search",
            srsearch: query,
            srlimit: Math.min(limit, 50),
            format: "json",
          },
          nullOn404: true,
        });
        return response?.query?.search ?? [];
      },
    );
  }

  /** The wikitext of one page. */
  public async getPage(titleId: string, page: string): Promise<string> {
    const wiki = this.wiki(titleId);
    return this.cached([wiki, "page", page], "getMetadata", titleId, 30 * 86_400, async () => {
      const response = await this.get<{
        parse?: { wikitext?: { "*"?: string } };
      }>(`/${wiki}/api.php`, {
        query: { action: "parse", page, prop: "wikitext", format: "json" },
        nullOn404: true,
      });
      const text = response?.parse?.wikitext?.["*"];
      if (typeof text !== "string") {
        throw new NotFoundError(this.id, `Liquipedia page "${page}" on ${wiki}`, titleId);
      }
      return text;
    });
  }

  /**
   * Pages in a category - how tournament listings are actually retrieved.
   *
   * `Category:Tournaments` on any wiki is the index of that title's events.
   */
  public async getCategoryMembers(
    titleId: string,
    category: string,
    limit = 50,
  ): Promise<{ title: string; pageid: number }[]> {
    const wiki = this.wiki(titleId);
    return this.cached(
      [wiki, "category", category, limit],
      "getEsportsTournaments",
      titleId,
      30 * 86_400,
      async () => {
        const response = await this.get<{
          query?: { categorymembers?: { title: string; pageid: number }[] };
        }>(`/${wiki}/api.php`, {
          query: {
            action: "query",
            list: "categorymembers",
            cmtitle: category.startsWith("Category:") ? category : `Category:${category}`,
            cmlimit: Math.min(limit, 500),
            format: "json",
          },
          nullOn404: true,
        });
        return response?.query?.categorymembers ?? [];
      },
    );
  }

  /** The URL of a page, for linking a user to the source. */
  public pageUrl(titleId: string, page: string): string {
    return `https://liquipedia.net/${this.wiki(titleId)}/${encodeURIComponent(page.replace(/ /g, "_"))}`;
  }
}

/** PandaScore's `range[begin_at]` filter, or `undefined` when unbounded. */
function rangeFilter(since?: number, until?: number): string | undefined {
  if (since === undefined && until === undefined) return undefined;
  const from = new Date(since ?? 0).toISOString();
  const to = new Date(until ?? Date.now() + 365 * 86_400_000).toISOString();
  return `${from},${to}`;
}
