/**
 * The TypeScript half of the cross-edition contract.
 *
 * `shared/vectors/` is generated *from* this edition, so on the surface this
 * suite looks circular - of course the generator's output matches the code it
 * was generated from. It is not circular, because of when it runs: the vectors
 * are committed, and this suite replays them against the *current* source. So
 * it catches the case that actually matters, which is a change to a pure
 * function landing without the vectors being regenerated - at which point the
 * Python edition is still asserting the old behaviour and the two have silently
 * diverged.
 *
 * A failure here means one of two things:
 *
 *   1. The change was intentional - run `npm run build && npm run vectors`,
 *      commit the new vectors, and the Python suite will pick up the new
 *      expectation on its next run.
 *   2. The change was not intentional, and this is the bug report.
 *
 * Either way the answer is never to edit `shared/vectors/` by hand.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RATE_LIMIT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TTL_SECONDS,
  DEFAULT_USER_AGENT,
  ESPORTS_CAPABILITY_PROVIDERS,
  MAX_PAGE_SIZE,
  PERMILLE,
  STEAM_APP_IDS,
  TTL,
  VERSION,
  bool,
  clamp,
  dashUuid,
  encodeSupercellTag,
  esportsProvidersFor,
  int,
  isSteamId64,
  kd,
  matchResult,
  normaliseSupercellTag,
  num,
  parseRiotId,
  permille,
  str,
  sum,
  toBattleTagPath,
  toMinorUnits,
  toSteamAccountId,
  toSteamId2,
  toSteamId3,
  toSteamId64,
  ts,
  undashUuid,
  winRate,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectorDir = join(here, "..", "..", "shared", "vectors");

/** Layout this suite understands. Mirrored in `python/tests/test_shared_vectors.py`. */
const FORMAT_VERSION = 1;

interface Case {
  args: unknown[];
  value?: unknown;
  error?: string;
}

function load(name: string): Record<string, never> & {
  formatVersion: number;
  [key: string]: unknown;
} {
  const payload = JSON.parse(readFileSync(join(vectorDir, `${name}.json`), "utf8"));
  expect(
    payload.formatVersion,
    `shared/vectors/${name}.json was written by a different generator`,
  ).toBe(FORMAT_VERSION);
  return payload;
}

/**
 * Replay one function's cases.
 *
 * A case carries either a `value` the function must return or an `error`,
 * meaning it threw - and it must still throw, because "this input is rejected"
 * is as much a part of the contract as any return value.
 */
function replay(
  fn: (...args: never[]) => unknown,
  cases: Case[],
  label: string,
): void {
  for (const item of cases) {
    const args = item.args as never[];
    const shown = JSON.stringify(item.args);

    if (item.error !== undefined) {
      expect(() => fn(...args), `${label}(${shown}) should throw`).toThrow();
      continue;
    }

    expect(fn(...args), `${label}(${shown})`).toEqual(item.value);
  }
}

describe("shared vectors: normalisation", () => {
  const vectors = load("normalize");

  it("declares the package version it was generated from", () => {
    expect(vectors.packageVersion).toBe(VERSION);
  });

  it("has cases for every function it names", () => {
    // Guards against a vector file that quietly lost a section - an empty array
    // passes every assertion below without testing anything.
    for (const key of [
      "num",
      "int",
      "str",
      "bool",
      "ts",
      "permille",
      "winRate",
      "kd",
      "clamp",
      "toMinorUnits",
      "sum",
      "matchResult",
    ]) {
      expect((vectors[key] as Case[]).length, `${key} cases`).toBeGreaterThan(0);
    }
  });

  it("num", () => replay(num as never, vectors.num as Case[], "num"));
  it("int", () => replay(int as never, vectors.int as Case[], "int"));
  it("str", () => replay(str as never, vectors.str as Case[], "str"));
  it("bool", () => replay(bool as never, vectors.bool as Case[], "bool"));
  it("ts", () => replay(ts as never, vectors.ts as Case[], "ts"));
  it("permille", () =>
    replay(permille as never, vectors.permille as Case[], "permille"));
  it("winRate", () => replay(winRate as never, vectors.winRate as Case[], "winRate"));
  it("kd", () => replay(kd as never, vectors.kd as Case[], "kd"));
  it("clamp", () => replay(clamp as never, vectors.clamp as Case[], "clamp"));
  it("toMinorUnits", () =>
    replay(toMinorUnits as never, vectors.toMinorUnits as Case[], "toMinorUnits"));
  it("sum", () => replay(sum as never, vectors.sum as Case[], "sum"));
  it("matchResult", () =>
    replay(matchResult as never, vectors.matchResult as Case[], "matchResult"));

  it("rounds halves the way the Python edition is made to", () => {
    // The single most likely place for the editions to drift, called out here
    // so a failure names the reason instead of a bare number mismatch: Python's
    // round() is banker's rounding and would give 62 for 1/16.
    expect(permille(1, 16)).toBe(63);
    expect(permille(3, 16)).toBe(188);
  });
});

describe("shared vectors: identity", () => {
  const vectors = load("identity");

  it("isSteamId64", () =>
    replay(isSteamId64 as never, vectors.isSteamId64 as Case[], "isSteamId64"));
  it("toSteamId64", () =>
    replay(toSteamId64 as never, vectors.toSteamId64 as Case[], "toSteamId64"));
  it("toSteamAccountId", () =>
    replay(
      toSteamAccountId as never,
      vectors.toSteamAccountId as Case[],
      "toSteamAccountId",
    ));
  it("toSteamId2", () =>
    replay(toSteamId2 as never, vectors.toSteamId2 as Case[], "toSteamId2"));
  it("toSteamId3", () =>
    replay(toSteamId3 as never, vectors.toSteamId3 as Case[], "toSteamId3"));

  it("parseRiotId", () => {
    // Compared field by field: the generator flattens the result so the Python
    // edition, whose RiotId is a dataclass, can compare like for like.
    for (const item of vectors.parseRiotId as Case[]) {
      const args = item.args as [string];
      if (item.error !== undefined) {
        expect(() => parseRiotId(...args)).toThrow();
        continue;
      }
      const parsed = parseRiotId(...args);
      expect({ gameName: parsed.gameName, tagLine: parsed.tagLine }).toEqual(item.value);
    }
  });

  it("toBattleTagPath", () =>
    replay(
      toBattleTagPath as never,
      vectors.toBattleTagPath as Case[],
      "toBattleTagPath",
    ));
  it("normaliseSupercellTag", () =>
    replay(
      normaliseSupercellTag as never,
      vectors.normaliseSupercellTag as Case[],
      "normaliseSupercellTag",
    ));
  it("encodeSupercellTag", () =>
    replay(
      encodeSupercellTag as never,
      vectors.encodeSupercellTag as Case[],
      "encodeSupercellTag",
    ));
  it("dashUuid", () =>
    replay(dashUuid as never, vectors.dashUuid as Case[], "dashUuid"));
  it("undashUuid", () =>
    replay(undashUuid as never, vectors.undashUuid as Case[], "undashUuid"));
});

describe("shared vectors: esports", () => {
  const vectors = load("esports");

  it("capability table is unchanged", () => {
    expect(ESPORTS_CAPABILITY_PROVIDERS).toEqual(vectors.capabilityProviders);
  });

  it("esportsProvidersFor", () => {
    for (const item of vectors.esportsProvidersFor as Case[]) {
      const [providerIds, capability] = item.args as [string[], never];
      expect(
        esportsProvidersFor(providerIds, capability),
        `esportsProvidersFor(${JSON.stringify(item.args)})`,
      ).toEqual(item.value);
    }
  });
});

describe("shared vectors: constants", () => {
  const vectors = load("constants");

  it("version", () => expect(VERSION).toBe(vectors.version));
  it("ttl table", () => expect(TTL).toEqual(vectors.ttl));
  it("steam app ids", () => expect(STEAM_APP_IDS).toEqual(vectors.steamAppIds));

  it("registers no placeholder app ids", () => {
    // Zero would mean "on Steam, id unknown", which is a fact nobody has. The
    // client's own guard rejects it, so an entry like that is a lie that only
    // shows up as a confusing error at call time.
    for (const [title, appId] of Object.entries(STEAM_APP_IDS)) {
      expect(appId, `app id for ${title}`).toBeGreaterThan(0);
    }
  });

  it("scalars", () => {
    expect(PERMILLE).toBe(vectors.permille);
    expect(MAX_PAGE_SIZE).toBe(vectors.maxPageSize);
    expect(DEFAULT_TTL_SECONDS).toBe(vectors.defaultTtlSeconds);
    expect(DEFAULT_TIMEOUT_MS).toBe(vectors.defaultTimeoutMs);
    expect(DEFAULT_RATE_LIMIT).toEqual(vectors.defaultRateLimit);
    expect(DEFAULT_USER_AGENT).toBe(vectors.defaultUserAgent);
  });

  it("covers every TTL the runtime asks for", () => {
    // A missing key falls back to DEFAULT_TTL_SECONDS silently, so an esports
    // fixture would be cached for a minute instead of thirty seconds and only
    // an operator staring at stale scores would ever notice.
    for (const key of ["rank", "match", "esportsMatchesLive", "earnings"]) {
      expect(TTL, `TTL.${key}`).toHaveProperty(key);
    }
  });
});
