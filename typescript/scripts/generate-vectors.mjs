#!/usr/bin/env node
/**
 * Regenerate `shared/vectors/`.
 *
 * These files are the contract between the TypeScript and the Python edition.
 * The registry (`shared/registry/`) already guarantees the two agree about
 * *coverage*; these vectors guarantee they agree about *behaviour* - the pure
 * functions where a one-character difference would silently produce two
 * dashboards that disagree in the third decimal.
 *
 * Both suites read them:
 *
 *   typescript/tests/shared-vectors.test.ts
 *   python/tests/test_shared_vectors.py
 *
 * Usage:
 *   npm run build && node scripts/generate-vectors.mjs
 *   node scripts/generate-vectors.mjs --check   # fail if out of date (CI)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "shared", "vectors");
const check = process.argv.includes("--check");

const distPath = pathToFileURL(join(here, "..", "dist", "index.mjs")).href;
const dist = await import(distPath).catch((error) => {
  console.error(`could not load dist/index.mjs: ${error.message}`);
  return null;
});
if (!dist) {
  console.error("Run `npm run build` first.");
  process.exit(1);
}

const FORMAT_VERSION = 1;

/**
 * Run a case and record what came back, or the error class if it threw.
 *
 * Errors are part of the contract too: `toSteamId64("gaben")` must fail in both
 * editions, and it must fail as a validation error rather than a crash.
 */
function evaluate(fn, args) {
  try {
    return { args, value: fn(...args) };
  } catch (error) {
    return { args, error: error?.name ?? "Error" };
  }
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const normalize = {
  formatVersion: FORMAT_VERSION,
  packageVersion: dist.VERSION,
  note:
    "Pure normalisation functions. Both editions must produce these values " +
    "exactly - permille rounding in particular, because JavaScript rounds " +
    "halves up and Python's round() is banker's rounding.",
  num: [
    [0], [1], [-1], [1.5], ["42"], ["3.5"], [""], [null], [undefined],
    [true], [false], ["abc"], [{}],
  ].map((args) => evaluate(dist.num, args)),
  int: [[3.9], [-3.9], ["7.2"], [0], [null], ["abc"]].map((args) =>
    evaluate(dist.int, args),
  ),
  str: [["  hello  "], ["   "], [""], [null], [42], [0]].map((args) =>
    evaluate(dist.str, args),
  ),
  bool: [
    [true], [false], ["true"], ["false"], [1], [0], ["1"], ["0"],
    ["maybe"], [null],
  ].map((args) => evaluate(dist.bool, args)),
  ts: [
    [1_700_000_000_000],
    [1_700_000_000],
    ["2024-01-01T00:00:00.000Z"],
    ["2024-01-01T00:00:00Z"],
    ["1700000000"],
    [0],
    [-5],
    ["not a date"],
    [null],
  ].map((args) => evaluate(dist.ts, args)),
  permille: [
    [1, 2], [1, 3], [2, 3], [1, 0], [0, 5], [null, 10], [10, null],
    // The half-rounding cases: 1/8 is 125, 3/8 is 375, 1/16 is exactly 62.5.
    [1, 8], [3, 8], [1, 16], [3, 16],
  ].map((args) => evaluate(dist.permille, args)),
  winRate: [
    [5, 5], [5, 4, 1], [0, 0], [null, 5], [3, 0], [1, 2],
  ].map((args) => evaluate(dist.winRate, args)),
  kd: [[10, 0], [10, 5], [3, 4], [0, 0], [null, 4]].map((args) =>
    evaluate(dist.kd, args),
  ),
  clamp: [[5, 1, 100], [0, 1, 100], [1000, 1, 100]].map((args) =>
    evaluate(dist.clamp, args),
  ),
  toMinorUnits: [[12.34], [1_000_000], [0.005], [null]].map((args) =>
    evaluate(dist.toMinorUnits, args),
  ),
  sum: [
    [[1, null, 2, undefined]],
    [[null, undefined]],
    [[]],
    [[0]],
  ].map((args) => evaluate(dist.sum, args)),
  matchResult: [
    [true], [false], ["true"], [true, true], [undefined], [null],
  ].map((args) => evaluate(dist.matchResult, args)),
};

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const GABEN_64 = "76561197960287930";

const identity = {
  formatVersion: FORMAT_VERSION,
  packageVersion: dist.VERSION,
  note:
    "Identifier conversions. A player whose Steam id converts differently in " +
    "a Python bot and a Node service is two different people to a database.",
  isSteamId64: [[GABEN_64], ["22202"], ["7656119796028793"], [""]].map((args) =>
    evaluate(dist.isSteamId64, args),
  ),
  toSteamId64: [
    [GABEN_64],
    ["[U:1:22202]"],
    ["U:1:22202"],
    ["STEAM_0:0:11101"],
    ["22202"],
    ["1"],
    ["7656119796028793000"],
    ["gaben"],
    [""],
  ].map((args) => evaluate(dist.toSteamId64, args)),
  toSteamAccountId: [[GABEN_64], ["STEAM_0:0:11101"]].map((args) =>
    evaluate(dist.toSteamAccountId, args),
  ),
  toSteamId2: [[GABEN_64], ["22203"]].map((args) => evaluate(dist.toSteamId2, args)),
  toSteamId3: [[GABEN_64]].map((args) => evaluate(dist.toSteamId3, args)),
  parseRiotId: [
    ["Faker#KR1"],
    ["no#1 fan#EUW"],
    ["Faker"],
    ["Faker#"],
    ["#KR1"],
  ].map((args) => {
    const result = evaluate(dist.parseRiotId, args);
    // Rendered as a plain object so the two editions compare like for like.
    return result.value
      ? { args, value: { gameName: result.value.gameName, tagLine: result.value.tagLine } }
      : result;
  }),
  toBattleTagPath: [["Player#1234"], ["Player-1234"], ["Player"]].map((args) =>
    evaluate(dist.toBattleTagPath, args),
  ),
  normaliseSupercellTag: [
    ["2ppOjcvl"],
    ["#2PP0JCVL"],
    ["  #2pp  "],
    ["#ABC"],
    [""],
  ].map((args) => evaluate(dist.normaliseSupercellTag, args)),
  encodeSupercellTag: [["#2PP"]].map((args) =>
    evaluate(dist.encodeSupercellTag, args),
  ),
  dashUuid: [
    ["069a79f444e94726a5befca90e38aaf5"],
    ["069a79f4-44e9-4726-a5be-fca90e38aaf5"],
    ["nope"],
  ].map((args) => evaluate(dist.dashUuid, args)),
  undashUuid: [["069a79f4-44e9-4726-A5BE-fca90e38aaf5"]].map((args) =>
    evaluate(dist.undashUuid, args),
  ),
};

// ---------------------------------------------------------------------------
// Esports vocabulary
// ---------------------------------------------------------------------------

const esports = {
  formatVersion: FORMAT_VERSION,
  packageVersion: dist.VERSION,
  note:
    "The one status vocabulary, and the provider-capability table. Both " +
    "editions map every provider's spelling onto the same six values.",
  capabilityProviders: dist.ESPORTS_CAPABILITY_PROVIDERS,
  esportsProvidersFor: [
    [["steam", "faceit", "pandascore", "liquipedia"], "getEsportsMatches"],
    [["startgg", "liquipedia", "esports-earnings"], "getEsportsTeams"],
    [["startgg", "liquipedia", "esports-earnings"], "getStandings"],
    [["deadlock-api", "liquipedia"], "getEsportsTeams"],
    [["riot", "pandascore"], "getPlayer"],
  ].map(([providerIds, capability]) => ({
    args: [providerIds, capability],
    value: dist.esportsProvidersFor(providerIds, capability),
  })),
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const constants = {
  formatVersion: FORMAT_VERSION,
  packageVersion: dist.VERSION,
  note:
    "Values that must not drift between the editions. A TTL that differs " +
    "means two deployments show a rank of a different age for the same player.",
  version: dist.VERSION,
  ttl: dist.TTL,
  steamAppIds: dist.STEAM_APP_IDS,
  permille: dist.PERMILLE,
  maxPageSize: dist.MAX_PAGE_SIZE,
  defaultTtlSeconds: dist.DEFAULT_TTL_SECONDS,
  defaultTimeoutMs: dist.DEFAULT_TIMEOUT_MS,
  defaultRateLimit: dist.DEFAULT_RATE_LIMIT,
  defaultUserAgent: dist.DEFAULT_USER_AGENT,
};

// ---------------------------------------------------------------------------

const files = [
  ["normalize.json", normalize],
  ["identity.json", identity],
  ["esports.json", esports],
  ["constants.json", constants],
];

mkdirSync(outDir, { recursive: true });

let stale = false;
for (const [name, payload] of files) {
  const path = join(outDir, name);
  // `undefined` does not survive JSON, so it is written as null - which is what
  // both editions mean by "absent" anyway.
  const next = `${JSON.stringify(payload, (_key, value) => (value === undefined ? null : value), 2)}\n`;

  if (check) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = "";
    }
    if (current !== next) {
      console.error(`out of date: shared/vectors/${name}`);
      stale = true;
    }
    continue;
  }

  writeFileSync(path, next, "utf8");
  console.log(`wrote shared/vectors/${name}`);
}

if (check && stale) {
  console.error("\nRun `npm run build && npm run vectors` and commit the result.");
  process.exit(1);
}
if (check) console.log("shared/vectors is up to date.");
