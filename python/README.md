# GameStatsFetcher — Python edition

> One client for every esports title. Players, ranks, matches, leaderboards and
> the professional circuit behind them — normalised across **87 titles**,
> **53 real APIs**, one set of types.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Python](https://img.shields.io/badge/python-%3E%3D3.10-brightgreen)](https://www.python.org/)
[![Titles](https://img.shields.io/badge/titles-87-blue)](../shared/registry/titles.json)
[![Providers](https://img.shields.io/badge/providers-53-blue)](../shared/registry/providers.json)

This is the Python half of [GameStatsFetcher](../README.md). It is not a port
that lags behind — the two editions share the registry that decides what every
title can do, and a set of generated test vectors that prove the pure functions
agree to the last digit. See [Two editions, one answer](#two-editions-one-answer).

---

## Install

```bash
pip install game-stats-fetcher
```

**Zero mandatory dependencies.** The default transport is built on `urllib` from
the standard library, so the package works in a fresh virtualenv with nothing
else in it.

Two extras, both optional:

```bash
pip install "game-stats-fetcher[http]"    # httpx: connection pooling, HTTP/2
pip install "game-stats-fetcher[redis]"   # a cache shared between processes
```

If `httpx` is importable, it is used automatically — you do not configure
anything. The standard-library transport is correct but opens a connection per
request, which is fine for a script and wasteful for a bot that runs for weeks.

## Five minutes

```python
import asyncio
import os

from gamestatsfetcher import GameStatsClient, MatchHistoryOptions


async def main() -> None:
    async with GameStatsClient(api_keys={"riot": os.environ["RIOT_API_KEY"]}) as client:
        # Resolve once. The ref survives a rename and saves the lookup call
        # every later method would otherwise pay for.
        ref = await client.lol.resolve_player({"name": "Hide on bush#KR1", "region": "kr"})

        for rank in await client.lol.get_rank(ref):
            print(f"{rank.queue}: {rank.tier} {rank.division} — {rank.tier_points} LP")

        history = await client.lol.get_match_history(ref, MatchHistoryOptions(limit=5))
        for match in history:
            champion = match.player_stats.extra.get("champion") if match.player_stats else None
            print(match.result.value, champion)


asyncio.run(main())
```

The package is **async throughout**. Every method on a title client is a
coroutine, and the client is an async context manager so the transport and the
cache connection actually get closed.

Some titles need no key at all:

```python
async with GameStatsClient() as client:  # no configuration
    rank, *_ = await client.dota2.get_rank({"steam_id": steam_id})  # OpenDota
    events = await client.title("tekken-8").get_esports_tournaments()  # Liquipedia
```

## Naming: `snake_case` everywhere, except the wire

Method and field names follow Python convention — `get_match_history`,
`tier_points`, `percentile_permille`. Two things deliberately keep their
original spelling:

- **Capability names** (`"getRank"`, `"getEsportsMatches"`) are registry keys,
  not method names. They come from a JSON file both editions read, and
  translating them would mean the Python edition asking a question the registry
  cannot be searched for.
- **`raw`** is whatever the upstream sent, untouched. Renaming keys inside it
  would defeat its entire purpose.

```python
client.title("cs2").supports("getRank")  # registry key
await client.cs2.get_rank(ref)  # Python method
```

## The honest coverage table

87 titles, in three tiers. **The tier is a fact about the industry, not a gap in
this package.**

| Tier | Titles | What you get | Why |
|---|---|---|---|
| **Full** | 27 | profile, career stats, rank, match history, match detail, ladder, plus the esports layer | The publisher, or a credible community project, publishes a real player API. |
| **Player** | 25 | profile, career stats, rank, ladder — but no per-match record | The API has no match history. Overwatch and Fortnite have never published one. |
| **Esports only** | 35 | fixtures, tournaments, standings, prize money | Bandai Namco publishes no Tekken player API. The professional circuit is what exists, and it is real, structured data. |

Read it from code without constructing a client:

```python
from gamestatsfetcher import list_titles, titles_by_capability, titles_by_genre

len(list_titles())  # 87
len(titles_by_capability("getRank"))  # 40
[t.name for t in titles_by_genre("fighting")]
```

## Unsupported raises. It does not return empty

```python
await client.title("tekken-8").get_rank({"name": "Arslan Ash"})
# UnsupportedCapabilityError: tekken-8 does not support getRank.
# It supports: getEsportsMatches, getEsportsTournaments, getStandings, getEarnings
```

An empty list is a legitimate answer to "what has this player played lately". If
a title with no player API returned one, a caller could not tell a quiet week
from a question the title cannot answer — and would find out weeks later, from a
dashboard that had silently been blank.

So ask first:

```python
title = client.title(title_id)
if title.supports("getRank"):
    ranks = await title.get_rank(query)
```

## Nothing is invented

Every normalised object carries a `raw` field holding the untouched upstream
payload. Normalisation loses detail by definition, so the detail survives — a
caller who needs the one field this package did not model is never blocked on a
release.

And absent is not zero:

```python
stats.kills  # 4213  — the API said so
stats.assists  # None  — the API does not report assists
stats.deaths  # 0     — the player genuinely has none
```

Every model is a **frozen dataclass**. Two results that describe the same thing
compare equal, and nothing you hand to a caller can be mutated behind your back.

```python
from dataclasses import asdict

asdict(rank)  # for JSON, a database row, an HTTP response
```

## Ratios are integers

Every ratio in the package is an integer in **permille** — thousandths — and
every amount of money is in **minor units**.

```python
rank.percentile_permille  # 5      -> top 0.5 %
stats.win_rate_permille  # 537    -> 53.7 %
stats.kd_permille  # 1500   -> 1.5 K/D
earnings.total_usd_cents  # 12_000_000 -> $120,000.00
```

Floats do not survive a round trip through JSON, a database and back without
occasionally arriving as `0.5369999999999999`. Integers do. This matches the
TypeScript edition exactly, and the shared vectors prove it — including the
rounding, which is the part that would otherwise have gone wrong quietly:
JavaScript's `Math.round` rounds halves away from zero, while Python's `round`
is banker's rounding, so `round(62.5)` is 62 and `Math.round(62.5)` is 63. The
package uses the JavaScript rule in both editions.

## Errors you can act on

Four kinds of "no data", and they need four different messages to a user:

| Situation | Error | The user should |
|---|---|---|
| No such player | `NotFoundError` | check the spelling |
| Profile is private | `PrivateProfileError` | open it in the game |
| Title cannot do this | `UnsupportedCapabilityError` | — (fix the code) |
| No key configured | `MissingCredentialError` | — (fix the deployment) |

All of them derive from `GameStatsError`, so one `except` clause catches
everything this package raises and nothing it does not.

```python
from gamestatsfetcher import (
    GameStatsError,
    NotFoundError,
    PrivateProfileError,
    UnsupportedCapabilityError,
)

try:
    ranks = await client.valorant.get_rank(query)
except NotFoundError:
    await reply("No player by that name.")
except PrivateProfileError:
    await reply("That profile is private — open it in the game to share stats.")
except UnsupportedCapabilityError as error:
    await reply(f"Not available for this title. {error}")
except GameStatsError:
    log.exception("game stats lookup failed")
    await reply("The game's API is having a moment. Try again shortly.")
```

`MissingCredentialError` names the option and the page the key comes from, and
is raised **before** any network call:

```text
steam needs an API key. Pass it as api_keys["steam"] —
get one at https://steamcommunity.com/dev/apikey
```

That `except GameStatsError` at the bottom really is a bottom. Every one of the
fourteen methods talks to a server this package does not control, and when a
mapper meets a payload it was not written for — a schema change, a gateway's
HTML error page served with a 200, a proxy answering with whatever it likes —
the result is a `ParseError` naming the title and the call, not an
`AttributeError` from four frames inside a normaliser:

```text
valorant returned an unexpected shape: get_leaderboard received data it could
not map (AttributeError: 'list' object has no attribute 'get')
```

The original exception is chained, so the traceback still points at the line
that broke. `tests/test_hostile_payloads.py` sweeps 87 titles × 14 methods × 10
payload shapes and asserts nothing escapes.

## Finding out what a deployment can do

```python
client = GameStatsClient(api_keys={"steam": ..., "riot": ...})

for row in client.diagnostics():
    if not row.ready:
        log.warning(
            "api_keys[%r] — unlocks %d titles — %s",
            row.missing_key,
            len(row.titles),
            row.docs_url,
        )

print(f"{len(client.usable_titles())} of {client.title_count()} titles usable.")
```

Run it at startup. A missing key found at boot is a five-minute fix; the same
key found at 3am is an incident.

## Configuration

Every option is a frozen dataclass rather than a loose dict, so a typo is a
`TypeError` at construction instead of a setting that silently did nothing.

```python
from gamestatsfetcher import (
    CacheConfig,
    GameStatsClient,
    RateLimitConfig,
    RetryConfig,
)

client = GameStatsClient(
    api_keys={"riot": ..., "steam": ..., "pandascore": ...},
    cache=CacheConfig(driver="memory", default_ttl_seconds=60, max_entries=5_000),
    rate_limit=RateLimitConfig(rps=5, burst=10),
    retry=RetryConfig(attempts=2, base_delay_ms=250),
    timeout_ms=15_000,
    fallback=False,  # try the next provider when one fails
    logger="info",  # a level name, a level, a logging.Logger, or "silent"
    transport=None,  # httpx if installed, else urllib
    user_agent=None,
)
```

`rate_limit` is a *fallback*, used only for providers that declare no quota of
their own. It cannot loosen a published limit — those come from the registry.

Construct **one** and keep it. The cache, the rate limiter and the connection
pool all live on the client; building one per request throws away the warm cache
and, worse, the rate-limiter state that keeps a key from being revoked.

### Caching

In-memory by default — nothing to deploy. Point it at Redis when several
processes should share one warm cache:

```python
from gamestatsfetcher import CacheConfig, RedisConfig

client = GameStatsClient(
    cache=CacheConfig(
        driver="redis",
        key_prefix="gsf:",
        redis=RedisConfig(host="localhost", port=6379),
    ),
)
```

If `redis` is not installed, the client warns once and falls back to memory
rather than refusing to start — an optional dependency should not be able to
take a deployment down at boot. Hand in an already-connected client with
`RedisConfig(client=...)` when your app has one.

TTLs come from how fast the underlying thing actually changes, not from how
often callers ask:

| | TTL | Why |
|---|---|---|
| A finished match | 24 h | It will never change again. The biggest quota saver here. |
| Player resolution | 24 h | A PUUID is forever. |
| Rank | 60 s | A bot showing a stale rank right after a promotion is the complaint this exists to avoid. |
| Live fixtures | 30 s | They move constantly while an event is running. |

### Rate limits are conditions of use, not tuning

Buckets are **shared per provider, not per title**. Asking about CS2 and Dota 2
in the same second is two requests against one Steam quota. An upstream 429
pauses every caller for that provider, not just the one that received it — that
is the difference between being throttled and having a key revoked.

```python
client.rate_limit_snapshot()  # {"riot": {"tokens": 17.4, "rps": 20.0}, ...}
```

### Bringing your own transport

`Transport` is a `Protocol`, so anything with the right `async def request` is
accepted — an `aiohttp` session, a recording transport for tests, a proxy that
signs requests:

```python
from typing import Mapping

from gamestatsfetcher import GameStatsClient, HttpResponse, default_transport


class RecordingTransport:
    def __init__(self, inner):
        self.inner, self.calls = inner, []

    async def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: str | None,
        timeout_ms: int,
    ) -> HttpResponse:
        self.calls.append((method, url))
        return await self.inner.request(
            method, url, headers=headers, body=body, timeout_ms=timeout_ms
        )

    async def aclose(self) -> None:
        await self.inner.aclose()


client = GameStatsClient(transport=RecordingTransport(default_transport()))
```

`RequestSpec` sits one layer above this: providers describe a call with it
(query, headers, `null_on_404`, per-call timeout) and `HttpClient` turns that
into the four arguments above, after the limiter and the retry loop have had
their say.

## Two editions, one answer

The two editions do not drift, and that is enforced rather than promised.

**Coverage** — `shared/registry/` is generated by the TypeScript edition and
shipped as package data here. This edition does not re-declare 87 titles and 53
providers; it reads the same JSON. Re-declaring them in a second language would
create exactly one thing: the opportunity for them to disagree.

```bash
python scripts/sync_registry.py --check   # CI; tests/test_registry_sync.py runs it too
```

**Behaviour** — `shared/vectors/` holds generated cases for every pure function:
normalisation, identifier conversion, the provider-capability table, the
constants. Both suites replay them (`tests/test_shared_vectors.py` here,
`typescript/tests/shared-vectors.test.ts` there), so a change to a win-rate
calculation that lands in one edition fails the other's build.

That contract has already earned its keep: the first run of it found a title
with a Steam client and no registered app id, and a placeholder app id of `0`
for a game that is not on Steam at all.

## Development

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev,http]"

pytest                                    # the suite
pytest --cov                              # with the coverage gate
mypy                                      # strict, on src/
ruff check . && ruff format --check .
python scripts/sync_registry.py --check   # registry data is current
```

`mypy` runs in `strict` mode with `warn_unreachable`. `Any` appears in exactly
one place on purpose: the `raw` field, which holds whatever the upstream sent.

## API surface

| | |
|---|---|
| `GameStatsClient` | the client; one per process |
| `client.<title>` | 46 typed shortcuts — `client.lol`, `client.cs2`, `client.rocket_league` |
| `client.title(id)` | any of the 87, by id or alias |
| `TitleClient` | `resolve_player`, `get_player`, `get_player_stats`, `get_rank`, `get_match_history`, `get_match`, `get_leaderboard`, `get_metadata` |
| the esports layer | `get_esports_matches`, `get_esports_tournaments`, `get_esports_teams`, `get_esports_players`, `get_standings`, `get_earnings` |
| registry functions | `list_titles`, `get_title`, `search_titles`, `titles_by_*`, `supports`, `list_providers` |
| identity helpers | `to_steam_id64`, `parse_riot_id`, `normalise_supercell_tag`, `dash_uuid`, … |

Everything public is re-exported from the package root and listed in `__all__`.

## Examples

- [`examples/basic.py`](./examples/basic.py) — resolve, rank, history, across several titles
- [`examples/discord_bot_integration.py`](./examples/discord_bot_integration.py) — the error handling a real bot needs
- [`examples/coverage_report.py`](./examples/coverage_report.py) — what this deployment can actually answer

## Links

- [Project README](../README.md) — the design rationale, in full
- [TypeScript edition](../typescript/README.md)
- [Shared registry](../shared/registry/README.md) · [Shared vectors](../shared/vectors/README.md)
- [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md) · [Changelog](./CHANGELOG.md)

## License

MIT — see [LICENSE](./LICENSE).
