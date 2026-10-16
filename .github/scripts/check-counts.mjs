#!/usr/bin/env node
/**
 * Every number the documentation advertises is the number the registry holds.
 *
 * A coverage table is the first thing anybody reads and the last thing anybody
 * updates. Before this check existed the README said "27 full / 21 player / 35
 * esports only" while the registry held 27 / 22 / 34 — one title had gained a
 * ladder and the table had not noticed. Nothing failed, because nothing was
 * looking.
 *
 * So the numbers are derived here from `shared/registry/` and compared with
 * every place the docs state one. A title added without touching the README is
 * now a red build rather than a paragraph that is quietly wrong.
 *
 * The patterns are written out one by one on purpose. A regex loose enough to
 * find "any number near the word titles" would also match the release year of
 * Old School RuneScape.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const read = (file) => readFileSync(join(root, file), "utf8");
const registry = (name) => JSON.parse(read(join("shared", "registry", `${name}.json`)));

const titles = registry("titles").titles;
const providers = registry("providers").providers;

const has = (title, capability) => title.capabilities.includes(capability);

/** The facts. Everything below is checked against these. */
const FACTS = {
  titles: titles.length,
  providers: providers.length,
  full: titles.filter((title) => has(title, "getMatchHistory")).length,
  player: titles.filter(
    (title) => has(title, "resolvePlayer") && !has(title, "getMatchHistory"),
  ).length,
  esportsOnly: titles.filter((title) => !has(title, "resolvePlayer")).length,
  withPlayerApi: titles.filter((title) => has(title, "resolvePlayer")).length,
  withTournaments: titles.filter((title) => has(title, "getEsportsTournaments")).length,
  withEarnings: titles.filter((title) => has(title, "getEarnings")).length,
};

/**
 * [file, description, regular expression with one capturing group, expected].
 *
 * Every entry must match exactly once. A pattern that stops matching is as much
 * a failure as one that matches the wrong number: it means the sentence was
 * reworded and nobody re-checked the figure inside it.
 */
const CLAIMS = [
  ["README.md", "the summary title count", /normalised across\n> \*\*(\d+) titles\*\*/, FACTS.titles],
  ["README.md", "the summary provider count", /\*\*(\d+) real APIs\*\*/, FACTS.providers],
  ["README.md", "the titles badge", /badge\/titles-(\d+)-blue/, FACTS.titles],
  ["README.md", "the providers badge", /badge\/providers-(\d+)-blue/, FACTS.providers],
  ["README.md", "the coverage table lead-in", /^(\d+) titles, in three tiers\./m, FACTS.titles],
  ["README.md", "the full tier", /\| \*\*Full\*\* \| (\d+) \|/, FACTS.full],
  ["README.md", "the player tier", /\| \*\*Player\*\* \| (\d+) \|/, FACTS.player],
  ["README.md", "the esports-only tier", /\| \*\*Esports only\*\* \| (\d+) \|/, FACTS.esportsOnly],
  ["README.md", "titles with a circuit", /^(\d+) of \d+ titles support `getEsportsTournaments`/m, FACTS.withTournaments],
  ["README.md", "the total beside it", /^\d+ of (\d+) titles support `getEsportsTournaments`/m, FACTS.titles],
  ["README.md", "titles with earnings", /and (\d+) support `getEarnings`/, FACTS.withEarnings],
  ["README.md", "titles with a player API", /^(\d+) have a player API at all\./m, FACTS.withPlayerApi],
  ["README.md", "the registry title count", /does not re-declare (\d+) titles/, FACTS.titles],
  ["README.md", "the registry provider count", /re-declare \d+ titles and (\d+) providers/, FACTS.providers],
  ["README.md", "the combined record count", /Re-declaring (\d+) records/, FACTS.titles + FACTS.providers],

  ["python/README.md", "the summary title count", /normalised across \*\*(\d+) titles\*\*/, FACTS.titles],
  ["python/README.md", "the summary provider count", /\*\*(\d+) real APIs\*\*/, FACTS.providers],
  ["python/README.md", "the titles badge", /badge\/titles-(\d+)-blue/, FACTS.titles],
  ["python/README.md", "the providers badge", /badge\/providers-(\d+)-blue/, FACTS.providers],
  ["python/README.md", "the coverage table lead-in", /^(\d+) titles, in three tiers\./m, FACTS.titles],
  ["python/README.md", "the full tier", /\| \*\*Full\*\* \| (\d+) \|/, FACTS.full],
  ["python/README.md", "the player tier", /\| \*\*Player\*\* \| (\d+) \|/, FACTS.player],
  ["python/README.md", "the esports-only tier", /\| \*\*Esports only\*\* \| (\d+) \|/, FACTS.esportsOnly],
  ["python/README.md", "the list_titles example", /len\(list_titles\(\)\)\s+# (\d+)/, FACTS.titles],
  ["python/README.md", "the registry title count", /does not re-declare (\d+) titles/, FACTS.titles],
  ["python/README.md", "the title lookup row", /any of the (\d+), by id or alias/, FACTS.titles],

  ["typescript/README.md", "the summary counts", /(\d+) titles, \d+ real APIs/, FACTS.titles],
  ["typescript/README.md", "the summary provider count", /\d+ titles, (\d+) real APIs/, FACTS.providers],
  ["typescript/README.md", "the lookup rationale", /because there are (\d+) and because/, FACTS.titles],

  ["python/pyproject.toml", "the package description title count", /normalised across (\d+) titles and \d+ real/, FACTS.titles],
  ["python/pyproject.toml", "the package description provider count", /normalised across \d+ titles and (\d+) real/, FACTS.providers],
  ["typescript/package.json", "the package description title count", /normalised across (\d+) titles and \d+ real/, FACTS.titles],
  ["typescript/package.json", "the package description provider count", /normalised across \d+ titles and (\d+) real/, FACTS.providers],

  ["CONTRIBUTING.md", "the contract suite size", /walks the same (\d+) titles/, FACTS.titles],
];

let failed = false;

for (const [file, description, pattern, expected] of CLAIMS) {
  const text = read(file);
  const match = text.match(pattern);
  if (!match) {
    console.error(
      `::error file=${file}::${description}: nothing matched ${pattern}. The ` +
        `sentence was reworded - re-check the figure and update this pattern.`,
    );
    failed = true;
    continue;
  }
  const stated = Number(match[1]);
  if (stated !== expected) {
    console.error(
      `::error file=${file}::${description} says ${stated}, the registry says ${expected}`,
    );
    failed = true;
  }
}

if (failed) {
  console.error("");
  console.error("The registry is the source of truth. Fix the prose, not the registry.");
  process.exit(1);
}

console.log(
  `ok - ${CLAIMS.length} advertised numbers match the registry ` +
    `(${FACTS.titles} titles, ${FACTS.providers} providers, ` +
    `${FACTS.full}/${FACTS.player}/${FACTS.esportsOnly} tiers)`,
);
