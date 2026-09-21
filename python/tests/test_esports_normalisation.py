"""The per-provider esports normalisers, one payload each.

Five providers describe the same match in five shapes: PandaScore nests
opponents under ``opponents[].opponent``, Octane calls them ``blue`` and
``orange``, OpenDota says ``radiant`` and ``dire``, start.gg calls them entrants
and Abios calls them participants. All five have to come out the other side as
the same :class:`EsportsMatch`, or a dashboard comparing two titles is comparing
two different things.

These are the methods behind that, tested directly. Going through the client for
each would need a route table per provider and would test the transport again
rather than the mapping.
"""

from __future__ import annotations

import pytest

from conftest import MockTransport
from conftest import test_options as client_options
from gamestatsfetcher import (
    EsportsMatchStatus,
    GameStatsClient,
    get_title,
)
from gamestatsfetcher.esports import EsportsLayer


@pytest.fixture
def layer() -> EsportsLayer:
    client = GameStatsClient(**client_options(MockTransport([])))
    return EsportsLayer(client.runtime, get_title("dota2"))


@pytest.fixture
def rl_layer() -> EsportsLayer:
    client = GameStatsClient(**client_options(MockTransport([])))
    return EsportsLayer(client.runtime, get_title("rocket-league"))


class TestOctane:
    """Rocket League. Psyonix publishes nothing, so Octane.gg is the circuit."""

    PAYLOAD = {
        "_id": "m1",
        "date": "2026-02-01T18:00:00Z",
        "format": {"length": 5},
        "event": {"_id": "e1", "name": "RLCS Major", "slug": "rlcs-major"},
        "blue": {"score": 4, "team": {"team": {"_id": "t1", "name": "Team Blue"}}},
        "orange": {"score": 2, "team": {"team": {"_id": "t2", "name": "Team Orange"}}},
    }

    def test_blue_and_orange_become_opponents(self, rl_layer: EsportsLayer) -> None:
        match = rl_layer._from_octane(self.PAYLOAD)
        assert [o.name for o in match.opponents] == ["Team Blue", "Team Orange"]
        assert [o.score for o in match.opponents] == [4, 2]

    def test_the_winner_is_derived_from_the_scores(self, rl_layer: EsportsLayer) -> None:
        # Octane does not state a winner, so it has to come from the scores -
        # and getting the comparison backwards would be invisible in the shape.
        match = rl_layer._from_octane(self.PAYLOAD)
        assert match.winner_id == "t1"

    def test_a_match_with_both_sides_present_is_finished(self, rl_layer: EsportsLayer) -> None:
        assert rl_layer._from_octane(self.PAYLOAD).status is EsportsMatchStatus.FINISHED

    def test_a_match_with_no_sides_yet_is_scheduled(self, rl_layer: EsportsLayer) -> None:
        upcoming = {"_id": "m2", "date": "2026-03-01T18:00:00Z", "event": {}}
        match = rl_layer._from_octane(upcoming)
        assert match.status is EsportsMatchStatus.SCHEDULED
        assert match.opponents == ()
        assert match.winner_id is None

    def test_the_event_becomes_a_tournament_reference(self, rl_layer: EsportsLayer) -> None:
        reference = rl_layer._from_octane(self.PAYLOAD).tournament
        assert reference is not None
        assert (reference.id, reference.name, reference.slug) == (
            "e1",
            "RLCS Major",
            "rlcs-major",
        )

    def test_a_match_without_an_event_has_no_reference(self, rl_layer: EsportsLayer) -> None:
        assert rl_layer._from_octane({"_id": "m3"}).tournament is None


class TestOpenDota:
    """Dota 2 professional matches, and the radiant/dire asymmetry."""

    PAYLOAD = {
        "match_id": 7_000_000_001,
        "leagueid": 15_728,
        "league_name": "The International",
        "start_time": 1_760_000_000,
        "radiant_win": True,
        "radiant_team_id": 2_163,
        "radiant_name": "Team Liquid",
        "radiant_score": 2,
        "dire_team_id": 15,
        "dire_name": "PSG.LGD",
        "dire_score": 1,
    }

    def test_radiant_is_the_first_opponent(self, layer: EsportsLayer) -> None:
        match = layer._from_opendota_pro(self.PAYLOAD)
        assert [o.name for o in match.opponents] == ["Team Liquid", "PSG.LGD"]

    def test_radiant_win_picks_the_right_side(self, layer: EsportsLayer) -> None:
        # The one thing that is easy to get backwards, and would be wrong in
        # exactly half the matches.
        assert layer._from_opendota_pro(self.PAYLOAD).winner_id == "2163"
        dire_won = {**self.PAYLOAD, "radiant_win": False}
        assert layer._from_opendota_pro(dire_won).winner_id == "15"

    def test_epoch_seconds_become_milliseconds(self, layer: EsportsLayer) -> None:
        assert layer._from_opendota_pro(self.PAYLOAD).started_at == 1_760_000_000_000

    def test_a_pro_match_is_always_finished(self, layer: EsportsLayer) -> None:
        # OpenDota's pro-match feed is history; there is no live entry in it.
        assert layer._from_opendota_pro(self.PAYLOAD).status is EsportsMatchStatus.FINISHED

    def test_unnamed_teams_fall_back_to_the_side(self, layer: EsportsLayer) -> None:
        # Qualifier matches routinely have no team record on either side.
        bare = {"match_id": 1, "radiant_win": True}
        match = layer._from_opendota_pro(bare)
        assert [o.name for o in match.opponents] == ["Radiant", "Dire"]


class TestAbios:
    PAYLOAD = {
        "id": 900,
        "title": "Grand Final",
        "lifecycle": "over",
        "start": "2026-01-05T10:00:00Z",
        "end": "2026-01-05T12:30:00Z",
        "best_of": 3,
        "winner": {"id": "77"},
        "participants": [
            {
                "score": 2,
                "roster": {
                    "id": "r1",
                    "team": {
                        "id": 77,
                        "name": "Team One",
                        "short_name": "T1",
                        "images": {"default": "https://cdn/t1.png"},
                    },
                },
            },
            {"score": 0, "roster": {"id": "r2", "team": {"id": 88, "name": "Team Two"}}},
        ],
    }

    def test_participants_become_opponents(self, layer: EsportsLayer) -> None:
        match = layer._from_abios(self.PAYLOAD)
        assert [o.name for o in match.opponents] == ["Team One", "Team Two"]
        assert match.opponents[0].acronym == "T1"
        assert match.opponents[0].logo_url == "https://cdn/t1.png"

    def test_the_lifecycle_maps_onto_the_shared_vocabulary(self, layer: EsportsLayer) -> None:
        # "over" is Abios's word. Nothing outside this method should see it.
        assert layer._from_abios(self.PAYLOAD).status is EsportsMatchStatus.FINISHED

    def test_it_keeps_the_end_time(self, layer: EsportsLayer) -> None:
        assert layer._from_abios(self.PAYLOAD).ended_at is not None

    def test_a_roster_without_a_team_still_produces_an_opponent(
        self, layer: EsportsLayer
    ) -> None:
        # Stand-in rosters and open-qualifier entries have no team record.
        payload = {"id": 1, "participants": [{"roster": {"id": "r9"}}]}
        opponent = layer._from_abios(payload).opponents[0]
        assert opponent.id == "r9"
        assert opponent.name == "unknown"


class TestStartGg:
    """The fighting-game circuit, where an entrant is a person, not a team."""

    SET = {
        "id": 555,
        "fullRoundText": "Grand Final",
        "completedAt": 1_760_000_100,
        "slots": [
            {
                "entrant": {"id": 1, "name": "Arslan Ash"},
                "standing": {"stats": {"score": {"value": 3}}},
            },
            {
                "entrant": {"id": 2, "name": "Knee"},
                "standing": {"stats": {"score": {"value": 1}}},
            },
        ],
    }
    TOURNAMENT = {"id": 42, "name": "EVO", "slug": "evo-2026"}

    def test_entrants_are_players_not_teams(self, layer: EsportsLayer) -> None:
        # A dashboard grouping by team would otherwise invent one-person teams
        # for every fighting-game title in the registry.
        match = layer._from_startgg_set(self.SET, self.TOURNAMENT)
        assert all(o.kind == "player" for o in match.opponents)
        assert [o.name for o in match.opponents] == ["Arslan Ash", "Knee"]

    def test_a_completed_set_is_finished(self, layer: EsportsLayer) -> None:
        match = layer._from_startgg_set(self.SET, self.TOURNAMENT)
        assert match.status is EsportsMatchStatus.FINISHED

    def test_a_started_set_is_live(self, layer: EsportsLayer) -> None:
        running = {**self.SET, "completedAt": None, "startedAt": 1_760_000_000}
        match = layer._from_startgg_set(running, self.TOURNAMENT)
        assert match.status is EsportsMatchStatus.LIVE

    def test_an_unplayed_set_is_scheduled(self, layer: EsportsLayer) -> None:
        pending = {**self.SET, "completedAt": None}
        match = layer._from_startgg_set(pending, self.TOURNAMENT)
        assert match.status is EsportsMatchStatus.SCHEDULED

    def test_an_empty_slot_reads_as_tbd(self, layer: EsportsLayer) -> None:
        # Brackets are published before they are filled, and "TBD" is what a
        # viewer should see rather than a blank or an invented name.
        half_filled = {"id": 1, "slots": [{"entrant": {"id": 1, "name": "Knee"}}, {}]}
        match = layer._from_startgg_set(half_filled, self.TOURNAMENT)
        assert match.opponents[1].name == "TBD"


class TestTournamentMappers:
    def test_pandascore_parses_the_free_text_prize_pool(self, layer: EsportsLayer) -> None:
        row = {
            "id": 1,
            "name": "The International",
            "slug": "ti",
            "tier": "s",
            "begin_at": "2026-08-01T00:00:00Z",
            "prizepool": "40000000 United States Dollar",
            "league": {"name": "DPC"},
        }
        tournament = layer._tournament_from_pandascore(row)
        assert tournament.prize_pool_minor == 4_000_000_000
        assert tournament.prize_pool_currency == "USD"
        assert tournament.tier == "s"

    def test_pandascore_falls_back_to_the_league_name(self, layer: EsportsLayer) -> None:
        row = {"id": 2, "league": {"name": "DPC"}}
        assert layer._tournament_from_pandascore(row).name == "DPC"

    def test_octane_events(self, layer: EsportsLayer) -> None:
        row = {
            "_id": "e1",
            "name": "RLCS",
            "slug": "rlcs",
            "prize": {"amount": 100_000, "currency": "USD"},
        }
        tournament = layer._tournament_from_octane(row)
        assert tournament.name == "RLCS"
        assert tournament.provider_id == "octane"

    def test_liquipedia_pages(self, layer: EsportsLayer) -> None:
        # Liquipedia gives a page title and nothing structured. The slug is
        # derived so a caller can build a link back.
        row = {"pageid": 99, "title": "The International 2026"}
        tournament = layer._tournament_from_liquipedia(row)
        assert tournament.id == "99"
        assert tournament.slug == "The_International_2026"

    def test_startgg_tournaments(self, layer: EsportsLayer) -> None:
        row = {"id": 7, "name": "EVO", "slug": "evo", "startAt": 1_760_000_000}
        tournament = layer._tournament_from_startgg(row)
        assert tournament.name == "EVO"
        assert tournament.begin_at == 1_760_000_000_000

    def test_toornament_tournaments(self, layer: EsportsLayer) -> None:
        row = {"id": "t9", "name": "Community Cup", "scheduled_date_start": "2026-04-01"}
        assert layer._tournament_from_toornament(row).name == "Community Cup"


class TestTeamAndPlayerMappers:
    def test_pandascore_team_carries_its_roster(self, layer: EsportsLayer) -> None:
        row = {
            "id": 1,
            "name": "Team Liquid",
            "acronym": "TL",
            "players": [{"id": 10, "name": "miCKe", "first_name": "Michael"}],
        }
        team = layer._team_from_pandascore(row)
        assert team.acronym == "TL"
        assert [p.nickname for p in team.players] == ["miCKe"]
        # The roster's players know which team they belong to.
        assert team.players[0].team_id == "1"

    def test_octane_team(self, layer: EsportsLayer) -> None:
        row = {"_id": "t1", "name": "G2", "slug": "g2", "location": {"nationality": "us"}}
        team = layer._team_from_octane(row)
        assert (team.name, team.acronym, team.country) == ("G2", "g2", "us")

    def test_opendota_team(self, layer: EsportsLayer) -> None:
        row = {"team_id": 2163, "name": "Team Liquid", "tag": "Liquid"}
        assert layer._team_from_opendota(row).id == "2163"

    def test_abios_team(self, layer: EsportsLayer) -> None:
        row = {"id": 5, "name": "Fnatic", "short_name": "FNC", "country": {"name": "SE"}}
        team = layer._team_from_abios(row)
        assert (team.acronym, team.country) == ("FNC", "SE")

    def test_a_team_with_no_name_is_labelled_not_blank(self, layer: EsportsLayer) -> None:
        # A blank row in a standings table is worse than an honest "unknown".
        assert layer._team_from_octane({"_id": "x"}).name == "unknown"

    def test_pandascore_player(self, layer: EsportsLayer) -> None:
        row = {
            "id": 3,
            "name": "Nisha",
            "first_name": "Michal",
            "nationality": "pl",
            "role": "mid",
            "current_team": {"id": 9},
        }
        player = layer._player_from_pandascore(row)
        assert (player.nickname, player.country, player.role) == ("Nisha", "pl", "mid")
        assert player.team_id == "9"

    def test_octane_player_splits_the_nested_name(self, layer: EsportsLayer) -> None:
        row = {
            "_id": "p1",
            "tag": "Firstkiller",
            "name": {"first": "Mariano", "last": "Arruda"},
            "country": "us",
            "team": {"_id": "t1"},
        }
        player = layer._player_from_octane(row)
        assert (player.nickname, player.first_name, player.team_id) == (
            "Firstkiller",
            "Mariano",
            "t1",
        )

    def test_opendota_player_prefers_the_pro_name(self, layer: EsportsLayer) -> None:
        # `name` is the professional handle and `personaname` is the Steam one;
        # a viewer expects the former.
        row = {"account_id": 111, "name": "Nisha", "personaname": "not-nisha"}
        assert layer._player_from_opendota(row).nickname == "Nisha"

    def test_opendota_falls_back_to_the_steam_name(self, layer: EsportsLayer) -> None:
        row = {"account_id": 111, "personaname": "somebody"}
        assert layer._player_from_opendota(row).nickname == "somebody"

    def test_abios_player(self, layer: EsportsLayer) -> None:
        row = {"id": 4, "nick_name": "ropz", "country": {"name": "EE"}}
        player = layer._player_from_abios(row)
        assert (player.nickname, player.country) == ("ropz", "EE")

    def test_every_mapper_stamps_the_title_and_provider(self, layer: EsportsLayer) -> None:
        # Results from different sources end up in the same list, and a caller
        # has to be able to tell which source produced which row.
        assert layer._team_from_octane({"_id": "x"}).title_id == "dota2"
        assert layer._team_from_octane({"_id": "x"}).provider_id == "octane"
        assert layer._player_from_abios({"id": 1}).provider_id == "abios"
