"""The registry is the contract, and this file is what makes that true.

Every title is walked, every method is called, and each one is asserted to
behave the way its registry entry says it will:

- a capability the title does not declare must raise
  :class:`UnsupportedCapabilityError`, never return an empty list;
- a capability it does declare must not raise that error.

The upstream answers 503 to everything, so a declared method fails as a
transport error rather than a contract one - which is exactly the distinction
being tested. 87 titles x 14 methods is a little over a thousand assertions, and
it is the only way to know the registry and the code have not drifted.

It mirrors ``typescript/tests/contract.test.ts`` case for case.
"""

from __future__ import annotations

import contextlib
from collections.abc import Awaitable, Callable
from typing import Any

import pytest

from conftest import MockTransport, Route, unthrottled
from conftest import test_options as client_options
from gamestatsfetcher import (
    GameStatsClient,
    LeaderboardOptions,
    MatchHistoryOptions,
    TitleClient,
    UnsupportedCapabilityError,
    list_titles,
)

#: A key for every provider, so nothing is skipped for want of a credential.
#: The composite ones carry the separator their provider expects.
ALL_KEYS = {
    "steam": "k",
    "riot": "k",
    "blizzard": "a:b",
    "bungie": "k",
    "pubg": "k",
    "clashRoyale": "k",
    "clashOfClans": "k",
    "brawlStars": "k",
    "wargaming": "k",
    "hirez": "a:b",
    "faceit": "k",
    "tracker": "k",
    "pandascore": "k",
    "abios": "a:b",
    "startgg": "k",
    "toornament": "a:b:c",
    "challonge": "k",
    "esportsEarnings": "k",
    "stratz": "k",
    "ballchasing": "k",
    "hypixel": "k",
    # Numeric: osu! wants the client id as a JSON number and refuses a
    # non-numeric one before any request is made.
    "osu": "1:b",
    "halo": "k",
    "fortnite": "k",
    "apex": "k",
    "brawlhalla": "k",
    "iracing": "a:b",
    "trackmania": "k",
    "marvelRivals": "k",
    "lichess": "k",
    "henrikdev": "k",
    "opendota": "k",
    "heroesprofile": "k",
    "guildwars2": "k",
}

#: A query carrying every identifier kind, so a title picks whichever it accepts.
PROBE = {
    "name": "probe",
    "steam_id": "76561197960287930",
    "player_tag": "#2PP",
    "battle_tag": "probe#1234",
    "puuid": "p",
    "game_name": "probe",
    "tag_line": "eu",
    "account_id": "1",
    "membership_id": "1",
    "epic_id": "e",
    "ubisoft_id": "u",
}

#: Every method on the canonical surface, with a call that exercises it.
CALLS: dict[str, Callable[[TitleClient], Awaitable[Any]]] = {
    "resolvePlayer": lambda t: t.resolve_player(dict(PROBE)),
    "getPlayer": lambda t: t.get_player({"name": "probe"}),
    "getPlayerStats": lambda t: t.get_player_stats({"name": "probe"}),
    "getRank": lambda t: t.get_rank({"name": "probe"}),
    "getMatchHistory": lambda t: t.get_match_history(
        {"name": "probe"}, MatchHistoryOptions(limit=1)
    ),
    "getMatch": lambda t: t.get_match("m1"),
    "getLeaderboard": lambda t: t.get_leaderboard(LeaderboardOptions(limit=1)),
    "getMetadata": lambda t: t.get_metadata(),
    "getEsportsMatches": lambda t: t.get_esports_matches(),
    "getEsportsTournaments": lambda t: t.get_esports_tournaments(),
    "getEsportsTeams": lambda t: t.get_esports_teams(),
    "getEsportsPlayers": lambda t: t.get_esports_players(),
    "getStandings": lambda t: t.get_standings("t1"),
    "getEarnings": lambda t: t.get_earnings("probe"),
}

ALL_CAPABILITIES = tuple(CALLS)
TITLES = list_titles()

#: Titles with a real player API and no professional circuit at all.
#:
#: The package's rule is "if it has an API it belongs here", not "if it has a
#: circuit". These four are the whole of the exception, and they are written out
#: rather than computed - a title that quietly stopped reporting tournaments
#: would otherwise join the list without anybody noticing.
NO_CIRCUIT = ("diablo-3", "eve-online", "old-school-runescape", "runescape")

TITLE_IDS = [title.id for title in TITLES]


def client() -> GameStatsClient:
    """A client whose upstream 503s everything.

    The point is which error class comes back, not the data. 503 rather than 500
    because it is the one status that reads unambiguously as "the upstream, not
    your request".
    """
    transport = MockTransport([Route(match="http", status=503, body={"e": 1})])
    # Unthrottled so a refusal is the *contract* refusing, never the rate
    # limiter answering first: LocalRateLimitError is a GameStatsError too, and
    # a sweep that met one would be asserting nothing.
    return unthrottled(GameStatsClient(**client_options(transport, api_keys=ALL_KEYS)))


async def refused_by_contract(title: TitleClient, capability: str) -> bool:
    """Whether a call was refused on contract grounds rather than any other."""
    try:
        await CALLS[capability](title)
    except UnsupportedCapabilityError:
        return True
    except Exception:
        return False
    return False


@pytest.mark.parametrize("title_id", TITLE_IDS)
def test_every_title_client_can_be_constructed(title_id: str) -> None:
    instance = client().title(title_id)
    assert instance.id == title_id


@pytest.mark.parametrize("title_id", TITLE_IDS)
def test_supports_agrees_with_the_registry(title_id: str) -> None:
    # If these two ever disagree, every other guarantee in the package is void:
    # callers branch on supports() and the methods enforce capabilities.
    instance = client().title(title_id)
    for capability in ALL_CAPABILITIES:
        assert instance.supports(capability) == (capability in instance.title.capabilities), (
            f"{title_id}.{capability}"
        )


@pytest.mark.parametrize("title_id", TITLE_IDS)
async def test_undeclared_capabilities_raise_rather_than_returning_empty(
    title_id: str,
) -> None:
    instance = client().title(title_id)
    undeclared = [
        capability
        for capability in ALL_CAPABILITIES
        if capability not in instance.title.capabilities
    ]
    for capability in undeclared:
        assert await refused_by_contract(instance, capability), (
            f"{title_id}.{capability} should have raised UnsupportedCapabilityError"
        )


@pytest.mark.parametrize("title_id", TITLE_IDS)
async def test_declared_capabilities_are_reachable(title_id: str) -> None:
    # A declared method may well fail against a dead upstream - that is a
    # transport failure, and fine. It must never fail as "this title cannot do
    # that", which would mean the registry is lying.
    instance = client().title(title_id)
    for capability in instance.title.capabilities:
        assert not await refused_by_contract(instance, capability), (
            f"{title_id}.{capability} is declared but refused itself"
        )


class TestCoverageTiers:
    """The three tiers the README promises, asserted rather than described."""

    def test_the_tier_sizes(self) -> None:
        full = [t for t in TITLES if "getMatchHistory" in t.capabilities]
        player = [
            t
            for t in TITLES
            if "resolvePlayer" in t.capabilities and "getMatchHistory" not in t.capabilities
        ]
        esports_only = [t for t in TITLES if "resolvePlayer" not in t.capabilities]

        assert len(full) == 27
        assert len(player) == 25
        assert len(esports_only) == 35
        assert len(full) + len(player) + len(esports_only) == 87

    def test_a_title_that_serves_one_match_can_list_them(self) -> None:
        # get_match takes an id, and the only place a caller gets one is
        # get_match_history. Declaring the first without the second would be a
        # method nobody can reach.
        #
        # The reverse does not hold, and should not: SC2Pulse, W3Champions,
        # HeroesProfile, Relic, Guild Wars 2 and Albion all return complete
        # match rows from their history endpoint and publish no per-match one.
        # For those, get_match would have nothing extra to fetch.
        for title in TITLES:
            if "getMatch" in title.capabilities:
                assert "getMatchHistory" in title.capabilities, title.id

    def test_the_titles_whose_history_is_already_complete(self) -> None:
        # Spelled out so a new title landing in this group is a decision rather
        # than an oversight.
        summary_only = {
            title.id
            for title in TITLES
            if "getMatchHistory" in title.capabilities and "getMatch" not in title.capabilities
        }
        assert summary_only == {
            "starcraft-2",
            "warcraft-3",
            "heroes-of-the-storm",
            "age-of-empires-2",
            "company-of-heroes-3",
            "guild-wars-2",
            "albion-online",
        }

    def test_a_title_that_resolves_players_can_do_something_with_them(self) -> None:
        for title in TITLES:
            if "resolvePlayer" in title.capabilities:
                assert {
                    "getPlayer",
                    "getPlayerStats",
                    "getRank",
                } & set(title.capabilities), title.id

    def test_every_title_has_the_esports_tier_or_is_a_stated_exception(self) -> None:
        # Four titles are here for their player API alone - RuneScape does not
        # have a professional circuit and Liquipedia does not run a portal for
        # it. Naming them keeps the guard meaningful for the other 83.
        without = sorted(
            title.id for title in TITLES if "getEsportsTournaments" not in title.capabilities
        )
        assert tuple(without) == NO_CIRCUIT

    def test_earnings_coverage_matches_the_readme(self) -> None:
        assert len([t for t in TITLES if "getEarnings" in t.capabilities]) == 77


def _domain(host: str) -> str:
    """The last two labels of a host.

    Compared at this level rather than exactly because several providers are
    regionalised: Albion serves ``gameinfo.``, ``gameinfo-ams.`` and
    ``gameinfo-sgp.albiononline.com`` from one registry entry, and all three are
    the same keyless provider.
    """
    labels = host.split(":")[0].split(".")
    return ".".join(labels[-2:]) if len(labels) >= 2 else host


def _keyless_domains() -> set[str]:
    """Domains belonging to providers that need no credential.

    Derived from the registry rather than listed by hand, so a provider added
    later is classified correctly without anybody remembering to edit a test.
    """
    from urllib.parse import urlsplit

    from gamestatsfetcher import list_providers

    return {
        _domain(urlsplit(provider.base_url).netloc)
        for provider in list_providers()
        if provider.auth == "none" or provider.optional_auth
    }


KEYLESS_DOMAINS = _keyless_domains()


class TestNoNetworkWithoutCredentials:
    def test_there_are_keyless_providers_to_check_against(self) -> None:
        # Guards the test below from passing vacuously if the derivation breaks.
        assert len(KEYLESS_DOMAINS) >= 10

    @pytest.mark.parametrize("title_id", TITLE_IDS)
    async def test_an_unconfigured_deployment_only_reaches_keyless_providers(
        self, title_id: str
    ) -> None:
        # A request sent with no key wastes a round trip to learn what the
        # registry already knows, and on several of these providers an
        # unauthenticated request still counts against an anonymous quota.
        # So every call that needs a key must fail before a socket is opened.
        from urllib.parse import urlsplit

        transport = MockTransport([Route(match="http", status=503, body={"e": 1})])
        instance = GameStatsClient(**client_options(transport, api_keys={})).title(title_id)

        for capability in ALL_CAPABILITIES:
            # Every call is expected to fail here; what is under test is what
            # went out on the wire before it did.
            with contextlib.suppress(Exception):
                await CALLS[capability](instance)

        for _, url in transport.calls:
            domain = _domain(urlsplit(url).netloc)
            assert domain in KEYLESS_DOMAINS, (
                f"{title_id} reached {domain} with no credentials configured"
            )
