/**
 * Print what this package covers, and what a given configuration can reach.
 *
 * Two uses:
 *
 * - Run it with no keys to see the whole catalogue and decide which keys are
 *   worth obtaining.
 * - Run it with your real environment as a deployment check - the "usable"
 *   count is the one that matters, and a key found missing here is a
 *   five-minute fix rather than a 3am incident.
 *
 *   npx vite-node examples/coverage-report.ts
 */

import { GameStatsClient, type Capability, type Genre } from "../src/index.js";

const client = new GameStatsClient({
  apiKeys: {
    steam: process.env.STEAM_API_KEY,
    riot: process.env.RIOT_API_KEY,
    blizzard: process.env.BLIZZARD_CLIENT,
    pandascore: process.env.PANDASCORE_TOKEN,
    startgg: process.env.STARTGG_TOKEN,
    esportsEarnings: process.env.ESPORTS_EARNINGS_KEY,
  },
});

const titles = client.titles();
const usable = new Set(client.usableTitles().map((title) => title.id));

// ---------------------------------------------------------------------------

heading(`${titles.length} titles, ${client.providers().length} providers`);

const capabilities: Capability[] = [
  "resolvePlayer",
  "getPlayerStats",
  "getRank",
  "getMatchHistory",
  "getMatch",
  "getLeaderboard",
  "getEsportsMatches",
  "getEsportsTournaments",
  "getEarnings",
];

// The number comes before the bar on purpose. A screen reader announces this
// line in order, and "resolvePlayer 52 of 87" is the sentence somebody needs -
// "hash hash hash dot dot dot" first is thirty characters of noise before the
// fact. The bar is a second, redundant encoding of a number that was already
// stated, which is the only honest way to use one.
for (const capability of capabilities) {
  const count = client.byCapability(capability).length;
  console.log(
    `  ${capability.padEnd(24)} ${String(count).padStart(3)} of ${titles.length}  ` +
      bar(count, titles.length),
  );
}

// ---------------------------------------------------------------------------

heading("By genre");

const genres = [...new Set(titles.map((title) => title.genre))].sort() as Genre[];
for (const genre of genres) {
  const inGenre = client.byGenre(genre);
  const withPlayers = inGenre.filter((title) => title.capabilities.includes("resolvePlayer"));
  console.log(
    `  ${genre.padEnd(18)} ${String(inGenre.length).padStart(2)} titles, ` +
      `${String(withPlayers.length).padStart(2)} with a player API`,
  );
}

// ---------------------------------------------------------------------------

heading("What this configuration can reach");

console.log(`  ${usable.size} of ${titles.length} titles usable right now.\n`);

const notReady = client.diagnostics().filter((row) => !row.ready);
if (notReady.length === 0) {
  console.log("  Every provider has a credential. Nothing to do.");
} else {
  console.log("  Missing credentials, most valuable first:\n");
  // Ranked by how many titles the key would *newly* unlock, not by how many it
  // touches - a key for titles already covered elsewhere is not the one to go
  // and get first. Sorting by one number while printing another would put a key
  // that unlocks nothing above one that unlocks three, which is what this used
  // to do.
  const ranked = notReady
    .map((row) => ({ row, blocked: row.titles.filter((id) => !usable.has(id)) }))
    .sort((left, right) => right.blocked.length - left.blocked.length);
  for (const { row, blocked } of ranked.slice(0, 12)) {
    if (blocked.length === 0) continue;
    console.log(
      `  ${`apiKeys.${row.missingKey ?? "?"}`.padEnd(28)} unlocks ${String(blocked.length).padStart(2)} more titles` +
        `  ${row.docsUrl}`,
    );
  }
}

// ---------------------------------------------------------------------------

heading("Titles with no player API");

const esportsOnly = titles.filter((title) => !title.capabilities.includes("resolvePlayer"));
console.log(
  `  ${esportsOnly.length} titles. Their publishers offer nothing; what exists is\n` +
    `  the professional circuit, and that is what this package serves for them.\n`,
);
for (const title of esportsOnly.slice(0, 12)) {
  console.log(`  ${title.name.padEnd(36)} ${title.providers.join(", ")}`);
}
if (esportsOnly.length > 12) console.log(`  ... and ${esportsOnly.length - 12} more`);

// ---------------------------------------------------------------------------

heading("Providers by who runs them");

for (const kind of ["first-party", "community", "esports-data", "tournament-platform"] as const) {
  const group = client.providers().filter((provider) => provider.kind === kind);
  console.log(`\n  ${kind} (${group.length})`);
  for (const provider of group) {
    const keyless = provider.auth === "none" || provider.optionalAuth === true;
    console.log(
      `    ${provider.label.padEnd(32)} ${keyless ? "no key needed" : `apiKeys.${provider.keyName}`}`,
    );
  }
}

// ---------------------------------------------------------------------------

heading("Rate limits worth knowing about");

// Two of these are conditions of use rather than tuning, and exceeding them is
// a breach of the provider's stated terms.
for (const provider of [...client.providers()].sort((a, b) => a.rps - b.rps).slice(0, 6)) {
  const note = provider.notes ? `  - ${provider.notes}` : "";
  console.log(`  ${provider.label.padEnd(32)} ${String(provider.rps).padStart(5)} req/s${note}`);
}

await client.destroy();

// ---------------------------------------------------------------------------

function heading(text: string): void {
  console.log(`\n${text}\n${"-".repeat(text.length)}\n`);
}

/**
 * A bar, purely as a second encoding of a number already printed beside it.
 *
 * Never the only place a value appears. Somebody reading this through a screen
 * reader, or piping it into a file, or looking at it in a terminal that has
 * eaten the alignment, still has the count.
 */
function bar(value: number, total: number, width = 24): string {
  const filled = total === 0 ? 0 : Math.round((value / total) * width);
  return `${"#".repeat(filled)}${".".repeat(Math.max(0, width - filled))}`;
}
