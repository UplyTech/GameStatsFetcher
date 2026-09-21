/**
 * The four titles where progress is the rank.
 *
 * Old School RuneScape, RuneScape, EVE Online and Diablo III. None of them has
 * matchmaking, so the interesting question in every case is the same: does the
 * client map "how far have I got" onto the shared shapes without inventing a
 * match, a win rate or a rating that the upstream never reported?
 */

import { describe, expect, it } from "vitest";
import { GameStatsClient } from "../src/client.js";
import { mockFetch, testOptions } from "./helpers.js";
import { NotFoundError, UnsupportedCapabilityError, ValidationError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// RuneScape, both lines
// ---------------------------------------------------------------------------

/** The JSON form, which is what the provider asks for first. */
const HISCORES = {
  skills: [
    { id: 0, name: "Overall", rank: 12_345, level: 2_277, xp: 4_600_000_000 },
    { id: 1, name: "Attack", rank: 50_000, level: 99, xp: 200_000_000 },
    // An unranked skill: the hiscores spell that -1, and it must never be
    // reported as rank -1 or as rank 0.
    { id: 2, name: "Defence", rank: -1, level: 1, xp: 0 },
  ],
  activities: [
    { id: 0, name: "Clue Scrolls (all)", rank: 900, score: 1_200 },
    { id: 1, name: "Zulrah", rank: -1, score: -1 },
  ],
};

describe("Old School RuneScape", () => {
  const routes = [{ match: "index_lite.json", body: HISCORES }];

  it("resolves by display name, because Jagex publishes no account id", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const ref = await client.title("old-school-runescape").resolvePlayer({ name: "Zezima" });
    expect(ref.id).toBe("Zezima");
    expect(ref.providerId).toBe("jagex");
    expect(mock.calls[0]).toContain("m=hiscore_oldschool");
  });

  it("reads the overall level as the account level", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const profile = await client.title("old-school-runescape").getPlayer({ name: "Zezima" });
    expect(profile.level).toBe(2_277);
    expect(profile.displayName).toBe("Zezima");
  });

  it("reports an unranked skill as null rather than as -1", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const ranks = await client.title("old-school-runescape").getRank({ name: "Zezima" });
    // Defence is unranked, so it is absent rather than present with a rank of
    // -1 - which would sort to the top of any leaderboard a caller builds.
    expect(ranks.map((rank) => rank.queue)).toEqual(["Overall", "Attack"]);
    expect(ranks[0]!.position).toBe(12_345);
    expect(ranks[0]!.tier).toBe("Level 2277");
    expect(ranks[0]!.tierPoints).toBe(4_600_000_000);
  });

  it("keeps skills and activities in separate namespaces", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const stats = await client.title("old-school-runescape").getPlayerStats({ name: "Zezima" });
    expect(Object.keys(stats.modes)).toContain("skill:0");
    expect(Object.keys(stats.modes)).toContain("activity:0");
    expect(stats.modes["skill:1"]!.extra.level).toBe(99);
    expect(stats.modes["activity:0"]!.extra.score).toBe(1_200);
    // An unranked activity keeps its row and reports null, because "you have
    // never killed Zulrah" is an answer and an absent row is not.
    expect(stats.modes["activity:1"]!.extra.score).toBeNull();
  });

  it("invents no match record, because the hiscores are a ladder", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const stats = await client.title("old-school-runescape").getPlayerStats({ name: "Zezima" });
    expect(stats.matchesPlayed).toBeNull();
    expect(stats.wins).toBeNull();
    expect(stats.winRatePermille).toBeNull();
    await expect(
      client.title("old-school-runescape").getMatchHistory({ name: "Zezima" }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it("falls back to the CSV form when the JSON one is not served", async () => {
    // The CSV endpoint is the one that has been stable the longest. It carries
    // no names, so the skill table supplies them positionally and the
    // activities are numbered rather than guessed at.
    const mock = mockFetch([
      { match: "index_lite.json", status: 404 },
      {
        match: "index_lite.ws",
        text: "12345,2277,4600000000\n50000,99,200000000\n-1,1,0\n900,1200\n",
        headers: { "Content-Type": "text/plain" },
      },
    ]);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const ranks = await client.title("old-school-runescape").getRank({ name: "Zezima" });
    expect(ranks[0]!.queue).toBe("Overall");
    expect(ranks[1]!.queue).toBe("Attack");
    expect(ranks).toHaveLength(2);
  });

  it("says which player was missing when both forms come back empty", async () => {
    const mock = mockFetch([
      { match: "index_lite.json", status: 404 },
      { match: "index_lite.ws", status: 404 },
    ]);
    const client = new GameStatsClient(testOptions(mock.fetch));
    await expect(
      client.title("old-school-runescape").getRank({ name: "NotAPlayer" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("asks for a name rather than guessing one", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    await expect(
      client.title("old-school-runescape").resolvePlayer({}),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("RuneScape", () => {
  it("reads the other hiscore table from the same host", async () => {
    const mock = mockFetch([{ match: "index_lite.json", body: HISCORES }]);
    const client = new GameStatsClient(testOptions(mock.fetch));
    await client.title("runescape").getPlayer({ name: "Zezima" });
    // The only difference between the two games is this path segment, so it is
    // the one thing worth asserting separately.
    expect(mock.calls[0]).toContain("m=hiscore/");
    expect(mock.calls[0]).not.toContain("oldschool");
  });
});

// ---------------------------------------------------------------------------
// EVE Online
// ---------------------------------------------------------------------------

describe("EVE Online", () => {
  const routes = [
    { match: "/universe/ids/", body: { characters: [{ id: 90_000_001, name: "Chribba" }] } },
    {
      match: "/characters/90000001/",
      body: {
        name: "Chribba",
        corporation_id: 98_000_001,
        alliance_id: 99_000_001,
        birthday: "2003-05-06T00:00:00Z",
        security_status: -4.95,
        race_id: 1,
      },
    },
    {
      match: "/corporations/98000001/",
      body: { name: "Otherworld Enterprises", ticker: "OTHER", member_count: 42 },
    },
    { match: "/alliances/99000001/", body: { name: "Test Alliance", ticker: "TEST" } },
    { match: "/status/", body: { players: 24_000, server_version: "2500000" } },
  ];

  it("turns a name into the id that actually survives a rename", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const ref = await client.title("eve-online").resolvePlayer({ name: "Chribba" });
    expect(ref.id).toBe("90000001");
    expect(ref.displayName).toBe("Chribba");
  });

  it("takes a numeric id without a name lookup", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const ref = await client.title("eve-online").resolvePlayer({ accountId: 90_000_001 });
    expect(ref.id).toBe("90000001");
    expect(mock.countOf("/universe/ids/")).toBe(0);
  });

  it("reports a name that matched no character as a missing character", async () => {
    const mock = mockFetch([{ match: "/universe/ids/", body: { corporations: [{ id: 1 }] } }]);
    const client = new GameStatsClient(testOptions(mock.fetch));
    await expect(
      client.title("eve-online").resolvePlayer({ name: "Some Corporation" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("carries the corporation as the clan and the birthday as the creation date", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const profile = await client.title("eve-online").getPlayer({ name: "Chribba" });
    expect(profile.clan).toBe("Otherworld Enterprises");
    expect(profile.createdAt).toBe(Date.parse("2003-05-06T00:00:00Z"));
    expect(profile.avatarUrl).toContain("/characters/90000001/portrait");
  });

  it("keeps security status in permille, because -4.95 is not -5", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const ranks = await client.title("eve-online").getRank({ name: "Chribba" });
    expect(ranks).toHaveLength(1);
    expect(ranks[0]!.queue).toBe("security-status");
    expect(ranks[0]!.rating).toBe(-4_950);
  });

  it("reports the corporation and alliance tickers as standing", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const stats = await client.title("eve-online").getPlayerStats({ name: "Chribba" });
    expect(stats.modes.standing!.extra.corporationTicker).toBe("OTHER");
    expect(stats.modes.standing!.extra.allianceTicker).toBe("TEST");
    expect(stats.modes.standing!.extra.securityStatusPermille).toBe(-4_950);
  });

  it("serves the server status as metadata and refuses anything else", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const status = (await client.title("eve-online").getMetadata()) as Record<string, unknown>;
    expect(status.players).toBe(24_000);
    await expect(client.title("eve-online").getMetadata("wallet")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("omits the rank entirely when ESI reports no security status", async () => {
    const mock = mockFetch([
      { match: "/universe/ids/", body: { characters: [{ id: 5, name: "New" }] } },
      { match: "/characters/5/", body: { name: "New" } },
    ]);
    const client = new GameStatsClient(testOptions(mock.fetch));
    expect(await client.title("eve-online").getRank({ name: "New" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Diablo III
// ---------------------------------------------------------------------------

describe("Diablo III", () => {
  const routes = [
    { match: "oauth.battle.net/token", body: { access_token: "t", expires_in: 86_400 } },
    {
      match: "/d3/profile/Player-1234/hero/",
      body: { id: 1, name: "Barb", class: "barbarian", level: 70 },
    },
    {
      match: "/d3/profile/Player-1234/",
      body: {
        battleTag: "Player#1234",
        paragonLevel: 800,
        paragonLevelSeason: 120,
        guildName: "Nephalem",
        lastUpdated: 1_700_000_000,
        kills: { elites: 12_345 },
        heroes: [
          { id: 1, name: "Barb", class: "barbarian", level: 70, paragonLevel: 800, hardcore: false, seasonal: true, dead: false },
          { id: 2, name: "Fallen", class: "wizard", level: 70, hardcore: true, dead: true },
        ],
      },
    },
    { match: "/data/d3/season/index", body: { currentSeason: 33 } },
    {
      match: "/data/d3/season/33/leaderboard/rift-team-4",
      body: {
        row: [
          {
            player: [
              { accountId: "1", data: "Alpha" },
              { accountId: "2", data: "Beta" },
            ],
            data: [{ id: "RiftLevel", number: 150 }],
          },
        ],
      },
    },
    { match: "/data/d3/season/", body: { currentSeason: 33 } },
  ];

  const options = () => testOptions(mockFetch(routes).fetch, { apiKeys: { blizzard: "a:b" } });

  it("accepts a BattleTag with the hash a caller actually types", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(
      testOptions(mock.fetch, { apiKeys: { blizzard: "a:b" } }),
    );
    const ref = await client.title("diablo-3").resolvePlayer({ battleTag: "Player#1234" });
    expect(ref.id).toBe("Player-1234");
    // Blizzard spells the separator `-` in a path; passing the `#` form is the
    // normal mistake and is converted rather than rejected.
    expect(mock.calls.some((url) => url.includes("Player-1234"))).toBe(true);
  });

  it("reads the paragon level as the account level", async () => {
    const client = new GameStatsClient(options());
    const profile = await client.title("diablo-3").getPlayer({ battleTag: "Player#1234" });
    expect(profile.level).toBe(800);
    expect(profile.clan).toBe("Nephalem");
    expect(profile.lastSeenAt).toBe(1_700_000_000_000);
  });

  it("reports both paragon ladders separately", async () => {
    const client = new GameStatsClient(options());
    const ranks = await client.title("diablo-3").getRank({ battleTag: "Player#1234" });
    expect(ranks.map((rank) => rank.queue)).toEqual(["paragon", "paragon-season"]);
    expect(ranks[0]!.tierPoints).toBe(800);
    expect(ranks[1]!.tierPoints).toBe(120);
  });

  it("keeps a dead hardcore hero, because that is the statistic players discuss", async () => {
    const client = new GameStatsClient(options());
    const stats = await client.title("diablo-3").getPlayerStats({ battleTag: "Player#1234" });
    expect(stats.modes["hero:2"]!.extra.dead).toBe("true");
    expect(stats.modes["hero:2"]!.extra.hardcore).toBe("true");
    expect(stats.kills).toBe(12_345);
  });

  it("names one member of a party record and keeps the rest in raw", async () => {
    const client = new GameStatsClient(options());
    const board = await client.title("diablo-3").getLeaderboard({ queue: "rift-team-4" });
    expect(board).toHaveLength(1);
    expect(board[0]!.position).toBe(1);
    expect(board[0]!.displayName).toBe("Alpha");
    expect(board[0]!.rating).toBe(150);
    // The second player is not dropped - it is in the row a caller can read.
    expect(JSON.stringify(board[0]!.raw)).toContain("Beta");
  });

  it("asks the season index rather than guessing which season is current", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(
      testOptions(mock.fetch, { apiKeys: { blizzard: "a:b" } }),
    );
    await client.title("diablo-3").getLeaderboard({ queue: "rift-team-4" });
    expect(mock.calls.some((url) => url.includes("/data/d3/season/"))).toBe(true);
    expect(mock.calls.some((url) => url.includes("/season/33/leaderboard/"))).toBe(true);
  });

  it("serves the season index as metadata and refuses anything else", async () => {
    const client = new GameStatsClient(options());
    expect(await client.title("diablo-3").getMetadata()).toBeTruthy();
    await expect(client.title("diablo-3").getMetadata("heroes")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("has no match history, because Diablo III records no matches", async () => {
    const client = new GameStatsClient(options());
    await expect(
      client.title("diablo-3").getMatchHistory({ battleTag: "Player#1234" }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });
});
