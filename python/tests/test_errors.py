"""Errors.

Four different kinds of "no data" need four different messages to a user, and
this module is where that distinction is kept. The tests care about two things:
that the message tells somebody what to do next, and that the ``code`` is stable
enough to branch on - because callers will branch on something, and if it is not
``code`` it will be the message text.
"""

from __future__ import annotations

import pytest

from gamestatsfetcher import (
    AllProvidersFailedError,
    AuthenticationError,
    CacheError,
    GameStatsError,
    HttpError,
    IdentifierError,
    LocalRateLimitError,
    MissingCredentialError,
    NetworkError,
    NotFoundError,
    ParseError,
    PrivateProfileError,
    RateLimitError,
    TimeoutError,
    UnknownProviderError,
    UnknownTitleError,
    UnsupportedCapabilityError,
    ValidationError,
    is_retryable_with_fallback,
)

ALL_ERRORS = [
    AllProvidersFailedError,
    AuthenticationError,
    CacheError,
    HttpError,
    IdentifierError,
    LocalRateLimitError,
    MissingCredentialError,
    NetworkError,
    NotFoundError,
    ParseError,
    PrivateProfileError,
    RateLimitError,
    TimeoutError,
    UnknownProviderError,
    UnknownTitleError,
    UnsupportedCapabilityError,
    ValidationError,
]


class TestHierarchy:
    @pytest.mark.parametrize("error_class", ALL_ERRORS)
    def test_everything_derives_from_the_base(self, error_class: type) -> None:
        # One `except GameStatsError` catches everything this package raises and
        # nothing it does not - which is the whole reason for a base class.
        assert issubclass(error_class, GameStatsError)
        assert issubclass(error_class, Exception)

    @pytest.mark.parametrize("error_class", ALL_ERRORS)
    def test_every_code_is_distinct(self, error_class: type) -> None:
        assert error_class.code != GameStatsError.code, error_class.__name__

    def test_codes_are_unique_across_the_module(self) -> None:
        # Two classes sharing a code makes branching on it silently wrong.
        codes = [cls.code for cls in ALL_ERRORS]
        assert len(set(codes)) == len(codes)

    def test_timeout_is_ours_and_not_the_builtin(self) -> None:
        # It shadows the builtin name on purpose, so `from gamestatsfetcher
        # import TimeoutError` reads naturally. The catch is that a module which
        # does *not* import it will not catch ours with a bare `except
        # TimeoutError` - which is why it carries the package's provider and
        # code fields, and why callers are pointed at GameStatsError instead.
        import builtins

        assert TimeoutError is not builtins.TimeoutError
        assert not issubclass(TimeoutError, builtins.TimeoutError)
        assert issubclass(TimeoutError, GameStatsError)


class TestMessages:
    def test_missing_credential_names_the_option_and_the_page(self) -> None:
        # The two things somebody debugging a deployment at 3am actually needs.
        error = MissingCredentialError(
            "steam", "steam", "https://steamcommunity.com/dev/apikey"
        )
        assert "api_keys.steam" in str(error)
        assert "https://steamcommunity.com/dev/apikey" in str(error)
        assert error.key_name == "steam"

    def test_unsupported_capability_lists_what_the_title_can_do(self) -> None:
        # A caller reading this in a log should not have to open the registry.
        error = UnsupportedCapabilityError(
            "tekken-8", "getRank", ["getEsportsMatches", "getEarnings"]
        )
        assert "tekken-8 does not support getRank" in str(error)
        assert "getEsportsMatches, getEarnings" in str(error)

    def test_unsupported_capability_on_a_title_that_supports_nothing(self) -> None:
        assert "nothing yet" in str(UnsupportedCapabilityError("x", "getRank", []))

    def test_unknown_title_offers_suggestions(self) -> None:
        error = UnknownTitleError("leage-of-legends", ["league-of-legends"])
        assert "Did you mean: league-of-legends?" in str(error)

    def test_unknown_title_without_suggestions_does_not_dangle(self) -> None:
        assert str(UnknownTitleError("zzz")).endswith('"zzz"')

    def test_identifier_error_names_what_would_have_worked(self) -> None:
        error = IdentifierError("cs2", ["steam_id", "name"])
        assert "steam_id" in str(error)

    def test_rate_limit_includes_the_wait_when_upstream_said_one(self) -> None:
        assert "retry in 5000ms" in str(RateLimitError("riot", 5_000))
        assert "retry in" not in str(RateLimitError("riot", None))

    def test_all_providers_failed_carries_every_failure(self) -> None:
        # The first failure is rarely the interesting one: "no key", then "429",
        # then "500" is three different fixes.
        error = AllProvidersFailedError(
            "cs2",
            "getEsportsMatches",
            [
                ("pandascore", MissingCredentialError("pandascore", "pandascore", "u")),
                ("startgg", RateLimitError("startgg", None)),
            ],
        )
        assert "pandascore (MISSING_CREDENTIAL)" in str(error)
        assert "startgg (RATE_LIMIT)" in str(error)
        assert len(error.failures) == 2


class TestContext:
    def test_the_provider_and_title_survive_onto_the_error(self) -> None:
        # Which of a title's several providers failed is the first question
        # anybody asks, and the answer must not be only in the message text.
        error = NotFoundError("steam", "player 123", title_id="cs2")
        assert (error.provider, error.title_id, error.status_code) == (
            "steam",
            "cs2",
            404,
        )

    def test_to_dict_is_log_safe(self) -> None:
        # Errors travel into logs and error trackers. No key is stored on an
        # error, so none can leak through here - and the upstream body, which
        # can contain anything, is deliberately not in the mapping.
        error = HttpError("riot", 500, "internal error", cause="x-api-key=SECRET")
        payload = error.to_dict()
        assert payload["code"] == "HTTP_ERROR"
        assert payload["provider"] == "riot"
        assert payload["statusCode"] == 500
        assert "SECRET" not in repr(payload)
        assert "cause" not in payload

    def test_a_long_upstream_body_is_truncated(self) -> None:
        # A 2 MB HTML error page must not land in a single log line.
        error = HttpError("riot", 500, "x" * 5_000)
        assert len(error.message) < 500
        assert error.message.endswith("...")

    def test_newlines_are_flattened(self) -> None:
        # Multi-line messages break single-line log parsing.
        error = HttpError("riot", 500, "first line\nsecond line")
        assert "\n" not in error.message

    def test_timeout_states_the_budget_it_exceeded(self) -> None:
        error = TimeoutError("riot", 15_000)
        assert "15000" in str(error)
        assert error.provider == "riot"


class TestFallbackPolicy:
    @pytest.mark.parametrize(
        "error",
        [
            HttpError("p", 500, "boom"),
            NetworkError("p", "connection reset"),
            TimeoutError("p", 15_000),
            RateLimitError("p", None),
            LocalRateLimitError("p", 1_000),
            MissingCredentialError("p", "k", "u"),
            ParseError("p", "schema changed"),
        ],
    )
    def test_transport_and_configuration_failures_are_worth_a_second_provider(
        self, error: GameStatsError
    ) -> None:
        assert is_retryable_with_fallback(error) is True

    @pytest.mark.parametrize(
        "error",
        [
            NotFoundError("p", "player"),
            PrivateProfileError("p", "player"),
            ValidationError("bad input"),
            UnsupportedCapabilityError("t", "getRank", []),
            UnknownTitleError("t"),
        ],
    )
    def test_facts_about_the_world_are_not(self, error: GameStatsError) -> None:
        # A player who does not exist does not exist anywhere, and a private
        # profile stays private. Asking a second provider only spends quota.
        assert is_retryable_with_fallback(error) is False

    def test_an_error_from_outside_this_package_is_not_retried(self) -> None:
        # A KeyError is a bug here, not an upstream problem, and retrying it
        # against a second provider would hide the bug behind a slower failure.
        assert is_retryable_with_fallback(KeyError("boom")) is False
        assert is_retryable_with_fallback(None) is False
