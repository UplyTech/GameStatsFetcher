/**
 * The tournament platforms: start.gg, Toornament and Challonge.
 *
 * For the fighting games this is not supplementary data - it *is* the
 * competitive record. Capcom, Bandai Namco, NetherRealm and Arc System Works
 * publish no player API and no results API; every Evo bracket, every regional,
 * every weekly lives on start.gg, and that is where a Tekken 8 or Street
 * Fighter 6 result comes from.
 */

import { ProviderClient } from "./base.js";
import type { RequestSpec } from "../http.js";
import { AuthenticationError, NotFoundError, ValidationError } from "../errors.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

// ---------------------------------------------------------------------------
// start.gg
// ---------------------------------------------------------------------------

/**
 * start.gg (formerly smash.gg).
 *
 * GraphQL, 80 requests per minute, and one design decision worth explaining:
 * **videogame ids are looked up rather than hard-coded.** start.gg's numeric
 * ids are stable but undocumented, and a wrong constant would silently return
 * another game's tournaments - which is far worse than one extra cached call.
 */
export class StartGgProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("startgg", runtime);
  }

  /** Resolve a game name to a start.gg videogame id, once per runtime. */
  public async videogameId(titleName: string): Promise<number> {
    return this.memo(`videogame:${titleName.toLowerCase()}`, 24 * 3_600 * 1_000, async () => {
      const data = await this.graphql<{
        videogames?: { nodes?: { id: number; name: string; displayName?: string }[] };
      }>(
        `query Videogames($name: String!) {
          videogames(query: { filter: { name: $name }, perPage: 8 }) {
            nodes { id name displayName }
          }
        }`,
        { name: titleName },
      );
      const nodes = data.videogames?.nodes ?? [];
      const normalise = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
      const wanted = normalise(titleName);
      const exact = nodes.find(
        (node) => normalise(node.name) === wanted || normalise(node.displayName ?? "") === wanted,
      );
      const chosen = exact ?? nodes[0];
      if (!chosen) {
        throw new ValidationError(`start.gg has no videogame matching "${titleName}"`);
      }
      return chosen.id;
    });
  }

  /** Tournaments for a game, ordered by start date. */
  public async getTournaments(
    titleId: string,
    titleName: string,
    options: { page?: number; perPage?: number; since?: number; until?: number; upcoming?: boolean } = {},
  ): Promise<Record<string, unknown>[]> {
    const videogameId = await this.videogameId(titleName);
    return this.cached(
      [videogameId, "tournaments", options.page ?? 1, options.upcoming ? "up" : "all"],
      "getEsportsTournaments",
      titleId,
      TTL.esportsTournaments ?? 1_800,
      async () => {
        const data = await this.graphql<{
          tournaments?: { nodes?: Record<string, unknown>[] };
        }>(
          `query Tournaments($videogameId: ID!, $page: Int!, $perPage: Int!, $afterDate: Timestamp, $beforeDate: Timestamp) {
            tournaments(query: {
              page: $page
              perPage: $perPage
              sortBy: "startAt asc"
              filter: {
                videogameIds: [$videogameId]
                afterDate: $afterDate
                beforeDate: $beforeDate
              }
            }) {
              nodes {
                id
                name
                slug
                startAt
                endAt
                numAttendees
                isOnline
                countryCode
                city
                venueName
                events { id name numEntrants videogame { id name } }
              }
            }
          }`,
          {
            videogameId,
            page: options.page ?? 1,
            perPage: Math.min(options.perPage ?? 25, 50),
            // start.gg takes seconds, and `undefined` means unbounded.
            afterDate: options.since
              ? Math.floor(options.since / 1_000)
              : options.upcoming
                ? Math.floor(Date.now() / 1_000)
                : undefined,
            beforeDate: options.until ? Math.floor(options.until / 1_000) : undefined,
          },
        );
        return data.tournaments?.nodes ?? [];
      },
    );
  }

  /** One tournament by slug, with its events. */
  public async getTournament(slug: string, titleId: string): Promise<Record<string, unknown>> {
    return this.cached(
      ["tournament", slug],
      "getEsportsTournaments",
      titleId,
      TTL.esportsTournaments ?? 1_800,
      async () => {
        const data = await this.graphql<{ tournament?: Record<string, unknown> }>(
          `query Tournament($slug: String!) {
            tournament(slug: $slug) {
              id name slug startAt endAt numAttendees isOnline countryCode city venueName
              events { id name slug numEntrants state videogame { id name } }
            }
          }`,
          { slug },
        );
        if (!data.tournament) {
          throw new NotFoundError(this.id, `start.gg tournament "${slug}"`, titleId);
        }
        return data.tournament;
      },
    );
  }

  /**
   * Sets (matches) in one event.
   *
   * This is the fighting-game equivalent of a match list: two entrants, a
   * score, a round and a bracket position.
   */
  public async getEventSets(
    eventId: string | number,
    titleId: string,
    options: { page?: number; perPage?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["sets", eventId, options.page ?? 1],
      "getEsportsMatches",
      titleId,
      TTL.esportsMatches ?? 300,
      async () => {
        const data = await this.graphql<{
          event?: { sets?: { nodes?: Record<string, unknown>[] } };
        }>(
          `query EventSets($eventId: ID!, $page: Int!, $perPage: Int!) {
            event(id: $eventId) {
              id
              name
              sets(page: $page, perPage: $perPage, sortType: STANDARD) {
                nodes {
                  id
                  round
                  fullRoundText
                  startedAt
                  completedAt
                  winnerId
                  displayScore
                  slots {
                    id
                    standing { placement stats { score { value } } }
                    entrant { id name participants { player { id gamerTag } } }
                  }
                }
              }
            }
          }`,
          {
            eventId,
            page: options.page ?? 1,
            perPage: Math.min(options.perPage ?? 40, 60),
          },
        );
        return data.event?.sets?.nodes ?? [];
      },
    );
  }

  /** Final placements for one event. */
  public async getEventStandings(
    eventId: string | number,
    titleId: string,
    options: { page?: number; perPage?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    return this.cached(
      ["standings", eventId, options.page ?? 1],
      "getStandings",
      titleId,
      TTL.standings ?? 600,
      async () => {
        const data = await this.graphql<{
          event?: { standings?: { nodes?: Record<string, unknown>[] } };
        }>(
          `query EventStandings($eventId: ID!, $page: Int!, $perPage: Int!) {
            event(id: $eventId) {
              standings(query: { page: $page, perPage: $perPage }) {
                nodes {
                  placement
                  entrant { id name participants { player { id gamerTag } user { location { country } } } }
                }
              }
            }
          }`,
          { eventId, page: options.page ?? 1, perPage: Math.min(options.perPage ?? 32, 64) },
        );
        return data.event?.standings?.nodes ?? [];
      },
    );
  }

  /** A player, by their start.gg id. */
  public async getPlayer(playerId: string | number, titleId: string): Promise<Record<string, unknown>> {
    return this.cached(
      ["player", playerId],
      "getEsportsPlayers",
      titleId,
      TTL.esportsPlayers ?? 3_600,
      async () => {
        const data = await this.graphql<{ player?: Record<string, unknown> }>(
          `query Player($id: ID!) {
            player(id: $id) {
              id
              gamerTag
              prefix
              user { name location { country city } authorizations { type externalUsername } }
            }
          }`,
          { id: playerId },
        );
        if (!data.player) throw new NotFoundError(this.id, `start.gg player ${playerId}`, titleId);
        return data.player;
      },
    );
  }

  /** Search players by gamer tag. */
  public async searchPlayers(gamerTag: string): Promise<Record<string, unknown>[]> {
    const data = await this.graphql<{ players?: { nodes?: Record<string, unknown>[] } }>(
      `query SearchPlayers($tag: String!) {
        players(query: { filter: { gamerTag: $tag }, perPage: 20 }) {
          nodes { id gamerTag prefix user { name location { country } } }
        }
      }`,
      { tag: gamerTag },
    );
    return data.players?.nodes ?? [];
  }
}

// ---------------------------------------------------------------------------
// Toornament
// ---------------------------------------------------------------------------

/**
 * Toornament.
 *
 * Grassroots and mid-tier events across every title. Authentication is two
 * pieces at once: an `X-Api-Key` header *and* an OAuth2 bearer token, which is
 * why the credential is three colon-separated values.
 */
export class ToornamentProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("toornament", runtime);
  }

  private async accessToken(): Promise<string> {
    const [, clientId, clientSecret] = this.requireKeyParts(
      3,
      "apiKey:clientId:clientSecret",
    );
    return this.memo("token", 3_600 * 1_000, async () => {
      const response = await this.runtime.http.send<{ access_token?: string }>(
        this.id,
        "https://api.toornament.com/oauth/v2/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: String(clientId),
            client_secret: String(clientSecret),
            scope: "organizer:view",
          }).toString(),
        },
      );
      if (!response?.access_token) {
        throw new AuthenticationError(this.id, "token endpoint returned no access_token");
      }
      return response.access_token;
    });
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    const [apiKey] = this.requireKeyParts(3, "apiKey:clientId:clientSecret");
    const token = await this.accessToken();
    return {
      ...spec,
      headers: {
        "X-Api-Key": apiKey as string,
        Authorization: `Bearer ${token}`,
        ...spec.headers,
      },
    };
  }

  /** Featured tournaments, optionally filtered by discipline. */
  public async getTournaments(
    discipline?: string,
    options: { range?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    const tournaments = await this.get<Record<string, unknown>[] | null>("/tournaments", {
      query: { discipline },
      // Toornament pages with an HTTP Range header rather than query params.
      headers: { Range: options.range ?? "tournaments=0-49" },
      nullOn404: true,
    });
    return tournaments ?? [];
  }

  /** Matches within one tournament. */
  public async getMatches(
    tournamentId: string,
    range = "matches=0-49",
  ): Promise<Record<string, unknown>[]> {
    const matches = await this.get<Record<string, unknown>[] | null>(
      `/tournaments/${tournamentId}/matches`,
      { headers: { Range: range }, nullOn404: true },
    );
    return matches ?? [];
  }

  /** Final standings for one tournament. */
  public async getStandings(
    tournamentId: string,
    range = "rankings=0-49",
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.get<Record<string, unknown>[] | null>(
      `/tournaments/${tournamentId}/stages`,
      { headers: { Range: range }, nullOn404: true },
    );
    return rows ?? [];
  }

  /** Participants of one tournament. */
  public async getParticipants(
    tournamentId: string,
    range = "participants=0-49",
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.get<Record<string, unknown>[] | null>(
      `/tournaments/${tournamentId}/participants`,
      { headers: { Range: range }, nullOn404: true },
    );
    return rows ?? [];
  }

  /** The discipline list, which is Toornament's word for "title". */
  public async getDisciplines(): Promise<Record<string, unknown>[]> {
    return this.cached(["disciplines"], "getMetadata", "esports", TTL.metadata ?? 3_600, async () => {
      const rows = await this.get<Record<string, unknown>[] | null>("/disciplines", {
        headers: { Range: "disciplines=0-99" },
        nullOn404: true,
      });
      return rows ?? [];
    });
  }
}

// ---------------------------------------------------------------------------
// Challonge
// ---------------------------------------------------------------------------

/**
 * Challonge.
 *
 * Title-agnostic by design: a Challonge bracket does not know what game it is
 * for. That makes it the right home for a community event in a title nothing
 * else covers, and the wrong place to look for a title's whole circuit.
 */
export class ChallongeProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("challonge", runtime);
  }

  protected override authQueryName(): string {
    return "api_key";
  }

  /** Tournaments visible to the key's account. */
  public async getTournaments(options: {
    state?: "pending" | "in_progress" | "ended";
    createdAfter?: string;
  } = {}): Promise<Record<string, unknown>[]> {
    const rows = await this.get<{ tournament?: Record<string, unknown> }[] | null>(
      "/tournaments.json",
      {
        query: { state: options.state, created_after: options.createdAfter },
        nullOn404: true,
      },
    );
    return (rows ?? []).map((row) => row.tournament ?? row);
  }

  /** One tournament by id or url slug. */
  public async getTournament(idOrUrl: string): Promise<Record<string, unknown>> {
    const response = await this.get<{ tournament?: Record<string, unknown> } | null>(
      `/tournaments/${idOrUrl}.json`,
      { query: { include_participants: 1, include_matches: 1 }, nullOn404: true },
    );
    if (!response?.tournament) {
      throw new NotFoundError(this.id, `Challonge tournament "${idOrUrl}"`);
    }
    return response.tournament;
  }

  /** Matches of one tournament. */
  public async getMatches(idOrUrl: string): Promise<Record<string, unknown>[]> {
    const rows = await this.get<{ match?: Record<string, unknown> }[] | null>(
      `/tournaments/${idOrUrl}/matches.json`,
      { nullOn404: true },
    );
    return (rows ?? []).map((row) => row.match ?? row);
  }

  /** Participants of one tournament, with their final placement. */
  public async getParticipants(idOrUrl: string): Promise<Record<string, unknown>[]> {
    const rows = await this.get<{ participant?: Record<string, unknown> }[] | null>(
      `/tournaments/${idOrUrl}/participants.json`,
      { nullOn404: true },
    );
    return (rows ?? []).map((row) => row.participant ?? row);
  }
}
