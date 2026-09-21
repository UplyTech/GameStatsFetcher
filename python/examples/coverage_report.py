"""Print what this package covers, and what a given configuration can reach.

Two uses:

* Run it with no keys to see the whole catalogue and decide which keys are worth
  obtaining.
* Run it with your real environment as a deployment check - the "usable" count
  is the one that matters, and a key found missing here is a five-minute fix
  rather than a 3am incident.

::

    python examples/coverage_report.py

Nothing here makes a network call: it all comes out of the registry, which is
generated data shipped with the package.
"""

from __future__ import annotations

import os

from gamestatsfetcher import GameStatsClient

CAPABILITIES = [
    "resolvePlayer",
    "getPlayerStats",
    "getRank",
    "getMatchHistory",
    "getMatch",
    "getLeaderboard",
    "getEsportsMatches",
    "getEsportsTournaments",
    "getEarnings",
]

PROVIDER_KINDS = ["first-party", "community", "esports-data", "tournament-platform"]


def heading(text: str) -> None:
    print(f"\n{text}\n{'-' * len(text)}\n")


def bar(value: int, total: int, width: int = 24) -> str:
    """A bar, purely as a second encoding of a number already printed beside it.

    Never the only place a value appears. Somebody reading this through a screen
    reader, or piping it into a file, or looking at it in a terminal that has
    eaten the alignment, still has the count.
    """
    filled = round(value / total * width) if total else 0
    return "#" * filled + "." * max(0, width - filled)


def main() -> None:
    client = GameStatsClient(
        api_keys={
            key: value
            for key, value in {
                "steam": os.environ.get("STEAM_API_KEY"),
                "riot": os.environ.get("RIOT_API_KEY"),
                "blizzard": os.environ.get("BLIZZARD_CLIENT"),
                "pandascore": os.environ.get("PANDASCORE_TOKEN"),
                "startgg": os.environ.get("STARTGG_TOKEN"),
                "esportsEarnings": os.environ.get("ESPORTS_EARNINGS_KEY"),
            }.items()
            if value
        }
    )

    titles = client.titles()
    providers = client.providers()
    usable = {title.id for title in client.usable_titles()}

    heading(f"{len(titles)} titles, {len(providers)} providers")
    for capability in CAPABILITIES:
        count = len(client.by_capability(capability))
        # The number before the bar on purpose: a screen reader announces
        # this line in order, and "resolvePlayer 52 of 87" is the sentence
        # somebody needs. The bar is a second, redundant encoding of a
        # number already stated, which is the only honest way to use one.
        print(f"  {capability:<24} {count:>3} of {len(titles)}  {bar(count, len(titles))}")

    heading("By genre")
    for genre in sorted({title.genre for title in titles}):
        in_genre = client.by_genre(genre)
        with_players = [t for t in in_genre if "resolvePlayer" in t.capabilities]
        print(
            f"  {genre:<18} {len(in_genre):>2} titles, "
            f"{len(with_players):>2} with a player API"
        )

    heading("What this configuration can reach")
    print(f"  {len(usable)} of {len(titles)} titles usable right now.\n")

    not_ready = [row for row in client.diagnostics() if not row.ready]
    if not not_ready:
        print("  Every provider has a credential. Nothing to do.")
    else:
        print("  Missing credentials, most valuable first:\n")
        # Ranked by how many titles the key would *newly* unlock, not by how
        # many it touches - a key for titles already covered elsewhere is not
        # the one to go and get first.
        ranked = sorted(
            not_ready,
            key=lambda row: len([t for t in row.titles if t not in usable]),
            reverse=True,
        )
        for row in ranked[:12]:
            blocked = [t for t in row.titles if t not in usable]
            if not blocked:
                continue
            option = f"api_keys[{row.missing_key!r}]"
            print(f"  {option:<28} unlocks {len(blocked):>2} more titles  {row.docs_url}")

    heading("Titles with no player API")
    esports_only = [t for t in titles if "resolvePlayer" not in t.capabilities]
    print(
        f"  {len(esports_only)} titles. Their publishers offer nothing; what exists is\n"
        "  the professional circuit, and that is what this package serves for them.\n"
    )
    for title in esports_only[:12]:
        print(f"  {title.name:<36} {', '.join(title.providers)}")
    if len(esports_only) > 12:
        print(f"  ... and {len(esports_only) - 12} more")

    heading("Providers by who runs them")
    for kind in PROVIDER_KINDS:
        group = [p for p in providers if p.kind == kind]
        print(f"\n  {kind} ({len(group)})")
        for provider in group:
            keyless = provider.auth == "none" or provider.optional_auth
            need = "no key needed" if keyless else f"api_keys[{provider.key_name!r}]"
            print(f"    {provider.label:<32} {need}")

    heading("Rate limits worth knowing about")
    # Two of these are conditions of use rather than tuning, and exceeding them
    # is a breach of the provider's stated terms.
    for provider in sorted(providers, key=lambda p: p.rps)[:6]:
        note = f"  - {provider.notes}" if provider.notes else ""
        # `g` rather than the default: the registry stores 1 and 0.16, and the
        # default float repr would print "1.0" here while the TypeScript
        # edition prints "1" for the same registry entry.
        print(f"  {provider.label:<32} {provider.rps:>5g} req/s{note}")


if __name__ == "__main__":
    main()
