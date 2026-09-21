"""The four titles where progress is the rank.

Old School RuneScape, RuneScape, EVE Online and Diablo III. None of them has
matchmaking, so the interesting question in every case is the same: does the
client map "how far have I got" onto the shared shapes without inventing a
match, a win rate or a rating that the upstream never reported?

The mirror of ``typescript/tests/persistent.test.ts``, case for case.
"""

from __future__ import annotations

import asyncio

import pytest

from conftest import MockTransport, Route, make_client
from conftest import test_options as client_options
from gamestatsfetcher import (
    GameStatsClient,
    LeaderboardOptions,
    NotFoundError,
    UnsupportedCapabilityError,
    ValidationError,
)

#: The JSON form, which is what the provider asks for first.
HISCORES = {
    "skills": [
        {"id": 0, "name": "Overall", "rank": 12_345, "level": 2_277, "xp": 4_600_000_000},
        {"id": 1, "name": "Attack", "rank": 50_000, "level": 99, "xp": 200_000_000},
        # An unranked skill: the hiscores spell that -1, and it must never be
        # reported as rank -1 or as rank 0.
        {"id": 2, "name": "Defence", "rank": -1, "level": 1, "xp": 0},
    ],
    "activities": [
        {"id": 0, "name": "Clue Scrolls (all)", "rank": 900, "score": 1_200},
        {"id": 1, "name": "Zulrah", "rank": -1, "score": -1},
    ],
}

JSON_ROUTES = [Route(match="index_lite.json", body=HISCORES)]


class TestOldSchoolRuneScape:
    async def test_resolves_by_display_name(self) -> None:
        # Jagex publishes no account id, so the name is the key - and a rename
        # silently repoints it, which the client documents rather than hides.
        client, transport = make_client(JSON_ROUTES)
        ref = await client.title("old-school-runescape").resolve_player({"name": "Zezima"})
        assert ref.id == "Zezima"
        assert ref.provider_id == "jagex"
        assert "m=hiscore_oldschool" in transport.calls[0][1]
        await client.aclose()

    async def test_reads_the_overall_level_as_the_account_level(self) -> None:
        client, _ = make_client(JSON_ROUTES)
        profile = await client.title("old-school-runescape").get_player({"name": "Zezima"})
        assert profile.level == 2_277
        assert profile.display_name == "Zezima"
        await client.aclose()

    async def test_an_unranked_skill_is_absent_rather_than_ranked_minus_one(self) -> None:
        client, _ = make_client(JSON_ROUTES)
        ranks = await client.title("old-school-runescape").get_rank({"name": "Zezima"})
        # Defence is unranked. A rank of -1 would sort to the top of any
        # leaderboard a caller builds out of these.
        assert [rank.queue for rank in ranks] == ["Overall", "Attack"]
        assert ranks[0].position == 12_345
        assert ranks[0].tier == "Level 2277"
        assert ranks[0].tier_points == 4_600_000_000
        await client.aclose()

    async def test_skills_and_activities_keep_separate_namespaces(self) -> None:
        client, _ = make_client(JSON_ROUTES)
        stats = await client.title("old-school-runescape").get_player_stats({"name": "Zezima"})
        assert "skill:0" in stats.modes
        assert "activity:0" in stats.modes
        assert stats.modes["skill:1"].extra["level"] == 99
        assert stats.modes["activity:0"].extra["score"] == 1_200
        # An unranked activity keeps its row and reports None, because "you have
        # never killed Zulrah" is an answer and an absent row is not.
        assert stats.modes["activity:1"].extra["score"] is None
        await client.aclose()

    async def test_no_match_record_is_invented(self) -> None:
        client, _ = make_client(JSON_ROUTES)
        stats = await client.title("old-school-runescape").get_player_stats({"name": "Zezima"})
        assert stats.matches_played is None
        assert stats.wins is None
        assert stats.win_rate_permille is None
        with pytest.raises(UnsupportedCapabilityError):
            await client.title("old-school-runescape").get_match_history({"name": "Zezima"})
        await client.aclose()

    async def test_falls_back_to_the_csv_form(self) -> None:
        # The CSV endpoint is the one that has been stable the longest. It
        # carries no names, so the skill table supplies them positionally and
        # the activities are numbered rather than guessed at.
        client, _ = make_client(
            [
                Route(match="index_lite.json", status=404),
                Route(
                    match="index_lite.ws",
                    text="12345,2277,4600000000\n50000,99,200000000\n-1,1,0\n900,1200\n",
                    headers={"Content-Type": "text/plain"},
                ),
            ]
        )
        ranks = await client.title("old-school-runescape").get_rank({"name": "Zezima"})
        assert [rank.queue for rank in ranks] == ["Overall", "Attack"]
        await client.aclose()

    async def test_says_which_player_was_missing(self) -> None:
        client, _ = make_client(
            [
                Route(match="index_lite.json", status=404),
                Route(match="index_lite.ws", status=404),
            ]
        )
        with pytest.raises(NotFoundError):
            await client.title("old-school-runescape").get_rank({"name": "NotAPlayer"})
        await client.aclose()

    async def test_asks_for_a_name_rather_than_guessing_one(self) -> None:
        client, _ = make_client(JSON_ROUTES)
        with pytest.raises(ValidationError):
            await client.title("old-school-runescape").resolve_player({})
        await client.aclose()


class TestRuneScape:
    async def test_reads_the_other_table_from_the_same_host(self) -> None:
        client, transport = make_client(JSON_ROUTES)
        await client.title("runescape").get_player({"name": "Zezima"})
        # The only difference between the two games is this path segment, so it
        # is the one thing worth asserting separately.
        assert "m=hiscore/" in transport.calls[0][1]
        assert "oldschool" not in transport.calls[0][1]
        await client.aclose()


EVE_ROUTES = [
    Route(
        match="/universe/ids/", body={"characters": [{"id": 90_000_001, "name": "Chribba"}]}
    ),
    Route(
        match="/characters/90000001/",
        body={
            "name": "Chribba",
            "corporation_id": 98_000_001,
            "alliance_id": 99_000_001,
            "birthday": "2003-05-06T00:00:00Z",
            "security_status": -4.95,
            "race_id": 1,
        },
    ),
    Route(
        match="/corporations/98000001/",
        body={"name": "Otherworld Enterprises", "ticker": "OTHER", "member_count": 42},
    ),
    Route(match="/alliances/99000001/", body={"name": "Test Alliance", "ticker": "TEST"}),
    Route(match="/status/", body={"players": 24_000, "server_version": "2500000"}),
]


class TestEveOnline:
    async def test_turns_a_name_into_the_id_that_survives_a_rename(self) -> None:
        client, _ = make_client(EVE_ROUTES)
        ref = await client.title("eve-online").resolve_player({"name": "Chribba"})
        assert ref.id == "90000001"
        assert ref.display_name == "Chribba"
        await client.aclose()

    async def test_takes_a_numeric_id_without_a_name_lookup(self) -> None:
        client, transport = make_client(EVE_ROUTES)
        ref = await client.title("eve-online").resolve_player({"account_id": 90_000_001})
        assert ref.id == "90000001"
        assert not any("/universe/ids/" in url for _, url in transport.calls)
        await client.aclose()

    async def test_a_name_that_matched_no_character_is_a_missing_character(self) -> None:
        client, _ = make_client(
            [Route(match="/universe/ids/", body={"corporations": [{"id": 1}]})]
        )
        with pytest.raises(NotFoundError):
            await client.title("eve-online").resolve_player({"name": "Some Corporation"})
        await client.aclose()

    async def test_the_corporation_is_the_clan(self) -> None:
        client, _ = make_client(EVE_ROUTES)
        profile = await client.title("eve-online").get_player({"name": "Chribba"})
        assert profile.clan == "Otherworld Enterprises"
        assert profile.created_at == 1_052_179_200_000
        assert profile.avatar_url is not None
        assert "/characters/90000001/portrait" in profile.avatar_url
        await client.aclose()

    async def test_security_status_stays_in_permille(self) -> None:
        # -4.95 and -5.0 mean different things at a gate camp, and rounding to
        # an integer would lose exactly that difference.
        client, _ = make_client(EVE_ROUTES)
        ranks = await client.title("eve-online").get_rank({"name": "Chribba"})
        assert len(ranks) == 1
        assert ranks[0].queue == "security-status"
        assert ranks[0].rating == -4_950
        await client.aclose()

    async def test_reports_the_tickers_as_standing(self) -> None:
        client, _ = make_client(EVE_ROUTES)
        stats = await client.title("eve-online").get_player_stats({"name": "Chribba"})
        assert stats.modes["standing"].extra["corporationTicker"] == "OTHER"
        assert stats.modes["standing"].extra["allianceTicker"] == "TEST"
        assert stats.modes["standing"].extra["securityStatusPermille"] == -4_950
        await client.aclose()

    async def test_serves_the_server_status_and_refuses_anything_else(self) -> None:
        client, _ = make_client(EVE_ROUTES)
        status = await client.title("eve-online").get_metadata()
        assert status["players"] == 24_000
        with pytest.raises(ValidationError):
            await client.title("eve-online").get_metadata("wallet")
        await client.aclose()

    async def test_omits_the_rank_when_esi_reports_no_security_status(self) -> None:
        client, _ = make_client(
            [
                Route(match="/universe/ids/", body={"characters": [{"id": 5, "name": "New"}]}),
                Route(match="/characters/5/", body={"name": "New"}),
            ]
        )
        assert await client.title("eve-online").get_rank({"name": "New"}) == []
        await client.aclose()


D3_ROUTES = [
    Route(match="oauth.battle.net/token", body={"access_token": "t", "expires_in": 86_400}),
    Route(
        match="/d3/profile/Player-1234/hero/",
        body={"id": 1, "name": "Barb", "class": "barbarian", "level": 70},
    ),
    Route(
        match="/d3/profile/Player-1234/",
        body={
            "battleTag": "Player#1234",
            "paragonLevel": 800,
            "paragonLevelSeason": 120,
            "guildName": "Nephalem",
            "lastUpdated": 1_700_000_000,
            "kills": {"elites": 12_345},
            "heroes": [
                {
                    "id": 1,
                    "name": "Barb",
                    "class": "barbarian",
                    "level": 70,
                    "paragonLevel": 800,
                    "hardcore": False,
                    "seasonal": True,
                    "dead": False,
                },
                {
                    "id": 2,
                    "name": "Fallen",
                    "class": "wizard",
                    "level": 70,
                    "hardcore": True,
                    "dead": True,
                },
            ],
        },
    ),
    Route(
        match="/data/d3/season/33/leaderboard/rift-team-4",
        body={
            "row": [
                {
                    "player": [
                        {"accountId": "1", "data": "Alpha"},
                        {"accountId": "2", "data": "Beta"},
                    ],
                    "data": [{"id": "RiftLevel", "number": 150}],
                }
            ]
        },
    ),
    Route(match="/data/d3/season/", body={"currentSeason": 33}),
]


def d3_client():
    return make_client(D3_ROUTES, api_keys={"blizzard": "a:b"})


class TestDiabloThree:
    async def test_accepts_a_battle_tag_with_the_hash_a_caller_types(self) -> None:
        client, transport = d3_client()
        ref = await client.title("diablo-3").resolve_player({"battle_tag": "Player#1234"})
        assert ref.id == "Player-1234"
        # Blizzard spells the separator `-` in a path; passing the `#` form is
        # the normal mistake and is converted rather than rejected.
        assert any("Player-1234" in url for _, url in transport.calls)
        await client.aclose()

    async def test_reads_the_paragon_level_as_the_account_level(self) -> None:
        client, _ = d3_client()
        profile = await client.title("diablo-3").get_player({"battle_tag": "Player#1234"})
        assert profile.level == 800
        assert profile.clan == "Nephalem"
        assert profile.last_seen_at == 1_700_000_000_000
        await client.aclose()

    async def test_reports_both_paragon_ladders(self) -> None:
        client, _ = d3_client()
        ranks = await client.title("diablo-3").get_rank({"battle_tag": "Player#1234"})
        assert [rank.queue for rank in ranks] == ["paragon", "paragon-season"]
        assert ranks[0].tier_points == 800
        assert ranks[1].tier_points == 120
        await client.aclose()

    async def test_keeps_a_dead_hardcore_hero(self) -> None:
        # Hardcore deaths are the statistic Diablo players actually discuss, so
        # dropping the dead hero would drop the interesting half of the career.
        client, _ = d3_client()
        stats = await client.title("diablo-3").get_player_stats({"battle_tag": "Player#1234"})
        assert stats.modes["hero:2"].extra["dead"] == "true"
        assert stats.modes["hero:2"].extra["hardcore"] == "true"
        assert stats.kills == 12_345
        await client.aclose()

    async def test_names_one_member_of_a_party_and_keeps_the_rest(self) -> None:
        client, _ = d3_client()
        board = await client.title("diablo-3").get_leaderboard(
            LeaderboardOptions(queue="rift-team-4")
        )
        assert len(board) == 1
        assert board[0].position == 1
        assert board[0].display_name == "Alpha"
        assert board[0].rating == 150
        # The second player is not dropped - it is in the row a caller can read.
        assert "Beta" in str(board[0].raw)
        await client.aclose()

    async def test_asks_the_season_index_rather_than_guessing(self) -> None:
        client, transport = d3_client()
        await client.title("diablo-3").get_leaderboard(LeaderboardOptions(queue="rift-team-4"))
        assert any("/data/d3/season/" in url for _, url in transport.calls)
        assert any("/season/33/leaderboard/" in url for _, url in transport.calls)
        await client.aclose()

    async def test_serves_the_season_index_and_refuses_anything_else(self) -> None:
        client, _ = d3_client()
        assert await client.title("diablo-3").get_metadata() is not None
        with pytest.raises(ValidationError):
            await client.title("diablo-3").get_metadata("heroes")
        await client.aclose()

    async def test_has_no_match_history(self) -> None:
        client, _ = d3_client()
        with pytest.raises(UnsupportedCapabilityError):
            await client.title("diablo-3").get_match_history({"battle_tag": "Player#1234"})
        await client.aclose()


class TestIndependentCallsRunTogether:
    """The calls that need nothing from each other are issued together.

    This is not a timing test and it cannot flake. The transport below holds the
    *first* request it sees until a second one arrives: if the client issues them
    concurrently both complete, and if it issues them one after the other the
    first never returns and ``wait_for`` fails with a clear message.

    It is worth pinning because the failure is invisible. Sequential code is
    correct - it just costs a caller an extra round trip on every profile page,
    for ever, and nothing in a normal test suite notices.
    """

    async def test_eve_asks_for_the_corporation_and_the_alliance_at_once(self) -> None:
        gate = _PairGate(
            MockTransport(EVE_ROUTES),
            waits_for={"/corporations/", "/alliances/"},
        )
        client = GameStatsClient(**client_options(gate))
        stats = await asyncio.wait_for(
            client.title("eve-online").get_player_stats({"name": "Chribba"}),
            timeout=5,
        )
        assert stats.modes["standing"].extra["corporationTicker"] == "OTHER"
        assert gate.paired, "the corporation and alliance lookups ran one after the other"
        await client.aclose()


class _PairGate:
    """A transport that holds the first of a pair until the second arrives."""

    def __init__(self, inner: MockTransport, waits_for: set[str]) -> None:
        self.inner = inner
        self.waits_for = waits_for
        self.arrived: set[str] = set()
        self.paired = False
        self._both = asyncio.Event()

    @property
    def calls(self) -> list[tuple[str, str]]:
        return self.inner.calls

    async def request(self, method: str, url: str, **kwargs: object) -> object:
        match = next((needle for needle in self.waits_for if needle in url), None)
        if match is not None:
            self.arrived.add(match)
            if self.arrived == self.waits_for:
                self.paired = True
                self._both.set()
            else:
                # Blocks until the sibling call arrives. Sequential code never
                # gets here twice, so wait_for above is what reports it.
                await self._both.wait()
        return await self.inner.request(method, url, **kwargs)  # type: ignore[arg-type]

    async def aclose(self) -> None:
        await self.inner.aclose()
