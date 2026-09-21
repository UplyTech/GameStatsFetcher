/**
 * One end-to-end mapping test per provider family.
 *
 * These are the tests that would catch a normaliser reading the wrong field -
 * the failure that produces a dashboard full of nulls and no error anywhere.
 * Each block mocks the upstream payload shape and asserts the canonical object
 * that comes out the other side.
 */

import { describe, expect, it } from "vitest";
import { GameStatsClient } from "../src/client.js";
import { mockFetch, testOptions } from "./helpers.js";
import { MissingCredentialError } from "../src/errors.js";

const STEAM_ID = "76561197960287930";

// ---------------------------------------------------------------------------
// Overwatch 2 - OverFast
// ---------------------------------------------------------------------------

describe("Overwatch 2", () => {
  const routes = [
    {
      match: "/summary",
      body: {
        username: "Ana",
        avatar: "https://a.test/a.png",
        endorsement: { level: 4, frame: "f" },
        privacy: "public",
        competitive: {
          pc: {
            tank: { division: "diamond", tier: 2 },
            damage: { division: "master", tier: 1 },
          },
        },
      },
    },
    {
      match: "/stats",
      body: {
        career_stats: {
          "all-heroes": [
            {
              stats: [
                { key: "games_played", value: 500 },
                { key: "games_won", value: 260 },
                { key: "games_lost", value: 240 },
                { key: "eliminations", value: 9_000 },
                { key: "deaths", value: 4_500 },
                { key: "time_played", value: 360_000 },
              ],
            },
          ],
        },
        heroes_comparisons: {
          time_played: {
            values: [{ hero: "ana", hero_display_name: "Ana", value: 72_000 }],
          },
        },
      },
    },
  ];

  it("turns a BattleTag into the dashed path OverFast needs", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    await client.overwatch.resolvePlayer({ battleTag: "Ana#1234" });
    expect(mock.calls[0]).toContain("Ana-1234");
  });

  it("maps career totals and derives the win rate", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const stats = await client.overwatch.getPlayerStats({ battleTag: "Ana#1234" });

    expect(stats.matchesPlayed).toBe(500);
    expect(stats.winRatePermille).toBe(520);
    expect(stats.kills).toBe(9_000);
    expect(stats.kdPermille).toBe(2_000);
    expect(stats.modes.ana?.extra.timePlayedSeconds).toBe(72_000);
  });

  it("reports one rank per role, because each is ranked separately", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const ranks = await client.overwatch.getRank({ battleTag: "Ana#1234" });

    expect(ranks.map((rank) => rank.queue)).toEqual(["pc:tank", "pc:damage"]);
    expect(ranks[0]).toMatchObject({ tier: "Diamond", division: "2" });
  });

  it("flags a private career profile", async () => {
    const mock = mockFetch([
      { match: "/summary", body: { username: "Ana", privacy: "private" } },
    ]);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const profile = await client.overwatch.getPlayer({ battleTag: "Ana#1234" });
    expect(profile.isPrivate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Apex Legends - ApexLegendsAPI
// ---------------------------------------------------------------------------

describe("Apex Legends", () => {
  const bridge = {
    match: "/bridge",
    body: {
      global: {
        uid: "1001",
        name: "Hal",
        level: 500,
        avatar: "https://a.test/a.png",
        rank: { rankName: "Predator", rankDiv: 1, rankScore: 25_000, ladderPosPlatform: 12 },
        arena: { rankName: "Diamond", rankDiv: 2, rankScore: 8_000 },
      },
      total: { kills: { value: 50_000 }, deaths: { value: 20_000 } },
      legends: {
        all: {
          Wraith: { data: [{ key: "kills", value: 20_000 }] },
        },
      },
    },
  };

  it("carries the platform on the ref, because names are not unique", async () => {
    const mock = mockFetch([bridge]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { apex: "k" } }));
    const ref = await client.apex.resolvePlayer({ name: "Hal", platform: "xbox" });

    expect(ref).toMatchObject({ id: "1001", displayName: "Hal", platform: "xbox" });
    expect(mock.calls[0]).toContain("platform=X1");
  });

  it("reports battle royale and arenas as separate ranks", async () => {
    const mock = mockFetch([bridge]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { apex: "k" } }));
    const ranks = await client.apex.getRank({ name: "Hal" });

    expect(ranks.map((rank) => rank.queue)).toEqual(["battle-royale", "arenas"]);
    expect(ranks[0]).toMatchObject({ tier: "Predator", rating: 25_000, position: 12 });
  });

  it("folds the per-legend trackers into modes", async () => {
    const mock = mockFetch([bridge]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { apex: "k" } }));
    const stats = await client.apex.getPlayerStats({ name: "Hal" });

    expect(stats.kills).toBe(50_000);
    expect(stats.kdPermille).toBe(2_500);
    expect(stats.modes.Wraith?.extra.kills).toBe(20_000);
  });
});

// ---------------------------------------------------------------------------
// PUBG
// ---------------------------------------------------------------------------

describe("PUBG", () => {
  const routes = [
    {
      match: "/players?filter",
      body: {
        data: [
          { type: "player", id: "account.abc", attributes: { name: "chocoTaco", shardId: "steam" }, relationships: { matches: { data: [{ type: "match", id: "m1" }] } } },
        ],
      },
    },
    // Declared before the plain player route: the lifetime URL contains it.
    {
      match: "/seasons/lifetime",
      body: {
        data: {
          attributes: {
            gameModeStats: {
              "squad-fpp": {
                roundsPlayed: 1_000,
                wins: 120,
                losses: 880,
                kills: 4_000,
                assists: 900,
                damageDealt: 350_000.5,
                headshotKills: 800,
                longestKill: 412.7,
                timeSurvived: 900_000.4,
                top10s: 300,
                revives: 210,
                assists_unused: 0,
              },
            },
          },
        },
      },
    },
    {
      match: "/players/account.abc",
      body: {
        data: {
          type: "player",
          id: "account.abc",
          attributes: { name: "chocoTaco", shardId: "steam" },
          relationships: { matches: { data: [{ type: "match", id: "m1" }] } },
        },
      },
    },
  ];

  it("resolves by name and keeps the shard on the ref", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { pubg: "k" } }));
    const ref = await client.pubg.resolvePlayer({ name: "chocoTaco", region: "steam" });
    expect(ref).toMatchObject({ id: "account.abc", displayName: "chocoTaco", region: "steam" });
  });

  it("sends the JSON:API accept header PUBG insists on", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { pubg: "k" } }));
    await client.pubg.resolvePlayer({ name: "chocoTaco" });
    expect((mock.inits[0]?.headers as Record<string, string>).Accept).toBe(
      "application/vnd.api+json",
    );
  });

  it("aggregates the per-mode stats into a career total", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { pubg: "k" } }));
    const stats = await client.pubg.getPlayerStats({ name: "chocoTaco" });

    expect(stats.matchesPlayed).toBe(1_000);
    expect(stats.wins).toBe(120);
    expect(stats.winRatePermille).toBe(120);
    expect(stats.modes["squad-fpp"]?.extra.longestKill).toBe(413);
  });

  it("returns thin summaries by default, because hydrating costs the quota", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { pubg: "k" } }));
    const history = await client.pubg.getMatchHistory({ name: "chocoTaco" });

    expect(history).toHaveLength(1);
    expect(history[0]?.matchId).toBe("m1");
    expect(history[0]?.result).toBe("unknown");
    expect(mock.countOf("/matches/")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Clash Royale - Supercell
// ---------------------------------------------------------------------------

describe("Clash Royale", () => {
  // The battle log route is declared first: routes match by substring in order,
  // and `/players/%23` would otherwise swallow `/players/%23.../battlelog`.
  const routes = [
    {
      match: "/battlelog",
      body: [
        {
          type: "PvP",
          battleTime: "20260901T120000.000Z",
          gameMode: { name: "Ladder" },
          arena: { name: "Legendary Arena" },
          team: [{ tag: "#2PP0JCVL", crowns: 3, trophyChange: 30 }],
          opponent: [{ tag: "#ABC", crowns: 1 }],
        },
      ],
    },
    {
      match: "/players/%23",
      body: {
        tag: "#2PP0JCVL",
        name: "Surgical Goblin",
        expLevel: 13,
        trophies: 7_200,
        bestTrophies: 7_800,
        wins: 4_000,
        losses: 3_500,
        battleCount: 7_600,
        threeCrownWins: 1_200,
        arena: { name: "Legendary Arena" },
        clan: { name: "Nova" },
      },
    },
  ];

  it("normalises a mistyped tag before asking Supercell", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { clashRoyale: "k" } }));
    // Lower case, a letter O for a zero and no leading hash: all three are
    // things users do when copying a tag out of a screenshot.
    await client.clashRoyale.resolvePlayer({ playerTag: "2ppOjcvl" });
    expect(mock.calls[0]).toContain("%232PP0JCVL");
  });

  it("derives draws from the battle count Supercell reports", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { clashRoyale: "k" } }));
    const stats = await client.clashRoyale.getPlayerStats({ playerTag: "#2PP0JCVL" });

    expect(stats.wins).toBe(4_000);
    expect(stats.losses).toBe(3_500);
    expect(stats.draws).toBe(100);
    expect(stats.modes.ladder?.extra.trophies).toBe(7_200);
  });

  it("reads the crown count as the match result", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { clashRoyale: "k" } }));
    const [battle] = await client.clashRoyale.getMatchHistory({ playerTag: "#2PP0JCVL" });

    expect(battle?.result).toBe("win");
    expect(battle?.playerStats?.extra.crowns).toBe(3);
    expect(battle?.playerStats?.extra.opponentCrowns).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SMITE - Hi-Rez
// ---------------------------------------------------------------------------

describe("SMITE", () => {
  const routes = [
    { match: "/createsessionJson", body: { ret_msg: "Approved", session_id: "S1" } },
    {
      match: "/getplayeridbynameJson",
      body: [
        { player_id: "77", portal_id: "5", Name: "Zapman" },
        { player_id: "88", portal_id: "9", Name: "Zapman" },
      ],
    },
    {
      match: "/getplayerJson",
      body: [
        {
          Id: 77,
          Name: "Zapman",
          hz_player_name: "Zapman",
          Level: 120,
          Wins: 3_000,
          Losses: 2_000,
          Created_Datetime: "1/1/2015 12:00:00 AM",
          RankedConquest: {
            Name: "Grandmaster",
            Tier: 26,
            Points: 150,
            Rank: 12,
            Wins: 200,
            Losses: 150,
            Leaves: 0,
            PrevRank: 25,
            Season: 11,
            Trend: 1,
          },
          RankedJoust: { Name: "Unranked", Tier: 0, Points: 0, Rank: 0, Wins: 0, Losses: 0, Leaves: 0, PrevRank: 0, Season: 11, Trend: 0 },
        },
      ],
    },
    { match: "/getgodranksJson", body: [{ god: "Anhur", Wins: 100, Losses: 60, Kills: 900, Deaths: 400, Assists: 300, Rank: 10 }] },
  ];

  it("signs every call and opens a session once", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { hirez: "dev:auth" } }));
    await client.smite.getPlayer({ name: "Zapman" });
    await client.smite.getPlayer({ name: "Zapman" });

    expect(mock.countOf("/createsessionJson")).toBe(1);
    // devId, a 32-character MD5 signature, the session and a timestamp.
    expect(mock.calls[1]).toMatch(/\/getplayeridbynameJson\/dev\/[0-9a-f]{32}\/S1\/\d{14}\//);
  });

  it("prefers the PC account when a name exists on two platforms", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { hirez: "dev:auth" } }));
    const ref = await client.smite.resolvePlayer({ name: "Zapman" });
    expect(ref.id).toBe("77");
  });

  it("drops the queues the player has never touched", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { hirez: "dev:auth" } }));
    const ranks = await client.smite.getRank({ name: "Zapman" });

    expect(ranks.map((rank) => rank.queue)).toEqual(["conquest"]);
    expect(ranks[0]).toMatchObject({ tier: "Grandmaster", rating: 150, position: 12 });
  });

  it("maps per-god statistics onto modes", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { hirez: "dev:auth" } }));
    const stats = await client.smite.getPlayerStats({ name: "Zapman" });
    expect(stats.modes.Anhur).toMatchObject({ wins: 100, losses: 60, kills: 900 });
  });
});

// ---------------------------------------------------------------------------
// Age of Empires IV - AoE4World
// ---------------------------------------------------------------------------

describe("Age of Empires IV", () => {
  const routes = [
    { match: "/players/search", body: { players: [{ profile_id: 4_242, name: "Beasty" }] } },
    {
      match: "/players/4242",
      body: {
        profile_id: 4_242,
        name: "Beasty",
        country: "nl",
        last_game_at: "2026-09-01T10:00:00Z",
        modes: {
          rm_solo: {
            rating: 1_900,
            max_rating: 2_050,
            rank: 4,
            rank_level: "conqueror_3",
            games_count: 500,
            wins_count: 320,
            losses_count: 180,
            streak: 5,
          },
        },
      },
    },
  ];

  it("prefers an exact name match over the first search hit", async () => {
    const mock = mockFetch([
      { match: "/players/search", body: { players: [{ profile_id: 1, name: "BeastyQT" }, { profile_id: 2, name: "Beasty" }] } },
      { match: "/players/2", body: { profile_id: 2, name: "Beasty", modes: {} } },
    ]);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const ref = await client.aoe4.resolvePlayer({ name: "Beasty" });
    expect(ref.id).toBe("2");
  });

  it("maps per-mode ratings into ranks and stats", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));

    const ranks = await client.aoe4.getRank({ name: "Beasty" });
    expect(ranks[0]).toMatchObject({
      queue: "rm_solo",
      tier: "conqueror_3",
      rating: 1_900,
      position: 4,
      wins: 320,
      losses: 180,
    });

    const stats = await client.aoe4.getPlayerStats({ name: "Beasty" });
    expect(stats.matchesPlayed).toBe(500);
    expect(stats.winRatePermille).toBe(640);
  });
});

// ---------------------------------------------------------------------------
// osu!
// ---------------------------------------------------------------------------

describe("osu!", () => {
  const user = (mode: string, rank: number | null) => ({
    id: 124_493,
    username: "peppy",
    country_code: "AU",
    avatar_url: "https://a.ppy.sh/2",
    join_date: "2007-09-24T00:00:00+00:00",
    statistics: {
      level: { current: 102, progress: 40 },
      pp: 5_000,
      global_rank: rank,
      country_rank: 12,
      play_count: 30_000,
      play_time: 2_000_000,
      hit_accuracy: 98.5,
      ranked_score: 1_000,
      maximum_combo: 2_000,
    },
    __mode: mode,
  });

  it("exchanges client credentials for a token once", async () => {
    const mock = mockFetch([
      { match: "oauth/token", body: { access_token: "T", expires_in: 86_400 } },
      { match: "/users/", body: user("osu", 42) },
    ]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { osu: "1:secret" } }));

    await client.osu.getPlayer({ name: "peppy" });
    await client.osu.getPlayer({ name: "peppy" });
    expect(mock.countOf("oauth/token")).toBe(1);
    expect((mock.inits[1]?.headers as Record<string, string>).Authorization).toBe("Bearer T");
  });

  it("reports one rank per mode and skips the modes never played", async () => {
    const mock = mockFetch([
      { match: "oauth/token", body: { access_token: "T" } },
      {
        match: "/users/",
        sequence: [
          { body: user("osu", 42) },
          { body: user("osu", 42) },
          { body: user("taiko", null) },
          { body: user("fruits", null) },
          { body: user("mania", null) },
        ],
      },
    ]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { osu: "1:secret" } }));
    const ranks = await client.osu.getRank({ name: "peppy" });

    expect(ranks).toHaveLength(1);
    expect(ranks[0]).toMatchObject({ queue: "osu", position: 42, rating: 5_000 });
  });

  it("treats a failed play as a loss, which is osu!'s only binary outcome", async () => {
    const mock = mockFetch([
      { match: "oauth/token", body: { access_token: "T" } },
      { match: "/users/peppy", body: user("osu", 42) },
      {
        match: "/scores/recent",
        body: [
          {
            id: 9,
            mode: "osu",
            passed: false,
            created_at: "2026-09-01T10:00:00Z",
            score: 400_000,
            pp: null,
            accuracy: 0.91,
            max_combo: 300,
            rank: "D",
            beatmap: { total_length: 200, version: "Insane", difficulty_rating: 6.2 },
            beatmapset: { artist: "A", title: "B" },
          },
        ],
      },
    ]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { osu: "1:secret" } }));
    const [play] = await client.osu.getMatchHistory({ name: "peppy" });

    expect(play?.result).toBe("loss");
    expect(play?.map).toBe("A - B - Insane");
    expect(play?.playerStats?.extra.stars).toBe(6.2);
  });
});

// ---------------------------------------------------------------------------
// Chess
// ---------------------------------------------------------------------------

describe("chess", () => {
  const routes = [
    {
      match: "api.chess.com/pub/player/hikaru/stats",
      body: {
        chess_blitz: { last: { rating: 3_250 }, best: { rating: 3_400 }, record: { win: 5_000, loss: 1_000, draw: 500 } },
        chess_bullet: { last: { rating: 3_300 }, best: { rating: 3_500 }, record: { win: 8_000, loss: 2_000, draw: 400 } },
        puzzle_rush: { best: { score: 60 } },
      },
    },
    {
      match: "api.chess.com/pub/player/hikaru",
      body: {
        username: "Hikaru",
        url: "https://www.chess.com/member/Hikaru",
        joined: 1_268_000_000,
        last_online: 1_760_000_000,
        country: "https://api.chess.com/pub/country/US",
        avatar: "https://a.test/a.png",
      },
    },
  ];

  it("defaults to Chess.com and records the site on the ref", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const ref = await client.chess.resolvePlayer({ name: "Hikaru" });
    expect(ref.providerId).toBe("chess-com");
    expect(ref.id).toBe("hikaru");
  });

  it("sums the per-time-control records into a career total", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const stats = await client.chess.getPlayerStats({ name: "Hikaru" });

    expect(stats.wins).toBe(13_000);
    expect(stats.losses).toBe(3_000);
    expect(stats.draws).toBe(900);
    // Draws belong in the denominator: 13000 / 16900.
    expect(stats.winRatePermille).toBe(769);
    expect(stats.modes.chess_blitz?.extra.rating).toBe(3_250);
    // A non-chess record must not become a time control.
    expect(stats.modes.puzzle_rush).toBeUndefined();
  });

  it("switches to Lichess when asked, and parses its NDJSON games", async () => {
    const games = [
      {
        id: "g1",
        perf: "blitz",
        createdAt: 1_760_000_000_000,
        lastMoveAt: 1_760_000_300_000,
        winner: "white",
        turns: 40,
        opening: { name: "Sicilian" },
        players: { white: { user: { id: "drnykterstein" } }, black: { user: { id: "other" } } },
      },
    ];
    const mock = mockFetch([
      { match: "lichess.org/api/user/", body: { id: "drnykterstein", username: "DrNykterstein" } },
      {
        match: "lichess.org/api/games/user/",
        text: games.map((game) => JSON.stringify(game)).join("\n"),
      },
    ]);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const ref = await client.chess.resolvePlayer({ name: "DrNykterstein", extra: { site: "lichess" } });
    expect(ref.providerId).toBe("lichess");

    const [game] = await client.chess.getMatchHistory(ref);
    expect(game).toMatchObject({ matchId: "g1", mode: "blitz", result: "win" });
    expect(game?.durationSeconds).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// World of Tanks - Wargaming
// ---------------------------------------------------------------------------

describe("World of Tanks", () => {
  const routes = [
    {
      match: "/account/list/",
      body: { status: "ok", data: [{ account_id: 555, nickname: "Skill4ltu" }] },
    },
    {
      match: "/account/info/",
      body: {
        status: "ok",
        data: {
          "555": {
            account_id: 555,
            nickname: "Skill4ltu",
            created_at: 1_300_000_000,
            last_battle_time: 1_760_000_000,
            global_rating: 12_500,
            clan_id: 99,
            statistics: {
              all: { battles: 90_000, wins: 60_000, losses: 29_000, draws: 1_000, frags: 130_000, damage_dealt: 200_000_000, damage_received: 100_000_000, spotted: 50_000, survived_battles: 40_000, xp: 90_000_000 },
              random: { battles: 80_000, wins: 54_000, losses: 25_500, draws: 500, frags: 120_000, damage_dealt: 180_000_000, damage_received: 90_000_000, spotted: 45_000, survived_battles: 36_000, xp: 80_000_000 },
            },
          },
        },
      },
    },
  ];

  it("turns a 200-with-error into a real error", async () => {
    const mock = mockFetch([
      { match: "/account/list/", body: { status: "error", error: { message: "INVALID_APPLICATION_ID" } } },
    ]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { wargaming: "k" } }));
    // Wargaming answers 200 for a failure, so a plain HTTP check would treat
    // this as success and hand back an empty object.
    await expect(client.worldOfTanks.resolvePlayer({ name: "Nobody" })).rejects.toThrow(
      /INVALID_APPLICATION_ID/,
    );
  });

  it("routes to the region's host", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { wargaming: "k" } }));
    await client.worldOfTanks.resolvePlayer({ name: "Skill4ltu", region: "na" });
    // `na` is `.com`, which is the one people get wrong.
    expect(mock.calls[0]).toContain("https://api.worldoftanks.com");
  });

  it("maps career statistics and the global rating", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { wargaming: "k" } }));
    const stats = await client.worldOfTanks.getPlayerStats({ name: "Skill4ltu" });

    expect(stats.matchesPlayed).toBe(90_000);
    expect(stats.winRatePermille).toBe(667);
    expect(stats.modes.random?.wins).toBe(54_000);

    const [rank] = await client.worldOfTanks.getRank({ name: "Skill4ltu" });
    expect(rank?.rating).toBe(12_500);
  });
});

// ---------------------------------------------------------------------------
// Brawlhalla
// ---------------------------------------------------------------------------

describe("Brawlhalla", () => {
  const routes = [
    { match: "/search", body: { brawlhalla_id: 3, name: "Boomie" } },
    {
      match: "/player/3/stats",
      body: {
        brawlhalla_id: 3,
        name: "Boomie",
        level: 100,
        games: 20_000,
        wins: 12_000,
        clan: { clan_name: "Blue Mammoth" },
        legends: [
          { legend_id: 3, legend_name_key: "bodvar", games: 5_000, wins: 3_100, kos: 9_000, falls: 6_000, damagedealt: "500000", damagetaken: "400000", matchtime: 100_000 },
        ],
      },
    },
    {
      match: "/player/3/ranked",
      body: {
        tier: "Diamond",
        rating: 2_100,
        games: 500,
        wins: 300,
        "2v2": [{ teamname: "Boomie+Friend", tier: "Platinum", rating: 1_800, games: 100, wins: 60 }],
      },
    },
  ];

  it("resolves through a Steam id when one is given", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { brawlhalla: "k" } }));
    const ref = await client.brawlhalla.resolvePlayer({ steamId: STEAM_ID });

    expect(ref).toMatchObject({ id: "3", displayName: "Boomie", platform: "steam" });
    expect(mock.calls[0]).toContain(`steamid=${STEAM_ID}`);
  });

  it("reports 1v1 and every 2v2 team as separate ranks", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { brawlhalla: "k" } }));
    const ranks = await client.brawlhalla.getRank({ steamId: STEAM_ID });

    expect(ranks.map((rank) => rank.queue)).toEqual(["1v1", "2v2:Boomie+Friend"]);
    expect(ranks[0]).toMatchObject({ tier: "Diamond", rating: 2_100, wins: 300, losses: 200 });
  });

  it("derives losses per legend from games and wins", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { brawlhalla: "k" } }));
    const stats = await client.brawlhalla.getPlayerStats({ steamId: STEAM_ID });

    expect(stats.matchesPlayed).toBe(20_000);
    expect(stats.losses).toBe(8_000);
    expect(stats.modes.bodvar).toMatchObject({ wins: 3_100, losses: 1_900, kills: 9_000 });
  });
});

// ---------------------------------------------------------------------------
// Rocket League
// ---------------------------------------------------------------------------

describe("Rocket League", () => {
  const routes = [
    {
      match: "public-api.tracker.gg",
      body: {
        data: {
          platformInfo: { platformUserHandle: "Jstn", avatarUrl: null },
          userInfo: { countryCode: "US" },
          segments: [
            {
              type: "overview",
              stats: { wins: { value: 5_000 }, matchesPlayed: { value: 9_000 }, timePlayed: { value: 1_000_000 } },
            },
            {
              type: "playlist",
              attributes: { playlistId: 13 },
              metadata: { name: "Ranked Standard 3v3" },
              stats: {
                rating: { value: 1_950, rank: 40, percentile: 99.8 },
                tier: { metadata: { name: "Supersonic Legend" } },
                division: { metadata: { name: "Division I" } },
                matchesWon: { value: 400 },
                matchesLost: { value: 300 },
              },
            },
          ],
        },
      },
    },
    {
      match: "ballchasing.com/api/replays",
      body: {
        list: [
          {
            id: "r1",
            date: "2026-09-01T20:00:00Z",
            playlist_name: "Ranked Standard",
            map_name: "DFH Stadium",
            duration: 312,
            blue: { goals: 3 },
            orange: { goals: 1 },
          },
        ],
      },
    },
  ];

  it("reports one rank per playlist, with the percentile in permille", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: { tracker: "k" } }));
    const ranks = await client.rocketLeague.getRank({ name: "Jstn", platform: "epic" });

    expect(ranks).toHaveLength(1);
    expect(ranks[0]).toMatchObject({
      queue: "Ranked Standard 3v3",
      tier: "Supersonic Legend",
      division: "Division I",
      rating: 1_950,
      position: 40,
      // Tracker reports 99.8 %, and the model stores permille.
      percentilePermille: 998,
    });
  });

  it("reads uploaded replays as match history and reports the scoreline", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(
      testOptions(mock.fetch, { apiKeys: { tracker: "k", ballchasing: "b" } }),
    );
    const [replay] = await client.rocketLeague.getMatchHistory({ steamId: STEAM_ID });

    expect(replay).toMatchObject({ matchId: "r1", map: "DFH Stadium", durationSeconds: 312 });
    expect(replay?.playerStats?.extra).toMatchObject({ blueGoals: 3, orangeGoals: 1 });
    // The list row does not say which side the player was on, so the summary
    // reports the score and leaves the verdict to getMatch.
    expect(replay?.result).toBe("unknown");
  });

  it("sends the Ballchasing token as a bare Authorization header", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(
      testOptions(mock.fetch, { apiKeys: { tracker: "k", ballchasing: "TOKEN" } }),
    );
    await client.rocketLeague.getMatchHistory({ steamId: STEAM_ID });
    const call = mock.inits[mock.calls.findIndex((url) => url.includes("ballchasing"))];
    expect((call?.headers as Record<string, string>).Authorization).toBe("TOKEN");
  });
});

// ---------------------------------------------------------------------------
// Dota 2 - OpenDota
// ---------------------------------------------------------------------------

describe("Dota 2", () => {
  const routes = [
    {
      match: "/players/22202/wl",
      body: { win: 600, lose: 400 },
    },
    {
      match: "/players/22202/heroes",
      body: [{ hero_id: 8, games: 300, win: 200 }],
    },
    {
      match: "/players/22202/totals",
      body: [
        { field: "kills", n: 1_000, sum: 9_000 },
        { field: "deaths", n: 1_000, sum: 6_000 },
        { field: "assists", n: 1_000, sum: 15_000 },
        { field: "duration", n: 1_000, sum: 2_400_000 },
      ],
    },
    {
      match: "/players/22202/matches",
      body: [
        {
          match_id: 7_000_000_001,
          player_slot: 1,
          radiant_win: true,
          duration: 2_400,
          game_mode: 22,
          lobby_type: 7,
          hero_id: 8,
          start_time: 1_760_000_000,
          kills: 12,
          deaths: 3,
          assists: 9,
          gold_per_min: 620,
          xp_per_min: 700,
          last_hits: 300,
          hero_damage: 30_000,
        },
      ],
    },
    {
      match: "/players/22202",
      body: {
        profile: { account_id: 22_202, personaname: "Dendi", avatarfull: "https://a.test/a.jpg", loccountrycode: "UA" },
        rank_tier: 75,
        leaderboard_rank: 120,
        mmr_estimate: { estimate: 7_800 },
      },
    },
  ];

  it("keys OpenDota on the 32-bit account id", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const ref = await client.dota2.resolvePlayer({ steamId: STEAM_ID });

    expect(ref.id).toBe("22202");
    expect(mock.calls[0]).toContain("/players/22202");
  });

  it("decodes the two-digit rank tier into a medal and a star", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const [rank] = await client.dota2.getRank({ steamId: STEAM_ID });

    // 75 is Divine 5.
    expect(rank).toMatchObject({ tier: "Divine 5", division: "5", rating: 7_800, position: 120 });
    expect(rank?.wins).toBe(600);
  });

  it("reads the player slot to decide which side won", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const [match] = await client.dota2.getMatchHistory({ steamId: STEAM_ID });

    // Slot 1 is Radiant, and Radiant won.
    expect(match?.result).toBe("win");
    expect(match?.playerStats).toMatchObject({ kills: 12, deaths: 3, assists: 9 });
    expect(match?.playerStats?.extra.gpm).toBe(620);
  });

  it("folds the totals endpoint into career kills and deaths", async () => {
    const mock = mockFetch(routes);
    const client = new GameStatsClient(testOptions(mock.fetch));
    const stats = await client.dota2.getPlayerStats({ steamId: STEAM_ID });

    expect(stats.wins).toBe(600);
    expect(stats.winRatePermille).toBe(600);
    expect(stats.kills).toBe(9_000);
    expect(stats.kdPermille).toBe(1_500);
    expect(stats.modes["8"]).toMatchObject({ matchesPlayed: 300, wins: 200, losses: 100 });
  });
});

describe("Guild Wars 2", () => {
  it("refuses to call an account-scoped endpoint without a key", async () => {
    // Every GW2 endpoint this package uses is account-scoped, so the token is
    // required. Sending the request unauthenticated would spend a round trip to
    // be told 401, and the caller would see "unauthorised" rather than the name
    // of the option they forgot to set.
    const mock = mockFetch([{ match: "guildwars2", body: { name: "Probe.1234" } }]);
    const client = new GameStatsClient(testOptions(mock.fetch, { apiKeys: {} }));

    await expect(client.guildWars2.getPlayer({ name: "Probe.1234" })).rejects.toThrow(
      MissingCredentialError,
    );
    expect(mock.calls).toEqual([]);
  });

  it("sends the token as a bearer once one is configured", async () => {
    const mock = mockFetch([
      { match: "/account", body: { id: "A", name: "Probe.1234", created: "2015-01-01T00:00:00Z" } },
    ]);
    const client = new GameStatsClient(
      testOptions(mock.fetch, { apiKeys: { guildwars2: "TOKEN" } }),
    );

    const profile = await client.guildWars2.getPlayer({ name: "Probe.1234" });

    expect(profile.displayName).toBe("Probe.1234");
    const [init] = mock.inits;
    expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer TOKEN");
  });

  it("says so when asked about somebody other than the key's owner", async () => {
    // The API is account-scoped through the caller's own key, so there is no
    // "look up another player" - and returning the key owner's data for a
    // different name would be the worst possible answer.
    const mock = mockFetch([{ match: "/account", body: { id: "A", name: "Probe.1234" } }]);
    const client = new GameStatsClient(
      testOptions(mock.fetch, { apiKeys: { guildwars2: "TOKEN" } }),
    );

    await expect(client.guildWars2.resolvePlayer({ name: "Somebody.5678" })).rejects.toThrow(
      /only exposes the account its API key belongs to/,
    );
  });
});

describe("osu! credential shape", () => {
  it("refuses a non-numeric client id by name, before the request", async () => {
    // osu! wants the client id as a JSON number, and `Number("name")` is NaN,
    // which `JSON.stringify` writes as `null` - so the token endpoint would
    // answer a bare 401 and send the reader looking at their secret rather than
    // at the half that is actually wrong.
    const mock = mockFetch([{ match: "oauth/token", body: { access_token: "t" } }]);
    const client = new GameStatsClient(
      testOptions(mock.fetch, { apiKeys: { osu: "name:secret" } }),
    );
    await expect(client.osu.getPlayer({ name: "peppy" })).rejects.toThrow(/apiKeys\.osu/);
    expect(mock.calls, "the credential was checked before the request").toEqual([]);
  });
});
