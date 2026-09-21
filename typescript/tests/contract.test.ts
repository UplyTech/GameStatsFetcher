/**
 * The registry is the contract, and this file is what makes that true.
 *
 * Every title is walked, every method is called, and each one is asserted to
 * behave the way its registry entry says it will:
 *
 * - a capability the title does not declare must throw
 *   `UnsupportedCapabilityError`, never return an empty array;
 * - a capability it does declare must not throw that error.
 *
 * The upstream is a fetch that answers 503 to everything, so a declared method
 * fails as a transport error rather than a contract one - which is exactly the
 * distinction being tested.
 */

import { describe, expect, it } from "vitest";
import { GameStatsClient } from "../src/client.js";
import { listTitles } from "../src/titles.js";
import { UnsupportedCapabilityError } from "../src/errors.js";
import type { Capability, TitleDescriptor } from "../src/types.js";
import { mockFetch, testOptions, unthrottled } from "./helpers.js";

/** A key for every provider, so nothing is skipped for want of a credential. */
const ALL_KEYS = {
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
  // Numeric: osu! wants the client id as a JSON number and refuses a
  // non-numeric one before any request is made.
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

/** Every method the canonical surface exposes, with a call that exercises it. */
const CALLS: Record<Capability, (title: ReturnType<GameStatsClient["title"]>) => Promise<unknown>> = {
  resolvePlayer: (title) => title.resolvePlayer({ name: "probe", steamId: "76561197960287930", playerTag: "#2PP", battleTag: "probe#1234", puuid: "p", gameName: "probe", tagLine: "eu", accountId: "1", membershipId: "1", epicId: "e", ubisoftId: "u" }),
  getPlayer: (title) => title.getPlayer({ name: "probe" }),
  getPlayerStats: (title) => title.getPlayerStats({ name: "probe" }),
  getRank: (title) => title.getRank({ name: "probe" }),
  getMatchHistory: (title) => title.getMatchHistory({ name: "probe" }),
  getMatch: (title) => title.getMatch("m1"),
  getLeaderboard: (title) => title.getLeaderboard({}),
  getMetadata: (title) => title.getMetadata(),
  getEsportsMatches: (title) => title.getEsportsMatches(),
  getEsportsTournaments: (title) => title.getEsportsTournaments(),
  getEsportsTeams: (title) => title.getEsportsTeams(),
  getEsportsPlayers: (title) => title.getEsportsPlayers(),
  getStandings: (title) => title.getStandings("t1"),
  getEarnings: (title) => title.getEarnings("probe"),
};

const ALL_CAPABILITIES = Object.keys(CALLS) as Capability[];

function client(): GameStatsClient {
  // Everything 503s: the point is which error class comes back, not the data.
  const mock = mockFetch([{ match: "http", status: 503 }]);
  // Unthrottled so a refusal is the *contract* refusing, never the rate limiter
  // answering first: LocalRateLimitError is a GameStatsError too, and a sweep
  // that met one would be asserting nothing.
  return unthrottled(new GameStatsClient(testOptions(mock.fetch, { apiKeys: ALL_KEYS })));
}

/** Run a call and report whether it was refused on contract grounds. */
async function refusedByContract(
  title: ReturnType<GameStatsClient["title"]>,
  capability: Capability,
): Promise<boolean> {
  try {
    await CALLS[capability](title);
    return false;
  } catch (error) {
    return error instanceof UnsupportedCapabilityError;
  }
}

describe("every title client can be constructed", () => {
  const titles = listTitles();

  it.each(titles.map((title) => [title.id, title] as [string, TitleDescriptor]))(
    "%s",
    (_id, descriptor) => {
      const instance = client().title(descriptor.id);
      expect(instance.id).toBe(descriptor.id);
      expect(instance.title).toBe(descriptor);
      // supports() must agree with the registry for every capability.
      for (const capability of ALL_CAPABILITIES) {
        expect(instance.supports(capability)).toBe(
          descriptor.capabilities.includes(capability),
        );
      }
    },
  );
});

describe("undeclared capabilities throw rather than returning empty", () => {
  const titles = listTitles();

  it.each(titles.map((title) => [title.id, title] as [string, TitleDescriptor]))(
    "%s",
    async (_id, descriptor) => {
      const instance = client().title(descriptor.id);
      const undeclared = ALL_CAPABILITIES.filter(
        (capability) => !descriptor.capabilities.includes(capability),
      );

      for (const capability of undeclared) {
        expect(
          await refusedByContract(instance, capability),
          `${descriptor.id}.${capability} should have thrown UnsupportedCapabilityError`,
        ).toBe(true);
      }
    },
  );
});

describe("declared capabilities are reachable", () => {
  const titles = listTitles();

  it.each(titles.map((title) => [title.id, title] as [string, TitleDescriptor]))(
    "%s",
    async (_id, descriptor) => {
      const instance = client().title(descriptor.id);

      for (const capability of descriptor.capabilities) {
        // A declared method may fail against a dead upstream - that is a
        // transport failure. It must never fail as "this title cannot do that".
        expect(
          await refusedByContract(instance, capability),
          `${descriptor.id}.${capability} is declared but refused itself`,
        ).toBe(false);
      }
    },
  );
});

describe("titles with no player API", () => {
  it("are exactly the ones the industry gives no player API", () => {
    // A change here is a real change in coverage, not a refactor - so it should
    // be a deliberate diff rather than a silent one.
    const esportsOnly = listTitles()
      .filter((title) => !title.capabilities.includes("resolvePlayer"))
      .map((title) => title.id)
      .sort();

    expect(esportsOnly).toEqual(
      [
        "arena-of-valor",
        "assetto-corsa-competizione",
        "crossfire",
        "dragon-ball-fighterz",
        "ea-fc",
        "efootball",
        "escape-from-tarkov",
        "f1",
        "fall-guys",
        "free-fire",
        "gran-turismo-7",
        "granblue-fantasy-versus-rising",
        "guilty-gear-strive",
        "gwent",
        "hearthstone",
        "honor-of-kings",
        "king-of-fighters-15",
        "madden-nfl",
        "magic-the-gathering-arena",
        "mobile-legends",
        "mortal-kombat-1",
        "nba-2k",
        "path-of-exile",
        "point-blank",
        "pokemon-unite",
        "pubg-mobile",
        "quake-champions",
        "shadowverse",
        "splatoon-3",
        "starcraft-brood-war",
        "street-fighter-6",
        "super-smash-bros-melee",
        "super-smash-bros-ultimate",
        "tekken-8",
        "wild-rift",
      ].sort(),
    );
  });

  it("still answer the esports questions", () => {
    const gsc = client();
    for (const title of listTitles()) {
      if (title.capabilities.includes("resolvePlayer")) continue;
      const instance = gsc.title(title.id);
      expect(instance.supports("getEsportsTournaments")).toBe(true);
      expect(instance.supports("getEarnings")).toBe(true);
    }
  });
});
