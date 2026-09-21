#!/usr/bin/env node
/**
 * Regenerate `shared/registry/`.
 *
 * The JSON under `shared/` is the machine-readable form of the two registries -
 * every title and every provider, with the capabilities each actually serves.
 * It exists so that things which are not this package can read the coverage:
 * a documentation site, a dashboard, a bot's slash-command choices, a script
 * that checks which keys a deployment is missing.
 *
 * It is generated, never edited. A diff here means the coverage of the package
 * changed, which belongs in CHANGELOG.md with a version bump.
 *
 * Usage:
 *   npm run build && node scripts/generate-registry.mjs
 *   node scripts/generate-registry.mjs --check   # fail if out of date (CI)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "shared", "registry");
const check = process.argv.includes("--check");

// pathToFileURL, not a bare path: a Windows absolute path is not a valid
// module specifier and would fail with a confusing ERR_UNSUPPORTED_ESM_URL_SCHEME.
const distPath = pathToFileURL(join(here, "..", "dist", "index.mjs")).href;
const dist = await import(distPath).catch((error) => {
  console.error(`could not load dist/index.mjs: ${error.message}`);
  return null;
});
if (!dist) {
  console.error("Run `npm run build` first.");
  process.exit(1);
}

const { listTitles, listProviders, ESPORTS_CAPABILITY_PROVIDERS, dedicatedTitleIds, VERSION } =
  dist;

/**
 * Bumped when the shape of these files changes, so a consumer written against
 * an older layout fails loudly instead of reading half of it.
 */
const FORMAT_VERSION = 1;

/** Every method the canonical surface exposes, in the order the docs use. */
const CAPABILITIES = [
  "resolvePlayer",
  "getPlayer",
  "getPlayerStats",
  "getRank",
  "getMatchHistory",
  "getMatch",
  "getLeaderboard",
  "getMetadata",
  "getEsportsMatches",
  "getEsportsTournaments",
  "getEsportsTeams",
  "getEsportsPlayers",
  "getStandings",
  "getEarnings",
];

const dedicated = new Set(dedicatedTitleIds());

const titles = {
  formatVersion: FORMAT_VERSION,
  packageVersion: VERSION,
  count: listTitles().length,
  titles: listTitles().map((title) => ({
    id: title.id,
    name: title.name,
    aliases: [...title.aliases],
    genre: title.genre,
    publisher: title.publisher,
    releaseYear: title.releaseYear,
    status: title.status,
    providers: [...title.providers],
    capabilities: [...title.capabilities],
    identifiers: [...title.identifiers],
    regions: [...title.regions],
    platforms: [...title.platforms],
    // True when the package ships a bespoke client rather than serving the
    // title through the generic esports surface alone.
    dedicatedClient: dedicated.has(title.id),
  })),
};

const providers = {
  formatVersion: FORMAT_VERSION,
  packageVersion: VERSION,
  count: listProviders().length,
  /** Which provider can answer which esports question. */
  esportsCapabilities: ESPORTS_CAPABILITY_PROVIDERS,
  providers: listProviders().map((provider) => ({
    id: provider.id,
    label: provider.label,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    auth: provider.auth,
    optionalAuth: provider.optionalAuth === true,
    keyName: provider.keyName,
    docsUrl: provider.docsUrl,
    rps: provider.rps,
    burst: provider.burst,
    requiresUserAgent: provider.requiresUserAgent,
    notes: provider.notes,
    titles: listTitles()
      .filter((title) => title.providers.includes(provider.id))
      .map((title) => title.id),
  })),
};

/** A flat matrix, for the coverage table in the README and for a docs site. */
const coverage = {
  formatVersion: FORMAT_VERSION,
  packageVersion: VERSION,
  capabilities: CAPABILITIES,
  rows: listTitles().map((title) => ({
    id: title.id,
    name: title.name,
    genre: title.genre,
    // A compact bitmask-style row: 1 for supported, 0 for not.
    supports: Object.fromEntries(
      CAPABILITIES.map((capability) => [
        capability,
        title.capabilities.includes(capability) ? 1 : 0,
      ]),
    ),
  })),
};

const files = [
  ["titles.json", titles],
  ["providers.json", providers],
  ["coverage.json", coverage],
];

mkdirSync(outDir, { recursive: true });

let stale = false;
for (const [name, payload] of files) {
  const path = join(outDir, name);
  const next = `${JSON.stringify(payload, null, 2)}\n`;

  if (check) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = "";
    }
    if (current !== next) {
      console.error(`out of date: shared/registry/${name}`);
      stale = true;
    }
    continue;
  }

  writeFileSync(path, next, "utf8");
  console.log(`wrote shared/registry/${name} (${payload.count ?? payload.rows.length} entries)`);
}

if (check && stale) {
  console.error("\nRun `npm run build && npm run registry` and commit the result.");
  process.exit(1);
}
if (check) console.log("shared/registry is up to date.");
