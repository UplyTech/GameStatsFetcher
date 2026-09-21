# Shared test vectors

**Generated. Never edited by hand.**

These four files are the contract between the TypeScript and the Python edition.
[`shared/registry/`](../registry/) already guarantees the two agree about
*coverage* — which titles exist and what each can answer. These guarantee they
agree about *behaviour*.

| File | What it pins |
|---|---|
| `normalize.json` | Every pure normalisation function: `num`, `int`, `str`, `bool`, `ts`, `permille`, `winRate`, `kd`, `clamp`, `toMinorUnits`, `sum`, `matchResult` |
| `identity.json` | Every identifier conversion: Steam id forms, Riot IDs, BattleTags, Supercell tags, Minecraft UUIDs |
| `esports.json` | The provider-capability table, and `esportsProvidersFor` over it |
| `constants.json` | The TTL table, Steam app ids, permille scale, page and timeout limits, rate-limit defaults, User-Agent |

## Why they exist

Two editions that quietly compute different win rates are worse than two
separate libraries, because nobody expects the difference. A team running the
Node service and the Python bot side by side would see the same player's rate
differ in the third decimal and have no reason to suspect the library.

The case that made this concrete: **JavaScript's `Math.round` rounds halves away
from zero, and Python's `round` is banker's rounding.** `Math.round(62.5)` is 63
and `round(62.5)` is 62. A direct port would have disagreed on every ratio that
lands exactly on a half — silently, in production, forever. The Python edition
uses the JavaScript rule, and `normalize.json` is what keeps it that way.

## How they work

Each file holds cases of the shape:

```json
{ "args": [1, 16], "value": 63 }
{ "args": ["gaben"], "error": "ValidationError" }
```

A case carries either a `value` the function must return, or an `error`, which
means the TypeScript edition threw and the Python one must too. **Rejection is
part of the contract**: `toSteamId64("gaben")` must fail in both editions, and
fail as validation rather than as a crash.

Both suites replay every case:

- [`typescript/tests/shared-vectors.test.ts`](../../typescript/tests/shared-vectors.test.ts)
- [`python/tests/test_shared_vectors.py`](../../python/tests/test_shared_vectors.py)

The TypeScript suite looks circular — the vectors are generated from that
edition, so of course they match. They are not, because of *when* it runs: the
vectors are committed, and the suite replays them against the **current**
source. It catches the case that actually matters, which is a change to a pure
function landing without the vectors being regenerated — at which point the
Python edition is still asserting the old behaviour and the two have diverged.

## Regenerating

```bash
cd typescript
npm run build
npm run vectors            # rewrite the four files
npm run vectors:check      # fail if out of date (CI)
```

A failure in either suite means one of two things:

1. **The change was intentional.** Regenerate, commit the new vectors, and the
   Python suite picks up the new expectation on its next run.
2. **The change was not intentional**, and this is the bug report.

Either way the answer is never to edit these files by hand.

## Format version

Every file carries `formatVersion`, and both suites assert it. A file written by
a future generator fails loudly instead of being half-read.

Current version: **1**.
