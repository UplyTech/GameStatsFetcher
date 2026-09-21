import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findTitle,
  getTitle,
  listTitles,
  searchTitles,
  suggestTitles,
  supports,
  titleCount,
  titlesByCapability,
  titlesByGenre,
  titlesByPlatform,
  titlesByProvider,
} from "../src/titles.js";
import { providersFor } from "../src/esports.js";
import {
  ESPORTS_CAPABILITY_PROVIDERS,
  findProvider,
  getProvider,
  listProviders,
  providersByKind,
  rateLimitTable,
  registerProvider,
} from "../src/providers.js";
import { UnknownProviderError, UnknownTitleError } from "../src/errors.js";
import { dedicatedTitleIds } from "../src/games/index.js";

describe("title registry integrity", () => {
  const titles = listTitles();

  it("holds a substantial catalogue", () => {
    expect(titles.length).toBeGreaterThanOrEqual(70);
    expect(titleCount()).toBe(titles.length);
  });

  it("has no duplicate ids", () => {
    const ids = titles.map((title) => title.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every title at least one provider", () => {
    for (const title of titles) {
      expect(title.providers.length, `${title.id} has no provider`).toBeGreaterThan(0);
    }
  });

  it("only names providers that exist in the provider registry", () => {
    for (const title of titles) {
      for (const providerId of title.providers) {
        expect(findProvider(providerId), `${title.id} names unknown provider ${providerId}`).toBeDefined();
      }
    }
  });

  it("gives every title at least one capability", () => {
    for (const title of titles) {
      expect(title.capabilities.length, `${title.id} can do nothing`).toBeGreaterThan(0);
    }
  });

  it("gives every title that can resolve a player something to resolve it from", () => {
    for (const title of titles) {
      if (!supports(title, "resolvePlayer")) continue;
      expect(title.identifiers.length, `${title.id} accepts no identifier`).toBeGreaterThan(0);
    }
  });

  it("never claims a player capability without resolvePlayer", () => {
    // Every player-facing method needs a ref, and a ref comes from resolving.
    const needsResolve = ["getPlayer", "getPlayerStats", "getMatchHistory"] as const;
    for (const title of titles) {
      for (const capability of needsResolve) {
        if (supports(title, capability)) {
          expect(supports(title, "resolvePlayer"), `${title.id} claims ${capability}`).toBe(true);
        }
      }
    }
  });

  it("has a plausible release year for every title", () => {
    for (const title of titles) {
      expect(title.releaseYear).toBeGreaterThan(1400);
      expect(title.releaseYear).toBeLessThanOrEqual(new Date().getFullYear() + 1);
    }
  });

  it("registers a dedicated client only for a title that exists", () => {
    for (const id of dedicatedTitleIds()) {
      expect(findTitle(id), `dedicated client for unknown title ${id}`).toBeDefined();
    }
  });
});

describe("title lookup", () => {
  it("finds a title by id, name and alias", () => {
    expect(findTitle("cs2")?.id).toBe("cs2");
    expect(findTitle("Counter-Strike 2")?.id).toBe("cs2");
    expect(findTitle("csgo")?.id).toBe("cs2");
  });

  it("ignores case and punctuation", () => {
    expect(findTitle("CS:GO")?.id).toBe("cs2");
    expect(findTitle("cs go")?.id).toBe("cs2");
    expect(findTitle("  LoL  ")?.id).toBe("league-of-legends");
  });

  it("returns undefined for an unknown title rather than throwing", () => {
    expect(findTitle("halflife3")).toBeUndefined();
  });

  it("throws with suggestions when the strict lookup misses", () => {
    expect(() => getTitle("valorent")).toThrow(UnknownTitleError);
    try {
      getTitle("valorent");
    } catch (error) {
      expect((error as UnknownTitleError).suggestions).toContain("valorant");
    }
  });
});

describe("title search", () => {
  it("puts an exact match first", () => {
    expect(searchTitles("dota")[0]?.id).toBe("dota2");
  });

  it("tolerates a typo", () => {
    expect(searchTitles("overwatc").map((title) => title.id)).toContain("overwatch-2");
  });

  it("respects the limit", () => {
    expect(searchTitles("a", 3).length).toBeLessThanOrEqual(3);
  });

  it("returns the head of the catalogue for an empty query", () => {
    expect(searchTitles("", 5).length).toBe(5);
  });

  it("suggests ids, not descriptors", () => {
    expect(suggestTitles("leagu", 2).every((id) => typeof id === "string")).toBe(true);
  });
});

describe("title filters", () => {
  it("filters by genre", () => {
    const fighting = titlesByGenre("fighting");
    expect(fighting.length).toBeGreaterThan(5);
    expect(fighting.map((title) => title.id)).toContain("tekken-8");
  });

  it("filters by provider, which answers 'what breaks if Riot goes down'", () => {
    const riot = titlesByProvider("riot");
    expect(riot.map((title) => title.id)).toEqual(
      expect.arrayContaining(["league-of-legends", "valorant", "teamfight-tactics"]),
    );
  });

  it("filters by capability", () => {
    const ranked = titlesByCapability("getRank");
    expect(ranked.map((title) => title.id)).toContain("league-of-legends");
    expect(ranked.map((title) => title.id)).not.toContain("tekken-8");
  });

  it("filters by platform", () => {
    expect(titlesByPlatform("android").map((title) => title.id)).toContain("clash-royale");
  });

  it("never declares an esports capability no provider for that title can serve", () => {
    // This is the invariant that keeps the registry a contract rather than a
    // wish list: a declared capability must be reachable with some credential.
    const offenders: string[] = [];
    for (const title of listTitles()) {
      for (const capability of [
        "getEsportsMatches",
        "getEsportsTournaments",
        "getEsportsTeams",
        "getEsportsPlayers",
        "getStandings",
      ] as const) {
        if (!supports(title, capability)) continue;
        if (providersFor(title, capability).length === 0) {
          offenders.push(`${title.id}.${capability}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only claims getEarnings for titles that name a prize-money source", () => {
    const offenders = listTitles()
      .filter((title) => supports(title, "getEarnings"))
      .filter((title) => !title.providers.includes("esports-earnings"))
      .map((title) => title.id);
    expect(offenders).toEqual([]);
  });

  it("gives every title the esports tournament capability or a stated reason", () => {
    // Most titles here are esports titles and every one of those must be able
    // to list tournaments. The exceptions are games that have a real,
    // first-party player API and no professional circuit at all - the package's
    // rule is "if it has an API it belongs here", not "if it has a circuit".
    //
    // The list is written out rather than computed. A title that quietly stops
    // reporting tournaments would otherwise join it without anybody noticing,
    // and that is the failure this test exists to catch.
    const NO_CIRCUIT = ["diablo-3", "eve-online", "old-school-runescape", "runescape"];

    const without = listTitles()
      .filter((title) => !supports(title, "getEsportsTournaments"))
      .map((title) => title.id)
      .sort();
    expect(without).toEqual(NO_CIRCUIT);
  });

  it("never claims an esports capability without a provider that answers it", () => {
    // The other half of the rule above. Tournaments without live matches is a
    // normal state - Liquipedia covers the brackets for titles PandaScore has
    // never carried - so the guard is not "all or nothing" but "nothing
    // unbacked": every esports capability a title claims must have at least one
    // esports provider behind it.
    const ESPORTS_PROVIDERS = [
      "pandascore",
      "abios",
      "liquipedia",
      "esports-earnings",
      "startgg",
      "toornament",
      "challonge",
      "octane",
    ];
    const offenders = listTitles()
      .filter((title) =>
        title.capabilities.some((capability) => capability.startsWith("getEsports")),
      )
      .filter(
        (title) => !title.providers.some((provider) => ESPORTS_PROVIDERS.includes(provider)),
      )
      .map((title) => title.id);
    expect(offenders).toEqual([]);
  });
});

describe("provider registry integrity", () => {
  const providers = listProviders();

  it("holds every provider the titles reference", () => {
    expect(providers.length).toBeGreaterThanOrEqual(40);
  });

  it("has no duplicate ids", () => {
    const ids = providers.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no provider nothing can route to", () => {
    // A provider no title names and no caller can reach is dead code that still
    // has to be maintained, rate-limited and documented.
    //
    // Three are reachable only through the explicit escape hatch,
    // `getEsportsMatches({ provider })`, and that is deliberate rather than an
    // omission: Abios is commercial, and Toornament and Challonge are bracket
    // platforms that do not know what game a bracket is for. No title can
    // honestly claim them, so a caller who has one names it.
    //
    // The list is spelled out so a *fourth* provider left unrouted by accident
    // still fails this test. Mirrored in python/tests/test_registry.py.
    const routed = new Set(listTitles().flatMap((title) => title.providers));
    const unrouted = providers
      .map((provider) => provider.id)
      .filter((id) => !routed.has(id))
      .sort();

    expect(unrouted).toEqual(["abios", "challonge", "toornament"]);
  });

  it("keeps the opt-in providers able to answer something", () => {
    // Being unrouted is only acceptable while the capability table knows what
    // they do - otherwise naming one explicitly would fail too.
    const served = new Set(Object.values(ESPORTS_CAPABILITY_PROVIDERS).flat());
    for (const id of ["abios", "toornament", "challonge"]) {
      expect(served.has(id), `${id} serves no capability`).toBe(true);
    }
  });

  it("gives every authenticated provider a key name and a docs link", () => {
    for (const provider of providers) {
      if (provider.auth === "none") continue;
      expect(provider.keyName, `${provider.id} has no keyName`).toBeTruthy();
      expect(provider.docsUrl, `${provider.id} has no docsUrl`).toMatch(/^https?:\/\//);
    }
  });

  it("gives every provider a positive rate limit", () => {
    for (const provider of providers) {
      expect(provider.rps, `${provider.id} rps`).toBeGreaterThan(0);
      expect(provider.burst, `${provider.id} burst`).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps the strictest published limits, because they are conditions of use", () => {
    // Esports Earnings documents one request per second, and Liquipedia's terms
    // ask for one per two seconds. Loosening either would breach them.
    expect(getProvider("esports-earnings").rps).toBeLessThanOrEqual(1);
    expect(getProvider("liquipedia").rps).toBeLessThanOrEqual(0.5);
    expect(getProvider("liquipedia").requiresUserAgent).toBe(true);
  });

  it("throws for an unknown provider", () => {
    expect(() => getProvider("nope")).toThrow(UnknownProviderError);
    expect(findProvider("nope")).toBeUndefined();
  });

  it("groups providers by who runs them", () => {
    expect(providersByKind("first-party").length).toBeGreaterThan(5);
    expect(providersByKind("esports-data").map((p) => p.id)).toContain("pandascore");
    expect(providersByKind("tournament-platform").map((p) => p.id)).toContain("startgg");
  });

  it("builds a rate-limit table covering every provider", () => {
    const table = rateLimitTable();
    expect(Object.keys(table).length).toBe(providers.length);
    expect(table.steam).toEqual({ rps: 5, burst: 10 });
  });

  it("refuses to replace a built-in provider", () => {
    expect(() =>
      registerProvider({
        id: "steam",
        label: "impostor",
        kind: "community",
        baseUrl: "https://example.com",
        auth: "none",
        keyName: null,
        docsUrl: "https://example.com",
        rps: 1,
        burst: 1,
        requiresUserAgent: false,
        notes: null,
      }),
    ).toThrow(/already registered/);
  });
});

describe("the accessibility contract", () => {
  /**
   * The promises the README makes to anybody rendering this data.
   *
   * None of these is about the package's own output - it draws nothing. They
   * are about never being the reason a caller's interface is unusable: a rank
   * that exists only as a colour, a ratio that only makes sense as a bar, a
   * missing value that renders as zero.
   */

  it("gives every ratio a name that states its scale", () => {
    // A caller announcing "62.5 percent" needs to know 625 means that, and the
    // field name is where that is stated. Read off the built declaration file,
    // because that is what a consumer actually sees.
    const declaration = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "types.ts"),
      "utf8",
    );
    const ratios = [...declaration.matchAll(/readonly (\w*(?:Rate|Percentile|[Kk]d)\w*)/g)].map(
      (match) => match[1] as string,
    );
    expect(ratios.length).toBeGreaterThan(0);
    for (const name of ratios) {
      expect(name).toMatch(/Permille$/);
    }
  });

  it("makes every reported number nullable, so nothing missing reads as zero", () => {
    // The single most common way this data becomes a lie: an upstream that
    // reported nothing rendered as "0 %".
    const declaration = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "types.ts"),
      "utf8",
    );
    const block = declaration.slice(
      declaration.indexOf("export interface PlayerStats"),
      declaration.indexOf("export interface ModeStats"),
    );
    const numbers = [...block.matchAll(/readonly (\w+): number( \| null)?/g)];
    expect(numbers.length).toBeGreaterThan(0);
    for (const match of numbers) {
      expect(match[2], `PlayerStats.${match[1]} must be nullable`).toBe(" | null");
    }
  });

  it("names the source on every ref, in text", () => {
    // So a UI can write "according to OpenDota" rather than colour-coding it.
    const title = listTitles()[0]!;
    expect(title.providers.length).toBeGreaterThan(0);
    expect(typeof title.providers[0]).toBe("string");
  });
});
