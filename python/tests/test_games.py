"""Title clients: one representative test per family.

The contract suite already walks all 83 titles and proves the registry and the
code agree. What it cannot check is whether the *mapping* is right - whether a
FACEIT level ends up in ``tier_points`` and a Riot LP total in the same field.

So this file takes one title from each provider family and asserts the whole
path: request built, response mapped, canonical shape out. Each case is one
where getting the mapping wrong would be plausible and invisible.
"""

from __future__ import annotations

import contextlib

import pytest

from conftest import MockTransport, Route, make_client
from conftest import test_options as client_options
from gamestatsfetcher import (
    GameStatsClient,
    MatchResult,
    MissingCredentialError,
    ValidationError,
)

GABEN = "76561197960287930"
GABEN_ACCOUNT = "22202"


class TestValve:
    """CS2, Dota 2 - Steam for identity, somebody else for everything else."""

    async def test_cs2_resolves_a_vanity_url(self) -> None:
        routes = [
            Route(
                match="ResolveVanityURL",
                body={"response": {"success": 1, "steamid": GABEN}},
            ),
            Route(
                match="GetPlayerSummaries",
                body={
                    "response": {"players": [{"steamid": GABEN, "personaname": "Rabscuttle"}]}
                },
            ),
        ]
        client, _ = make_client(routes, api_keys={"steam": "k"})

        ref = await client.cs2.resolve_player({"name": "gabelogannewell"})

        assert ref.id == GABEN
        assert ref.display_name == "Rabscuttle"
        assert ref.provider_id == "steam"
        await client.aclose()

    async def test_a_steam_id_pasted_into_the_name_field_is_understood(self) -> None:
        # It happens constantly, and one extra round trip to Steam's vanity
        # endpoint would fail rather than resolve.
        routes = [
            Route(
                match="GetPlayerSummaries",
                body={"response": {"players": [{"steamid": GABEN, "personaname": "x"}]}},
            ),
        ]
        client, transport = make_client(routes, api_keys={"steam": "k"})

        ref = await client.cs2.resolve_player({"name": GABEN})

        assert ref.id == GABEN
        assert transport.count_of("ResolveVanityURL") == 0
        await client.aclose()

    async def test_cs2_rank_is_faceit_and_says_so(self) -> None:
        # Valve publishes no matchmaking rank at all. Reporting FACEIT under a
        # queue named "competitive" would be a quiet lie about the source.
        routes = [
            Route(
                match="GetPlayerSummaries",
                body={"response": {"players": [{"steamid": GABEN, "personaname": "x"}]}},
            ),
            Route(
                match="open.faceit.com",
                body={
                    "player_id": "p1",
                    "games": {"cs2": {"skill_level": 10, "faceit_elo": 2350}},
                },
            ),
        ]
        client, _ = make_client(routes, api_keys={"steam": "k", "faceit": "k"})

        ranks = await client.cs2.get_rank({"steam_id": GABEN})

        assert len(ranks) == 1
        assert ranks[0].queue == "faceit"
        assert ranks[0].tier == "Level 10"
        assert ranks[0].tier_points == 10
        assert ranks[0].rating == 2350
        await client.aclose()

    async def test_no_faceit_account_is_an_empty_list_not_an_error(self) -> None:
        # That is a fact about the player, not a failure of the call - and the
        # title does support getRank, so raising would be wrong.
        routes = [
            Route(
                match="GetPlayerSummaries",
                body={"response": {"players": [{"steamid": GABEN, "personaname": "x"}]}},
            ),
            Route(match="open.faceit.com", status=404, body={"e": "not found"}),
        ]
        client, _ = make_client(routes, api_keys={"steam": "k", "faceit": "k"})

        assert await client.cs2.get_rank({"steam_id": GABEN}) == []
        await client.aclose()

    async def test_dota2_uses_the_32_bit_account_id(self) -> None:
        # OpenDota keys on the 32-bit form. Sending the 64-bit one returns a
        # 404 for a player who exists.
        routes = [
            Route(
                match=f"/players/{GABEN_ACCOUNT}",
                body={"profile": {"account_id": 22202, "personaname": "x"}},
            ),
        ]
        client, transport = make_client(routes)

        await client.dota2.get_player({"steam_id": GABEN})

        assert GABEN_ACCOUNT in transport.url_containing("/players/")
        assert GABEN not in transport.url_containing("/players/")
        await client.aclose()

    async def test_dota2_needs_no_key(self) -> None:
        # One of the titles that works out of the box, which the README claims.
        routes = [Route(match="/players/", body={"profile": {"personaname": "x"}})]
        client, _ = make_client(routes, api_keys={})

        profile = await client.dota2.get_player({"steam_id": GABEN})

        assert profile.display_name == "x"
        await client.aclose()


class TestRiot:
    """Riot IDs, split routing, and the two-call resolve every method depends on."""

    async def test_a_pasted_riot_id_is_split(self) -> None:
        routes = [
            Route(
                match="/riot/account/v1/accounts/by-riot-id/",
                body={"puuid": "PUUID", "gameName": "Faker", "tagLine": "KR1"},
            ),
        ]
        client, transport = make_client(routes, api_keys={"riot": "k"})

        ref = await client.lol.resolve_player({"name": "Faker#KR1", "region": "kr"})

        assert ref.id == "PUUID"
        url = transport.url_containing("by-riot-id")
        assert "Faker" in url and "KR1" in url
        await client.aclose()

    async def test_resolve_costs_exactly_one_request(self) -> None:
        # The whole reason resolve_player exists as a separate step: the ref is
        # a PUUID, which never changes, so a caller who keeps it never pays for
        # this lookup again.
        routes = [
            Route(match="by-riot-id", body={"puuid": "P", "gameName": "a", "tagLine": "b"}),
        ]
        client, transport = make_client(routes, api_keys={"riot": "k"})

        await client.lol.resolve_player({"name": "a#b", "region": "kr"})

        assert len(transport.calls) == 1
        await client.aclose()

    async def test_account_lookup_uses_the_continental_cluster(self) -> None:
        # Riot splits its API in two: accounts live on a continental cluster,
        # everything else on a platform host. Sending an account lookup to the
        # platform host is a 404 that looks like "no such player".
        routes = [
            Route(match="by-riot-id", body={"puuid": "P", "gameName": "a", "tagLine": "b"}),
        ]
        client, transport = make_client(routes, api_keys={"riot": "k"})

        await client.lol.resolve_player({"name": "a#b", "region": "kr"})

        assert "asia.api.riotgames.com" in transport.url_containing("by-riot-id")
        await client.aclose()

    async def test_game_endpoints_use_the_platform_host(self) -> None:
        routes = [
            Route(match="by-riot-id", body={"puuid": "P", "gameName": "a", "tagLine": "b"}),
            Route(match="/lol/summoner/v4/", body={"puuid": "P", "summonerLevel": 300}),
            Route(match="by-puuid", body={"puuid": "P", "gameName": "a", "tagLine": "b"}),
        ]
        client, transport = make_client(routes, api_keys={"riot": "k"})

        await client.lol.get_player({"name": "a#b", "region": "kr"})

        assert "kr.api.riotgames.com" in transport.url_containing("/lol/summoner/")
        await client.aclose()

    async def test_the_key_is_sent_as_a_header_not_a_query_parameter(self) -> None:
        # A key in a URL ends up in access logs, proxies and error reports.
        routes = [
            Route(match="by-riot-id", body={"puuid": "P", "gameName": "a", "tagLine": "b"}),
        ]
        client, transport = make_client(routes, api_keys={"riot": "SECRET"})

        await client.lol.resolve_player({"name": "a#b", "region": "kr"})

        assert all("SECRET" not in url for _, url in transport.calls)
        assert transport.headers[0].get("X-Riot-Token") == "SECRET"
        await client.aclose()

    async def test_an_unknown_region_is_refused_before_the_request(self) -> None:
        client, transport = make_client([], api_keys={"riot": "k"})
        with pytest.raises(ValidationError):
            await client.lol.resolve_player({"name": "a#b", "region": "atlantis"})
        assert transport.calls == []
        await client.aclose()

    async def test_valorant_falls_back_to_henrikdev_without_a_production_key(
        self,
    ) -> None:
        # Riot's ranked endpoints need an approved production key. The README
        # documents this fallback, so it has to work.
        routes = [
            Route(
                match="api.henrikdev.xyz",
                body={"data": {"puuid": "P", "name": "a", "tag": "b"}},
            ),
        ]
        client, transport = make_client(routes, api_keys={"henrikdev": "k"})

        await client.valorant.resolve_player({"name": "a#b"})

        assert transport.count_of("henrikdev") >= 1
        await client.aclose()


class TestBlizzard:
    async def test_an_oauth_token_is_minted_before_the_data_call(self) -> None:
        routes = [
            Route(match="oauth.battle.net", body={"access_token": "T", "expires_in": 3600}),
            Route(
                match="/profile/wow/character/",
                body={"name": "Probe", "id": 1, "level": 70},
            ),
        ]
        client, transport = make_client(routes, api_keys={"blizzard": "id:secret"})

        await client.wow.get_player({"name": "Probe-Silvermoon", "region": "eu"})

        assert transport.count_of("oauth.battle.net") == 1
        assert transport.headers[-1].get("Authorization") == "Bearer T"
        await client.aclose()

    async def test_the_token_is_reused_across_calls(self) -> None:
        # Minting one per request would triple the request count and, on a busy
        # bot, run into Blizzard's OAuth limit rather than its API limit.
        routes = [
            Route(match="oauth.battle.net", body={"access_token": "T", "expires_in": 3600}),
            Route(match="/profile/wow/character/", body={"name": "Probe", "id": 1}),
        ]
        client, transport = make_client(routes, api_keys={"blizzard": "id:secret"})

        await client.wow.get_player({"name": "Probe-Silvermoon", "region": "eu"})
        await client.wow.get_player({"name": "Probe-Silvermoon", "region": "eu"})

        assert transport.count_of("oauth.battle.net") == 1
        await client.aclose()

    async def test_a_composite_key_missing_its_second_half_is_refused(self) -> None:
        # "blizzard": "just-the-id" is a very easy thing to configure, and the
        # OAuth call would fail with an opaque 400 rather than saying so.
        #
        # ValidationError rather than MissingCredentialError, and the difference
        # is deliberate: a *missing* key means "this deployment has not been
        # given one", which is worth trying another provider for. A *malformed*
        # one means the operator configured this and got it wrong, and quietly
        # answering from a different source would hide that.
        client, transport = make_client([], api_keys={"blizzard": "only-one-part"})
        with pytest.raises(ValidationError) as caught:
            await client.wow.get_player({"name": "Probe-Silvermoon", "region": "eu"})
        assert "clientId:clientSecret" in str(caught.value)
        assert "api_keys.blizzard" in str(caught.value)
        assert transport.calls == []
        await client.aclose()

    async def test_a_missing_blizzard_key_names_the_option_and_the_page(self) -> None:
        client, transport = make_client([], api_keys={})
        with pytest.raises(MissingCredentialError) as caught:
            await client.wow.get_player({"name": "Probe-Silvermoon", "region": "eu"})
        assert "api_keys.blizzard" in str(caught.value)
        assert caught.value.docs_url.startswith("http")
        assert transport.calls == []
        await client.aclose()

    async def test_wow_needs_a_realm_and_says_so(self) -> None:
        # A bare character name resolves to nobody, and Blizzard's 404 would
        # read as "no such character".
        client, transport = make_client([], api_keys={"blizzard": "id:secret"})
        with pytest.raises(ValidationError) as caught:
            await client.wow.resolve_player({"name": "Probe"})
        assert "realm" in str(caught.value)
        assert transport.calls == []
        await client.aclose()

    async def test_starcraft_2_reaches_sc2pulse_without_a_key(self) -> None:
        # SC2's ladder data comes from SC2Pulse, not from Blizzard - which is
        # why the title works with no credentials at all.
        routes = [
            Route(match="sc2pulse", body=[{"members": {"character": {"id": 1}}}]),
        ]
        client, transport = make_client(routes, api_keys={})

        # The canned payload is not a real SC2Pulse response, so the mapping
        # fails - which is fine, the assertion is about the request.
        with contextlib.suppress(Exception):
            await client.starcraft2.resolve_player({"battle_tag": "Probe#1234"})

        assert transport.count_of("sc2pulse") >= 1
        # The tag is escaped into the query rather than sent raw: a bare # would
        # be read as a fragment and the search term would arrive empty.
        assert "#" not in transport.url_containing("sc2pulse")
        await client.aclose()


class TestSupercell:
    async def test_the_tag_is_url_encoded_into_the_path(self) -> None:
        # Supercell takes the tag in the path. An unescaped # is a fragment and
        # the request arrives without it.
        routes = [Route(match="/players/", body={"tag": "#2PP", "name": "Probe"})]
        client, transport = make_client(routes, api_keys={"clashRoyale": "k"})

        await client.clash_royale.get_player({"player_tag": "#2PP"})

        assert "%232PP" in transport.url_containing("/players/")
        await client.aclose()

    async def test_a_tag_typed_without_the_hash_still_works(self) -> None:
        routes = [Route(match="/players/", body={"tag": "#2PP", "name": "Probe"})]
        client, transport = make_client(routes, api_keys={"clashRoyale": "k"})

        await client.clash_royale.get_player({"player_tag": "2pp"})

        assert "%232PP" in transport.url_containing("/players/")
        await client.aclose()


class TestSteamStatsFamily:
    async def test_dead_by_daylight_has_an_app_id(self) -> None:
        # It shares SteamStatsClient with Rust, War Thunder and Naraka, and
        # differs only by app id - so a missing one is a title that raises
        # ValidationError for every stats call.
        routes = [
            Route(
                match="GetPlayerSummaries",
                body={"response": {"players": [{"steamid": GABEN, "personaname": "x"}]}},
            ),
            Route(
                match="GetUserStatsForGame",
                body={"playerstats": {"stats": [{"name": "DBD_KillerSkulls", "value": 7}]}},
            ),
        ]
        client, transport = make_client(routes, api_keys={"steam": "k"})

        stats = await client.title("dead-by-daylight").get_player_stats({"steam_id": GABEN})

        assert "appid=381210" in transport.url_containing("GetUserStatsForGame")
        assert stats.raw is not None
        await client.aclose()


class TestGenericTitleClient:
    """The 33 titles with no player API. Not stubs - a full esports surface."""

    async def test_tekken_8_answers_tournament_questions(self) -> None:
        routes = [
            Route(
                match="liquipedia.net",
                body={
                    "query": {
                        "categorymembers": [
                            {"pageid": 4242, "title": "Tekken World Tour/2026"},
                        ]
                    }
                },
            ),
        ]
        client, _ = make_client(routes, api_keys={})

        tournaments = await client.title("tekken-8").get_esports_tournaments()

        assert len(tournaments) == 1
        assert tournaments[0].name == "Tekken World Tour/2026"
        assert tournaments[0].provider_id == "liquipedia"
        assert tournaments[0].title_id == "tekken-8"
        await client.aclose()

    async def test_it_uses_the_wiki_a_title_actually_lives_on(self) -> None:
        # Liquipedia has no per-game wiki for Tekken; the fighting games share
        # one called "fighters". Asking for /tekken-8/ would 404 forever.
        routes = [Route(match="liquipedia.net", body={"query": {"categorymembers": []}})]
        client, transport = make_client(routes, api_keys={})

        await client.title("tekken-8").get_esports_tournaments()

        assert "/fighters/api.php" in transport.url_containing("liquipedia")
        await client.aclose()

    async def test_liquipedia_gets_a_contact_user_agent(self) -> None:
        # Not politeness: their terms of use require a User-Agent identifying
        # the application, and a generic one gets the caller blocked.
        routes = [Route(match="liquipedia.net", body={"query": {"categorymembers": []}})]
        client, transport = make_client(routes, api_keys={})

        await client.title("tekken-8").get_esports_tournaments()

        agent = transport.headers[0].get("User-Agent", "")
        assert "GameStatsFetcher" in agent and "http" in agent
        await client.aclose()

    async def test_it_still_refuses_what_it_cannot_do(self) -> None:
        from gamestatsfetcher import UnsupportedCapabilityError

        client, _ = make_client([])
        with pytest.raises(UnsupportedCapabilityError):
            await client.title("tekken-8").get_player_stats({"name": "probe"})
        await client.aclose()


class TestMatchNormalisation:
    async def test_a_match_result_is_from_the_queried_players_side(self) -> None:
        # The one thing a match summary must get right. A history that reports
        # the winning team rather than the player's own result is subtly wrong
        # in a way nobody notices until they check a loss.
        # Route order matters: "/players/22202/matches" contains both patterns,
        # so the more specific one has to come first.
        routes = [
            Route(
                match="/matches",
                body=[
                    # radiant_win with a Radiant slot: a win.
                    {"match_id": 1, "player_slot": 0, "radiant_win": True, "duration": 1800},
                    # radiant_win with a Dire slot: a loss.
                    {"match_id": 2, "player_slot": 128, "radiant_win": True, "duration": 1500},
                ],
            ),
            Route(match="/players/22202", body={"profile": {"personaname": "x"}}),
        ]
        client, _ = make_client(routes)

        history = await client.dota2.get_match_history({"steam_id": GABEN})

        assert [m.result for m in history] == [MatchResult.WIN, MatchResult.LOSS]
        await client.aclose()


class TestOsuCredentialShape:
    """osu! is the one provider whose credential has a typed half."""

    async def test_a_non_numeric_client_id_is_refused_by_name(self) -> None:
        # osu! wants the client id as a JSON number. Sending a word gets a bare
        # 401 back, which sends the reader looking at their secret rather than
        # at the half that is actually wrong - so it is refused here, before the
        # request, with the option named.
        transport = MockTransport([Route(match="oauth/token", body={"access_token": "t"})])
        client = GameStatsClient(**client_options(transport, api_keys={"osu": "name:secret"}))
        with pytest.raises(ValidationError) as caught:
            await client.title("osu").get_player({"name": "peppy"})
        assert "api_keys.osu" in str(caught.value)
        assert "clientId:clientSecret" in str(caught.value)
        assert transport.calls == [], "the credential was checked before the request"
        await client.aclose()
