"""Identifier conversion.

The shared vectors already prove these agree with the TypeScript edition. What
this suite adds is the *why*: every case here is a way one player could end up
looking like two, which is the failure this module exists to prevent.
"""

from __future__ import annotations

import pytest

from gamestatsfetcher import (
    PlayerQuery,
    ValidationError,
    dash_uuid,
    encode_supercell_tag,
    expand_riot_query,
    format_riot_id,
    is_steam_id64,
    normalise_supercell_tag,
    parse_riot_id,
    pick_identifier,
    to_battle_tag_path,
    to_steam_account_id,
    to_steam_id2,
    to_steam_id3,
    to_steam_id64,
    undash_uuid,
)
from gamestatsfetcher.identity import RiotId

GABEN = "76561197960287930"
GABEN_ACCOUNT = "22202"


class TestSteam:
    def test_every_rendering_converges_on_one_id(self) -> None:
        # The whole point. These four strings are the same person, and a
        # database keyed on the un-normalised form would hold four rows.
        for form in (GABEN, "[U:1:22202]", "STEAM_0:0:11101", GABEN_ACCOUNT):
            assert to_steam_id64(form) == GABEN

    def test_the_conversions_round_trip(self) -> None:
        assert to_steam_account_id(GABEN) == GABEN_ACCOUNT
        assert to_steam_id64(to_steam_id2(GABEN)) == GABEN
        assert to_steam_id64(to_steam_id3(GABEN)) == GABEN

    def test_id3_without_brackets(self) -> None:
        # Source engine logs and several community tools drop the brackets.
        assert to_steam_id64("U:1:22202") == GABEN

    def test_odd_account_ids_survive_the_id2_round_trip(self) -> None:
        # STEAM_0:Y:Z splits the account id across two fields; an implementation
        # that forgot Y would map every odd id onto its even neighbour - which is
        # a different, real person.
        odd = to_steam_id64("22203")
        assert to_steam_id2(odd) == "STEAM_0:1:11101"
        assert to_steam_id64(to_steam_id2(odd)) == odd

    def test_a_truncated_id64_is_rejected(self) -> None:
        # The failure mode of storing a SteamID64 in a float. Accepting it would
        # silently return a different person's id.
        with pytest.raises(ValidationError):
            to_steam_id64("7656119796028793000")

    def test_a_vanity_url_is_not_an_identifier(self) -> None:
        # Resolving one needs a network call, which belongs in the provider.
        with pytest.raises(ValidationError):
            to_steam_id64("gaben")

    def test_is_steam_id64_is_strict(self) -> None:
        assert is_steam_id64(GABEN) is True
        assert is_steam_id64(GABEN_ACCOUNT) is False
        assert is_steam_id64("") is False

    def test_accepts_an_integer(self) -> None:
        # JSON payloads and databases both hand these back as numbers.
        assert to_steam_id64(int(GABEN)) == GABEN


class TestRiot:
    def test_splits_on_the_last_hash(self) -> None:
        # Game names may contain a hash; tag lines may not. Splitting on the
        # first one would put half the name into the tag.
        parsed = parse_riot_id("no#1 fan#EUW")
        assert (parsed.game_name, parsed.tag_line) == ("no#1 fan", "EUW")

    def test_round_trips(self) -> None:
        assert format_riot_id(parse_riot_id("Faker#KR1")) == "Faker#KR1"
        assert format_riot_id(RiotId(game_name="T1", tag_line="KR1")) == "T1#KR1"

    @pytest.mark.parametrize("value", ["Faker", "Faker#", "#KR1", ""])
    def test_rejects_an_incomplete_id(self, value: str) -> None:
        # Half a Riot ID resolves to nobody. Failing here gives the user
        # "check the spelling"; passing it on gives them a 404 from Riot.
        with pytest.raises(ValidationError):
            parse_riot_id(value)

    def test_expand_riot_query_splits_a_pasted_id(self) -> None:
        # Users paste the whole thing into one box far more often than they fill
        # two fields.
        expanded = expand_riot_query(PlayerQuery(name="Faker#KR1"))
        assert (expanded.game_name, expanded.tag_line) == ("Faker", "KR1")

    def test_expand_riot_query_leaves_explicit_fields_alone(self) -> None:
        query = PlayerQuery(game_name="Faker", tag_line="KR1", name="something else")
        assert expand_riot_query(query) is query

    def test_expand_riot_query_ignores_a_name_without_a_tag(self) -> None:
        # Plenty of titles search by a plain display name.
        query = PlayerQuery(name="Faker")
        assert expand_riot_query(query).game_name is None


class TestBattleNet:
    def test_the_hash_becomes_a_dash(self) -> None:
        # Blizzard's URLs use a dash; the launcher shows a hash. Sending the
        # hash unescaped truncates the path at the fragment.
        assert to_battle_tag_path("Player#1234") == "Player-1234"

    def test_an_already_converted_tag_is_left_alone(self) -> None:
        assert to_battle_tag_path("Player-1234") == "Player-1234"


class TestSupercell:
    def test_uppercases_and_adds_the_hash(self) -> None:
        assert normalise_supercell_tag("2ppjcvl") == "#2PPJCVL"

    def test_the_letter_o_is_read_as_a_zero(self) -> None:
        # Supercell's alphabet has no O, so a tag copied out of a screenshot
        # with one in it is a misread zero every single time. Correcting it is
        # the difference between finding the player and a 404.
        assert normalise_supercell_tag("2ppOjcvl") == "#2PP0JCVL"

    def test_strips_whitespace_and_a_duplicate_hash(self) -> None:
        assert normalise_supercell_tag("  #2pp  ") == "#2PP"

    def test_url_encodes_the_hash(self) -> None:
        # Supercell's API takes the tag in the path, and an unescaped # is a
        # fragment - the request would arrive without the tag at all.
        assert encode_supercell_tag("#2PP") == "%232PP"

    @pytest.mark.parametrize("value", ["#ABC", "#2P", "", "#2PP!"])
    def test_rejects_what_is_not_a_supercell_tag(self, value: str) -> None:
        # The alphabet is 0289PYLQGRJCUV and nothing else - A, B and C are not
        # in it - and a tag is 3 to 12 characters. Rejecting here gives the user
        # "check the tag" instead of a bare 404 from Supercell.
        with pytest.raises(ValidationError):
            normalise_supercell_tag(value)


class TestUuid:
    def test_dashes_a_bare_uuid(self) -> None:
        # Mojang's API returns undashed; almost everything else expects dashes.
        assert dash_uuid("069a79f444e94726a5befca90e38aaf5") == (
            "069a79f4-44e9-4726-a5be-fca90e38aaf5"
        )

    def test_an_already_dashed_uuid_passes_through(self) -> None:
        dashed = "069a79f4-44e9-4726-a5be-fca90e38aaf5"
        assert dash_uuid(dashed) == dashed

    def test_undash_lowercases(self) -> None:
        # Two spellings of one uuid would be two cache keys and two rows.
        assert undash_uuid("069a79f4-44e9-4726-A5BE-fca90e38aaf5") == (
            "069a79f444e94726a5befca90e38aaf5"
        )

    def test_rejects_something_that_is_not_a_uuid(self) -> None:
        with pytest.raises(ValidationError):
            dash_uuid("nope")


class TestPickIdentifier:
    def test_prefers_the_earlier_entry(self) -> None:
        # Titles list identifiers best-first: a PUUID never changes, a display
        # name changes whenever the player feels like it.
        query = PlayerQuery(puuid="abc", name="Faker")
        assert pick_identifier(query, ["puuid", "name"]) == ("puuid", "abc")

    def test_falls_through_to_what_the_caller_actually_gave(self) -> None:
        query = PlayerQuery(name="Faker")
        assert pick_identifier(query, ["puuid", "name"]) == ("name", "Faker")

    def test_ignores_blank_values(self) -> None:
        # An empty form field is not an identifier.
        query = PlayerQuery(puuid="   ", name="Faker")
        assert pick_identifier(query, ["puuid", "name"]) == ("name", "Faker")

    def test_returns_none_when_nothing_matches(self) -> None:
        # The caller turns this into IdentifierError, which names what the title
        # would have accepted.
        assert pick_identifier(PlayerQuery(name="x"), ["puuid", "steam_id"]) is None

    def test_accepts_a_numeric_account_id(self) -> None:
        # osu!, Wargaming and iRacing all key on an integer.
        assert pick_identifier(PlayerQuery(account_id=124_493), ["account_id"]) == (
            "account_id",
            "124493",
        )
