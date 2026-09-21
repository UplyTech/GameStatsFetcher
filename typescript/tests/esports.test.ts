import { describe, expect, it } from "vitest";
import { GameStatsClient } from "../src/client.js";
import {
  AllProvidersFailedError,
  MissingCredentialError,
  UnsupportedCapabilityError,
} from "../src/errors.js";
import { mockFetch, testOptions } from "./helpers.js";

/** A PandaScore fixture, trimmed to the fields the normaliser reads. */
const PANDASCORE_MATCH = {
  id: 1,
  name: "G2 vs FNC",
  status: "not_started",
  scheduled_at: "2026-09-10T17:00:00Z",
  begin_at: null,
  end_at: null,
  number_of_games: 3,
  winner_id: null,
  opponents: [
    { type: "Team", opponent: { id: 10, name: "G2 Esports", acronym: "G2", image_url: "https://i.test/g2.png" } },
    { type: "Team", opponent: { id: 11, name: "Fnatic", acronym: "FNC", image_url: null } },
  ],
  results: [
    { team_id: 10, score: 0 },
    { team_id: 11, score: 0 },
  ],
  streams_list: [{ raw_url: "https://twitch.tv/lec", language: "en", official: true }],
  tournament: { id: 500, name: "Summer Split", slug: "lec-summer" },
  league: { id: 4, name: "LEC" },
};

describe("fixtures", () => {
  it("normalises a PandaScore match into the canonical shape", async () => {
    const mock = mockFetch([{ match: "api.pandascore.co", body: [PANDASCORE_MATCH] }]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { pandascore: "k" } }));

    const [match] = await client.lol.getEsportsMatches({ status: "scheduled" });
    expect(match).toMatchObject({
      id: "1",
      titleId: "league-of-legends",
      status: "scheduled",
      bestOf: 3,
      providerId: "pandascore",
    });
    expect(match?.scheduledAt).toBe(Date.parse("2026-09-10T17:00:00Z"));
    expect(match?.opponents).toHaveLength(2);
    expect(match?.opponents[0]).toMatchObject({ name: "G2 Esports", acronym: "G2", score: 0 });
    expect(match?.streams[0]).toMatchObject({ url: "https://twitch.tv/lec", official: true });
    expect(match?.tournament).toMatchObject({ id: "500", name: "Summer Split" });
  });

  it("maps every provider's status vocabulary onto one", async () => {
    const mock = mockFetch([
      {
        match: "api.pandascore.co",
        body: [
          { ...PANDASCORE_MATCH, id: 1, status: "running" },
          { ...PANDASCORE_MATCH, id: 2, status: "finished" },
          { ...PANDASCORE_MATCH, id: 3, status: "canceled" },
          { ...PANDASCORE_MATCH, id: 4, status: "who knows" },
        ],
      },
    ]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { pandascore: "k" } }));
    const matches = await client.lol.getEsportsMatches();
    expect(matches.map((match) => match.status)).toEqual([
      "live",
      "finished",
      "cancelled",
      "unknown",
    ]);
  });

  it("picks the live endpoint for a live query and the cheap TTL with it", async () => {
    const mock = mockFetch([{ match: "matches/running", body: [] }]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { pandascore: "k" } }));
    await client.lol.getEsportsMatches({ status: "live" });
    expect(mock.calls[0]).toContain("/matches/running");
  });

  it("uses start.gg for a fighting game and reads its sets as fixtures", async () => {
    const mock = mockFetch([
      {
        match: "api.start.gg",
        sequence: [
          // The videogame lookup comes first, then tournaments, then sets.
          { body: { data: { videogames: { nodes: [{ id: 49_783, name: "Tekken 8" }] } } } },
          {
            body: {
              data: {
                tournaments: {
                  nodes: [
                    {
                      id: 1,
                      name: "EVO Japan",
                      slug: "evo-japan",
                      startAt: 1_760_000_000,
                      events: [{ id: 99, name: "Tekken 8 Singles" }],
                    },
                  ],
                },
              },
            },
          },
          {
            body: {
              data: {
                event: {
                  sets: {
                    nodes: [
                      {
                        id: 7,
                        fullRoundText: "Grand Final",
                        completedAt: 1_760_010_000,
                        winnerId: 42,
                        slots: [
                          { entrant: { id: 42, name: "Arslan Ash" }, standing: { stats: { score: { value: 3 } } } },
                          { entrant: { id: 43, name: "Knee" }, standing: { stats: { score: { value: 1 } } } },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
        ],
      },
    ]);

    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { startgg: "k" } }));
    const [set] = await client.title("tekken-8").getEsportsMatches();

    expect(set).toMatchObject({
      id: "7",
      titleId: "tekken-8",
      name: "Grand Final",
      status: "finished",
      winnerId: "42",
      providerId: "startgg",
    });
    // A fighting-game entrant is a person, not an organisation.
    expect(set?.opponents[0]).toMatchObject({ name: "Arslan Ash", score: 3, kind: "player" });
  });
});

describe("provider selection", () => {
  it("skips a provider whose key was never configured", async () => {
    const mock = mockFetch([
      { match: "api.start.gg", body: { data: { videogames: { nodes: [] } } } },
      { match: "api.pandascore.co", body: [] },
      { match: "liquipedia.net", body: { query: { categorymembers: [] } } },
    ]);
    // Street Fighter 6 prefers start.gg, then PandaScore, then Liquipedia.
    // With neither key configured, the first two are skipped without costing a
    // request and Liquipedia - which needs none - answers.
    const client = new GameStatsClient(testOptions(mock.fetch));
    await client.title("street-fighter-6").getEsportsTournaments();

    expect(mock.calls.every((url) => url.includes("liquipedia.net"))).toBe(true);
    expect(mock.countOf("api.start.gg")).toBe(0);
    expect(mock.countOf("pandascore")).toBe(0);
  });

  it("has nothing to try when every provider for a capability needs a key", async () => {
    const mock = mockFetch([]);
    const client = new GameStatsClient(testOptions(mock.fetch));
    // Deadlock's only esports provider is Liquipedia, which cannot serve teams
    // - so asking for them is unsupported rather than merely unconfigured.
    await expect(client.deadlock.getEsportsTeams()).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
    expect(mock.calls).toHaveLength(0);
  });

  it("honours an explicit provider override", async () => {
    const mock = mockFetch([{ match: "api.pandascore.co", body: [] }]);
    const client = new GameStatsClient(
      testOptions(mock.fetch, { apiKeys: { pandascore: "k", startgg: "s" } }),
    );
    await client.title("street-fighter-6").getEsportsMatches({ provider: "pandascore" });
    expect(mock.calls.every((url) => url.includes("pandascore"))).toBe(true);
  });

  it("does not silently switch provider unless fallback is enabled", async () => {
    const mock = mockFetch([{ match: "api.pandascore.co", status: 500 }]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { pandascore: "k" } }));
    // A silent switch to a community mirror changes whose terms of service
    // apply, so it has to be a decision rather than a default.
    await expect(client.lol.getEsportsMatches()).rejects.toMatchObject({ code: "HTTP_ERROR" });
  });

  it("tries the next provider when fallback is on, and reports every failure", async () => {
    const mock = mockFetch([
      { match: "api.pandascore.co", status: 500 },
      { match: "liquipedia.net", status: 503 },
    ]);
    const client = new GameStatsClient(
      testOptions(mock.fetch, { apiKeys: { pandascore: "k" }, fallback: true }),
    );
    try {
      await client.lol.getEsportsTournaments();
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AllProvidersFailedError);
      const failures = (error as AllProvidersFailedError).failures;
      expect(failures.map((failure) => failure.provider)).toContain("pandascore");
      expect(failures.length).toBeGreaterThan(1);
    }
  });

  it("refuses a title PandaScore does not cover, naming what it does", async () => {
    const mock = mockFetch([]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { pandascore: "k" } }));
    await expect(
      client.title("tekken-8").getEsportsMatches({ provider: "pandascore" }),
    ).rejects.toThrow(/does not cover/);
  });
});

describe("prize money", () => {
  it("reports earnings in integer cents, never as a float", async () => {
    const mock = mockFetch([
      {
        match: "LookupPlayerByName",
        body: [{ PlayerId: 1, CurrentHandle: "N0tail" }],
      },
      {
        match: "LookupPlayerById",
        body: {
          PlayerId: 1,
          CurrentHandle: "N0tail",
          NameFirst: "Johan",
          NameLast: "Sundstein",
          CountryCode: "dk",
          TotalUSDPrize: 7_184_163.28,
        },
      },
      {
        match: "LookupPlayerTournaments",
        body: [{ GameName: "Dota 2", TotalUSDPrize: 7_100_000, TotalTournaments: 120 }],
      },
    ]);
    const client = new GameStatsClient(
      testOptions(mock.fetch, { apiKeys: { esportsEarnings: "k" } }),
    );

    const earnings = await client.dota2.getEarnings("N0tail");
    expect(earnings.totalUsdCents).toBe(718_416_328);
    expect(Number.isInteger(earnings.totalUsdCents)).toBe(true);
    expect(earnings.name).toBe("Johan Sundstein");
    expect(earnings.byTitle[0]).toMatchObject({ titleId: "dota2", totalUsdCents: 710_000_000 });
  });

  it("needs its own key, whatever else is configured", async () => {
    const mock = mockFetch([]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { pandascore: "k" } }));
    await expect(client.dota2.getEarnings("N0tail")).rejects.toBeInstanceOf(
      MissingCredentialError,
    );
  });
});

describe("coverage of titles with no player API", () => {
  it("still serves the whole esports surface", async () => {
    const mock = mockFetch([{ match: "api.pandascore.co", body: [] }]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { pandascore: "k" } }));

    for (const titleId of ["mobile-legends", "free-fire", "pubg-mobile", "honor-of-kings"]) {
      const title = client.title(titleId);
      expect(title.supports("getEsportsMatches")).toBe(true);
      expect(title.supports("getEsportsTournaments")).toBe(true);
      expect(title.supports("getEarnings")).toBe(true);
      await expect(title.getEsportsMatches()).resolves.toEqual([]);
    }
  });

  it("falls back to Liquipedia for the titles nothing structured covers", async () => {
    const mock = mockFetch([
      {
        match: "liquipedia.net",
        body: {
          query: {
            categorymembers: [{ title: "Evo/2025", pageid: 42 }],
          },
        },
      },
    ]);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const [tournament] = await client.title("guilty-gear-strive").getEsportsTournaments();

    expect(tournament).toMatchObject({
      id: "42",
      name: "Evo/2025",
      providerId: "liquipedia",
      titleId: "guilty-gear-strive",
    });
    // The wiki name is not always the title id.
    expect(mock.calls[0]).toContain("/fighters/api.php");
  });
});
