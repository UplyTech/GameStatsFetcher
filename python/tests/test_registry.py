"""The registry, and the invariants that make it worth trusting.

The registry is a contract: it says what every title can answer, and the client
enforces it. A registry that over-promises is worse than no registry, because a
caller reads it, believes it, and finds out in production.

So the tests here are mostly invariants over all 87 titles rather than spot
checks on a few. A new title that breaks one of them fails the suite the moment
it is added, which is the point.
"""

from __future__ import annotations

import dataclasses
from typing import Any

import pytest

from gamestatsfetcher import (
    ESPORTS_CAPABILITY_PROVIDERS,
    UnknownProviderError,
    UnknownTitleError,
    esports_providers_for,
    find_provider,
    find_title,
    get_provider,
    get_title,
    list_providers,
    list_titles,
    providers_by_kind,
    rate_limit_table,
    register_provider,
    register_title,
    search_titles,
    suggest_titles,
    supports,
    title_count,
    titles_by_capability,
    titles_by_genre,
    titles_by_platform,
    titles_by_provider,
)
from gamestatsfetcher.types import (
    ModeStats,
    PlayerRef,
    PlayerStats,
    ProviderDescriptor,
    RankInfo,
    TitleDescriptor,
)

TITLES = list_titles()
PROVIDERS = list_providers()
PROVIDER_IDS = {provider.id for provider in PROVIDERS}

#: Titles with a real player API and no professional circuit at all.
#:
#: The package's rule is "if it has an API it belongs here", not "if it has a
#: circuit". These four are the whole of the exception, and they are written out
#: rather than computed - a title that quietly stopped reporting tournaments
#: would otherwise join the list without anybody noticing.
NO_CIRCUIT = ("diablo-3", "eve-online", "old-school-runescape", "runescape")


class TestShape:
    def test_the_advertised_counts(self) -> None:
        # The README, the badges and the package description all state these.
        assert title_count() == 87
        assert len(PROVIDERS) == 53

    def test_ids_are_unique(self) -> None:
        assert len({t.id for t in TITLES}) == len(TITLES)
        assert len(PROVIDER_IDS) == len(PROVIDERS)

    def test_every_title_names_at_least_one_provider(self) -> None:
        for title in TITLES:
            assert title.providers, f"{title.id} has no provider"

    def test_every_provider_a_title_names_exists(self) -> None:
        # A typo here would produce UnknownProviderError at call time, for one
        # title, possibly months later.
        for title in TITLES:
            for provider_id in title.providers:
                assert provider_id in PROVIDER_IDS, f"{title.id} -> {provider_id}"

    def test_every_provider_is_reachable(self) -> None:
        # A provider nothing can route to is dead code that still has to be
        # maintained, rate-limited and documented.
        #
        # Three are reachable only through the explicit escape hatch,
        # ``EsportsQueryOptions(provider=...)``, and that is deliberate rather
        # than an omission: Abios is commercial, and Toornament and Challonge
        # are bracket platforms that do not know what game a bracket is for. No
        # title can honestly claim them, so a caller who has one names it.
        #
        # The list is spelled out so that a *fourth* provider left unrouted by
        # accident still fails this test.
        opt_in_only = {"abios", "toornament", "challonge"}
        routed = {p for title in TITLES for p in title.providers}
        assert PROVIDER_IDS - routed == opt_in_only

    def test_the_opt_in_providers_can_still_answer_something(self) -> None:
        # Being unrouted is only acceptable while the capability table knows
        # what they do - otherwise naming one explicitly would fail too.
        served = {
            provider_id
            for provider_ids in ESPORTS_CAPABILITY_PROVIDERS.values()
            for provider_id in provider_ids
        }
        assert {"abios", "toornament", "challonge"} <= served

    def test_every_title_declares_capabilities(self) -> None:
        for title in TITLES:
            assert title.capabilities, f"{title.id} claims nothing"

    def test_a_title_with_player_capabilities_accepts_an_identifier(self) -> None:
        # Otherwise resolve_player has nothing to work with and the title is
        # unreachable in practice while looking supported in the registry.
        player_caps = {"getPlayer", "getPlayerStats", "getRank", "getMatchHistory"}
        for title in TITLES:
            if player_caps & set(title.capabilities):
                assert title.identifiers, f"{title.id} takes no identifier"


class TestTheCoreInvariant:
    """The one that keeps the registry honest."""

    def test_no_title_promises_an_esports_capability_no_provider_can_serve(
        self,
    ) -> None:
        # This is enforced at load by reconciliation rather than by review, so
        # this test is really asserting that the reconciliation ran. Before it
        # existed, 188 title-capability pairs were over-declared.
        for title in TITLES:
            for capability in title.capabilities:
                able = esports_providers_for(title.providers, capability)
                if able is None:
                    continue  # not an esports capability
                assert able, f"{title.id} declares {capability} with no able provider"

    def test_esports_providers_for_ignores_non_esports_capabilities(self) -> None:
        # None means "not my business", which is what lets the same filter run
        # over every capability without a special case at each call site.
        assert esports_providers_for(["riot"], "getRank") is None

    def test_it_preserves_the_titles_preference_order(self) -> None:
        # Titles list providers best-first, and the esports layer tries them in
        # that order. Sorting them here would quietly change which source
        # answers.
        ordered = esports_providers_for(
            ["liquipedia", "startgg", "pandascore"], "getEsportsTournaments"
        )
        assert ordered == ("liquipedia", "startgg", "pandascore")

    def test_it_drops_providers_that_cannot_serve_the_capability(self) -> None:
        # steam and faceit have no esports fixtures; keeping them would cost a
        # wasted round trip per call to learn what the table already knows.
        assert esports_providers_for(
            ["steam", "faceit", "pandascore"], "getEsportsMatches"
        ) == ("pandascore",)

    def test_every_capability_in_the_table_names_real_providers(self) -> None:
        for capability, provider_ids in ESPORTS_CAPABILITY_PROVIDERS.items():
            assert provider_ids, f"{capability} lists no provider"
            for provider_id in provider_ids:
                assert provider_id in PROVIDER_IDS, f"{capability} -> {provider_id}"


class TestLookup:
    def test_by_id_alias_and_name(self) -> None:
        assert get_title("cs2").id == "cs2"
        assert get_title("csgo").id == "cs2"
        assert get_title("Counter-Strike 2").id == "cs2"

    def test_lookup_ignores_case_and_punctuation(self) -> None:
        # Users type "cs:go", "CS GO" and "csgo" and mean the same title.
        assert get_title("CS:GO").id == "cs2"

    def test_an_unknown_title_raises_with_suggestions(self) -> None:
        # Returning None would push the same guesswork onto every caller.
        with pytest.raises(UnknownTitleError) as caught:
            get_title("leage of legends")
        assert "league-of-legends" in str(caught.value)

    def test_find_title_returns_none_instead_of_raising(self) -> None:
        assert find_title("not-a-game") is None

    def test_provider_lookup(self) -> None:
        assert get_provider("steam").id == "steam"
        assert find_provider("nope") is None
        with pytest.raises(UnknownProviderError):
            get_provider("nope")

    def test_supports(self) -> None:
        assert supports(get_title("lol"), "getRank") is True
        assert supports(get_title("tekken-8"), "getRank") is False


class TestSearch:
    def test_exact_beats_prefix_beats_substring(self) -> None:
        assert search_titles("dota")[0].id == "dota2"

    def test_a_typo_still_finds_the_title(self) -> None:
        # A Discord autocomplete handler is the use case, and users misspell.
        assert "valorant" in [t.id for t in search_titles("valorent")]

    def test_an_empty_query_returns_a_page_rather_than_everything(self) -> None:
        assert len(search_titles("", limit=5)) == 5

    def test_nonsense_finds_nothing(self) -> None:
        # The edit-distance fallback has a ceiling on purpose; without one,
        # every query would return ten arbitrary titles.
        assert search_titles("zzzzzzzzzzqqqq") == ()

    def test_suggest_titles_is_a_short_list_of_ids(self) -> None:
        suggestions = suggest_titles("valorent")
        assert len(suggestions) <= 3
        assert all(isinstance(s, str) for s in suggestions)


class TestFilters:
    def test_by_genre(self) -> None:
        assert {t.id for t in titles_by_genre("moba")} >= {"dota2", "league-of-legends"}

    def test_by_capability(self) -> None:
        ranked = titles_by_capability("getRank")
        assert get_title("lol") in ranked
        assert get_title("tekken-8") not in ranked

    def test_by_provider(self) -> None:
        assert {t.id for t in titles_by_provider("riot")} >= {
            "league-of-legends",
            "valorant",
            "teamfight-tactics",
        }

    def test_by_platform(self) -> None:
        assert get_title("cs2") in titles_by_platform("steam")

    def test_every_title_offers_the_esports_tier_or_is_a_stated_exception(self) -> None:
        # The floor of the coverage promise: a title with no player API always
        # has a professional circuit somebody publishes. The reverse is not a
        # promise - four titles have a first-party player API and no circuit,
        # and they are named rather than tolerated.
        without = sorted(
            title.id for title in TITLES if "getEsportsTournaments" not in title.capabilities
        )
        assert tuple(without) == NO_CIRCUIT
        assert len(titles_by_capability("getEsportsTournaments")) == title_count() - len(
            NO_CIRCUIT
        )

    def test_a_filter_that_matches_nothing_returns_empty(self) -> None:
        assert titles_by_genre("interpretive-dance") == ()


class TestRateLimits:
    def test_every_provider_declares_a_bucket(self) -> None:
        table = rate_limit_table()
        for provider in PROVIDERS:
            assert provider.id in table, f"{provider.id} has no rate limit"
            assert table[provider.id].rps > 0
            assert table[provider.id].burst >= table[provider.id].rps

    def test_the_limits_that_are_terms_of_use(self) -> None:
        # These two are not tuning knobs. Exceeding them is a breach of the
        # provider's stated conditions, not merely impolite.
        table = rate_limit_table()
        assert table["esports-earnings"].rps <= 1
        assert table["liquipedia"].rps <= 0.5

    def test_a_provider_needing_a_user_agent_says_so(self) -> None:
        assert get_provider("liquipedia").requires_user_agent is True


class TestCredentials:
    def test_a_provider_needing_auth_names_its_key_and_where_to_get_it(self) -> None:
        # MissingCredentialError prints both. A provider missing either turns a
        # five-minute fix into a search through documentation.
        for provider in PROVIDERS:
            if provider.auth == "none" or provider.optional_auth:
                continue
            assert provider.key_name, f"{provider.id} needs auth but names no key"
            assert provider.docs_url.startswith("http"), provider.id

    def test_keyless_providers_name_no_key(self) -> None:
        for provider in PROVIDERS:
            if provider.auth == "none":
                assert provider.key_name is None, provider.id

    def test_providers_by_kind(self) -> None:
        first_party = providers_by_kind("first-party")
        assert {p.id for p in first_party} >= {"riot", "steam"}


@pytest.fixture
def clean_registry() -> Any:
    """Restore the registry after a test that registers something into it.

    Registration writes to module-level state, which is the right design for a
    process-wide registry and a hazard in a test suite: without this, a title
    registered here would still be there when ``test_registry_sync.py`` compares
    the loaded registry against the shipped JSON, and that suite would fail
    pointing at the wrong thing entirely.
    """
    from gamestatsfetcher import registry as module

    titles = dict(module._TITLES)
    aliases = dict(module._ALIASES)
    providers = dict(module._PROVIDERS)
    try:
        yield
    finally:
        module._TITLES.clear()
        module._TITLES.update(titles)
        module._ALIASES.clear()
        module._ALIASES.update(aliases)
        module._PROVIDERS.clear()
        module._PROVIDERS.update(providers)


def a_test_title(**overrides: Any) -> TitleDescriptor:
    fields: dict[str, Any] = {
        "id": "test-only-title",
        "name": "Test Only Title",
        "aliases": ("tot",),
        "genre": "fighting",
        "publisher": "Nobody",
        "release_year": 2026,
        "status": "active",
        "providers": ("liquipedia",),
        "capabilities": ("getEsportsTournaments",),
        "identifiers": (),
        "regions": (),
        "platforms": (),
    }
    fields.update(overrides)
    return TitleDescriptor(**fields)


def a_test_provider(**overrides: Any) -> ProviderDescriptor:
    fields: dict[str, Any] = {
        "id": "test-only-provider",
        "label": "Test Only",
        "kind": "community",
        "base_url": "https://example.invalid",
        "auth": "none",
        "key_name": None,
        "docs_url": "https://example.invalid/docs",
        "rps": 1,
        "burst": 1,
    }
    fields.update(overrides)
    return ProviderDescriptor(**fields)


@pytest.mark.usefixtures("clean_registry")
class TestRuntimeRegistration:
    def test_a_registered_title_is_reconciled_like_a_built_in(self) -> None:
        # A private title must not be able to promise what a shipped one cannot.
        # Liquipedia serves tournaments but not standings, so the declared
        # getStandings has to be dropped at registration.
        register_title(a_test_title(capabilities=("getEsportsTournaments", "getStandings")))
        registered = get_title("test-only-title")
        assert "getEsportsTournaments" in registered.capabilities
        assert "getStandings" not in registered.capabilities

    def test_a_registered_title_is_findable_by_id_alias_and_name(self) -> None:
        register_title(a_test_title())
        assert get_title("test-only-title").id == "test-only-title"
        assert get_title("tot").id == "test-only-title"
        assert get_title("Test Only Title").id == "test-only-title"

    def test_registering_over_a_built_in_is_refused(self) -> None:
        # Silently changing what an existing call returns is the worst possible
        # outcome of an extension point.
        with pytest.raises(ValueError):
            register_title(get_title("cs2"))

    def test_registering_a_provider_twice_is_refused(self) -> None:
        register_provider(a_test_provider())
        assert get_provider("test-only-provider").label == "Test Only"
        with pytest.raises(ValueError):
            register_provider(a_test_provider())

    def test_a_registered_provider_gets_a_rate_limit_bucket(self) -> None:
        # Otherwise it would fall back to the generic default and quietly ignore
        # whatever quota the operator registered it with.
        register_provider(a_test_provider(rps=3, burst=6))
        assert rate_limit_table()["test-only-provider"].rps == 3

    def test_the_registry_is_left_as_it_was_found(self) -> None:
        # Proves the fixture above actually restores, rather than the suite
        # merely happening to run in a forgiving order.
        assert find_title("test-only-title") is None
        assert find_provider("test-only-provider") is None


class TestTheAccessibilityContract:
    """The promises the README makes to anybody rendering this data.

    None of these is about the package's own output - it draws nothing. They are
    about never being the reason a caller's interface is unusable: a rank that
    exists only as a colour, a ratio that only makes sense as a bar, a missing
    value that renders as zero.

    They are asserted over every title in the registry rather than spot-checked,
    because a single client that quietly starts returning an icon id in ``tier``
    would break the promise for everybody who trusted it.
    """

    def test_every_rank_field_that_names_something_is_text(self) -> None:
        # `tier` is "Diamond 2", never a palette index and never an icon id. The
        # models are typed, so this checks the *shape* the registry implies: a
        # title with a rank capability must have somewhere textual to put it.
        for title in TITLES:
            if "getRank" not in title.capabilities:
                continue
            fields = {field.name for field in dataclasses.fields(RankInfo)}
            assert "tier" in fields and "rating" in fields, title.id

    def test_every_ratio_says_what_scale_it_is_on(self) -> None:
        # A caller announcing "62.5 percent" needs to know 625 means that. The
        # field name is where that is stated, and it is stated in every one.
        ratio_fields = [
            field.name
            for model in (PlayerStats, ModeStats, RankInfo)
            for field in dataclasses.fields(model)
            if "rate" in field.name or "percentile" in field.name or "kd" in field.name
        ]
        assert ratio_fields, "no ratio fields found - has a model been renamed?"
        for name in ratio_fields:
            assert name.endswith("_permille"), name

    def test_a_missing_number_is_none_and_never_zero(self) -> None:
        # The single most common way this data becomes a lie: an upstream that
        # reported nothing rendered as "0 %". Every numeric field on the player
        # models is Optional so a caller can tell the two apart.
        for model in (PlayerStats, ModeStats, RankInfo):
            for field in dataclasses.fields(model):
                if field.name in {"ref", "id", "label", "queue", "raw", "extra", "modes"}:
                    continue
                annotation = str(field.type)
                assert "None" in annotation, f"{model.__name__}.{field.name}"

    def test_every_result_names_the_source_that_produced_it(self) -> None:
        # So a UI can write "according to OpenDota" in text rather than encoding
        # provenance as a colour or a badge a screen reader skips.
        assert "provider_id" in {field.name for field in dataclasses.fields(PlayerRef)}
