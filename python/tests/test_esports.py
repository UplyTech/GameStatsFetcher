"""The esports layer.

This is the part of the package that covers all 83 titles with a circuit rather than the 52
with a player API, so it is where "one client for every esports title" is
actually true. It is also where the most sources disagree, which is why the
status vocabulary and the provider-selection rules are tested here in detail.
"""

from __future__ import annotations

import pytest

from conftest import MockTransport, Route, make_client
from conftest import test_options as client_options
from gamestatsfetcher import (
    EsportsMatchStatus,
    EsportsQueryOptions,
    GameStatsClient,
    GameStatsError,
    MissingCredentialError,
    UnsupportedCapabilityError,
    get_title,
    normalise_status,
    providers_for,
)
from gamestatsfetcher.esports import _parse_prize_currency, _parse_prize_pool

PANDASCORE_MATCH = {
    "id": 1,
    "name": "Team A vs Team B",
    "status": "running",
    "begin_at": "2026-01-01T12:00:00Z",
    "number_of_games": 3,
    "league": {"name": "ESL Pro League"},
    "serie": {"full_name": "Season 21"},
    "tournament": {"id": 9, "name": "Playoffs"},
    "opponents": [
        {"opponent": {"id": 10, "name": "Team A", "acronym": "TA"}},
        {"opponent": {"id": 11, "name": "Team B", "acronym": "TB"}},
    ],
    "results": [{"team_id": 10, "score": 2}, {"team_id": 11, "score": 1}],
    "streams_list": [{"raw_url": "https://twitch.tv/esl", "language": "en"}],
}


class TestStatusVocabulary:
    """Every provider spells status differently. There is one vocabulary here."""

    @pytest.mark.parametrize("spelling", ["running", "live", "started"])
    def test_live(self, spelling: str) -> None:
        assert normalise_status(spelling) is EsportsMatchStatus.LIVE

    @pytest.mark.parametrize("spelling", ["finished", "over", "ended", "completed"])
    def test_finished(self, spelling: str) -> None:
        assert normalise_status(spelling) is EsportsMatchStatus.FINISHED

    @pytest.mark.parametrize(
        "spelling", ["not_started", "upcoming", "scheduled", "unscheduled"]
    )
    def test_scheduled(self, spelling: str) -> None:
        assert normalise_status(spelling) is EsportsMatchStatus.SCHEDULED

    @pytest.mark.parametrize("spelling", ["canceled", "cancelled"])
    def test_both_spellings_of_cancelled(self, spelling: str) -> None:
        # One is American and one is British, and different providers use each.
        assert normalise_status(spelling) is EsportsMatchStatus.CANCELLED

    def test_postponed_is_not_cancelled(self) -> None:
        # A postponed match will be played; a cancelled one will not. Folding
        # them together would delete a fixture from somebody's calendar.
        assert normalise_status("postponed") is EsportsMatchStatus.POSTPONED

    def test_it_is_case_insensitive(self) -> None:
        assert normalise_status("RUNNING") is EsportsMatchStatus.LIVE

    def test_an_unknown_spelling_is_unknown_not_a_guess(self) -> None:
        # A new status from a provider must not silently become "finished".
        assert normalise_status("quantum") is EsportsMatchStatus.UNKNOWN
        assert normalise_status(None) is EsportsMatchStatus.UNKNOWN


class TestProviderSelection:
    def test_a_title_only_offers_providers_that_can_serve_the_capability(self) -> None:
        cs2 = get_title("cs2")
        assert "pandascore" in providers_for(cs2, "getEsportsMatches")
        assert "steam" not in providers_for(cs2, "getEsportsMatches")

    def test_a_capability_no_provider_serves_yields_nothing(self) -> None:
        assert providers_for(get_title("cs2"), "getRank") == ()

    async def test_a_provider_without_a_key_is_skipped_not_tried(self) -> None:
        # It would cost a round trip to learn what the registry already knows.
        # Liquipedia needs no key, so it is what answers here.
        routes = [Route(match="liquipedia", body={"result": []})]
        client, transport = make_client(routes, api_keys={})

        await client.title("tekken-8").get_esports_tournaments()

        assert transport.count_of("pandascore") == 0
        assert transport.count_of("start.gg") == 0
        assert transport.count_of("liquipedia") >= 1
        await client.aclose()

    async def test_a_capability_with_no_configured_provider_says_which_key(
        self,
    ) -> None:
        # The message has to distinguish "this title cannot do that" from "this
        # deployment cannot do that yet" - they are entirely different fixes.
        # tekken-8's standings come from start.gg, which needs a key.
        client, transport = make_client([], api_keys={})
        with pytest.raises(UnsupportedCapabilityError) as caught:
            await client.title("tekken-8").get_standings("some-tournament")
        message = str(caught.value)
        assert "no credential is configured" in message or "no provider" in message
        assert transport.calls == []
        await client.aclose()

    async def test_naming_a_provider_explicitly_bypasses_the_preference_order(
        self,
    ) -> None:
        # The escape hatch that makes Abios, Toornament and Challonge reachable
        # even though no title claims them.
        client, transport = make_client([], api_keys={})
        with pytest.raises(MissingCredentialError) as caught:
            await client.title("tekken-8").get_esports_tournaments(
                EsportsQueryOptions(provider="toornament")
            )
        assert caught.value.provider == "toornament"
        assert transport.calls == []
        await client.aclose()


class TestNormalisation:
    async def test_a_pandascore_match_becomes_the_canonical_shape(self) -> None:
        routes = [Route(match="api.pandascore.co", body=[PANDASCORE_MATCH])]
        client, _ = make_client(routes, api_keys={"pandascore": "k"})

        matches = await client.cs2.get_esports_matches()

        assert len(matches) == 1
        match = matches[0]
        assert match.status is EsportsMatchStatus.LIVE
        assert match.provider_id == "pandascore"
        assert match.title_id == "cs2"
        assert [o.name for o in match.opponents] == ["Team A", "Team B"]
        assert [o.score for o in match.opponents] == [2, 1]
        assert match.best_of == 3
        assert match.streams[0].url == "https://twitch.tv/esl"
        await client.aclose()

    async def test_the_raw_payload_survives(self) -> None:
        # Normalisation loses detail by definition. A caller who needs the one
        # field this package did not model must not be blocked on a release.
        routes = [Route(match="api.pandascore.co", body=[PANDASCORE_MATCH])]
        client, _ = make_client(routes, api_keys={"pandascore": "k"})

        match = (await client.cs2.get_esports_matches())[0]

        assert match.raw["league"]["name"] == "ESL Pro League"
        await client.aclose()

    async def test_an_empty_upstream_list_is_an_empty_result_not_an_error(
        self,
    ) -> None:
        # This is the case where empty is a legitimate answer: the title
        # supports the question, and the answer is "no fixtures right now".
        routes = [Route(match="api.pandascore.co", body=[])]
        client, _ = make_client(routes, api_keys={"pandascore": "k"})

        assert await client.cs2.get_esports_matches() == []
        await client.aclose()


class TestFallback:
    """Dota 2 is the case that exercises this: OpenDota first, PandaScore after."""

    async def test_without_fallback_the_first_failure_is_the_answer(self) -> None:
        # Silently switching sources changes whose terms of service apply and
        # which numbers a dashboard is comparing, so it is opt-in.
        routes = [Route(match="opendota", status=500, body={"e": 1})]
        client, transport = make_client(routes, api_keys={"pandascore": "k"}, fallback=False)
        with pytest.raises(GameStatsError):
            await client.dota2.get_esports_matches()
        assert transport.count_of("pandascore") == 0
        await client.aclose()

    async def test_with_fallback_the_next_provider_is_tried(self) -> None:
        routes = [
            Route(match="opendota", status=500, body={"e": 1}),
            Route(match="api.pandascore.co", body=[PANDASCORE_MATCH]),
        ]
        client, transport = make_client(routes, api_keys={"pandascore": "k"}, fallback=True)
        matches = await client.dota2.get_esports_matches()
        assert transport.count_of("pandascore") >= 1
        assert matches[0].provider_id == "pandascore"
        await client.aclose()

    async def test_when_everything_fails_every_failure_is_reported(self) -> None:
        # "no key" then "429" then "500" is three separate fixes, and an error
        # naming only the last would hide two of them.
        from gamestatsfetcher import AllProvidersFailedError

        routes = [
            Route(match="opendota", status=500, body={"e": 1}),
            Route(match="api.pandascore.co", status=503, body={"e": 1}),
        ]
        client, _ = make_client(routes, api_keys={"pandascore": "k"}, fallback=True)
        with pytest.raises(AllProvidersFailedError) as caught:
            await client.dota2.get_esports_matches()
        assert len(caught.value.failures) == 2
        await client.aclose()


class TestPrizeParsing:
    def test_pandascores_free_text_prize_pool(self) -> None:
        # "1000000 United States Dollar" is what actually arrives.
        assert _parse_prize_pool("1000000 United States Dollar") == 100_000_000
        assert _parse_prize_currency("1000000 United States Dollar") == "USD"

    def test_thousands_separators(self) -> None:
        assert _parse_prize_pool("1,250,000 Euro") == 125_000_000
        assert _parse_prize_currency("1,250,000 Euro") == "EUR"

    def test_something_unparseable_is_absent_not_zero(self) -> None:
        # A wrong prize pool is worse than a missing one - it gets quoted.
        assert _parse_prize_pool("undisclosed") is None
        assert _parse_prize_pool(None) is None

    def test_an_unknown_currency_is_absent_rather_than_assumed_usd(self) -> None:
        assert _parse_prize_currency("500000 Zorkmids") is None


class TestCoverageFloor:
    """The promise the README makes about the esports tier."""

    async def test_every_title_with_a_circuit_can_be_asked_for_tournaments(self) -> None:
        # The floor of the coverage table: a title with no player API always has
        # a circuit somebody publishes. The four titles that are here for their
        # player API alone are the stated exception.
        no_circuit = ("diablo-3", "eve-online", "old-school-runescape", "runescape")
        client = GameStatsClient(**client_options(MockTransport([])))
        for title in client.titles():
            if title.id in no_circuit:
                assert not client.title(title.id).supports("getEsportsTournaments"), title.id
                continue
            assert client.title(title.id).supports("getEsportsTournaments"), title.id
        await client.aclose()

    async def test_the_esports_layer_exists_on_every_title(self) -> None:
        client = GameStatsClient(**client_options(MockTransport([])))
        for title in client.titles():
            assert client.title(title.id).esports is not None
        await client.aclose()
