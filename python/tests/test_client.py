"""The client: construction, lookup, diagnostics and lifecycle.

Nothing here talks to a network. The transport is injected, so a test that
reaches the wire is a test with a bug in it.
"""

from __future__ import annotations

import logging

import pytest

from conftest import MockTransport, Route, make_client
from conftest import test_options as client_options
from gamestatsfetcher import (
    CacheConfig,
    GameStatsClient,
    MissingCredentialError,
    RateLimitConfig,
    TitleClient,
    UnknownTitleError,
    UnsupportedCapabilityError,
    ValidationError,
    as_query,
)
from gamestatsfetcher.types import PlayerQuery


def offline(**overrides: object) -> GameStatsClient:
    return GameStatsClient(**client_options(MockTransport([]), **overrides))


class TestConstruction:
    def test_a_client_with_no_configuration_at_all(self) -> None:
        # Several titles are keyless, so this has to work rather than raise.
        client = GameStatsClient()
        assert client.title_count() == 87

    def test_api_keys_are_copied_not_referenced(self) -> None:
        # A caller mutating their own dict afterwards must not silently change
        # what this client authenticates with.
        keys = {"riot": "abc"}
        client = offline(api_keys=keys)
        keys["riot"] = "changed"
        assert client.runtime.api_keys["riot"] == "abc"

    def test_the_fallback_rate_limit_does_not_loosen_a_published_one(self) -> None:
        # Providers declare their own quota from published terms. A caller
        # asking for 1000 rps must not be able to override Liquipedia's.
        client = offline(rate_limit=RateLimitConfig(rps=1_000, burst=1_000))
        assert client.runtime.limiter.available_in("liquipedia") == 0
        client.runtime.limiter.try_acquire("liquipedia")
        assert client.runtime.limiter.available_in("liquipedia") > 0

    def test_a_logger_instance_is_used_as_given(self) -> None:
        logger = logging.getLogger("test.gsf")
        assert offline(logger=logger).runtime.logger is logger

    def test_the_default_logger_is_silent(self) -> None:
        # A library that logs by default writes into somebody else's log format
        # uninvited.
        assert offline().runtime.logger.level > logging.CRITICAL


class TestTitleLookup:
    def test_by_id_alias_and_shortcut_are_the_same_title(self) -> None:
        client = offline()
        assert client.title("cs2").id == "cs2"
        assert client.title("csgo").id == "cs2"
        assert client.cs2.id == "cs2"

    def test_the_shortcut_returns_the_dedicated_client(self) -> None:
        client = offline()
        assert type(client.cs2).__name__ == "CS2Client"

    def test_a_title_without_a_dedicated_client_still_works(self) -> None:
        # Tekken 8 has no player API, but it has a full esports surface served
        # by the generic client. That is not a stub.
        client = offline()
        tekken = client.title("tekken-8")
        assert type(tekken) is TitleClient
        assert tekken.supports("getEsportsTournaments")

    def test_an_unknown_title_raises_with_suggestions(self) -> None:
        with pytest.raises(UnknownTitleError) as caught:
            offline().title("rocket leage")
        assert "rocket-league" in str(caught.value)

    def test_try_title_returns_none_instead(self) -> None:
        assert offline().try_title("not-a-game") is None

    def test_title_clients_are_reused(self) -> None:
        # They hold no per-call state, and rebuilding one per call would throw
        # away nothing but would still be waste on a hot path.
        client = offline()
        assert client.title("cs2") is client.title("cs2")


class TestCapabilityEnforcement:
    def test_supports_reads_the_registry(self) -> None:
        client = offline()
        assert client.title("lol").supports("getRank") is True
        assert client.title("tekken-8").supports("getRank") is False

    async def test_an_unsupported_method_raises_before_any_request(self) -> None:
        # The design decision the package is built on. An empty list here would
        # be indistinguishable from a quiet week.
        client, transport = make_client([])
        with pytest.raises(UnsupportedCapabilityError) as caught:
            await client.title("tekken-8").get_rank({"name": "Arslan Ash"})
        assert transport.calls == []
        assert "getEsportsTournaments" in str(caught.value)

    async def test_a_missing_key_raises_before_any_request_too(self) -> None:
        # And names the option and the page, which is what somebody debugging a
        # deployment needs.
        client, transport = make_client([], api_keys={})
        with pytest.raises(MissingCredentialError) as caught:
            await client.valorant.get_rank({"name": "Player#EUW"})
        assert transport.calls == []
        assert "api_keys.riot" in str(caught.value)


class TestQueries:
    def test_a_string_is_read_as_a_name(self) -> None:
        # `client.cs2.get_rank("gaben")` is what people try first.
        assert as_query("gaben").name == "gaben"

    def test_a_dict_becomes_a_query(self) -> None:
        query = as_query({"steam_id": "76561197960287930", "region": "eu"})
        assert query.steam_id == "76561197960287930"
        assert query.region == "eu"

    def test_a_query_passes_through_unchanged(self) -> None:
        query = PlayerQuery(name="x")
        assert as_query(query) is query

    def test_an_unknown_field_is_rejected_rather_than_ignored(self) -> None:
        # A silently dropped "steamid" (no underscore) would look like the
        # caller supplied no identifier at all, three layers away from the typo.
        with pytest.raises(ValidationError) as caught:
            as_query({"steamid": "76561197960287930"})
        assert "steamid" in str(caught.value)


class TestDiagnostics:
    def test_a_provider_with_no_key_reports_what_is_missing(self) -> None:
        rows = {row.id: row for row in offline(api_keys={}).diagnostics()}
        assert rows["riot"].ready is False
        assert rows["riot"].missing_key == "riot"
        assert rows["riot"].docs_url.startswith("http")

    def test_a_configured_provider_is_ready(self) -> None:
        rows = {row.id: row for row in offline(api_keys={"riot": "k"}).diagnostics()}
        assert rows["riot"].ready is True
        assert rows["riot"].missing_key is None

    def test_a_keyless_provider_is_ready_without_configuration(self) -> None:
        rows = {row.id: row for row in offline(api_keys={}).diagnostics()}
        assert rows["liquipedia"].ready is True

    def test_a_provider_whose_key_only_raises_the_quota_is_ready(self) -> None:
        # Reporting OpenDota as broken because nobody signed up for an optional
        # key would bury the rows that actually need attention.
        rows = {row.id: row for row in offline(api_keys={}).diagnostics()}
        assert rows["opendota"].ready is True
        assert rows["opendota"].missing_key is None

    def test_every_row_names_the_titles_it_unlocks(self) -> None:
        # "unlocks 12 titles" is what makes a missing-key warning actionable.
        for row in offline().diagnostics():
            if row.id in {"abios", "toornament", "challonge"}:
                continue  # opt-in only, claimed by no title
            assert row.titles, row.id

    def test_an_empty_string_key_is_not_a_key(self) -> None:
        # `api_keys={"riot": os.environ.get("RIOT_KEY", "")}` is a very common
        # shape, and treating "" as configured turns a boot-time warning into a
        # 401 at request time.
        rows = {row.id: row for row in offline(api_keys={"riot": ""}).diagnostics()}
        assert rows["riot"].ready is False


class TestUsableTitles:
    def test_no_keys_does_not_mean_every_title(self) -> None:
        # Every title lists Liquipedia, which needs no key, so a loose test
        # would report 87 of 87 usable with nothing configured - technically
        # true and useless as a deployment check.
        client = offline(api_keys={})
        assert 0 < len(client.usable_titles()) < client.title_count()

    def test_keys_widen_it(self) -> None:
        without = len(offline(api_keys={}).usable_titles())
        with_keys = len(
            offline(api_keys={"steam": "k", "riot": "k", "pandascore": "k"}).usable_titles()
        )
        assert with_keys > without

    def test_a_title_with_no_player_api_counts_on_its_esports_providers(self) -> None:
        client = offline(api_keys={})
        assert client.title("tekken-8").title in client.usable_titles()

    def test_a_title_with_a_player_api_needs_a_player_provider(self) -> None:
        # CS2 without a Steam or FACEIT key is not usable for what CS2 is for,
        # even though its Liquipedia entry answers tournament questions.
        client = offline(api_keys={})
        assert client.title("cs2").title not in client.usable_titles()


class TestRegistryPassThrough:
    def test_the_filters_reach_the_registry(self) -> None:
        client = offline()
        assert len(client.titles()) == client.title_count() == 87
        assert len(client.providers()) == 53
        assert client.search("dota")[0].id == "dota2"
        assert {t.id for t in client.by_genre("moba")} >= {"dota2"}
        assert client.title("lol").title in client.by_capability("getRank")
        assert {t.id for t in client.by_provider("riot")} >= {"valorant"}

    def test_dedicated_titles_is_the_bespoke_client_list(self) -> None:
        client = offline()
        dedicated = set(client.dedicated_titles())
        assert "cs2" in dedicated
        assert "tekken-8" not in dedicated
        assert len(dedicated) == 54

    def test_raw_exposes_the_provider_factories(self) -> None:
        # The escape hatch for endpoints the canonical model does not model.
        assert callable(offline().raw.opendota)


class TestLifecycle:
    async def test_the_context_manager_closes_the_transport(self) -> None:
        transport = MockTransport([])
        async with GameStatsClient(**client_options(transport)):
            pass
        assert transport.closed is True

    async def test_closing_twice_is_safe(self) -> None:
        # A process that forgets aclose() keeps a socket open until it exits, so
        # callers are encouraged to call it - including twice.
        client, _ = make_client([])
        await client.aclose()
        await client.aclose()

    async def test_clear_cache_empties_it(self) -> None:
        client = GameStatsClient(
            **client_options(MockTransport([]), cache=CacheConfig(driver="memory"))
        )
        await client.runtime.cache.set("k", "v", 60)
        await client.clear_cache()
        assert await client.runtime.cache.get("k") is None
        await client.aclose()

    def test_the_rate_limit_snapshot_is_readable(self) -> None:
        client = offline()
        client.runtime.limiter.try_acquire("steam")
        assert "steam" in client.rate_limit_snapshot()


class TestCaching:
    async def test_a_repeated_call_is_served_from_the_cache(self) -> None:
        # OpenDota needs no key, which makes it the honest end-to-end case.
        routes = [
            Route(match="/players/22202", body={"profile": {"personaname": "gaben"}}),
        ]
        client = GameStatsClient(
            **client_options(MockTransport(routes), cache=CacheConfig(driver="memory"))
        )
        transport: MockTransport = client.runtime.transport  # type: ignore[assignment]

        await client.dota2.get_player({"steam_id": "76561197960287930"})
        first = len(transport.calls)
        await client.dota2.get_player({"steam_id": "76561197960287930"})

        assert len(transport.calls) == first, "the second call should have been cached"
        await client.aclose()

    async def test_the_null_cache_does_not_cache(self) -> None:
        routes = [
            Route(match="/players/22202", body={"profile": {"personaname": "gaben"}}),
        ]
        client, transport = make_client(routes)  # cache driver "none"

        await client.dota2.get_player({"steam_id": "76561197960287930"})
        first = len(transport.calls)
        await client.dota2.get_player({"steam_id": "76561197960287930"})

        assert len(transport.calls) > first
        await client.aclose()


class TestTitleShortcuts:
    """The 46 named properties on the client.

    Each is one line - `return self.title("cs2")` - and each one is a chance to
    paste the wrong title id. `client.wow` returning the Warcraft III client
    would type-check, run, and be wrong in a way nobody would look for.

    So every shortcut is walked and asserted against the registry entry it
    claims, and the count is asserted too, so a new one added without a test is
    still covered here.
    """

    #: property name -> the title id it must resolve to.
    SHORTCUTS = {
        "cs2": "cs2",
        "dota2": "dota2",
        "tf2": "team-fortress-2",
        "deadlock": "deadlock",
        "lol": "league-of-legends",
        "tft": "teamfight-tactics",
        "valorant": "valorant",
        "runeterra": "legends-of-runeterra",
        "overwatch": "overwatch-2",
        "starcraft2": "starcraft-2",
        "warcraft3": "warcraft-3",
        "hots": "heroes-of-the-storm",
        "wow": "world-of-warcraft",
        "hearthstone": "hearthstone",
        "apex": "apex-legends",
        "fortnite": "fortnite",
        "pubg": "pubg",
        "rainbow_six": "rainbow-six-siege",
        "call_of_duty": "call-of-duty",
        "battlefield": "battlefield",
        "splitgate": "splitgate",
        "halo": "halo-infinite",
        "destiny2": "destiny-2",
        "the_finals": "the-finals",
        "marvel_rivals": "marvel-rivals",
        "rocket_league": "rocket-league",
        "clash_royale": "clash-royale",
        "clash_of_clans": "clash-of-clans",
        "brawl_stars": "brawl-stars",
        "smite": "smite",
        "paladins": "paladins",
        "aoe2": "age-of-empires-2",
        "aoe4": "age-of-empires-4",
        "coh3": "company-of-heroes-3",
        "osu": "osu",
        "beat_saber": "beat-saber",
        "chess": "chess",
        "minecraft": "minecraft",
        "brawlhalla": "brawlhalla",
        "iracing": "iracing",
        "trackmania": "trackmania",
        "guild_wars_2": "guild-wars-2",
        "path_of_exile": "path-of-exile",
        "albion": "albion-online",
        "world_of_tanks": "world-of-tanks",
        "world_of_warships": "world-of-warships",
    }

    @pytest.mark.parametrize(("attribute", "title_id"), sorted(SHORTCUTS.items()))
    def test_a_shortcut_resolves_to_the_title_it_names(
        self, attribute: str, title_id: str
    ) -> None:
        client = offline()
        assert getattr(client, attribute).id == title_id

    @pytest.mark.parametrize("attribute", sorted(SHORTCUTS))
    def test_a_shortcut_returns_the_same_object_as_title(self, attribute: str) -> None:
        # Two objects would mean two of anything a client ever caches per title.
        client = offline()
        assert getattr(client, attribute) is client.title(self.SHORTCUTS[attribute])

    def test_every_shortcut_on_the_client_is_listed_here(self) -> None:
        # Otherwise a shortcut added later is untested and unnoticed.
        declared = {
            name
            for name in dir(GameStatsClient)
            if isinstance(getattr(GameStatsClient, name, None), property)
            and name not in {"raw"}
        }
        assert declared == set(self.SHORTCUTS)
