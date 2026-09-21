"""The error hierarchy.

Every error raised by this package derives from :class:`GameStatsError`, so a
caller can catch one class and still branch on ``code`` or ``isinstance``.

The distinction that matters most in practice is between the four kinds of
"no data":

============================  ==========================  =========================
Situation                     Error                       What the caller should do
============================  ==========================  =========================
The player does not exist     :class:`NotFoundError`      tell the user
The profile is private        :class:`PrivateProfileError`  tell the user to open it
The title cannot do this      :class:`UnsupportedCapabilityError`  fix the code
No key was configured         :class:`MissingCredentialError`      fix the deployment
============================  ==========================  =========================

Collapsing those into one "failed" would make every one of them look like an
outage, and three of the four are not.

The class names, the ``code`` strings and the message wording are identical to
the TypeScript edition, so a log line from a Python bot and one from a Node
service can be grepped the same way.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

__all__ = [
    "GameStatsError",
    "HttpError",
    "NetworkError",
    "TimeoutError",
    "AuthenticationError",
    "MissingCredentialError",
    "RateLimitError",
    "LocalRateLimitError",
    "NotFoundError",
    "PrivateProfileError",
    "ValidationError",
    "IdentifierError",
    "UnsupportedCapabilityError",
    "UnknownTitleError",
    "UnknownProviderError",
    "ParseError",
    "CacheError",
    "AllProvidersFailedError",
    "is_retryable_with_fallback",
]


def _truncate(text: str, limit: int = 300) -> str:
    """Flatten and shorten an upstream body.

    A 2 MB HTML error page must not land in a log line, and newlines in a
    message break single-line log parsing.
    """
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else f"{flat[:limit]}..."


class GameStatsError(Exception):
    """Base class for every error raised by this package."""

    #: Stable, machine-readable discriminator. Never compare message texts.
    code: str = "GAMESTATS_ERROR"

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        provider: str | None = None,
        title_id: str | None = None,
        status_code: int | None = None,
        cause: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code
        #: Provider the failure came from, when there was one.
        self.provider = provider
        #: Title the call was about, when there was one.
        self.title_id = title_id
        #: Upstream HTTP status, when the failure was an HTTP response.
        self.status_code = status_code
        #: Whatever caused this - an upstream body, an OSError from the socket.
        self.cause = cause

    def to_dict(self) -> dict[str, Any]:
        """A log-safe mapping. Never contains an API key - none is stored here."""
        return {
            "name": type(self).__name__,
            "code": self.code,
            "message": self.message,
            "provider": self.provider,
            "titleId": self.title_id,
            "statusCode": self.status_code,
        }

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"{type(self).__name__}({self.message!r}, code={self.code!r})"


class HttpError(GameStatsError):
    """An upstream request failed with a status no specific class covers."""

    code = "HTTP_ERROR"

    def __init__(self, provider: str, status_code: int, body: str, cause: Any = None) -> None:
        super().__init__(
            f"{provider} responded {status_code}: {_truncate(body)}",
            provider=provider,
            status_code=status_code,
            cause=cause,
        )
        #: The response body, untruncated. Upstreams put the real reason here.
        self.body = body


class NetworkError(GameStatsError):
    """The request never got a response: DNS, TLS, socket, or a reset."""

    code = "NETWORK_ERROR"

    def __init__(self, provider: str, message: str, cause: Any = None) -> None:
        super().__init__(f"{provider} unreachable: {message}", provider=provider, cause=cause)


class TimeoutError(GameStatsError):  # noqa: A001 - shadows the builtin deliberately
    """The request exceeded ``timeout_ms`` and was abandoned locally.

    Named to match the TypeScript edition. Catch it as
    ``gamestatsfetcher.TimeoutError``; the builtin is still reachable as
    ``builtins.TimeoutError``.
    """

    code = "TIMEOUT"

    def __init__(self, provider: str, timeout_ms: int) -> None:
        super().__init__(
            f"{provider} did not respond within {timeout_ms}ms", provider=provider
        )
        self.timeout_ms = timeout_ms


class AuthenticationError(GameStatsError):
    """Upstream returned 401 or 403: wrong key, expired key, or missing scope."""

    code = "AUTH_ERROR"

    def __init__(
        self, provider: str, message: str = "authentication rejected", cause: Any = None
    ) -> None:
        super().__init__(
            f"{provider}: {message}", provider=provider, status_code=401, cause=cause
        )


class MissingCredentialError(GameStatsError):
    """No key was configured for a provider that needs one.

    Raised before any network call, and it names the option and the page the key
    comes from - the two things somebody debugging a deployment actually needs.
    """

    code = "MISSING_CREDENTIAL"

    def __init__(
        self, provider: str, key_name: str, docs_url: str, title_id: str | None = None
    ) -> None:
        super().__init__(
            f"{provider} needs an API key. Pass it as api_keys.{key_name} - "
            f"get one at {docs_url}",
            provider=provider,
            title_id=title_id,
        )
        self.key_name = key_name
        self.docs_url = docs_url


class RateLimitError(GameStatsError):
    """Upstream returned 429."""

    code = "RATE_LIMIT"

    def __init__(self, provider: str, retry_after_ms: int | None, cause: Any = None) -> None:
        message = (
            f"{provider} rate limit reached"
            if retry_after_ms is None
            else f"{provider} rate limit reached, retry in {retry_after_ms}ms"
        )
        super().__init__(message, provider=provider, status_code=429, cause=cause)
        #: From the ``Retry-After`` header, when the provider sent one.
        self.retry_after_ms = retry_after_ms


class LocalRateLimitError(GameStatsError):
    """The local token bucket refused the request before it reached the network.

    This is the limiter doing its job: it is cheaper to wait here than to spend
    one of the provider's quota on a request that would come back 429.
    """

    code = "LOCAL_RATE_LIMIT"

    def __init__(self, provider: str, retry_after_ms: int) -> None:
        super().__init__(
            f"local rate limit for {provider} would need a {retry_after_ms}ms wait",
            provider=provider,
        )
        self.retry_after_ms = retry_after_ms


class NotFoundError(GameStatsError):
    """The player, match or tournament does not exist."""

    code = "NOT_FOUND"

    def __init__(self, provider: str, what: str, title_id: str | None = None) -> None:
        super().__init__(
            f"{provider}: {what} not found",
            provider=provider,
            status_code=404,
            title_id=title_id,
        )


class PrivateProfileError(GameStatsError):
    """The account exists but its stats are hidden.

    Steam, Xbox and PlayStation all default new profiles to private, so this is
    a frequent and normal outcome rather than an exceptional one - and it needs
    a different message to the user than "not found".
    """

    code = "PRIVATE_PROFILE"

    def __init__(self, provider: str, player_id: str, title_id: str | None = None) -> None:
        super().__init__(
            f"{provider}: profile {player_id} is private",
            provider=provider,
            title_id=title_id,
        )


class ValidationError(GameStatsError):
    """The caller passed something this package can reject without asking upstream."""

    code = "VALIDATION_ERROR"

    def __init__(self, message: str, cause: Any = None) -> None:
        super().__init__(message, cause=cause)


class IdentifierError(GameStatsError):
    """The identifiers given are not ones this title accepts.

    The message lists what the title does accept, because "invalid identifier"
    on its own sends the caller to the documentation for no reason.
    """

    code = "IDENTIFIER_ERROR"

    def __init__(self, title_id: str, accepted: Sequence[str]) -> None:
        super().__init__(
            f"{title_id} cannot resolve a player from the fields given. "
            f"It accepts: {', '.join(accepted)}",
            title_id=title_id,
        )
        self.accepted = tuple(accepted)


class UnsupportedCapabilityError(GameStatsError):
    """The title exists but does not support this method.

    Raised, never swallowed into an empty list: a caller who asks Tekken 8 for a
    solo-queue rank has a bug, and an empty list would hide it until somebody
    noticed the dashboard had been blank for a month.
    """

    code = "UNSUPPORTED_CAPABILITY"

    def __init__(self, title_id: str, capability: str, supported: Sequence[str]) -> None:
        super().__init__(
            f"{title_id} does not support {capability}. "
            f"It supports: {', '.join(supported) or 'nothing yet'}",
            title_id=title_id,
        )
        self.capability = capability
        self.supported = tuple(supported)


class UnknownTitleError(GameStatsError):
    """The title id is not in the registry."""

    code = "UNKNOWN_TITLE"

    def __init__(self, title_id: str, suggestions: Sequence[str] = ()) -> None:
        message = (
            f'unknown title "{title_id}". Did you mean: {", ".join(suggestions)}?'
            if suggestions
            else f'unknown title "{title_id}"'
        )
        super().__init__(message, title_id=title_id)
        self.suggestions = tuple(suggestions)


class UnknownProviderError(GameStatsError):
    """The provider id is not in the registry."""

    code = "UNKNOWN_PROVIDER"

    def __init__(self, provider_id: str) -> None:
        super().__init__(f'unknown provider "{provider_id}"', provider=provider_id)


class ParseError(GameStatsError):
    """Upstream answered, but not with anything this package can map.

    Usually means the provider changed its schema. Kept distinct from
    :class:`HttpError` so a schema drift is visible in logs as itself rather
    than as a generic failure.
    """

    code = "PARSE_ERROR"

    def __init__(self, provider: str, message: str, cause: Any = None) -> None:
        super().__init__(
            f"{provider} returned an unexpected shape: {message}",
            provider=provider,
            cause=cause,
        )


class CacheError(GameStatsError):
    """The cache layer failed. Never propagates - caching is always best-effort."""

    code = "CACHE_ERROR"

    def __init__(self, message: str, cause: Any = None) -> None:
        super().__init__(message, cause=cause)


class AllProvidersFailedError(GameStatsError):
    """Every provider in a title's fallback chain failed.

    Carries all of them, because the first failure is rarely the interesting
    one: "no key" followed by "429" followed by "500" is three different fixes.
    """

    code = "ALL_PROVIDERS_FAILED"

    def __init__(
        self,
        title_id: str,
        capability: str,
        failures: Sequence[tuple[str, GameStatsError]],
    ) -> None:
        detail = ", ".join(f"{provider} ({error.code})" for provider, error in failures)
        super().__init__(
            f"every provider for {title_id}.{capability} failed: {detail}",
            title_id=title_id,
        )
        self.failures = tuple(failures)


def is_retryable_with_fallback(error: object) -> bool:
    """True for the errors where trying the next provider could plausibly help.

    A player who does not exist does not exist anywhere, and a private profile
    stays private - switching provider there only wastes a request.
    """
    if not isinstance(error, GameStatsError):
        return False
    return error.code in {
        "HTTP_ERROR",
        "NETWORK_ERROR",
        "TIMEOUT",
        "RATE_LIMIT",
        "LOCAL_RATE_LIMIT",
        "MISSING_CREDENTIAL",
        "PARSE_ERROR",
    }
