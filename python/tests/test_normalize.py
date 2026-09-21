"""Normalisation.

``tests/test_shared_vectors.py`` already proves these functions agree with the
TypeScript edition. This suite covers what the vectors deliberately do not: the
*reasons* behind the behaviour, the builders that assemble whole models, and the
Python-only edges (``bool`` being a subclass of ``int``, ``float('nan')``).
"""

from __future__ import annotations

from gamestatsfetcher import (
    MatchResult,
    PlayerRef,
    as_bool,
    as_int,
    as_list,
    as_str,
    clamp,
    empty_participant_stats,
    kd,
    match_result,
    mode_stats,
    num,
    participant_stats,
    permille,
    pick,
    player_stats,
    to_minor_units,
    total,
    ts,
    win_rate,
)

REF = PlayerRef(title_id="cs2", provider_id="steam", id="76561197960287930")


class TestScalars:
    def test_num_maps_booleans_to_one_and_zero(self) -> None:
        # Deliberate, and matched in the TypeScript edition, where `Number(true)`
        # is 1. Several of these APIs report a flag - "won", "is_premium" - that
        # a caller then counts, and the two editions must count it the same way.
        assert num(True) == 1
        assert num(False) == 0

    def test_sum_still_ignores_booleans(self) -> None:
        # The exception to the above, and the one that matters: folding a list of
        # per-mode values must not let a stray flag contribute 1 to a total.
        # TypeScript's `sum` filters on `typeof value === "number"`, which
        # excludes booleans there; bool is an int subclass here, so it is
        # excluded explicitly.
        assert total([True, False]) is None
        assert total([2, True]) == 2

    def test_num_rejects_nan(self) -> None:
        assert num(float("nan")) is None

    def test_num_parses_numeric_strings(self) -> None:
        # Several of these APIs return every number as a string.
        assert num("42") == 42
        assert num("3.5") == 3.5
        assert num("") is None
        assert num("abc") is None

    def test_int_truncates_toward_zero(self) -> None:
        assert as_int(3.9) == 3
        assert as_int(-3.9) == -3

    def test_str_trims_and_drops_the_empty_result(self) -> None:
        # A name that is only whitespace is not a name. Returning "" would put a
        # blank row in a leaderboard rather than an obvious gap.
        assert as_str("  hello  ") == "hello"
        assert as_str("   ") is None

    def test_str_keeps_zero(self) -> None:
        # 0 is a legitimate id in several of these APIs, and str(0) is falsy.
        assert as_str(0) == "0"

    def test_bool_understands_the_spellings_that_actually_arrive(self) -> None:
        assert as_bool("true") is True
        assert as_bool("0") is False
        assert as_bool(1) is True
        assert as_bool("maybe") is None
        assert as_bool(None) is None


class TestTimestamps:
    def test_seconds_and_milliseconds_are_told_apart_by_magnitude(self) -> None:
        assert ts(1_700_000_000) == 1_700_000_000_000
        assert ts(1_700_000_000_000) == 1_700_000_000_000

    def test_iso_with_and_without_milliseconds(self) -> None:
        # fromisoformat rejects a trailing Z before 3.11, which is most of the
        # timestamps these APIs send.
        assert ts("2024-01-01T00:00:00Z") == 1_704_067_200_000
        assert ts("2024-01-01T00:00:00.000Z") == 1_704_067_200_000

    def test_naive_iso_is_read_as_utc(self) -> None:
        # Guessing the local zone would make the same payload parse differently
        # on a laptop and in a container.
        assert ts("2024-01-01T00:00:00") == 1_704_067_200_000

    def test_rfc_1123_dates(self) -> None:
        # Cloudflare fronts several of these APIs and answers in this format.
        assert ts("Mon, 01 Jan 2024 00:00:00 GMT") == 1_704_067_200_000

    def test_zero_and_negative_are_absent_not_epoch(self) -> None:
        # A 0 here means "the API has no date", not 1 January 1970.
        assert ts(0) is None
        assert ts(-5) is None

    def test_booleans_and_junk(self) -> None:
        assert ts(True) is None
        assert ts("not a date") is None


class TestRatios:
    def test_permille_is_an_integer(self) -> None:
        assert permille(1, 3) == 333
        assert permille(2, 3) == 667

    def test_permille_rounds_halves_away_from_zero(self) -> None:
        # The JavaScript rule, on purpose. Python's round() would give 62.
        assert permille(1, 16) == 63

    def test_permille_refuses_to_divide_by_zero(self) -> None:
        assert permille(1, 0) is None
        assert permille(None, 10) is None

    def test_win_rate_counts_draws_in_the_denominator(self) -> None:
        # A title with draws that ignored them would report a win rate higher
        # than the player has.
        assert win_rate(5, 5) == 500
        assert win_rate(5, 4, 1) == 500

    def test_win_rate_of_an_unplayed_account_is_absent(self) -> None:
        assert win_rate(0, 0) is None

    def test_kd_treats_zero_deaths_as_one(self) -> None:
        # Every scoreboard in every one of these games does this. Returning None
        # would make a perfect game look like missing data.
        assert kd(10, 0) == 10_000
        assert kd(10, 5) == 2_000

    def test_clamp(self) -> None:
        assert clamp(1_000, 1, 100) == 100
        assert clamp(0, 1, 100) == 1

    def test_to_minor_units(self) -> None:
        assert to_minor_units(12.34) == 1_234
        assert to_minor_units(None) is None


class TestTotals:
    def test_sum_ignores_absent_values(self) -> None:
        assert total([1, None, 2, None]) == 3

    def test_sum_of_nothing_is_absent_not_zero(self) -> None:
        # Folding per-mode numbers into a career total: a player whose provider
        # reported nothing must not come out with 0 kills as a stated fact.
        assert total([None, None]) is None
        assert total([]) is None

    def test_sum_of_an_explicit_zero_is_zero(self) -> None:
        assert total([0]) == 0

    def test_sum_ignores_booleans(self) -> None:
        assert total([True, False]) is None

    def test_sum_returns_an_int_when_the_result_is_whole(self) -> None:
        assert total([1.5, 2.5]) == 4
        assert isinstance(total([1.5, 2.5]), int)


class TestMatchResult:
    def test_the_three_outcomes(self) -> None:
        assert match_result(True) is MatchResult.WIN
        assert match_result(False) is MatchResult.LOSS
        assert match_result(False, True) is MatchResult.DRAW

    def test_unknown_is_not_a_loss(self) -> None:
        # The distinction that matters: a match whose result the API did not
        # report must not be counted against the player.
        assert match_result(None) is MatchResult.UNKNOWN


class TestPick:
    def test_walks_dicts_and_lists(self) -> None:
        data = {"data": [{"stats": {"kills": 12}}]}
        assert pick(data, "data", 0, "stats", "kills") == 12

    def test_a_missing_step_ends_the_walk(self) -> None:
        assert pick({"a": {}}, "a", "b", "c") is None
        assert pick(None, "a") is None

    def test_an_index_past_the_end(self) -> None:
        assert pick({"a": []}, "a", 3) is None


class TestAsList:
    def test_wraps_a_single_item(self) -> None:
        # Half of these APIs return a bare object when there is one result and
        # an array when there are several.
        assert as_list({"id": 1}) == [{"id": 1}]

    def test_absent_becomes_empty(self) -> None:
        assert as_list(None) == []

    def test_a_list_passes_through(self) -> None:
        assert as_list([1, 2]) == [1, 2]


class TestBuilders:
    def test_player_stats_derives_every_ratio(self) -> None:
        stats = player_stats(ref=REF, wins=60, losses=40, kills=100, deaths=50)
        assert stats.matches_played == 100
        assert stats.win_rate_permille == 600
        assert stats.kd_permille == 2_000

    def test_player_stats_leaves_underived_fields_absent(self) -> None:
        # Nothing is invented: no wins reported means no win rate, not 0 %.
        stats = player_stats(ref=REF, kills=10)
        assert stats.win_rate_permille is None
        assert stats.matches_played is None
        assert stats.wins is None

    def test_player_stats_counts_draws_into_matches_played(self) -> None:
        stats = player_stats(ref=REF, wins=5, losses=4, draws=1)
        assert stats.matches_played == 10
        assert stats.win_rate_permille == 500

    def test_mode_stats_labels_itself_from_its_id(self) -> None:
        mode = mode_stats(id="ranked", wins=3, losses=1)
        assert mode.label == "ranked"
        assert mode.matches_played == 4
        assert mode.win_rate_permille == 750

    def test_mode_stats_keeps_an_explicit_label(self) -> None:
        assert mode_stats(id="ranked", label="Ranked Solo").label == "Ranked Solo"

    def test_empty_participant_stats_is_all_absent(self) -> None:
        # The starting point for a provider that fills in what it knows. Every
        # field must be None, not 0, or every unreported stat becomes a claim.
        blank = empty_participant_stats()
        assert blank.kills is None
        assert blank.deaths is None
        assert blank.assists is None

    def test_participant_stats_fills_the_rest_with_none(self) -> None:
        # A scoreboard row is raw counts, not derived ratios - unlike career
        # stats, where the derivation has to happen once rather than in fifty
        # provider modules.
        stats = participant_stats(kills=9, deaths=3)
        assert (stats.kills, stats.deaths) == (9, 3)
        assert stats.assists is None
        assert stats.extra == {}

    def test_participant_stats_keeps_title_specific_numbers_in_extra(self) -> None:
        stats = participant_stats(kills=9, extra={"headshots": 4})
        assert stats.extra["headshots"] == 4

    def test_models_are_frozen(self) -> None:
        # A caller cannot edit a result and hand it back looking authoritative.
        stats = player_stats(ref=REF, wins=1, losses=1)
        try:
            stats.wins = 99  # type: ignore[misc]
        except Exception as error:
            assert type(error).__name__ == "FrozenInstanceError"
        else:  # pragma: no cover - only reached if the model stops being frozen
            raise AssertionError("PlayerStats should be immutable")
