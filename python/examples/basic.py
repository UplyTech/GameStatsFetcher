"""The five things you will actually do with this package.

Run it with a key or two set; every block skips itself when its credential is
missing, so it is useful even with none::

    STEAM_API_KEY=... RIOT_API_KEY=... python examples/basic.py

The counterpart in the TypeScript edition is ``typescript/examples/basic.ts``,
and it does the same five things in the same order.
"""

from __future__ import annotations

import asyncio
import os

from gamestatsfetcher import (
    CacheConfig,
    GameStatsClient,
    MatchHistoryOptions,
    MissingCredentialError,
    NotFoundError,
    PrivateProfileError,
    UnsupportedCapabilityError,
)


def env(name: str) -> str | None:
    """An unset variable and one set to "" are both "no key"."""
    return os.environ.get(name) or None


async def main() -> None:
    client = GameStatsClient(
        api_keys={
            key: value
            for key, value in {
                "steam": env("STEAM_API_KEY"),
                "riot": env("RIOT_API_KEY"),
                "pandascore": env("PANDASCORE_TOKEN"),
                "esportsEarnings": env("ESPORTS_EARNINGS_KEY"),
            }.items()
            if value
        },
        cache=CacheConfig(driver="memory"),
        # Name yourself: two providers require it, and the rest appreciate it.
        user_agent="GameStatsFetcher-example/1.0 (dev@example.com)",
    )

    async with client:
        await what_is_configured(client)
        await a_title_that_needs_no_key(client)
        await a_riot_lookup(client)
        await the_esports_tier(client)
        await asking_before_calling(client)


# ---------------------------------------------------------------------------
# 1. What can this deployment actually do?
# ---------------------------------------------------------------------------


async def what_is_configured(client: GameStatsClient) -> None:
    print(f"\n{client.title_count()} titles registered.")

    missing = [row for row in client.diagnostics() if not row.ready]
    if missing:
        print(f"\n{len(missing)} providers have no credential configured:")
        for row in missing[:5]:
            print(f"  {row.label:<28} api_keys[{row.missing_key!r}]  {row.docs_url}")
        if len(missing) > 5:
            print("  ...")

    usable = client.usable_titles()
    print(f"\n{len(usable)} titles are usable with what is configured.")


# ---------------------------------------------------------------------------
# 2. Dota 2 - no key at all
# ---------------------------------------------------------------------------


async def a_title_that_needs_no_key(client: GameStatsClient) -> None:
    """OpenDota is keyless, which makes this the fastest thing to try."""
    print("\n--- Dota 2 (no key needed) ---")
    try:
        # Resolve once. The ref is what every other method wants, and keeping it
        # saves the lookup call each of them would otherwise pay for.
        ref = await client.dota2.resolve_player({"steam_id": "76561198054320440"})
        print(f"  {ref.display_name or ref.id}")

        for rank in await client.dota2.get_rank(ref):
            print(f"  {rank.queue}: {rank.tier} (MMR {rank.rating})")

        history = await client.dota2.get_match_history(ref, MatchHistoryOptions(limit=3))
        for match in history:
            stats = match.player_stats
            line = f"  {match.result.value:<7} {match.mode or 'unknown mode'}"
            if stats:
                line += f"  {stats.kills}/{stats.deaths}/{stats.assists}"
            print(line)
    except NotFoundError:
        print("  that account has no public Dota 2 profile")
    except Exception as error:  # noqa: BLE001 - an example, not a service
        print(f"  skipped: {error}")


# ---------------------------------------------------------------------------
# 3. League of Legends - a key, a region, and a Riot ID
# ---------------------------------------------------------------------------


async def a_riot_lookup(client: GameStatsClient) -> None:
    print("\n--- League of Legends ---")
    try:
        # "Name#Tag" pasted into one field is understood, which is what people
        # actually type.
        ref = await client.lol.resolve_player({"name": "Hide on bush#KR1", "region": "kr"})
        for rank in await client.lol.get_rank(ref):
            print(
                f"  {rank.queue}: {rank.tier} {rank.division or ''} "
                f"- {rank.tier_points} LP ({rank.wins}W/{rank.losses}L)"
            )
    except MissingCredentialError as error:
        # Raised before any network call, and it names the option and the page.
        print(f"  skipped: {error}")
    except (NotFoundError, PrivateProfileError) as error:
        print(f"  {error}")


# ---------------------------------------------------------------------------
# 4. The esports tier, which every title has
# ---------------------------------------------------------------------------


async def the_esports_tier(client: GameStatsClient) -> None:
    """Tekken 8 has no player API at all, and still answers this."""
    print("\n--- Tekken 8 (esports only) ---")
    try:
        tournaments = await client.title("tekken-8").get_esports_tournaments()
        for tournament in tournaments[:5]:
            print(f"  {tournament.name}")
        if not tournaments:
            print("  no tournaments listed right now")
    except Exception as error:  # noqa: BLE001
        print(f"  skipped: {error}")


# ---------------------------------------------------------------------------
# 5. Asking before calling
# ---------------------------------------------------------------------------


async def asking_before_calling(client: GameStatsClient) -> None:
    """The habit that makes generic code over 83 titles possible."""
    print("\n--- capability checks ---")

    for title_id in ("cs2", "tekken-8"):
        title = client.title(title_id)
        if title.supports("getRank"):
            print(f"  {title_id}: has ranks")
        else:
            print(f"  {title_id}: no player API - esports data only")

    # And what happens if you ask anyway. Never an empty list, which would be
    # indistinguishable from a quiet week.
    try:
        await client.title("tekken-8").get_rank({"name": "Arslan Ash"})
    except UnsupportedCapabilityError as error:
        print(f"\n  {error}")


if __name__ == "__main__":
    asyncio.run(main())
