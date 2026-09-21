# Contributing to GameStatsFetcher

Thank you for looking. Most of the rules below exist to protect one property:
**everything in the registry is real and reachable.** That is the only reason
the coverage table is worth reading.

## Two editions: what changes where

The package ships a TypeScript and a Python edition, and there is a fixed order
to touching them.

| You are changing | Start in | Then |
|---|---|---|
| A title or a provider | `typescript/src/titles.ts` / `providers.ts` | `npm run registry` → `python scripts/sync_registry.py` |
| A pure function (normalisation, identity) | either — implement in **both** | `npm run build && npm run vectors`, then run both suites |
| A provider or title client | either — port to the other | run both suites |
| A constant (TTL, app id, limit) | `typescript/src/constants.ts` and `python/.../constants.py` | `npm run vectors` |

**The registry has one source.** `typescript/src/titles.ts` is where titles are
declared; everything else is generated from it. The Python edition reads the
generated JSON and never re-declares a title — a registry is data, and
re-declaring 134 records in a second language would create exactly one thing:
the opportunity for them to disagree.

**Pure functions have two implementations and one set of expectations.**
`shared/vectors/` is generated from the TypeScript edition and replayed by both
suites, so a behaviour change that lands in one and not the other fails the
build. If you change a normaliser, regenerate the vectors and make the Python
suite pass before opening the pull request — not after.

One trap worth stating, because it has already been paid for: **JavaScript's
`Math.round` rounds halves away from zero and Python's `round` is banker's
rounding.** `python/.../normalize.py` has `_round_half_up` for exactly this. Any
new rounding in the Python edition must use it.

A change that only lands in one edition is not finished. If you cannot port it,
say so in the pull request and open an issue for the other half — that is a
worse outcome than a delay, but a far better one than silent drift.

## The rule that matters most

> **A title goes in only if a real, currently reachable API serves it.**

Not a scraper. Not a placeholder waiting for an API that has been "coming
soon" for two years. Not an endpoint you found in a browser's network tab that
needs a session cookie.

If somebody publishes an API — the game's publisher, a credible community
project, an esports data company, a bracket platform — the title belongs here.
If nobody does, it does not, however large its scene. A registry that lists a
title it cannot serve is worse than one that omits it, because a caller has no
way to tell which entries are true.

The same rule applies to a *capability*. Adding `getRank` to a title whose API
has no rank makes every caller's rank display silently empty.

**A professional circuit is not a requirement.** Four titles here have a real
player API and no circuit at all — Diablo III, EVE Online and the two
RuneScapes. They answer every player question and refuse every esports one with
`UnsupportedCapabilityError`, which is the honest answer: an empty tournament
list would read like a quiet week. Those four are written out by name in both
registry suites rather than computed, so a fifth cannot join them without
somebody deciding it should.

## Adding a title

1. **Find the API and read its terms.** Write the rate limit down; you will
   need it in step 2. If it requires a descriptive User-Agent or asks for
   caching, note that too.
2. **Add the provider** to `typescript/src/providers.ts` if it is not there.
   `rps` and `burst` come from the published quota, **rounded down**. Getting
   this wrong gets somebody's key revoked, not merely throttled.
3. **Add the title** to `typescript/src/titles.ts`. Declare the capabilities
   you believe it has.
4. **Write the client** in `typescript/src/games/`, or skip it — a title with
   no player API needs no client at all, and gets the full esports surface from
   the generic one.
5. **Wire it up** in `typescript/src/games/index.ts` if you wrote a client.
6. **Run the tests.** The contract suite walks every title and every method:

   ```bash
   cd typescript && npm test
   ```

   It will tell you if you claimed a capability you did not implement, or
   implemented one you did not claim.

7. **Regenerate the registry** and commit it:

   ```bash
   npm run build && npm run registry
   ```

8. **Port it to Python and sync the registry:**

   ```bash
   cd ../python
   python scripts/sync_registry.py     # picks up the new title
   # port the provider to src/gamestatsfetcher/providers/
   # port the client   to src/gamestatsfetcher/games/ and register it in games/__init__.py
   pytest
   ```

   The Python contract suite walks the same 87 titles, so it will fail on the
   new one until the client exists — which is the reminder, not a nuisance. A
   title with no player API needs no client in either edition; the generic one
   gives it the full esports surface.

### The capability you do not have to declare

Esports capabilities are **computed**. The registry intersects what a title
declares with `ESPORTS_CAPABILITY_PROVIDERS` — the table of which provider
answers which question — and drops the rest at load.

So declare `ESPORTS_CAPS` generously and let the reconciliation narrow it. What
you must not do is add a provider to that table without implementing the
corresponding branch in `typescript/src/esports.ts`; the table is a promise the
layer has to keep.

## Adding a provider

The descriptor is not documentation, it is what the runtime uses:

| Field | Consequence of getting it wrong |
|---|---|
| `rps` / `burst` | too high and applications get banned; too low and the package is slow for no reason |
| `keyName` | the `MissingCredentialError` names the wrong option, and somebody debugs for an hour |
| `docsUrl` | the same, minus the hour |
| `auth` | the credential is attached in a way the provider rejects |
| `optionalAuth` | a provider that works without a key gets reported as broken in every diagnostics run |
| `requiresUserAgent` | requests are refused with no useful message |

Providers whose auth is a session or an OAuth exchange override `authorize()`.
See `BlizzardProvider` (client credentials), `HiRezProvider` (MD5-signed
sessions) and `IRacingProvider` (hashed password, cookie) for the three shapes
that already exist.

## What belongs in this package

- **No storage.** The cache is a cache: everything in it is disposable and has
  a TTL. Persistence is the caller's.
- **No display.** No embeds, no images, no formatted strings. Numbers out.
- **No invented data.** A field the upstream does not provide is `null`. If you
  find yourself writing `?? 0`, stop and ask whether zero is a fact.
- **No scraping.** If it needs a browser, a session cookie or a parsed HTML
  page, it does not go in. OverFast is in the registry because *OverFast*
  publishes an API; this package does not read Blizzard's pages itself.
- **No silent provider switching.** `fallback` is off by default because
  changing source changes whose terms of service apply. That must be a caller's
  decision.
- **No ambient configuration.** Nothing is read from `process.env` inside the
  package. Credentials arrive as options.

## Code style

- **Integers for anything that will be compared or stored.** Ratios are
  permille, money is minor units. Floating point in a win rate produces two
  dashboards that disagree in the third decimal and nobody knows which is right.
- **Every normalised object keeps `raw`.** Normalisation loses detail, so the
  detail survives.
- **Comments explain decisions, not mechanics.** `// convert to seconds` is
  noise; `// Riot wants seconds here while every other timestamp it returns is
  in milliseconds` is the sentence somebody needs in two years.
- **Name the provider quirk where it lives.** Supercell's IP-bound tokens,
  Wargaming's 200-with-an-error, Bungie's wrapped envelope, PUBG's 14-day match
  expiry: each of those is documented in the module that has to cope with it.
- `eslint` and `tsc --noEmit` must be clean. `no-explicit-any` is an error, on
  purpose: the whole point of this package is that the payloads are typed.
- `mypy --strict` and `ruff` must be clean. `Any` appears in the Python edition
  in exactly one place on purpose: the `raw` field, which holds whatever the
  upstream sent.
- **Python field names are `snake_case`; registry keys are not.** Capability
  names (`"getRank"`) come from a JSON file both editions read, so they keep
  their wire spelling in both. `PlayerQuery.get` translates between the two, and
  that is the only place that should need to.

## Tests

```bash
cd typescript
npm install
npm test && npm run typecheck && npm run lint
npm run registry:check && npm run vectors:check
```

```bash
cd python
pip install -e ".[dev]"
pytest && mypy && ruff check . && ruff format --check .
python scripts/sync_registry.py --check
python scripts/coverage_gate.py
```

```bash
# Both editions at once. The last one needs python and npx on PATH.
node .github/scripts/check-versions.mjs
node .github/scripts/check-counts.mjs
node .github/scripts/check-vectors.mjs
node .github/scripts/check-docs.mjs
node .github/scripts/check-examples.mjs
node .github/scripts/generate-cspell-registry.mjs --check
```

Both, before opening a pull request. A change that passes one suite and breaks
the other is the failure mode the shared files exist to catch.

### Coverage

Both editions gate coverage in **two tiers**, because one number over the whole
package averages together two very different kinds of code.

The core — caching, rate limiting, transport, normalisation, identity, the
registries, the client — is held to **90 % statements**. Every line is reachable
from a test with no network, and a bug there is a bug in every title at once.

The provider and title modules are mapping code: fifty-odd near-identical
translations from one JSON shape to another. They are held to a lower floor
(65 % in Python) and covered by a representative test per provider family plus
two sweeps over the whole catalogue. Driving them to 90 % would mean fifty more
fixtures whose only real assertion is that the fixture was typed correctly —
test volume, not test value.

The floor is 65 rather than 40 because the sweeps reach roughly that much on
their own. It exists to catch a module that has fallen out of *both* of them,
which is a real gap; it is not a target to write fixtures against.

The gates live in `typescript/vitest.config.ts` and
`python/scripts/coverage_gate.py`, each with that reasoning written down.

### The contract suite

`typescript/tests/contract.test.ts` and `python/tests/test_contract.py` are the
ones to understand before changing a registry entry. They are the same suite,
ported case for case. For every title they assert:

- every capability the registry declares is reachable, and
- every capability it does not declare raises `UnsupportedCapabilityError`.

A failure there means the registry and the code disagree — and the registry is
what callers read, so one of them is lying.

The Python suite adds one check the TypeScript one does not yet have: that an
unconfigured deployment only ever reaches providers that need no credential. A
request sent with no key spends a round trip to learn what the registry already
knows, and on several providers it still counts against an anonymous quota.

### The hostile-payload sweep

`typescript/tests/hostile-payloads.test.ts` and
`python/tests/test_hostile_payloads.py` are the contract suite's other half.
Where that one answers 503 and asks *which error class*, this one answers **200
with a body no mapper was written for** and asks whether anything escapes that a
caller cannot catch.

Ten payload shapes, each chosen because a real API answers with it under some
failure: an empty object, an empty array, a literal `null`, an envelope with the
wrong middle, a list of ids where objects were documented, a bare number, a bare
string. 87 titles × 14 methods × 10 shapes is 5,500 calls per edition.

Two things make it worth having rather than merely large:

- **The boundary is enforced in one place.** `title_client.py` wraps every
  canonical method through `__init_subclass__`; `title-client.ts` wraps the
  prototype chain from `createTitleClient`. A title client added next year is
  covered by having been written, not by somebody remembering.
- **The sweep proves it reached the mappers.** It asserts a request count as
  well as an error class, because a rate limiter that refused every call would
  raise a `GameStatsError` too — and a sweep that passed that way would be
  asserting nothing. Both sweeps call `unthrottled()` first for the same reason.

If you add a mapper, you do not have to add anything here. If you add a *payload
shape a real provider sends*, add it to `HOSTILE_BODIES` in both editions.

### The examples

`.github/scripts/check-examples.mjs` runs all six examples and diffs the two
coverage reports line by line. An example nobody runs is documentation that
lies, and two examples meant to be the same program in two languages drift the
moment nobody compares them.

Exactly two differences are normalised, both genuine differences between the
languages rather than between the editions: how a key is named
(`api_keys['steam']` versus `apiKeys.steam`), and the column width that follows
from it. Anything else — a count, a name, an ordering, a bar, a blank line — is
a finding.

### The shared vectors

`shared/vectors/` is generated, never edited. Both suites replay every case; see
[`shared/vectors/README.md`](./shared/vectors/README.md) for what to do when one
of them fails.

## Changing an existing title

| Change | Version bump |
|---|---|
| Fixing a mapping that read the wrong field | patch |
| Adding a title, a provider or a capability | minor |
| Adding a provider to an existing title | minor |
| **Removing a capability** | **major** — somebody is calling it |
| Removing a title | major |
| Changing what a normalised field means | major |
| A provider's rate limit being lowered | patch, and ship it quickly |

A removed capability is a breaking change even when the upstream is what
removed it. Announce it; do not let a caller discover it from an exception.

## Reporting a bug

The useful report contains:

- the title id and the method,
- the query you passed (with identifiers redacted if you like),
- the provider that answered — it is on `PlayerRef.providerId` and every
  esports object,
- what you expected and what you got,
- and, if you have it, the `raw` field. It is on every normalised object, and it
  is usually the whole answer.

A mapping bug becomes a fixture in `tests/games.test.ts`, which is where fixed
bugs in this package end up.

## Security

Please do not open a public issue for a security problem. See
[SECURITY.md](./SECURITY.md).
