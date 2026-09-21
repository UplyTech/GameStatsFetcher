/**
 * The five things you will actually do with this package.
 *
 * Run it with a key or two set; every block skips itself when its credential is
 * missing, so it is useful even with none:
 *
 *   STEAM_API_KEY=... RIOT_API_KEY=... npx vite-node examples/basic.ts
 */

import {
  GameStatsClient,
  MissingCredentialError,
  NotFoundError,
  PrivateProfileError,
  UnsupportedCapabilityError,
} from "../src/index.js";

const client = new GameStatsClient({
  apiKeys: {
    steam: process.env.STEAM_API_KEY,
    riot: process.env.RIOT_API_KEY,
    pandascore: process.env.PANDASCORE_TOKEN,
    esportsEarnings: process.env.ESPORTS_EARNINGS_KEY,
  },
  cache: { driver: "memory" },
  // Name yourself: two providers require it, and the rest appreciate it.
  userAgent: "GameStatsFetcher-example/1.0 (dev@example.com)",
});

// ---------------------------------------------------------------------------
// 1. What can this deployment actually do?
// ---------------------------------------------------------------------------

console.log(`\n${client.titleCount()} titles registered.`);

const missing = client.diagnostics().filter((row) => !row.ready);
if (missing.length > 0) {
  console.log(`\n${missing.length} providers have no credential configured:`);
  for (const row of missing.slice(0, 5)) {
    console.log(`  ${row.label.padEnd(28)} apiKeys.${row.missingKey}  ${row.docsUrl}`);
  }
  console.log("  ...");
}
console.log(`\n${client.usableTitles().length} titles are usable with what is configured.`);

// ---------------------------------------------------------------------------
// 2. A player, end to end
// ---------------------------------------------------------------------------

if (process.env.RIOT_API_KEY) {
  console.log("\n--- League of Legends ---");
  try {
    // Resolve once, re-use the ref: it saves the lookup call on every method
    // after this one, and it survives the player renaming themselves.
    const ref = await client.lol.resolvePlayer({ name: "Hide on bush#KR1", region: "kr" });
    console.log(`resolved ${ref.displayName} -> ${ref.id}`);

    const profile = await client.lol.getPlayer(ref);
    console.log(`level ${profile.level}`);

    for (const rank of await client.lol.getRank(ref)) {
      const record = `${rank.wins}W ${rank.losses}L`;
      console.log(`${rank.queue}: ${rank.tier} ${rank.division} (${rank.tierPoints} LP, ${record})`);
    }

    const history = await client.lol.getMatchHistory(ref, { limit: 3 });
    for (const match of history) {
      const stats = match.playerStats;
      console.log(
        `${match.result.padEnd(5)} ${stats?.extra.champion ?? "?"} ` +
          `${stats?.kills}/${stats?.deaths}/${stats?.assists}`,
      );
    }
  } catch (error) {
    report(error);
  }
}

// ---------------------------------------------------------------------------
// 3. The same shape, a different title
// ---------------------------------------------------------------------------

if (process.env.STEAM_API_KEY) {
  console.log("\n--- Counter-Strike 2 ---");
  try {
    // Valve publishes no matchmaking rank, so `getRank` reports FACEIT level -
    // and returns an empty list for a player with no FACEIT account.
    const stats = await client.cs2.getPlayerStats({ steamId: "76561197960287930" });
    console.log(
      `${stats.matchesPlayed} matches, ${permille(stats.winRatePermille)} win rate, ` +
        `${permille(stats.kdPermille)} K/D`,
    );
  } catch (error) {
    report(error);
  }
}

// ---------------------------------------------------------------------------
// 4. Dota 2 needs no key at all
// ---------------------------------------------------------------------------

console.log("\n--- Dota 2 (OpenDota, no key required) ---");
try {
  const [rank] = await client.dota2.getRank({ steamId: "76561198054320440" });
  console.log(`${rank?.tier ?? "unranked"} - MMR estimate ${rank?.rating ?? "unknown"}`);
} catch (error) {
  report(error);
}

// ---------------------------------------------------------------------------
// 5. A title with no player API at all
// ---------------------------------------------------------------------------

console.log("\n--- Tekken 8 ---");
const tekken = client.title("tekken-8");
console.log(`supports getRank: ${tekken.supports("getRank")}`);
console.log(`supports getEsportsTournaments: ${tekken.supports("getEsportsTournaments")}`);

try {
  // Bandai Namco publishes no player API, so this throws rather than returning
  // an empty array that would look like a quiet week.
  await tekken.getRank({ name: "Arslan Ash" });
} catch (error) {
  if (error instanceof UnsupportedCapabilityError) {
    console.log(`as expected: ${error.message}`);
  }
}

try {
  const events = await tekken.getEsportsTournaments({ limit: 3 });
  for (const event of events) console.log(`  ${event.name}`);
} catch (error) {
  report(error);
}

await client.destroy();

// ---------------------------------------------------------------------------

/** Permille to a readable percentage. The model stores integers on purpose. */
function permille(value: number | null): string {
  return value === null ? "unknown" : `${(value / 10).toFixed(1)} %`;
}

/** Say what went wrong in the terms the caller can act on. */
function report(error: unknown): void {
  if (error instanceof MissingCredentialError) {
    console.log(`skipped: ${error.message}`);
  } else if (error instanceof PrivateProfileError) {
    console.log("skipped: that profile is private");
  } else if (error instanceof NotFoundError) {
    console.log("skipped: no such player");
  } else {
    console.log(`failed: ${(error as Error).message}`);
  }
}
