# GameStatsFetcher

> One client for every game that publishes one. Players, ranks, matches,
> leaderboards and the professional circuit behind them — normalised across
> **87 titles**, **53 real APIs**, one set of types.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](./typescript)
[![Python](https://img.shields.io/badge/python-%3E%3D3.10-brightgreen)](./python)
[![Titles](https://img.shields.io/badge/titles-87-blue)](./shared/registry/titles.json)
[![Providers](https://img.shields.io/badge/providers-53-blue)](./shared/registry/providers.json)

**Two editions, one answer.** TypeScript and Python, and they do not drift —
that is enforced rather than promised. See
[Two editions](#two-editions-and-why-they-cannot-drift).

```bash
npm install @uplytech/game-stats-fetcher     # Node
pip install game-stats-fetcher               # Python
```

---

## What it does, in one sentence

You ask "what is this player's rank in that game" once, in one shape, and it
works whether *that game* is League of Legends, Age of Empires IV or Clash
Royale — three publishers, three authentication schemes, three completely
different ideas of what a rank is.

```typescript
const ranks = await client.title(anyTitleId).getRank({ name: whateverTheUserTyped });
```

```python
ranks = await client.title(any_title_id).get_rank({"name": whatever_the_user_typed})
```

## What it deliberately does not do

| Not in scope | Why |
|---|---|
| **Invent data** | A field the upstream does not provide is `null`. Never a plausible default, never a zero. |
| **Hide which source answered** | Every result carries the provider that produced it. Sources disagree, and pretending otherwise is how a dashboard lies. |
| **Pretend a title has data it does not** | An unsupported method throws. It never returns an empty array that looks like a quiet week. |
| **Store anything** | The cache is a cache. Your database is yours. |
| **Draw anything** | No embeds, no cards, no images. Numbers out; the picture is yours. |
| **Scrape** | Every provider here is an API somebody publishes, under terms this package respects. |

## The honest coverage table

87 titles, in three tiers. **The tier is a fact about the industry, not a gap
in this package.**

| Tier | Titles | What you get | Why |
|---|---|---|---|
| **Full** | 27 | profile, career stats, rank, match history, match detail, ladder, plus the esports layer | The publisher, or a credible community project, publishes a real player API. |
| **Player** | 25 | profile, career stats, rank, ladder — but no per-match record | The API has no match history. Overwatch and Fortnite have never published one. |
| **Esports only** | 35 | fixtures, tournaments, standings, prize money | Bandai Namco publishes no Tekken player API. Neither does Moonton for Mobile Legends. The professional circuit is what exists, and it is real, structured data. |

83 of 87 titles support `getEsportsTournaments`, and 77 support `getEarnings`.
52 have a player API at all.

### The four titles with no circuit

Old School RuneScape, RuneScape, EVE Online and Diablo III are here for their
**player** API and nothing else. None of them has a professional circuit, so
none of them answers an esports question — asking gets an
`UnsupportedCapabilityError`, not an empty list.

They are in the registry because the rule is *if it has a real API, it belongs
here*, and Jagex's hiscores, CCP's ESI and Blizzard's Diablo III profile are as
real and as first-party as Riot's. A player asking "what is my Slayer rank" is
asking the same question as a player asking for their VALORANT rank, and there
is no reason for one to be answerable and the other not.

<details>
<summary><b>The full list, by genre</b></summary>

**Tactical shooters** — Counter-Strike 2, VALORANT, Rainbow Six Siege, Splatoon 3

**FPS** — Team Fortress 2, Destiny 2, Halo Infinite, Call of Duty, Battlefield,
The Finals, Splitgate, Escape from Tarkov: Arena, Quake Champions, CrossFire,
Point Blank

**Hero shooters** — Overwatch 2, Marvel Rivals, Paladins, Brawl Stars

**MOBA** — Dota 2, League of Legends, Wild Rift, Deadlock, Heroes of the Storm,
SMITE, Pokémon UNITE, Mobile Legends, Honor of Kings, Arena of Valor

**Battle royale** — PUBG, PUBG Mobile, Apex Legends, Fortnite, Free Fire,
Naraka: Bladepoint

**Fighting** — Street Fighter 6, Tekken 8, Smash Ultimate, Smash Melee,
Mortal Kombat 1, Guilty Gear Strive, Dragon Ball FighterZ, King of Fighters XV,
Granblue Fantasy Versus: Rising, Brawlhalla

**RTS** — StarCraft II, Brood War, Warcraft III, Age of Empires II DE,
Age of Empires IV, Company of Heroes 3, Clash of Clans

**Card** — Hearthstone, Legends of Runeterra, Clash Royale, MTG Arena, Gwent,
Shadowverse

**Sports & racing** — Rocket League, EA Sports FC, eFootball, NBA 2K, Madden NFL,
iRacing, Trackmania, Gran Turismo 7, F1, Assetto Corsa Competizione

**MMO & persistent** — World of Warcraft, Guild Wars 2, Path of Exile,
Albion Online, Minecraft (Hypixel), Rust, Dead by Daylight, Fall Guys,
Old School RuneScape, RuneScape, EVE Online

**Action RPG** — Diablo III

**Vehicle** — World of Tanks, World of Warships, War Thunder

**Skill & mind sports** — osu!, Beat Saber, Chess, Teamfight Tactics

The machine-readable version is [`shared/registry/titles.json`](./shared/registry/titles.json).

</details>

## Install

```bash
npm install @uplytech/game-stats-fetcher     # Node ≥ 20
pip install game-stats-fetcher               # Python ≥ 3.10
```

**Zero mandatory dependencies in both.** Node uses built-in `fetch`; Python's
default transport is `urllib` from the standard library. Two optional extras
each: a real HTTP client (`httpx` on Python — used automatically if installed)
and Redis, for a cache shared between processes.

## Five minutes

```typescript
import { GameStatsClient } from "@uplytech/game-stats-fetcher";

const client = new GameStatsClient({
  apiKeys: { riot: process.env.RIOT_API_KEY },
});

// Resolve once. The ref survives a rename and saves the lookup call every
// later method would otherwise pay for.
const ref = await client.lol.resolvePlayer({ name: "Hide on bush#KR1", region: "kr" });

for (const rank of await client.lol.getRank(ref)) {
  console.log(`${rank.queue}: ${rank.tier} ${rank.division} — ${rank.tierPoints} LP`);
}

const history = await client.lol.getMatchHistory(ref, { limit: 5 });
console.log(history.map((m) => `${m.result} as ${m.playerStats?.extra.champion}`));
```

The same thing in Python. Async throughout, `snake_case` fields, frozen
dataclasses:

```python
from gamestatsfetcher import GameStatsClient, MatchHistoryOptions

async with GameStatsClient(api_keys={"riot": key}) as client:
    ref = await client.lol.resolve_player({"name": "Hide on bush#KR1", "region": "kr"})

    for rank in await client.lol.get_rank(ref):
        print(f"{rank.queue}: {rank.tier} {rank.division} — {rank.tier_points} LP")

    history = await client.lol.get_match_history(ref, MatchHistoryOptions(limit=5))
```

Some titles need no key at all, in either edition:

```typescript
const client = new GameStatsClient();                       // no configuration
const [rank] = await client.dota2.getRank({ steamId });      // OpenDota
const events = await client.title("tekken-8").getEsportsTournaments();  // Liquipedia
```

## The design decision that matters most

**Unsupported throws. It does not return empty.**

```typescript
await client.title("tekken-8").getRank({ name: "Arslan Ash" });
// UnsupportedCapabilityError: tekken-8 does not support getRank.
// It supports: getEsportsMatches, getEsportsTournaments, getStandings, getEarnings
```

An empty array is a legitimate answer to "what has this player played lately".
If a title with no player API returned one, a caller could not tell a quiet week
from a question the title cannot answer — and would find out weeks later, from
a dashboard that had silently been blank.

So ask first, in code:

```typescript
if (title.supports("getRank")) { /* ... */ }
```

```python
if title.supports("getRank"):
    ...
```

Or read the registry without a client at all:

```typescript
import { titlesByCapability } from "@uplytech/game-stats-fetcher";
const ranked = titlesByCapability("getRank");   // 40 titles
```

```python
from gamestatsfetcher import titles_by_capability
ranked = titles_by_capability("getRank")   # 40 titles
```

## Two editions, and why they cannot drift

Most "we also have a Python version" packages are a port that quietly falls
behind. This one is held together in two places, both of them tested.

**Coverage** — [`shared/registry/`](./shared/registry/) is generated by the
TypeScript edition and shipped as package data in the Python one. The Python
edition does not re-declare 87 titles and 53 providers; it reads the same JSON.

> A registry is not behaviour, it is **data**. Re-declaring 140 records in a
> second language would create exactly one thing: the opportunity for them to
> disagree.

**Behaviour** — [`shared/vectors/`](./shared/vectors/) holds generated cases for
every pure function: normalisation, identifier conversion, the
provider-capability table, the constants. Both suites replay them, so a change
to a win-rate calculation that lands in one edition fails the other's build.

The case that made this concrete: **JavaScript's `Math.round` rounds halves away
from zero, and Python's `round` is banker's rounding.** `Math.round(62.5)` is 63
and `round(62.5)` is 62. A direct port would have disagreed on every ratio
landing exactly on a half — silently, forever. The Python edition uses the
JavaScript rule, and the vectors are what keep it that way.

```bash
cd typescript && npm run vectors:check        # vectors current?
cd python && python scripts/sync_registry.py --check   # registry copy current?
```

Both checks also run inside their test suites, so a stale copy fails the suite
rather than shipping two editions that disagree about their own coverage.

**Where they differ, and why:**

| | TypeScript | Python |
|---|---|---|
| Transport seam | the `fetch` option | a `Transport` Protocol — `urllib` by default, `httpx` when installed |
| Field names | `tierPoints`, `winRatePermille` | `tier_points`, `win_rate_permille` |
| Capability names | `"getRank"` | `"getRank"` — a registry key, not a method name |
| Models | `readonly` interfaces | frozen dataclasses |
| Registry | declared in `titles.ts` | read from the generated JSON |

## The registry is the contract

Every title has an entry saying what it can do, which providers serve it, and
which identifiers it accepts. The client enforces it, and — the part that keeps
it true — **the esports capabilities are computed, not declared.**

The source declares them generously. At load, each title's esports capabilities
are intersected with the table of which provider can answer which question. A
title cannot promise something none of its providers can do, and adding a
provider widens its capabilities automatically.

That invariant is a test:

```text
never declares an esports capability no provider for that title can serve ✓
```

## Nothing is invented

Every normalised object has a `raw` field holding the untouched upstream
payload. Normalisation loses detail by definition, so the detail survives — a
caller who needs the one field this package did not model is never blocked on a
release.

And absent is not zero:

```typescript
stats.kills           // 4213   — the API said so
stats.assists         // null   — the API does not report assists
stats.deaths          // 0      — the player genuinely has none
```

## Ranks, honestly

Ranks are the single most inconsistent concept across game APIs. All three
shapes are modelled, and each title fills in what it actually knows:

```typescript
interface RankInfo {
  tier: string | null;                 // "Diamond", "Global Elite", "Level 10"
  division: string | null;
  tierPoints: number | null;           // LP, RR, stars
  rating: number | null;               // MMR, Elo, SR
  position: number | null;             // ladder place
  percentilePermille: number | null;   // 5 = top 0.5 %
}
```

`getRank` returns a **list**, because League has solo and flex, Rocket League
has five playlists, and picking one for you would be a guess.

Some cases are worth stating outright:

- **Counter-Strike 2** — Valve publishes no matchmaking rank. What you get is
  FACEIT level and Elo, and `queue` says `"faceit"` so you know.
- **VALORANT** — Riot's ranked endpoints need an approved production key. With
  only a development key, configure `apiKeys.henrikdev` and it works.
- **Rocket League** — Psyonix publishes nothing at all. Ladder from Tracker,
  matches from uploaded Ballchasing replays, the circuit from Octane.gg. An
  empty history means nobody uploaded, not that nobody played.

## Accessible by construction

This package draws nothing, so it cannot be accessible on its own. What it can
do is never be the reason a caller's interface is not — and that is a design
constraint here rather than an afterthought.

**Every rank has a name, in text.** `tier` is `"Diamond 2"`, `"Global Elite"`,
`"Level 99"` — a string, never a colour, never an icon id, never an index into
a palette. A title whose ladder has no names leaves `tier` null and puts the
number in `rating`, so a caller always has something to say rather than
something to show.

**`null` means "not reported", and it is never zero.** This is the single most
common way this data turns into a lie: rendering a missing win rate as `0 %`
tells every reader — sighted or not — something false, and a screen reader has
no tone of voice to hint otherwise. Render `null` as "unknown" or omit the row.
[Nothing is invented](#nothing-is-invented) is what makes that distinction
trustworthy.

**Every ratio is an integer with a stated scale.** `winRatePermille: 625` is
62.5 %, exactly, in both editions. A caller can announce "62.5 percent" instead
of describing the length of a bar, and two clients will announce the same
number.

**Every result names its source.** `providerId` is on every ref and every entry,
so a UI can write "according to OpenDota" in text rather than encoding
provenance as a colour or a badge that a screen reader skips.

**Avatars are URLs, and a URL is not a description.** `avatarUrl` has no alt
text because the package has none to give. `displayName` is the text that
belongs in the `alt` attribute; an avatar with an empty `alt` and a name beside
it is also correct. An avatar with `alt="avatar"` is not.

**The example report states every number before it draws it.** `resolvePlayer
52 of 87 ##############` reads correctly in order; the bar is a second encoding
of a number already given, which is the only honest way to use one.

## Rate limits are conditions of use, not tuning

Each provider declares its own bucket, filled from its published quota and
rounded down. Two are conditions of use rather than guesses, and are treated
that way:

| Provider | Limit | Because |
|---|---|---|
| Esports Earnings | 1 req/s | The documentation asks for it explicitly. |
| Liquipedia | 1 req/2 s + a contact User-Agent + 30-day caching | Their API terms of use. |
| PUBG | 10 req/min | The tightest first-party quota here. |

Buckets are **shared per provider, not per title**. Asking about CS2 and Dota 2
in the same second is two requests against one Steam quota — a limiter that did
not know that would let both through, and version 2 of this package did exactly
that.

An upstream 429 pauses every caller for that provider, not just the one that
received it. That is the difference between being throttled and having a key
revoked.

## Caching is a correctness feature

TTLs come from how fast the underlying thing actually changes:

| | TTL | Why |
|---|---|---|
| A finished match | 24 h | It will never change again. The biggest quota saver here. |
| Player resolution | 24 h | A PUUID is forever. |
| Rank | 60 s | A bot showing a stale rank right after a promotion is the complaint this exists to avoid. |
| Live fixtures | 30 s | They move constantly while an event is running. |

In-memory by default — nothing to deploy. Point it at Redis when several
processes should share one warm cache.

## Errors you can act on

Four kinds of "no data", and they need four different messages to a user:

| Situation | Error | The user should |
|---|---|---|
| No such player | `NotFoundError` | check the spelling |
| Profile is private | `PrivateProfileError` | open it in the game |
| Title cannot do this | `UnsupportedCapabilityError` | — (fix the code) |
| No key configured | `MissingCredentialError` | — (fix the deployment) |

`MissingCredentialError` names the option and the page the key comes from, and
is thrown **before** any network call:

```text
steam needs an API key. Pass it as apiKeys.steam —
get one at https://steamcommunity.com/dev/apikey
```

### Nothing escapes the type you are catching

Every one of the fourteen methods talks to a server neither you nor this package
controls. Providers change schemas without notice, gateways answer a 200 with an
HTML error page, and a caller behind a misconfigured proxy gets whatever that
proxy felt like. When a mapper meets a shape it was not written for, what comes
out is a `ParseError` naming the title and the call:

```text
valorant returned an unexpected shape: get_leaderboard received data it could
not map (AttributeError: 'list' object has no attribute 'get')
```

That is the whole guarantee, and it is worth stating plainly because the
alternative is what this package used to do: leak a bare `TypeError` from four
frames inside a normaliser, past the `except GameStatsError` you had carefully
wrapped everything in. A sweep of 87 titles × 14 methods × 10 payload shapes —
5,500 calls per edition — is part of the suite, and asserts there are none.

The original exception is chained, so a stack trace still points at the line
that actually broke.

## Finding out what a deployment can do

```typescript
for (const row of client.diagnostics().filter((r) => !r.ready)) {
  console.warn(`apiKeys.${row.missingKey} — unlocks ${row.titles.length} titles — ${row.docsUrl}`);
}

console.log(`${client.usableTitles().length} of ${client.titleCount()} titles usable.`);
```

```python
for row in client.diagnostics():
    if not row.ready:
        log.warning(
            "api_keys[%r] — unlocks %d titles — %s",
            row.missing_key, len(row.titles), row.docs_url,
        )

print(f"{len(client.usable_titles())} of {client.title_count()} titles usable.")
```

Run it at startup. A missing key found at boot is a five-minute fix; the same
key found at 3am is an incident.

## Repository layout

```text
GameStatsFetcher/
├── README.md               # you are here
├── CHANGELOG.md
├── CONTRIBUTING.md         # how to add a title without breaking the contract
├── SECURITY.md             # credential handling, and what counts as a vulnerability
├── LICENSE                 # MIT
├── shared/
│   ├── registry/           # generated JSON: the coverage, machine-readable
│   └── vectors/            # generated cases: the behaviour both editions must match
├── typescript/
│   ├── src/
│   │   ├── titles.ts       # the title registry — the single source
│   │   ├── providers.ts    # the provider registry
│   │   ├── esports.ts      # the cross-title esports layer
│   │   ├── providers/      # one module per upstream API
│   │   └── games/          # one client per title with a player API
│   ├── tests/              # 566 tests, including a contract suite over every title
│   ├── examples/
│   └── scripts/            # generate-registry.mjs, generate-vectors.mjs
└── python/
    ├── src/gamestatsfetcher/
    │   ├── registry.py     # reads shared/registry — does not re-declare it
    │   ├── http.py         # the Transport protocol and its two implementations
    │   ├── esports.py      # the same esports layer
    │   ├── providers/      # the same 12 provider modules
    │   ├── games/          # the same 11 title-client modules
    │   └── data/           # the synced copy of shared/registry
    ├── tests/              # 996 tests, same contract suite
    ├── examples/
    └── scripts/            # sync_registry.py, coverage_gate.py
```

## Quality bar

| | TypeScript | Python |
|---|---|---|
| Tests | 625 | 1064 |
| Core coverage | ≥ 90 % statements | 92 % (floor 90) |
| Mapping-layer coverage | representative + two full sweeps | 67 % (floor 65) |
| Mandatory dependencies | 0 | 0 |
| Type checking | `tsc --noEmit`, `strict` | `mypy --strict`, `warn_unreachable` |
| Linting | `eslint`, `no-explicit-any` as an error | `ruff check` + `ruff format` |
| Registry ↔ client agreement | contract suite, per title, per method | the same suite, ported case for case |

Coverage is gated in two tiers in both editions, because one number over the
whole package averages together two very different kinds of code — see
[CONTRIBUTING.md](./CONTRIBUTING.md#coverage).

```bash
cd typescript && npm install
npm test && npm run typecheck && npm run lint && npm run build && npm run vectors:check

cd ../python && pip install -e ".[dev]"
pytest && mypy && ruff check . && ruff format --check . \
  && python scripts/sync_registry.py --check && python scripts/coverage_gate.py

# Both editions at once: the examples run, and the two coverage reports match.
cd .. && node .github/scripts/check-examples.mjs
```

Two suites sweep the whole catalogue rather than a sample, because a gap in a
package of 87 titles is not something a reviewer finds by reading:

- **The contract suite** answers 503 to everything and asserts that a declared
  capability never refuses itself and an undeclared one always does.
- **The hostile-payload sweep** answers 200 with ten bodies no mapper was
  written for, and asserts that every failure is still a `GameStatsError`.

Both lift the published rate limits first. Without that, a bucket emptying part
way through turns the rest of the sweep into `LocalRateLimitError` — which is a
`GameStatsError` too, so the assertions keep passing while the code under test
is never reached.

## Adding a title

If it has a real API, it belongs here. See
[CONTRIBUTING.md](./CONTRIBUTING.md) — the short version is: add the provider,
add the title, and the registry test will tell you whether you were honest
about what it can do.

**A title with no real API does not go in.** Not with a scraper, not with a
placeholder. The registry is only worth reading because everything in it is
reachable.

## Documentation

- [TypeScript edition](./typescript/README.md) — the full API
- [Python edition](./python/README.md) — the full API
- [Shared registry](./shared/registry/README.md) — the generated coverage data
- [Shared vectors](./shared/vectors/README.md) — the generated behaviour contract
- [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md) · [Changelog](./CHANGELOG.md)

## License

MIT — see [LICENSE](./LICENSE).
