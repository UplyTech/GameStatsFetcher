import { describe, expect, it } from "vitest";
import { GameStatsClient } from "../src/client.js";
import {
  MissingCredentialError,
  PrivateProfileError,
  UnknownTitleError,
  UnsupportedCapabilityError,
} from "../src/errors.js";
import { mockFetch, testOptions } from "./helpers.js";

const STEAM_ID = "76561197960287930";

describe("construction and lookup", () => {
  it("needs no options at all", () => {
    const client = new GameStatsClient();
    expect(client.titleCount()).toBeGreaterThan(70);
  });

  it("returns the same object for an accessor and an alias", () => {
    const client = new GameStatsClient();
    expect(client.cs2).toBe(client.title("csgo"));
    expect(client.cs2).toBe(client.title("CS:GO"));
    expect(client.lol).toBe(client.title("league-of-legends"));
  });

  it("throws for an unknown title, with suggestions", () => {
    const client = new GameStatsClient();
    expect(() => client.title("valorent")).toThrow(UnknownTitleError);
  });

  it("offers a non-throwing lookup for user input", () => {
    const client = new GameStatsClient();
    expect(client.tryTitle("dota")?.id).toBe("dota2");
    expect(client.tryTitle("half-life")).toBeUndefined();
  });

  it("exposes the registries without a network call", () => {
    const client = new GameStatsClient();
    expect(client.providers().length).toBeGreaterThan(40);
    expect(client.byGenre("moba").map((t) => t.id)).toContain("dota2");
    expect(client.search("rocket")[0]?.id).toBe("rocket-league");
  });
});

describe("capability enforcement", () => {
  it("throws rather than returning empty for a method the title cannot do", async () => {
    const client = new GameStatsClient();
    // Bandai Namco publishes no Tekken player API. An empty array here would
    // look like a quiet week rather than a question the title cannot answer.
    await expect(client.title("tekken-8").getRank({ name: "Arslan Ash" })).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
  });

  it("says what the title can do instead", async () => {
    const client = new GameStatsClient();
    try {
      await client.title("mobile-legends").getMatchHistory({ name: "x" });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as UnsupportedCapabilityError).message).toContain("getEsportsMatches");
    }
  });

  it("answers the same question through supports() without throwing", () => {
    const client = new GameStatsClient();
    expect(client.title("tekken-8").supports("getRank")).toBe(false);
    expect(client.title("tekken-8").supports("getEsportsTournaments")).toBe(true);
    expect(client.cs2.supports("getRank")).toBe(true);
  });
});

describe("credentials", () => {
  it("names the missing key and where to get it, before any network call", async () => {
    const mock = mockFetch([]);
    const client = new GameStatsClient(testOptions(mock.fetch));
    try {
      await client.cs2.resolvePlayer({ steamId: STEAM_ID });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingCredentialError);
      expect((error as MissingCredentialError).keyName).toBe("steam");
    }
    // Nothing went out - the registry already knew the key was missing.
    expect(mock.calls).toHaveLength(0);
  });

  it("reports readiness per provider", () => {
    const client = new GameStatsClient({ apiKeys: { riot: "k" } });
    const rows = client.diagnostics();
    expect(rows.find((row) => row.id === "riot")?.ready).toBe(true);
    expect(rows.find((row) => row.id === "steam")?.ready).toBe(false);
    expect(rows.find((row) => row.id === "steam")?.missingKey).toBe("steam");
    // Keyless providers are always ready.
    expect(rows.find((row) => row.id === "opendota")?.ready).toBe(true);
  });

  it("lists which titles a configured key unlocks", () => {
    const client = new GameStatsClient({ apiKeys: { riot: "k" } });
    const ids = client.usableTitles().map((title) => title.id);
    expect(ids).toContain("valorant");
    expect(ids).toContain("dota2"); // OpenDota needs no key
  });
});

describe("Counter-Strike 2 end to end", () => {
  const routes = [
    {
      match: "GetPlayerSummaries",
      body: {
        response: {
          players: [
            {
              steamid: STEAM_ID,
              personaname: "Rabscuttle",
              profileurl: "https://steamcommunity.com/id/gabelogannewell/",
              avatarfull: "https://avatars.test/full.jpg",
              communityvisibilitystate: 3,
              timecreated: 1_063_407_589,
              lastlogoff: 1_700_000_000,
              loccountrycode: "US",
            },
          ],
        },
      },
    },
    {
      match: "GetUserStatsForGame",
      body: {
        playerstats: {
          steamID: STEAM_ID,
          gameName: "ValveTestApp260",
          stats: [
            { name: "total_kills", value: 1_000 },
            { name: "total_deaths", value: 500 },
            { name: "total_matches_played", value: 200 },
            { name: "total_matches_won", value: 120 },
            { name: "total_time_played", value: 360_000 },
            { name: "total_wins_map_de_dust2", value: 40 },
            { name: "total_rounds_map_de_dust2", value: 400 },
          ],
        },
      },
    },
  ];

  it("resolves a player from a SteamID64", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { steam: "k" } }));
    const ref = await client.cs2.resolvePlayer({ steamId: STEAM_ID });

    expect(ref).toMatchObject({
      titleId: "cs2",
      providerId: "steam",
      id: STEAM_ID,
      displayName: "Rabscuttle",
      platform: "steam",
    });
  });

  it("accepts a legacy Steam id and normalises it", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { steam: "k" } }));
    const ref = await client.cs2.resolvePlayer({ steamId: "STEAM_0:0:11101" });
    expect(ref.id).toBe(STEAM_ID);
  });

  it("builds a profile", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { steam: "k" } }));
    const profile = await client.cs2.getPlayer({ steamId: STEAM_ID });

    expect(profile.displayName).toBe("Rabscuttle");
    expect(profile.country).toBe("US");
    expect(profile.isPrivate).toBe(false);
    expect(profile.createdAt).toBe(1_063_407_589_000);
  });

  it("derives win rate and K/D once, in permille", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { steam: "k" } }));
    const stats = await client.cs2.getPlayerStats({ steamId: STEAM_ID });

    expect(stats.matchesPlayed).toBe(200);
    expect(stats.wins).toBe(120);
    expect(stats.losses).toBe(80);
    expect(stats.winRatePermille).toBe(600);
    expect(stats.kdPermille).toBe(2_000);
    expect(stats.timePlayedSeconds).toBe(360_000);
  });

  it("breaks the per-map stats out as modes", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { steam: "k" } }));
    const stats = await client.cs2.getPlayerStats({ steamId: STEAM_ID });

    expect(stats.modes.de_dust2).toMatchObject({ label: "dust2", wins: 40 });
    expect(stats.modes.de_dust2?.extra.rounds).toBe(400);
  });

  it("keeps the raw payload for the fields the model does not carry", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { steam: "k" } }));
    const stats = await client.cs2.getPlayerStats({ steamId: STEAM_ID });
    expect(stats.raw).toMatchObject({ total_kills: 1_000 });
  });

  it("reports a private profile as such rather than as missing", async () => {
    const mock = mockFetch([
      {
        match: "GetPlayerSummaries",
        body: {
          response: {
            players: [{ steamid: STEAM_ID, personaname: "hidden", communityvisibilitystate: 1 }],
          },
        },
      },
      { match: "GetUserStatsForGame", body: {} },
    ]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { steam: "k" } }));
    await expect(
      client.cs2.getPlayerStats({ steamId: STEAM_ID }),
    ).rejects.toBeInstanceOf(PrivateProfileError);
  });

  it("returns no rank rather than failing when the player has no FACEIT account", async () => {
    const mock = mockFetch([...routes, { match: "open.faceit.com", status: 404 }]);
    const client = new GameStatsClient(
      testOptions(mock.fetch, { apiKeys: { steam: "k", faceit: "f" } }),
    );
    // No FACEIT account is a fact about the player, not a failure of the call.
    expect(await client.cs2.getRank({ steamId: STEAM_ID })).toEqual([]);
  });
});

describe("League of Legends end to end", () => {
  const routes = [
    {
      match: "/riot/account/v1/accounts/by-riot-id/",
      body: { puuid: "PUUID-1", gameName: "Hide on bush", tagLine: "KR1" },
    },
    {
      match: "/lol/summoner/v4/summoners/by-puuid/",
      body: { puuid: "PUUID-1", profileIconId: 6, revisionDate: 1_700_000_000_000, summonerLevel: 592 },
    },
    {
      match: "/lol/league/v4/entries/by-puuid/",
      body: [
        {
          queueType: "RANKED_SOLO_5x5",
          tier: "CHALLENGER",
          rank: "I",
          leaguePoints: 1_204,
          wins: 300,
          losses: 200,
          puuid: "PUUID-1",
        },
      ],
    },
  ];

  it("accepts a Riot ID pasted into the name field", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { riot: "k" } }));
    const ref = await client.lol.resolvePlayer({ name: "Hide on bush#KR1", region: "kr" });

    expect(ref.id).toBe("PUUID-1");
    expect(ref.region).toBe("kr");
    // The account lookup must go to the regional cluster, not the platform.
    expect(mock.calls[0]).toContain("https://asia.api.riotgames.com");
  });

  it("sends the key in the header Riot expects", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { riot: "secret" } }));
    await client.lol.resolvePlayer({ gameName: "Hide on bush", tagLine: "KR1", region: "kr" });
    expect((mock.inits[0]?.headers as Record<string, string>)["X-Riot-Token"]).toBe("secret");
  });

  it("reports one rank per queue, with the tier prettified", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { riot: "k" } }));
    const ranks = await client.lol.getRank({ name: "Hide on bush#KR1", region: "kr" });

    expect(ranks).toHaveLength(1);
    expect(ranks[0]).toMatchObject({
      queue: "RANKED_SOLO_5x5",
      tier: "Challenger",
      division: "I",
      tierPoints: 1_204,
      wins: 300,
      losses: 200,
    });
  });

  it("reports an unranked player as an empty list, not an error", async () => {
    const mock = mockFetch([
      routes[0]!,
      routes[1]!,
      { match: "/lol/league/v4/entries/by-puuid/", body: [] },
    ]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { riot: "k" } }));
    expect(await client.lol.getRank({ name: "New#EUW", region: "euw1" })).toEqual([]);
  });

  it("uses the platform host for the summoner and the cluster for the account", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { riot: "k" } }));
    await client.lol.getPlayer({ name: "Hide on bush#KR1", region: "kr" });

    expect(mock.calls.some((url) => url.includes("https://kr.api.riotgames.com/lol/summoner"))).toBe(
      true,
    );
    expect(mock.calls.some((url) => url.includes("https://asia.api.riotgames.com/riot/account"))).toBe(
      true,
    );
  });

  it("rejects a region that is not a Riot platform", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { riot: "k" } }));
    await expect(
      client.lol.resolvePlayer({ name: "x#y", region: "atlantis" }),
    ).rejects.toThrow(/unknown Riot platform/);
  });
});

describe("caching", () => {
  it("spends one upstream call for two identical lookups", async () => {
    const mock = mockFetch([
      {
        match: "GetPlayerSummaries",
        body: { response: { players: [{ steamid: STEAM_ID, personaname: "x", communityvisibilitystate: 3 }] } },
      },
    ]);
    const client = new GameStatsClient({
      fetch: mock.fetch,
      apiKeys: { steam: "k" },
      cache: { driver: "memory" },
      logger: "silent",
    });

    await client.cs2.getPlayer({ steamId: STEAM_ID });
    await client.cs2.getPlayer({ steamId: STEAM_ID });
    expect(mock.countOf("GetPlayerSummaries")).toBe(1);
  });

  it("shares one Steam bucket across titles, so the quota is spent once", () => {
    const client = new GameStatsClient({ apiKeys: { steam: "k" } });
    // CS2 and Team Fortress 2 both talk to Steam; they must not get a bucket
    // each, or a fan-out across titles would exceed the real quota.
    expect(client.internals.limiter.tryAcquire("steam")).toBe(true);
    const before = client.internals.limiter.snapshot().steam?.tokens ?? 0;
    client.internals.limiter.tryAcquire("steam");
    expect(client.internals.limiter.snapshot().steam?.tokens).toBe(before - 1);
  });

  it("clears its own cache on request", async () => {
    const mock = mockFetch([
      {
        match: "GetPlayerSummaries",
        body: { response: { players: [{ steamid: STEAM_ID, personaname: "x", communityvisibilitystate: 3 }] } },
      },
    ]);
    const client = new GameStatsClient({
      fetch: mock.fetch,
      apiKeys: { steam: "k" },
      cache: { driver: "memory" },
      logger: "silent",
    });
    await client.cs2.getPlayer({ steamId: STEAM_ID });
    await client.clearCache();
    await client.cs2.getPlayer({ steamId: STEAM_ID });
    expect(mock.countOf("GetPlayerSummaries")).toBe(2);
  });
});

describe("lifecycle", () => {
  it("destroys cleanly and more than once", async () => {
    const client = new GameStatsClient();
    await expect(client.destroy()).resolves.toBeUndefined();
    await expect(client.destroy()).resolves.toBeUndefined();
  });
});
