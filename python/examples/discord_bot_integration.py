"""A ``/stats <game> <player>`` command that works for every registered title.

The Discord parts are stand-ins so this file runs without discord.py, but the
shape is the real one - and the four things worth copying are:

1. **One client for the process.** It owns the cache and the rate limiters;
   constructing one per command spends every quota twice.
2. **Autocomplete from the registry**, so a user cannot pick a title the bot
   cannot serve.
3. **``supports()`` before the call**, so the reply says "Tekken 8 has no ranked
   ladder" instead of showing an empty embed.
4. **Typed errors mapped to sentences a user can act on.** "Your profile is
   private" and "that player does not exist" are different problems, and the
   error classes keep them apart.

::

    python examples/discord_bot_integration.py

The counterpart is ``typescript/examples/discord-bot-integration.ts``.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass

from gamestatsfetcher import (
    CacheConfig,
    GameStatsClient,
    LocalRateLimitError,
    MissingCredentialError,
    NotFoundError,
    PrivateProfileError,
    RankInfo,
    RateLimitError,
    RedisConfig,
    TitleDescriptor,
    UnsupportedCapabilityError,
)

# One per process. Not one per command, and not one per shard.
client = GameStatsClient(
    api_keys={
        key: value
        for key, value in {
            "steam": os.environ.get("STEAM_API_KEY"),
            "riot": os.environ.get("RIOT_API_KEY"),
            "faceit": os.environ.get("FACEIT_API_KEY"),
            "pandascore": os.environ.get("PANDASCORE_TOKEN"),
        }.items()
        if value
    },
    cache=CacheConfig(
        # Redis so every shard of the bot shares one warm cache. Without it each
        # shard would spend the same quota on the same player.
        driver="redis" if os.environ.get("REDIS_HOST") else "memory",
        redis=RedisConfig(host=os.environ.get("REDIS_HOST"), port=6379),
        key_prefix="bot:gsf:",
    ),
    user_agent="MyDiscordBot/2.1 (+https://example.com/bot)",
    logger="warning",
)


# ---------------------------------------------------------------------------
# Autocomplete
# ---------------------------------------------------------------------------


def autocomplete_titles(typed: str) -> list[dict[str, str]]:
    """Only offer titles this deployment can actually serve.

    A user picking a title whose key is not configured gets a confusing failure;
    filtering here means the option never appears.
    """
    usable = {title.id for title in client.usable_titles()}
    return [
        {"name": title.name, "value": title.id}
        for title in client.search(typed, limit=25)
        if title.id in usable
    ][:25]


# ---------------------------------------------------------------------------
# The command
# ---------------------------------------------------------------------------


@dataclass
class Embed:
    """Stand-in for whatever embed type your library uses."""

    title: str
    description: str
    fields: list[tuple[str, str]]
    footer: str


async def stats_command(title_id: str, player: str) -> Embed | str:
    """Build the reply. Returns an embed, or a sentence explaining why not."""
    title = client.try_title(title_id)
    if title is None:
        # Should be unreachable via autocomplete, but a user can always type.
        suggestions = ", ".join(t.name for t in client.search(title_id, limit=3))
        return f"I do not know a game called “{title_id}”. Did you mean: {suggestions}?"

    # Ask first. This is what turns "no data" into a useful sentence rather than
    # an empty embed the user has to interpret.
    if not title.supports("getRank"):
        return (
            f"{title.title.name} has no player API - its publisher does not "
            "offer one. I can show you the tournament schedule instead: "
            f"`/esports {title_id}`"
        )

    try:
        ref = await title.resolve_player(player)
        ranks = await title.get_rank(ref)
        return render(title.title, ref.display_name or player, ranks)

    except NotFoundError:
        return f"No {title.title.name} player called “{player}”. Check the spelling?"

    except PrivateProfileError:
        return (
            f"That {title.title.name} profile is private. Open it in the game's "
            "privacy settings and try again."
        )

    except (RateLimitError, LocalRateLimitError):
        # Upstream said stop, or our own limiter did. Same answer to the user;
        # both are temporary and neither is their fault.
        return "I am being rate limited right now. Try again in a minute."

    except MissingCredentialError as error:
        # Not the user's problem. Say something neutral to them and something
        # actionable to the operator.
        print(f"[config] {error}")
        return f"{title.title.name} is not set up on this bot yet. Sorry about that."

    except UnsupportedCapabilityError:
        # The supports() check above should prevent this; if it fires, the
        # registry and the code have disagreed and that is worth knowing.
        return "I cannot look that up for this game."


def render(title: TitleDescriptor, name: str, ranks: list[RankInfo]) -> Embed:
    if not ranks:
        # An empty list here is a real answer - the player exists and is
        # unranked - and it deserves different wording from an error.
        return Embed(
            title=f"{name} - {title.name}",
            description="Unranked, or no ranked games played this season.",
            fields=[],
            footer=f"{title.name}",
        )

    fields = []
    for rank in ranks:
        parts = [p for p in (rank.tier, rank.division) if p] or ["unranked"]
        value = " ".join(parts)
        if rank.tier_points is not None:
            value += f" - {rank.tier_points} LP"
        elif rank.rating is not None:
            value += f" - {rank.rating} MMR"
        if rank.percentile_permille is not None:
            # Permille, so 5 is the top 0.5 %.
            value += f" (top {rank.percentile_permille / 10:.1f} %)"
        if rank.wins is not None and rank.losses is not None:
            value += f"\n{rank.wins}W / {rank.losses}L"
        fields.append((rank.queue, value))

    return Embed(
        title=f"{name} - {title.name}",
        description="",
        fields=fields,
        # Say which source answered. Sources disagree, and a user comparing this
        # against a website should be able to see why.
        footer=f"via {ranks[0].ref.provider_id}",
    )


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------


async def on_ready() -> None:
    """Run this once at boot.

    A missing key found here is a five-minute fix. The same key found at 3am,
    from a user complaint, is an incident.
    """
    usable = client.usable_titles()
    print(f"[gsf] {len(usable)} of {client.title_count()} titles usable")

    for row in client.diagnostics():
        if not row.ready:
            print(
                f"[gsf] api_keys[{row.missing_key!r}] is not set - "
                f"{len(row.titles)} titles unavailable - {row.docs_url}"
            )


async def on_shutdown() -> None:
    """Close the transport and the cache connection."""
    await client.aclose()


# ---------------------------------------------------------------------------
# A tiny run, so the file is executable rather than only readable
# ---------------------------------------------------------------------------


async def main() -> None:
    await on_ready()

    print("\nautocomplete for 'cs':")
    for option in autocomplete_titles("cs")[:5]:
        print(f"  {option['name']}")

    print("\n/stats tekken-8 'Arslan Ash':")
    print(f"  {await stats_command('tekken-8', 'Arslan Ash')}")

    print("\n/stats not-a-game 'somebody':")
    print(f"  {await stats_command('not-a-game', 'somebody')}")

    await on_shutdown()


if __name__ == "__main__":
    asyncio.run(main())
