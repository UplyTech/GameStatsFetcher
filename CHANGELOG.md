# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A change to the coverage — a title added, a capability gained or lost, a rate
limit tightened — shows up as a diff in `shared/registry/` and is recorded here.

## [Unreleased]

### Changed

- **Node 22.12 or newer** (`engines.node` was `>=20.0.0`). Node 20 is end-of-life, and CI tests on Node 22 and 24 only.
- **Licence: Apache License 2.0** (was CC0 1.0 in `LICENSE` and MIT in the manifests). `LICENSE` carries the full Apache text, `NOTICE` the attribution `Copyright (c) 2021-present UplyTech` (UplyTech has existed as a community since 2021); both ship in the npm package, the wheel and the sdist. Author fields name UplyTech only.
- PyPI distribution name `uplytech-game-stats-fetcher` (was `game-stats-fetcher`); the import name is unchanged. npm stays `@uplytech/game-stats-fetcher`.
- Releases publish to npm and PyPI with Trusted Publishing (OIDC, no registry token) and npm provenance, after the signed GitHub release. Each registry is switched on with a repository variable once its Trusted Publisher exists. Every artefact also gets a GitHub build attestation.
- CI runs on GitHub-hosted runners, since the repository is public and the organisation runner serves private repositories only. Pull requests are validated again (read-only token, no secrets); CodeQL, dependency review and a published OpenSSF Scorecard are part of the checks.
- Repository links point to `github.com/UplyTech/GameStatsFetcher`.
- `NOTICE` names the licensor in full: UplyTech, Tim Hauke, Albert-Schweitzer-Ring 42, 25524 Itzehoe, Germany. Python metadata uses the PEP 639 fields (`license = "Apache-2.0"`, `license-files`); the wheel carries `LICENSE` and `NOTICE` under `licenses/`.
- Test toolchain: Vitest 5, ESLint 9 with a flat config, typescript-eslint 8. This clears the advisories in the old Vitest/Vite/esbuild dev tree (none of it reached a caller). The test matrix runs Node 22 and 24; Node 20 is end-of-life and Vitest 5 needs 22.12 or newer.
- Releases start only from a pushed `v*` tag on `main`; the manual trigger is gone. The registry jobs run in the environment `release` (only `v*` tags, the owner approves). Tool images in CI are pinned by digest. The Python dependency audit runs against the pinned dev environment and fails on any finding.

## [3.2.0] - 2026-09-09

Nothing an upstream sends can now escape as an exception you cannot catch.

Every method on the canonical surface talks to a server neither you nor this
package controls. Providers change schemas without notice, gateways answer a 200
with an HTML error page, and a caller behind a misconfigured proxy gets whatever
that proxy felt like. The mapping layer was written against the shapes those
providers document — and when it met something else, what came out was
`AttributeError: 'str' object has no attribute 'get'` (Python) or
`TypeError: rows.map is not a function` (TypeScript). Neither names the title,
neither names the call, and neither is a `GameStatsError` — so an application
that carefully wrapped every call still fell over.

A sweep of 87 titles × 14 methods × 10 payload shapes — 5,500 calls per edition —
found **695 such escapes in Python and 174 in TypeScript**. There are now none.

### Fixed

- **Every call translates a malformed payload into `ParseError`.** The wrapper
  names the title and the method (`valorant returned an unexpected shape:
  get_leaderboard received data it could not map …`) and chains the original
  exception, so the traceback still points at the line that broke. Applied to
  the prototype chain in TypeScript and via `__init_subclass__` in Python, so a
  title client added next year is covered by having been written rather than by
  somebody remembering.
- **Errors this package raises deliberately pass through untouched.**
  `UnsupportedCapabilityError`, `NotFoundError`, `ValidationError` and the rest
  are unchanged; only the accidents are translated.
- **119 list coercions in the Python providers now refuse a wrong shape instead
  of corrupting it.** `list()` on a mapping quietly yields its *keys* and on a
  string its characters, so an array endpoint answering `{"error": …}` used to
  reach a normaliser as a list of strings. `rows()`, `records()` and `record()`
  on `ProviderClient` say so instead.
- **A non-numeric osu! client id is refused by name, before the request.** osu!
  wants the client id as a JSON number; Python raised a bare `ValueError` from
  four frames down, and TypeScript sent `null` and got back an unexplained 401.
  Both now name the option and the page it comes from.
- **The TypeScript coverage-report example ranked one number while printing
  another.** Its "most valuable missing credential" list sorted by how many
  titles a provider *touches* and printed how many it would *newly unlock*, so a
  key that unlocked nothing could sit above one that unlocked three. It was also
  missing the rate-limits section entirely and drew its bars four characters
  narrower than the Python one.
- **`.github/knip.json` had never run.** knip validates its config against a
  schema that rejects unknown keys, so the `"//"` comment key made every run
  exit with `unrecognized_keys: //` — invisibly, because the step is
  `continue-on-error`. It is now `knip.jsonc`, with real comments.
- **The spelling gate was failing on 1,898 words.** Not one of them was a typo:
  they were title ids, provider ids and the field names other people's APIs
  chose. See below.

### Added — checks

- `python/tests/test_hostile_payloads.py` and
  `typescript/tests/hostile-payloads.test.ts`: the sweep described above, kept.
  Ten payload shapes, each chosen because a real API answers with it under some
  failure. Each sweep asserts it actually reached the mappers — a rate limiter
  that refused every call would throw a `GameStatsError` too, and a test that
  passed that way would be asserting nothing.
- `.github/scripts/check-examples.mjs`: runs all six examples and diffs the two
  coverage reports line by line, normalising exactly two things — how a key is
  named (`api_keys['steam']` vs `apiKeys.steam`) and the column width that
  follows from it. Everything else differing is a finding. It found four.
- `.github/scripts/generate-cspell-registry.mjs`: the spelling dictionary for
  every title and provider name is now generated from `shared/registry` and
  checked in CI, so adding a title never fails the spelling gate for a word that
  is not misspelt. What cannot be derived — upstream field names, the games' own
  vocabulary, the deliberate misspellings the fuzzy-lookup tests need — is in
  `.github/cspell-vocabulary.txt`, grouped and explained.
- The accessibility contract in the README is now asserted rather than
  described: every ratio field's name states its scale, every reported number is
  nullable so nothing missing renders as zero, and every result names its
  source.
- Both contract suites now lift the published rate limits before sweeping.
  Without that, a bucket emptying turned the rest of the sweep into
  `LocalRateLimitError` — a `GameStatsError`, so the assertions still passed
  while the code under test was never reached. The TypeScript contract suite
  went from 22.8 s to 0.2 s as a side effect.

### Changed

- The Python mapping-layer coverage floor rises from 40 % to 65 %, which is
  roughly what the two sweeps reach on their own. Measured coverage went from
  55.3 % to 67.4 %, and the package total from 64.7 % to 72.1 %.
- Both `coverage-report` examples now print identical output, and the bar is 24
  characters wide in both.

## [3.1.0] - 2026-09-09

Four titles that were missing for a reason that turned out not to be one.

The registry's rule has always been *if it has a real API, it belongs here*. In
practice it had a second, unwritten rule — *and if it has a professional
circuit* — which is why four games with first-party player APIs were absent. The
unwritten rule is gone. The written one is enforced.

### Added — titles

| Title | API | What you get |
|---|---|---|
| **Old School RuneScape** | Jagex hiscores, first-party, no key | Every skill's rank, level and experience; every tracked activity's rank and score |
| **RuneScape** | The same host, the other table | The same |
| **EVE Online** | CCP's ESI, first-party, no key | Character, corporation, alliance, security status, server status |
| **Diablo III** | Blizzard's own API, on the credential WoW and StarCraft II already use | Career, heroes, both paragon ladders, and the seasonal Greater Rift leaderboard |

None of the four has an esports circuit, so **none of them answers an esports
question** — asking throws `UnsupportedCapabilityError` rather than returning an
empty list that reads like a quiet week. That exception is named in the registry
tests of both editions, so a fifth cannot appear without somebody deciding it
should.

- New provider `jagex` (2 rps, descriptive User-Agent required) and `eve-esi`
  (10 rps). Both first-party, both unauthenticated.
- Diablo III rides the existing `blizzard` provider — no new credential.
- New genre `action-rpg`. Diablo III is not an MMO and not an RTS, and calling
  it either would make the genre filter lie to anybody grouping titles with it.

### Added — checks

- `.github/scripts/check-counts.mjs`: every number the documentation advertises
  is compared with the registry. It found the first thing it looked at — the
  README said "21 player-tier titles" while the registry held 22, because a
  title had gained a ladder and the table had not noticed. Thirty numbers across
  four documents are now checked on every push.

### Changed

- The tagline is "one client for every game that publishes one", not "every
  esports title". The package covers 83 titles with a circuit and 4 without, and
  the old wording made the second group look like a mistake.
- The coverage tiers are now 27 full / 25 player / 35 esports-only, of 87.

### Notes on what was *not* added

The rule cuts both ways, and these were considered and refused:

- **Final Fantasy XIV.** XIVAPI's character endpoints read the Lodestone, which
  is a web page. This package does not scrape, and a provider that does would
  make the registry's promise — everything in here is reachable and published —
  false for every other entry.
- **Diablo IV.** Blizzard publishes no player API for it. An absent title is a
  fact about the industry, not a gap here.
- **Genshin Impact, Honkai.** The community mirrors of an undocumented internal
  endpoint are not a published API, whatever their uptime.

## [3.0.0] - 2026-09-05

A rewrite. Version 2 was six titles behind a per-game API; this is 83 titles
behind one — in two languages.

### Added — the Python edition

The package now ships as `@uplytech/game-stats-fetcher` on npm and
`game-stats-fetcher` on PyPI. Both have the same 83 titles, the same 51
providers, the same fourteen methods and the same guarantees.

- **Async throughout**, and the client is an async context manager so the
  transport and the cache connection are actually closed.
- **Zero mandatory dependencies**, like the TypeScript edition. The default
  transport is `urllib` from the standard library, run in a worker thread;
  `httpx` is used automatically when installed and brings connection pooling
  and HTTP/2. `Transport` is a Protocol, so any client can be substituted —
  the same seam the TypeScript edition exposes through its `fetch` option.
- **Frozen dataclasses** for every model, `snake_case` for every field.
  Capability names keep their wire spelling (`"getRank"`), because they are
  registry keys read by both editions rather than method names.
- `mypy --strict` clean with `warn_unreachable`; `ruff check` and
  `ruff format` clean.
- 996 tests, including the contract suite ported case for case, and a two-tier
  coverage gate at `python/scripts/coverage_gate.py` (core 93 %, floor 90 %).

**The two editions are held together by two generated things, and both are
tested rather than promised:**

- `shared/registry/` — generated by the TypeScript edition, shipped as package
  data in the Python one. The Python edition reads it; it does not re-declare a
  single title. A stale copy fails the Python suite, not just CI.
- `shared/vectors/` — generated cases for every pure function, replayed by both
  suites. A change to a win-rate calculation that lands in one edition fails the
  other's build.

The vectors exist because of a specific trap: **JavaScript's `Math.round` rounds
halves away from zero and Python's `round` is banker's rounding.**
`Math.round(62.5)` is 63 and `round(62.5)` is 62. A direct port would have
disagreed on every ratio landing exactly on a half — silently, forever.

### Breaking changes

- **Every title exposes the same fourteen methods.** The per-game method names
  (`getPlayerSummary`, `getMatchHistory`, `getSummonerByName`, ...) are replaced
  by one canonical surface: `resolvePlayer`, `getPlayer`, `getPlayerStats`,
  `getRank`, `getMatchHistory`, `getMatch`, `getLeaderboard`, `getMetadata`,
  and the six esports methods.
- **Results are normalised.** Methods return `PlayerProfile`, `PlayerStats`,
  `RankInfo[]`, `MatchSummary[]` and so on rather than the upstream payload.
  The upstream payload is still there, on `raw`.
- **`getRank` returns a list**, not a single rank. League has solo and flex,
  Rocket League has five playlists, and picking one would be a guess.
- **The default export is gone.** Import the named `GameStatsClient`; mixing a
  default with named exports makes CommonJS consumers write `.default`.
- **Caching defaults to memory, not Redis.** Version 2 made Redis effectively
  mandatory. `ioredis` is now an optional peer and the in-memory LRU needs
  nothing deployed.
- **Ratios are permille integers**, not floats: `winRatePermille: 600` is 60 %.
- `client.rocketLeague` and friends still exist, but they return the new
  `TitleClient` subclasses.

### Added — coverage

- **83 titles**, up from 6. 48 have a player API; 35 are covered through their
  professional circuit because their publishers offer nothing else.
- **51 providers**: 19 first-party, 24 community, 5 esports-data, 3 tournament
  platforms. 20 of them need no key at all.
- First-party clients for Steam, Riot, Blizzard, Bungie, PUBG, all three
  Supercell APIs, Wargaming, Hi-Rez, iRacing, Guild Wars 2, Path of Exile,
  Albion, Relic, osu!, Hypixel and Brawlhalla.
- Community clients for OpenDota, STRATZ, FACEIT, Tracker Network, OverFast,
  HenrikDev, ApexLegendsAPI, Fortnite-API, HaloDotAPI, Ballchasing, Octane.gg,
  SC2Pulse, W3Champions, AoE4World, Raider.IO, logs.tf, ScoreSaber, BeatLeader,
  Heroes Profile, Chess.com, Lichess, trackmania.io, Deadlock API, Marvel
  Rivals and The Finals.
- Esports coverage through PandaScore, Abios, start.gg, Toornament, Challonge,
  Liquipedia and Esports Earnings — which is what makes the 35 titles with no
  player API usable rather than merely listed.

### Added — the registry

- `shared/registry/` — the coverage as generated JSON, readable without
  installing the package.
- `titlesByCapability()`, `titlesByProvider()`, `titlesByGenre()`,
  `searchTitles()` and `findTitle()`, so a caller can ask what a title can do
  before calling it.
- Typo-tolerant search and alias resolution: `"CS:GO"`, `"csgo"` and `"cs go"`
  all resolve to `cs2`.
- `registerTitle()` and `registerProvider()` for private or regional APIs.

### Added — behaviour worth knowing about

- **Esports capabilities are computed, not declared.** A title's declared set is
  intersected at load with the table of which provider serves which question, so
  the registry cannot promise something nothing can do — and adding a provider
  widens a title's capabilities automatically.
- **Unsupported methods throw.** They never return an empty array, because a
  caller cannot tell that apart from a quiet week.
- **Rate-limit buckets are per provider, shared across titles.** Version 2 gave
  each game client its own limiter, so asking about CS2 and Dota 2 in the same
  second spent one Steam quota twice and produced 429s nobody could explain.
- An upstream 429 pauses every caller for that provider, not only the one that
  received it.
- Retries use full jitter, so a fan-out that hits a 429 does not retry in
  lockstep into the same wall.
- `diagnostics()` and `usableTitles()` report what a deployment can actually
  reach, and which key would unlock the most titles next.

### Added — quality

- 566 tests in TypeScript and 996 in Python, including a contract suite in each
  that walks every title and every method and asserts the registry and the code
  agree.
- A two-tier coverage gate in both editions: 90 % on the core, a lower bar on the
  mapping layers, with the reasoning written into `vitest.config.ts` and
  `python/scripts/coverage_gate.py`.
- `npm run registry:check` and `npm run vectors:check` fail the build when the
  generated files are stale; `python scripts/sync_registry.py --check` does the
  same for the shipped copy, and runs inside the Python suite.
- A test that no provider is left unroutable, and that the three deliberately
  opt-in ones (Abios, Toornament, Challonge) can still be reached by naming them.
- A test that an unconfigured Python deployment only ever reaches providers that
  need no credential — a request sent with no key spends a round trip to learn
  what the registry already knows.

### Fixed

- `AuthenticationError` was thrown for a missing key from inside a synchronous
  method via `await import`, which could not work. Missing credentials now throw
  `MissingCredentialError` before any request, naming the option and the page
  the key comes from.
- `export type Record = Record<string, unknown>` in `types.ts` was a circular
  self-reference that shadowed the built-in.
- The Redis adapter threw from its `error` handler, which could take down the
  process. A cache failure is now always a miss.
- Valorant match history fetched full detail for every match id sequentially
  with no limit; `getMatchHistory` now clamps and the detail is cached for a day.
- The Steam client treated an empty stats payload as "no stats" without checking
  whether the profile was simply private.

Building the second edition and running the examples against the live APIs found
five more, and every one of them now has a test:

- **Liquipedia was unreachable from the Python edition.** It answers
  `406 Gzip encoding is required for API requests` to anything that does not ask
  for compression, and the standard-library transport did not. Liquipedia is the
  keyless provider serving the tournament tier for all 83 titles, so the
  package's widest promise failed in production while every offline test passed.
  `UrllibTransport` now negotiates and decodes gzip and deflate. (`fetch` and
  `httpx` do this themselves, so the TypeScript edition was never affected.)
- **`dead-by-daylight` had no Steam app id**, although it is a Steam-backed
  title sharing `SteamStatsClient` and is named in that class's own
  documentation — so every stats call for it raised `ValidationError`. Meanwhile
  `escape-from-tarkov` carried an app id of `0`, a fabricated value for a game
  that is not on Steam at all. Both fixed; a test now rejects any app id of `0`.
- **The Guild Wars 2 provider sent unauthenticated requests.** Every endpoint
  this package uses there is account-scoped, so the call always failed — with an
  opaque 401 rather than a `MissingCredentialError` naming the option. Fixed in
  both editions.
- **Abios's `getSeries` accepted `since` and `until` and sent neither.** A caller
  filtering fixtures by date got every fixture back with no way to tell. The
  parameters are gone rather than guessed at.
- **The Python registry's identifiers did not match its query fields.** The
  registry names them `steamId` and `battleTag` because it is one JSON file read
  by both editions; `PlayerQuery` names them `steam_id` and `battle_tag`. Every
  Steam-backed title therefore rejected a perfectly valid query with
  `IdentifierError`. `PlayerQuery.get` now translates at that one seam, and
  `as_query` accepts either spelling — and rejects an unknown key outright
  instead of dropping it and surfacing the typo three layers away.

### Decisions worth recording

- **Only titles with a real API.** No scrapers, no placeholders. A registry that
  lists something it cannot serve is worse than one that omits it, because a
  caller has no way to tell which entries are true.
- **`raw` on everything.** Normalisation loses detail by definition, so callers
  are never blocked on a release for the one field we did not model.
- **`null` is not `0`.** "The API does not report this" and "the value is zero"
  are different facts and a dashboard should be able to show them differently.
- **`fallback` off by default.** Switching provider changes whose terms of
  service you are operating under; that is a decision, not a default.
- **Liquipedia and Esports Earnings limits are not tunable defaults.** They are
  conditions of use, and this package honours them.
- **The registry has one source, not two.** The Python edition reads generated
  JSON rather than re-declaring 83 titles and 51 providers. A registry is data,
  and a second declaration of data is only ever an opportunity to disagree.
- **The two editions are proven to agree, not assumed to.** `shared/vectors/`
  pins every pure function, and both suites replay it. Two editions that quietly
  compute different win rates are worse than two separate libraries, because
  nobody expects the difference.
- **Three providers are reachable only by naming them.** Abios is commercial;
  Toornament and Challonge are bracket platforms that do not know what game a
  bracket is for. No title can honestly claim them, so they are opt-in through
  the explicit `provider` option — and a test asserts that list, so a fourth
  provider left unrouted by accident is caught.

## [2.0.0] - 2026-09-04

- New API surface (`GameStatsClient` + per-game namespaces).
- Riot endpoints split into `client.valorant` and `client.lol`.
- Activision support removed in favour of generic OAuth provider plugins.
- Per-method TTL caching, token-bucket rate limiting, pluggable `fetch`.
- Rocket League and Fortnite modules.

## [1.0.1] - 2024-03-12

- Initial published version with Steam / Riot / Activision clients.

## [1.0.0] - 2024-02-28

- Initial release.

[3.1.0]: https://github.com/uplytech/game-stats-fetcher/releases/tag/v3.1.0
[3.0.0]: https://github.com/uplytech/game-stats-fetcher/releases/tag/v3.0.0
[2.0.0]: https://github.com/uplytech/game-stats-fetcher/releases/tag/v2.0.0
