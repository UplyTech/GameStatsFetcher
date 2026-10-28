# @uplytech/game-stats-fetcher

> One client for every game that publishes one. 87 titles, 53 real APIs, one set of types.

[![npm version](https://img.shields.io/npm/v/%40uplytech%2Fgame-stats-fetcher)](https://www.npmjs.com/package/@uplytech/game-stats-fetcher)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen)](https://nodejs.org)

The overview, the coverage table and the design reasoning live in the
[repository README](../README.md). This file is the API.

---

## Install

```bash
npm install @uplytech/game-stats-fetcher
```

Node 22.12+. No mandatory dependencies. `ioredis` is an optional peer, needed only
for the Redis cache driver.

```typescript
import { GameStatsClient } from "@uplytech/game-stats-fetcher";
// or
const { GameStatsClient } = require("@uplytech/game-stats-fetcher");
```

There is no default export, deliberately: mixing one with named exports makes
CommonJS consumers write `.default`.

## Configuration

Every field is optional. A client with no options still serves the titles whose
providers need no key.

```typescript
const client = new GameStatsClient({
  apiKeys: {
    steam: process.env.STEAM_API_KEY,
    riot: process.env.RIOT_API_KEY,
    blizzard: `${process.env.BLIZZARD_ID}:${process.env.BLIZZARD_SECRET}`,
    pandascore: process.env.PANDASCORE_TOKEN,
  },

  cache: {
    driver: "redis",                 // "memory" (default) | "redis" | "none"
    redis: { host: "localhost", port: 6379 },
    keyPrefix: "gsf:",
    defaultTtlSeconds: 60,
    ttlOverrides: { "valorant:getRank": 30 },
  },

  retry: { attempts: 2, baseDelayMs: 250, respectRetryAfter: true },
  timeoutMs: 15_000,

  // Two providers require a descriptive User-Agent and will refuse a generic
  // one. Name your application and give a contact address.
  userAgent: "MyBot/2.1 (+https://example.com/bot)",

  // Try the next provider when the preferred one fails. Off by default: a
  // silent switch changes whose terms of service you are operating under.
  fallback: false,

  logger: "warn",                     // or your own {debug,info,warn,error}
  fetch: myFetch,                     // the seam every test in this package uses
});
```

Credentials that are two or three values are joined with a colon:

| Option | Shape |
|---|---|
| `blizzard` | `clientId:clientSecret` |
| `osu` | `clientId:clientSecret` |
| `hirez` | `devId:authKey` |
| `abios` | `clientId:secret` |
| `iracing` | `email:password` |
| `toornament` | `apiKey:clientId:clientSecret` |

`apiKeys` also accepts any other string key, for providers added through
`registerProvider()`.

## Two ways to reach a title

```typescript
client.cs2                  // typed accessor — autocompletes, returns CS2Client
client.title("csgo")        // registry lookup — ids and aliases, returns TitleClient
```

They are the same object. Accessors exist for the ~45 titles people reach for
constantly; the lookup exists because there are 87 and because a bot taking a
title from user input needs the string form anyway.

```typescript
client.tryTitle("half-life")     // undefined instead of throwing
client.title("valorent")         // UnknownTitleError, with suggestions
```

## The canonical surface

Every title exposes the same fourteen methods. What it actually supports is in
`title.capabilities`; anything else throws `UnsupportedCapabilityError`.

```typescript
// Players
resolvePlayer(query: PlayerQuery): Promise<PlayerRef>
getPlayer(query: PlayerQuery | PlayerRef): Promise<PlayerProfile>
getPlayerStats(query: PlayerQuery | PlayerRef): Promise<PlayerStats>
getRank(query: PlayerQuery | PlayerRef): Promise<RankInfo[]>
getMatchHistory(query, options?: MatchHistoryOptions): Promise<MatchSummary[]>
getMatch(matchId: string, context?: PlayerRef): Promise<MatchDetail>
getLeaderboard(options?: LeaderboardOptions): Promise<LeaderboardEntry[]>
getMetadata(kind?: string): Promise<unknown>

// The professional circuit — available for every registered title
getEsportsMatches(options?: EsportsQueryOptions): Promise<EsportsMatch[]>
getEsportsTournaments(options?): Promise<EsportsTournament[]>
getEsportsTeams(options?): Promise<EsportsTeam[]>
getEsportsPlayers(options?): Promise<EsportsPlayer[]>
getStandings(tournamentId: string, options?): Promise<EsportsStanding[]>
getEarnings(handle: string): Promise<PrizeEarnings>
```

### Resolving a player

`PlayerQuery` is one shape for every title; each title takes what it can use.

```typescript
{ steamId, puuid, gameName, tagLine, name, battleTag, playerTag,
  epicId, ubisoftId, membershipId, accountId, platform, region, extra }
```

A Riot ID pasted into `name` is split for you. A legacy Steam id (`STEAM_0:0:…`,
`[U:1:…]`, a bare 32-bit id) is normalised. A Supercell tag is upper-cased, its
leading `#` made optional, and the letter `O` corrected to a zero — because
users copy tags out of screenshots.

```typescript
await client.lol.resolvePlayer({ name: "Faker#KR1", region: "kr" });
await client.cs2.resolvePlayer({ steamId: "STEAM_0:0:11101" });
await client.clashRoyale.resolvePlayer({ playerTag: "2ppOjcvl" });
```

**Resolve once and keep the ref.** It is stable across renames and saves the
lookup call every later method would otherwise pay for.

### Reading the results

```typescript
const stats = await client.cs2.getPlayerStats(ref);

stats.matchesPlayed        // number | null
stats.winRatePermille      // 600 = 60.0 % — integer, never a float
stats.kdPermille           // 1500 = 1.50
stats.modes["de_dust2"]    // per map / playlist / hero / legend
stats.raw                  // the untouched upstream payload
```

Ratios are **permille integers**, matching the convention used by
[RankMode](../../RankMode) and [EconomyWorld](../../EconomyWorld), so a value
can be stored and compared without a float entering the pipeline.

`null` means the API does not report the field. `0` means the value is zero.

## Errors

```typescript
import { GameStatsError, NotFoundError, PrivateProfileError } from "@uplytech/game-stats-fetcher";

try {
  await client.cs2.getPlayerStats({ steamId });
} catch (error) {
  if (error instanceof PrivateProfileError) { /* tell the user to open it */ }
  else if (error instanceof NotFoundError)  { /* tell the user it is a typo */ }
  else if (error instanceof GameStatsError) { /* everything else, with .code */ }
}
```

| Class | `code` | Means |
|---|---|---|
| `NotFoundError` | `NOT_FOUND` | the player, match or tournament does not exist |
| `PrivateProfileError` | `PRIVATE_PROFILE` | it exists, and its owner hid it |
| `UnsupportedCapabilityError` | `UNSUPPORTED_CAPABILITY` | this title cannot answer that |
| `IdentifierError` | `IDENTIFIER_ERROR` | the query has none of the fields this title accepts |
| `MissingCredentialError` | `MISSING_CREDENTIAL` | no key configured — thrown before any request |
| `AuthenticationError` | `AUTH_ERROR` | the key was rejected |
| `RateLimitError` | `RATE_LIMIT` | upstream 429, with `retryAfterMs` |
| `LocalRateLimitError` | `LOCAL_RATE_LIMIT` | the local bucket refused before spending quota |
| `HttpError` | `HTTP_ERROR` | any other non-2xx, with `statusCode` and `body` |
| `NetworkError` / `TimeoutError` | `NETWORK_ERROR` / `TIMEOUT` | never got a response |
| `ParseError` | `PARSE_ERROR` | upstream answered with a shape we cannot map — usually a schema change |
| `AllProvidersFailedError` | `ALL_PROVIDERS_FAILED` | every provider in the chain failed; carries all of them |

Every error has `toJSON()` for structured logging. None of them ever holds a
credential: a configured key is replaced with `***` wherever it would otherwise
appear, including inside an upstream error body that quoted it back.

That `instanceof GameStatsError` branch really is a bottom. Every one of the
fourteen methods talks to a server this package does not control, and when a
mapper meets a payload it was not written for — a schema change, a gateway's
HTML error page served with a 200, a proxy answering with whatever it likes —
the result is a `ParseError` naming the title and the call, not a bare
`TypeError: rows.map is not a function`:

```text
warcraft-3 returned an unexpected shape: getLeaderboard received data it could
not map (TypeError: ladder.slice is not a function)
```

The original error is kept as `cause`, so the stack still points at the line
that broke. `tests/hostile-payloads.test.ts` sweeps 87 titles × 14 methods × 10
payload shapes and asserts nothing escapes.

## The registries, without a client

```typescript
import {
  listTitles, findTitle, searchTitles, titlesByCapability,
  titlesByGenre, titlesByProvider, listProviders,
} from "@uplytech/game-stats-fetcher";

titlesByCapability("getRank").length;          // 40
titlesByProvider("riot").map((t) => t.id);     // what breaks if Riot goes down
searchTitles("overwatc");                      // typo-tolerant, for autocomplete
findTitle("CS:GO")?.id;                        // "cs2"
```

## Diagnostics

```typescript
client.diagnostics();          // per provider: ready, missingKey, docsUrl, titles
client.usableTitles();         // titles this configuration can actually serve
client.rateLimitSnapshot();    // tokens and blocked-for per provider
```

## Escaping the canonical model

Some endpoints are deliberately not modelled — asking OpenDota to parse a
replay, uploading to Ballchasing, reading the Destiny manifest. The provider
clients are right there:

```typescript
await client.raw.opendota(client.internals).requestParse(matchId);
await client.raw.bungie(client.internals).getManifest();
```

They share the same cache, limiter and transport as everything else.

## Adding a provider or a title at runtime

```typescript
import { registerProvider, registerTitle } from "@uplytech/game-stats-fetcher";

registerProvider({
  id: "our-league", label: "Our League API", kind: "community",
  baseUrl: "https://api.ourleague.example", auth: "bearer",
  keyName: "ourLeague", docsUrl: "https://ourleague.example/docs",
  rps: 2, burst: 5, requiresUserAgent: false, notes: null,
});

registerTitle({ /* TitleDescriptor */ });
```

A registered title is reconciled like a built-in: it cannot claim an esports
capability its providers do not serve.

## Testing against this package

`fetch` is an option, so no mocking framework is needed:

```typescript
const client = new GameStatsClient({
  fetch: async (url) => new Response(JSON.stringify(fixture), { status: 200 }),
  cache: { driver: "none" },
  retry: { attempts: 0 },
});
```

That is exactly how this package's own 625 tests work.

## Scripts

```bash
npm run build           # tsup → dist (cjs + esm + d.ts)
npm test                # vitest
npm run test:coverage   # with the two-tier gate
npm run typecheck       # tsc --noEmit
npm run lint            # eslint
npm run registry        # regenerate shared/registry from dist
npm run registry:check  # fail if it is out of date
```

## License

Apache License 2.0. See [LICENSE](../LICENSE) and [NOTICE](../NOTICE).

Copyright (c) 2021-present UplyTech. UplyTech has existed as a community since 2021.
