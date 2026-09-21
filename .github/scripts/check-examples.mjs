#!/usr/bin/env node
/**
 * Run both editions' examples, and prove the two coverage reports agree.
 *
 * An example that nobody runs is documentation that lies, and two examples that
 * are meant to be the same program in two languages drift the moment nobody
 * compares them. Both of those had already happened here: the TypeScript
 * coverage report was missing the rate-limits section entirely, ranked its
 * "most valuable missing credential" list by one number while printing another,
 * and drew its bars four characters narrower than the Python one. Every one of
 * those is invisible until you put the two outputs side by side.
 *
 * So this does. It runs all six examples, and then diffs the two coverage
 * reports line by line after normalising exactly two things, both of which are
 * genuine differences between the languages rather than between the editions:
 *
 * - **How a key is named.** Python writes `api_keys['steam']`, TypeScript
 *   writes `apiKeys.steam`. Each is the spelling a reader of that edition needs
 *   to type, so neither should be changed to match the other.
 * - **Column padding.** The two spellings are different lengths, so the column
 *   each is padded into is a different number of characters even though the
 *   rendered table lines up in both.
 *
 * Nothing else is normalised. A count, a name, an ordering, a bar, a heading, a
 * blank line - any of those differing is a finding, because it means the two
 * editions disagree about the registry they both ship.
 *
 *     node .github/scripts/check-examples.mjs
 *
 * Exits non-zero on the first example that fails to run, or on any difference.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PYTHON = join(ROOT, "python");
const TYPESCRIPT = join(ROOT, "typescript");

/** Run one command and return its stdout, or exit reporting what broke. */
function run(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    console.error(`FAIL - ${command} ${args.join(" ")} exited ${result.status}`);
    if (result.stderr) console.error(result.stderr.trimEnd());
    process.exit(1);
  }
  return result.stdout;
}

/**
 * The two normalisations, and nothing else. See the file header for why each
 * one is a difference between the languages rather than between the editions.
 */
function normalise(text) {
  return text
    .replace(/api_keys\['([A-Za-z0-9]+)'\]/g, "apiKeys.$1")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .trimEnd();
}

let failures = 0;

// ---------------------------------------------------------------------------
// Every example runs.
// ---------------------------------------------------------------------------

const pythonExamples = readdirSync(join(PYTHON, "examples"))
  .filter((name) => name.endsWith(".py"))
  .sort();
const typescriptExamples = readdirSync(join(TYPESCRIPT, "examples"))
  .filter((name) => name.endsWith(".ts"))
  .sort();

if (pythonExamples.length !== typescriptExamples.length) {
  console.error(
    `FAIL - ${pythonExamples.length} Python examples but ` +
      `${typescriptExamples.length} TypeScript ones; each edition should carry the same set`,
  );
  failures += 1;
}

const pythonOutput = new Map();
for (const name of pythonExamples) {
  pythonOutput.set(
    name,
    run("python", [join("examples", name)], {
      cwd: PYTHON,
      env: { ...process.env, PYTHONPATH: "src", PYTHONIOENCODING: "utf-8" },
    }),
  );
}
console.log(`ok - ${pythonExamples.length} Python examples ran`);

const typescriptOutput = new Map();
for (const name of typescriptExamples) {
  typescriptOutput.set(
    name,
    run("npx", ["vite-node", join("examples", name)], { cwd: TYPESCRIPT }),
  );
}
console.log(`ok - ${typescriptExamples.length} TypeScript examples ran`);

// ---------------------------------------------------------------------------
// The coverage report is the same program twice, so it prints the same thing.
// ---------------------------------------------------------------------------

const left = normalise(pythonOutput.get("coverage_report.py") ?? "");
const right = normalise(typescriptOutput.get("coverage-report.ts") ?? "");

if (!left || !right) {
  console.error("FAIL - one of the coverage report examples produced no output");
  failures += 1;
} else if (left !== right) {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const differences = [];
  for (let index = 0; index < Math.max(leftLines.length, rightLines.length); index += 1) {
    if (leftLines[index] !== rightLines[index]) {
      differences.push(
        `  line ${index + 1}\n` +
          `    python:     ${leftLines[index] ?? "(no line)"}\n` +
          `    typescript: ${rightLines[index] ?? "(no line)"}`,
      );
    }
  }
  console.error(
    `FAIL - the two coverage reports differ on ${differences.length} of ` +
      `${Math.max(leftLines.length, rightLines.length)} lines:\n` +
      differences.slice(0, 12).join("\n"),
  );
  failures += 1;
} else {
  console.log(
    `ok - both coverage reports print the same ${left.split("\n").length} lines`,
  );
}

process.exit(failures === 0 ? 0 : 1);
