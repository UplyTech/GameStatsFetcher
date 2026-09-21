"""The cross-edition contract.

``shared/vectors/`` is generated from the TypeScript edition. This suite replays
every case against the Python one and asserts the answers are identical.

Two editions that quietly compute different win rates are worse than two
separate libraries, because nobody expects the difference. These files are how
that is prevented - and the permille cases in particular, because JavaScript's
``Math.round`` rounds halves away from zero while Python's ``round`` is banker's
rounding, so the naive port would disagree on every ratio landing on a half.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from gamestatsfetcher import (
    DEFAULT_TIMEOUT_MS,
    DEFAULT_TTL_SECONDS,
    DEFAULT_USER_AGENT,
    ESPORTS_CAPABILITY_PROVIDERS,
    MAX_PAGE_SIZE,
    PERMILLE,
    STEAM_APP_IDS,
    TTL,
    VERSION,
    as_bool,
    as_int,
    as_str,
    clamp,
    dash_uuid,
    encode_supercell_tag,
    esports_providers_for,
    is_steam_id64,
    kd,
    match_result,
    normalise_supercell_tag,
    num,
    parse_riot_id,
    permille,
    to_battle_tag_path,
    to_minor_units,
    to_steam_account_id,
    to_steam_id2,
    to_steam_id3,
    to_steam_id64,
    total,
    ts,
    undash_uuid,
    win_rate,
)
from gamestatsfetcher.constants import DEFAULT_BURST, DEFAULT_RPS

VECTORS = Path(__file__).resolve().parent.parent.parent / "shared" / "vectors"

#: Layout this suite understands. Asserted so a file from a future generator
#: fails loudly instead of being half-read.
FORMAT_VERSION = 1


def load(name: str) -> dict[str, Any]:
    payload = json.loads((VECTORS / f"{name}.json").read_text("utf-8"))
    assert payload["formatVersion"] == FORMAT_VERSION, (
        f"shared/vectors/{name}.json has formatVersion "
        f"{payload['formatVersion']}, this suite understands {FORMAT_VERSION}"
    )
    return payload


def check(fn: Callable[..., Any], cases: list[dict[str, Any]], label: str) -> None:
    """Replay one function's cases.

    A case either has a ``value`` - which must match exactly - or an ``error``,
    which means the TypeScript edition threw and this one must too.
    """
    for case in cases:
        args = case["args"]
        if "error" in case:
            with pytest.raises(Exception) as caught:  # noqa: B017 - class differs
                fn(*args)
            assert caught.value is not None, f"{label}{args!r} should have raised"
            continue

        actual = fn(*args)
        expected = case["value"]
        # JSON has no tuples, and both editions call these "lists".
        if isinstance(actual, tuple):
            actual = list(actual)
        assert actual == expected, (
            f"{label}{args!r} -> {actual!r}, TypeScript gives {expected!r}"
        )


class TestNormalize:
    """The pure numeric helpers, where a rounding difference would hide for months."""

    vectors = load("normalize")

    def test_num(self) -> None:
        check(num, self.vectors["num"], "num")

    def test_int(self) -> None:
        check(as_int, self.vectors["int"], "as_int")

    def test_str(self) -> None:
        check(as_str, self.vectors["str"], "as_str")

    def test_bool(self) -> None:
        check(as_bool, self.vectors["bool"], "as_bool")

    def test_ts(self) -> None:
        check(ts, self.vectors["ts"], "ts")

    def test_permille(self) -> None:
        check(permille, self.vectors["permille"], "permille")

    def test_win_rate(self) -> None:
        check(win_rate, self.vectors["winRate"], "win_rate")

    def test_kd(self) -> None:
        check(kd, self.vectors["kd"], "kd")

    def test_clamp(self) -> None:
        check(clamp, self.vectors["clamp"], "clamp")

    def test_to_minor_units(self) -> None:
        check(to_minor_units, self.vectors["toMinorUnits"], "to_minor_units")

    def test_sum(self) -> None:
        check(total, self.vectors["sum"], "total")

    def test_match_result(self) -> None:
        # The enum compares equal to its string value, which is what the
        # TypeScript union holds.
        for case in self.vectors["matchResult"]:
            actual = match_result(*case["args"])
            assert actual.value == case["value"], (
                f"match_result{case['args']!r} -> {actual.value!r}, "
                f"TypeScript gives {case['value']!r}"
            )


class TestIdentity:
    """Identifier conversions, where a difference silently splits one player in two."""

    vectors = load("identity")

    def test_is_steam_id64(self) -> None:
        check(is_steam_id64, self.vectors["isSteamId64"], "is_steam_id64")

    def test_to_steam_id64(self) -> None:
        check(to_steam_id64, self.vectors["toSteamId64"], "to_steam_id64")

    def test_to_steam_account_id(self) -> None:
        check(
            to_steam_account_id,
            self.vectors["toSteamAccountId"],
            "to_steam_account_id",
        )

    def test_to_steam_id2(self) -> None:
        check(to_steam_id2, self.vectors["toSteamId2"], "to_steam_id2")

    def test_to_steam_id3(self) -> None:
        check(to_steam_id3, self.vectors["toSteamId3"], "to_steam_id3")

    def test_parse_riot_id(self) -> None:
        for case in self.vectors["parseRiotId"]:
            if "error" in case:
                with pytest.raises(Exception):  # noqa: B017
                    parse_riot_id(*case["args"])
                continue
            parsed = parse_riot_id(*case["args"])
            assert {
                "gameName": parsed.game_name,
                "tagLine": parsed.tag_line,
            } == case["value"]

    def test_to_battle_tag_path(self) -> None:
        check(to_battle_tag_path, self.vectors["toBattleTagPath"], "to_battle_tag_path")

    def test_normalise_supercell_tag(self) -> None:
        check(
            normalise_supercell_tag,
            self.vectors["normaliseSupercellTag"],
            "normalise_supercell_tag",
        )

    def test_encode_supercell_tag(self) -> None:
        check(
            encode_supercell_tag,
            self.vectors["encodeSupercellTag"],
            "encode_supercell_tag",
        )

    def test_dash_uuid(self) -> None:
        check(dash_uuid, self.vectors["dashUuid"], "dash_uuid")

    def test_undash_uuid(self) -> None:
        check(undash_uuid, self.vectors["undashUuid"], "undash_uuid")


class TestEsports:
    """The provider-capability table, which decides what each title can answer."""

    vectors = load("esports")

    def test_capability_table_matches(self) -> None:
        expected = {
            capability: list(providers)
            for capability, providers in self.vectors["capabilityProviders"].items()
        }
        actual = {
            capability: list(providers)
            for capability, providers in ESPORTS_CAPABILITY_PROVIDERS.items()
        }
        assert actual == expected

    def test_esports_providers_for(self) -> None:
        for case in self.vectors["esportsProvidersFor"]:
            provider_ids, capability = case["args"]
            actual = esports_providers_for(provider_ids, capability)
            expected = case["value"]
            assert (list(actual) if actual is not None else None) == expected, (
                f"esports_providers_for({provider_ids!r}, {capability!r})"
            )


class TestConstants:
    """Values that must not drift.

    A TTL that differs means two deployments show a rank of a different age for
    the same player, and nobody would think to look here for the reason.
    """

    vectors = load("constants")

    def test_version(self) -> None:
        assert self.vectors["version"] == VERSION

    def test_ttl_table(self) -> None:
        assert dict(TTL) == self.vectors["ttl"]

    def test_steam_app_ids(self) -> None:
        # Compared whole, not key by key. A title missing from one edition is
        # exactly the bug this catches: ``SteamStatsClient`` throws when the id
        # is absent, so a gap here is a title that silently stops answering.
        assert dict(STEAM_APP_IDS) == self.vectors["steamAppIds"]

    def test_no_placeholder_app_ids(self) -> None:
        # Zero is not an app id. An entry standing in for "not on Steam" would
        # fail the client's own guard anyway, and it invents a fact.
        assert all(value > 0 for value in STEAM_APP_IDS.values())

    def test_scalars(self) -> None:
        assert self.vectors["permille"] == PERMILLE
        assert self.vectors["maxPageSize"] == MAX_PAGE_SIZE
        assert self.vectors["defaultTtlSeconds"] == DEFAULT_TTL_SECONDS
        assert self.vectors["defaultTimeoutMs"] == DEFAULT_TIMEOUT_MS

    def test_rate_limit_defaults(self) -> None:
        assert self.vectors["defaultRateLimit"]["rps"] == DEFAULT_RPS
        assert self.vectors["defaultRateLimit"]["burst"] == DEFAULT_BURST

    def test_user_agent(self) -> None:
        assert self.vectors["defaultUserAgent"] == DEFAULT_USER_AGENT
