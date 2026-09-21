# The shared registry

Three generated JSON files describing what this package covers. They are the
machine-readable form of the two registries in `typescript/src/` — every title,
every provider, and what each one can actually do.

**They are also the single source both editions read.** The TypeScript edition
generates them; the Python edition ships `titles.json` and `providers.json` as
package data and reads them at import. Nothing is declared twice.

They exist so that things which are **not** this package can read the coverage:
a documentation site, a status dashboard, a bot's slash-command choices, a
deployment check that lists the API keys a environment is missing.

## The files

| File | Holds |
|---|---|
| `titles.json` | Every title: id, aliases, genre, publisher, the providers that serve it, the capabilities it actually has, the identifiers it accepts, its regions and platforms. |
| `providers.json` | Every upstream API: who runs it, how it authenticates, which option holds its key, where to get one, the rate limits this package applies, and which titles depend on it. |
| `coverage.json` | The flat matrix — one row per title, one column per capability — for rendering a table without walking the other two. |

## They are generated, never edited

```bash
cd typescript
npm run build
npm run registry           # rewrite the three files
npm run registry:check     # fail if they are out of date (what CI runs)

cd ../python
python scripts/sync_registry.py          # copy into the package
python scripts/sync_registry.py --check  # fail if the copy is stale
```

The Python check also runs inside its test suite, so a stale copy fails the
suite rather than shipping two editions that disagree about their own coverage.

**A diff here is a change in coverage, not a formatting change.** A new title,
a provider that gained or lost a capability, a rate limit that was tightened —
all of them show up as a diff in these files, and all of them belong in
`CHANGELOG.md`.

Review the diff as carefully as you review code. A removed capability is a
breaking change for anyone who was calling it.

## Why capabilities are computed rather than declared

`titles.json` reports the capabilities a title *actually has*, which is not
always what its entry in `titles.ts` writes down.

The source declares the esports surface generously, because "this is an esports
title" is the interesting fact about it. The registry then intersects that with
`ESPORTS_CAPABILITY_PROVIDERS` — the table of which provider can answer which
question — and drops what nothing can serve. Tekken 8 is covered by start.gg,
which has brackets and placements but no notion of a roster for a 1v1 game, so
`getEsportsTeams` is absent from its row here.

The consequence worth knowing: **adding a provider to a title widens its
capabilities automatically.** Nobody has to remember to widen them separately,
and the two can therefore never disagree.

## Format version

Each file carries a `formatVersion`. Assert it before reading: a file written
by a future layout then fails loudly instead of being half-parsed.

```js
const registry = JSON.parse(await readFile("titles.json", "utf8"));
if (registry.formatVersion !== 1) throw new Error("unexpected registry layout");
```

`packageVersion` records which release of `@uplytech/game-stats-fetcher`
generated the file.

## Reading them without installing the package

```js
import titles from "./shared/registry/titles.json" with { type: "json" };

// Which titles have a real ranked ladder?
const ranked = titles.titles.filter((t) => t.capabilities.includes("getRank"));

// Which keys does a deployment need for the titles it cares about?
import providers from "./shared/registry/providers.json" with { type: "json" };
const wanted = ["cs2", "valorant", "rocket-league"];
const keys = providers.providers
  .filter((p) => p.keyName && !p.optionalAuth)
  .filter((p) => p.titles.some((id) => wanted.includes(id)))
  .map((p) => `apiKeys.${p.keyName}  ${p.docsUrl}`);
```

The same thing in Python, without installing the package either:

```python
import json
from pathlib import Path

titles = json.loads(Path("shared/registry/titles.json").read_text("utf-8"))
ranked = [t for t in titles["titles"] if "getRank" in t["capabilities"]]

providers = json.loads(Path("shared/registry/providers.json").read_text("utf-8"))
wanted = {"cs2", "valorant", "rocket-league"}
keys = [
    f"api_keys[{p['keyName']!r}]  {p['docsUrl']}"
    for p in providers["providers"]
    if p["keyName"] and not p["optionalAuth"] and wanted & set(p["titles"])
]
```

Note that the JSON keys stay `camelCase` in both editions. They are the shared
data format, not a language's naming convention, and translating them on the
Python side would mean the two editions no longer read the same file.
