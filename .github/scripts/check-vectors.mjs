#!/usr/bin/env node
/**
 * The shared vectors are readable and complete.
 *
 * A vector file with a syntax error fails in both suites at once, in a dozen
 * places and clearly in none of them. One parse here names the file and the
 * reason.
 *
 * The list is written out rather than discovered: a vector file that quietly
 * disappears is exactly the kind of drift these files exist to prevent.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = join(root, "shared");

/** What both suites read. */
const REQUIRED = [
  "vectors/constants.json",
  "vectors/esports.json",
  "vectors/identity.json",
  "vectors/normalize.json",
  "registry/providers.json",
  "registry/titles.json",
  "registry/coverage.json"
];

function walk(base, prefix = "") {
  const out = [];
  for (const entry of readdirSync(base)) {
    const full = join(base, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, prefix ? `${prefix}/${entry}` : entry));
    } else if (entry.endsWith(".json")) {
      out.push(prefix ? `${prefix}/${entry}` : entry);
    }
  }
  return out;
}

const present = walk(dir);
let failed = false;

for (const name of REQUIRED) {
  if (!present.includes(name)) {
    console.error(`::error::shared/${name} is missing`);
    failed = true;
  }
}

for (const name of present) {
  if (!REQUIRED.includes(name)) {
    console.error(
      `::error::shared/${name} is on no list. Add it to ` +
        `.github/scripts/check-vectors.mjs, or both suites will ignore it in silence.`,
    );
    failed = true;
    continue;
  }

  let data;
  try {
    data = JSON.parse(readFileSync(join(dir, name), "utf8"));
  } catch (error) {
    console.error(`::error file=shared/${name}::not valid JSON: ${error.message}`);
    failed = true;
    continue;
  }

  if (typeof data !== "object" || data === null) {
    console.error(`::error file=shared/${name}::expected an object or an array`);
    failed = true;
    continue;
  }

  console.log(`ok - ${name}`);
}

if (REQUIRED.length === 0) {
  console.error("::error::The list is empty - this check then checks nothing.");
  process.exit(1);
}

process.exit(failed ? 1 : 0);
