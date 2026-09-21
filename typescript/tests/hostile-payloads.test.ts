/**
 * Every call, against an upstream answering nonsense, must fail as a GameStatsError.
 *
 * This is the counterpart to `contract.test.ts`. That file answers 503 to
 * everything and checks the *contract*: a declared capability must not throw
 * `UnsupportedCapabilityError`. This one answers **200 with a body no mapper
 * was written for** and checks the *boundary*: whatever the mapper then hits,
 * what leaves the package is something a caller's `instanceof GameStatsError`
 * catches.
 *
 * Why that matters more than it sounds. Sixty-odd title clients map several
 * hundred upstream payloads, each written against a shape its provider
 * documents. Providers change without notice, gateways return HTML error pages
 * with a 200, and a caller behind a hostile or misconfigured proxy gets
 * whatever that proxy felt like. Before the boundary translation in
 * `title-client.ts`, a payload of the wrong shape escaped as
 * `TypeError: rows.map is not a function` - naming neither the title nor the
 * call, and not a `GameStatsError`, so an application that carefully wrapped
 * every call still fell over.
 *
 * 87 titles x 14 methods x 10 payload shapes is 5,500 calls, which is not a
 * number anybody would write by hand, and is exactly why it is generated. Every
 * payload here was chosen because a real API answers with it under some
 * failure:
 *
 * - an empty object or an empty array: an empty page, or an endpoint that has
 *   been emptied
 * - `null`: a JSON body of literal null, which several CDNs cache for 404s
 * - an envelope with the wrong middle: `data` present but an array where an
 *   object belongs, or the reverse
 * - a list of ids where objects were documented - the shape that used to reach
 *   a normaliser and explode
 * - a bare number or string, which is what an error page becomes after a proxy
 *   has JSON-encoded it
 *
 * It mirrors `python/tests/test_hostile_payloads.py` case for case.
 */

import { describe, expect, it } from "vitest";
import { GameStatsClient } from "../src/client.js";
import { listTitles } from "../src/titles.js";
import { GameStatsError, UnsupportedCapabilityError } from "../src/errors.js";
import type { Capability } from "../src/types.js";
import { testOptions, unthrottled } from "./helpers.js";

/** A key for every provider, so nothing is skipped for want of a credential. */
const ALL_KEYS: Record<string, string> = {
  steam: "k",
  riot: "k",
  blizzard: "a:b",
  bungie: "k",
  pubg: "k",
  clashRoyale: "k",
  clashOfClans: "k",
  brawlStars: "k",
  wargaming: "k",
  hirez: "a:b",
  faceit: "k",
  tracker: "k",
  pandascore: "k",
  abios: "a:b",
  startgg: "k",
  toornament: "a:b:c",
  challonge: "k",
  esportsEarnings: "k",
  stratz: "k",
  ballchasing: "k",
  hypixel: "k",
  // Numeric, because osu! wants the client id as a JSON number and rejects a
  // non-numeric one as a misconfiguration before any request is made.
  osu: "1:b",
  halo: "k",
  fortnite: "k",
  apex: "k",
  brawlhalla: "k",
  iracing: "a:b",
  trackmania: "k",
  marvelRivals: "k",
  lichess: "k",
  henrikdev: "k",
  opendota: "k",
  heroesprofile: "k",
  guildwars2: "k",
};

type AnyTitle = ReturnType<GameStatsClient["title"]>;

/** Every method the canonical surface exposes, with a call that exercises it. */
const CALLS: Record<Capability, (title: AnyTitle) => Promise<unknown>> = {
  resolvePlayer: (t) =>
    t.resolvePlayer({
      name: "probe",
      steamId: "76561197960287930",
      playerTag: "#2PP",
      battleTag: "probe#1234",
      puuid: "p",
      gameName: "probe",
      tagLine: "eu",
      accountId: "1",
      membershipId: "1",
      epicId: "e",
      ubisoftId: "u",
    }),
  getPlayer: (t) => t.getPlayer({ name: "probe" }),
  getPlayerStats: (t) => t.getPlayerStats({ name: "probe" }),
  getRank: (t) => t.getRank({ name: "probe" }),
  getMatchHistory: (t) => t.getMatchHistory({ name: "probe" }),
  getMatch: (t) => t.getMatch("m1"),
  getLeaderboard: (t) => t.getLeaderboard({}),
  getMetadata: (t) => t.getMetadata(),
  getEsportsMatches: (t) => t.getEsportsMatches(),
  getEsportsTournaments: (t) => t.getEsportsTournaments(),
  getEsportsTeams: (t) => t.getEsportsTeams(),
  getEsportsPlayers: (t) => t.getEsportsPlayers(),
  getStandings: (t) => t.getStandings("t1"),
  getEarnings: (t) => t.getEarnings("probe"),
};

/** Bodies no mapper is written for. See the file docstring for why each one. */
const HOSTILE_BODIES: Record<string, unknown> = {
  "empty-object": {},
  "empty-list": [],
  null: null,
  "data-empty-list": { data: [] },
  "data-empty-object": { data: {} },
  "wrong-types": { data: "x", response: 1, items: "y", results: 0 },
  "poisoned-rows": {
    data: ["x"],
    matches: ["x"],
    players: ["x"],
    results: ["x"],
    items: ["x"],
    entries: ["x"],
    teams: ["x"],
    response: ["x"],
  },
  "scalar-list": ["x"],
  number: 1,
  string: "boom",
};

/** Answers 200 with the same body to every request, whatever was asked. */
function always(body: unknown): { fetch: typeof fetch; requests: () => number } {
  let requests = 0;
  const impl = (async () => {
    requests += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, requests: () => requests };
}

const CAPABILITIES = Object.keys(CALLS) as Capability[];

describe("no payload escapes as anything but a GameStatsError", () => {
  it.each(Object.keys(HOSTILE_BODIES))(
    "body %s",
    async (label) => {
      const upstream = always(HOSTILE_BODIES[label]);
      const client = unthrottled(
        new GameStatsClient(testOptions(upstream.fetch, { apiKeys: ALL_KEYS })),
      );
      const escapes: string[] = [];
      let calls = 0;

      for (const title of listTitles()) {
        const instance = client.title(title.id);
        for (const capability of CAPABILITIES) {
          if (!title.capabilities.includes(capability)) continue;
          calls += 1;
          try {
            await CALLS[capability](instance);
          } catch (error) {
            // The whole point: every failure is one of ours, carrying a
            // provider, a code and a message a caller can act on.
            if (error instanceof GameStatsError) continue;
            const thrown = error as Error;
            escapes.push(`${title.id}.${capability}: ${thrown.name}: ${thrown.message}`);
          }
        }
      }

      expect(calls, `only ${calls} calls - has the registry shrunk?`).toBeGreaterThan(500);
      // Without this the sweep could pass by never reaching a mapper at all: a
      // rate limiter that refused every call throws a GameStatsError too.
      expect(
        upstream.requests(),
        `only ${upstream.requests()} requests for ${calls} calls - the mappers are not being reached`,
      ).toBeGreaterThan(calls / 2);
      expect(escapes.slice(0, 20), `${escapes.length} of ${calls} escaped`).toEqual([]);
    },
    300_000,
  );
});

describe("the boundary translation", () => {
  it("says which call could not be mapped", async () => {
    const client = unthrottled(
      new GameStatsClient(testOptions(always({ data: ["x"] }).fetch, { apiKeys: ALL_KEYS })),
    );
    let message = "";
    try {
      await client.title("warcraft-3").getLeaderboard({});
    } catch (error) {
      message = (error as Error).message;
      // The original error is kept, so the stack still points at the line that
      // actually broke rather than at the wrapper.
      expect((error as Error).cause).toBeDefined();
    }
    // The title and the call, both in the message: enough for a bug report
    // without a stack trace, which is what an operator reading a log has.
    expect(message).toContain("warcraft-3");
    expect(message).toContain("getLeaderboard");
    expect(message).toContain("could not map");
  });

  it("does not relabel a deliberate error", async () => {
    const client = unthrottled(
      new GameStatsClient(testOptions(always({}).fetch, { apiKeys: ALL_KEYS })),
    );
    const noPlayerApi = listTitles().find(
      (title) => !title.capabilities.includes("getPlayer"),
    )!;
    await expect(
      client.title(noPlayerApi.id).getPlayer({ name: "probe" }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });
});
