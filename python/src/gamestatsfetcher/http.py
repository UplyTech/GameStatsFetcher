"""The transport.

One place where every request in the package goes out, so that rate limiting,
retries, timeouts and error normalisation exist once rather than fifty times.
Provider modules build a URL and hand it here; they never open a socket.

What this layer deliberately does *not* do is interpret the body. A 200 with a
payload that means "player not found" is a provider quirk, and unpicking it
belongs in that provider's module, next to the rest of its oddities.

Where this edition differs from the TypeScript one
--------------------------------------------------

TypeScript has ``fetch`` built in; Python does not. Rather than make an HTTP
library mandatory - the UplyTech package standard says zero required
dependencies - the transport is a one-method protocol with two implementations:

* :class:`UrllibTransport` uses only the standard library, running the blocking
  call in a worker thread. It needs nothing installed and is fine for a bot
  making a handful of requests.
* :class:`HttpxTransport` is used automatically when ``httpx`` is importable,
  and brings connection pooling and HTTP/2. Install it with the ``http`` extra
  for anything long-running.

Either way the seam is the same one the TypeScript edition exposes through its
``fetch`` option, and it is what every test in this package uses.
"""

from __future__ import annotations

import asyncio
import gzip
import json as jsonlib
import math
import random
import urllib.error
import urllib.request
import zlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import quote

from .constants import (
    DEFAULT_RETRY_ATTEMPTS,
    DEFAULT_RETRY_BASE_DELAY_MS,
    DEFAULT_RETRY_MAX_DELAY_MS,
    DEFAULT_RETRY_ON,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_USER_AGENT,
)
from .errors import (
    AuthenticationError,
    HttpError,
    NetworkError,
    NotFoundError,
    ParseError,
    RateLimitError,
    TimeoutError,
)
from .rate_limiter import TokenBucketRateLimiter
from .types import RetryConfig

__all__ = [
    "HttpResponse",
    "Transport",
    "UrllibTransport",
    "HttpxTransport",
    "default_transport",
    "RequestSpec",
    "HttpClient",
    "append_query",
    "parse_retry_after",
]


@dataclass(frozen=True)
class HttpResponse:
    """What a transport hands back. Deliberately minimal."""

    status: int
    headers: Mapping[str, str]
    text: str

    def header(self, name: str) -> str | None:
        """Case-insensitive header lookup."""
        lowered = name.lower()
        for key, value in self.headers.items():
            if key.lower() == lowered:
                return value
        return None


class Transport(Protocol):
    """One method. Implement it to route this package's requests anywhere."""

    async def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: str | None,
        timeout_ms: int,
    ) -> HttpResponse: ...

    async def aclose(self) -> None: ...


class UrllibTransport:
    """Standard-library transport. No dependencies, no connection reuse.

    The blocking call runs in a worker thread so it never stalls the event loop.
    That is not as good as a real async client - there is no connection pooling
    and each request costs a thread - but it means the package installs and works
    with nothing beyond Python itself.

    Compression is handled here rather than left to the caller, because it is not
    optional: Liquipedia answers **406 Gzip encoding is required for API
    requests** to anything that does not ask for it, and Liquipedia is the
    keyless provider that serves the tournament tier for all 83 titles. ``httpx``
    and ``fetch`` both do this by default, which is why only this transport needs
    to say so.
    """

    def __init__(self) -> None:
        self._opener = urllib.request.build_opener()

    @staticmethod
    def _decode(payload: bytes, encoding: str | None) -> str:
        """Decompress a body according to its ``Content-Encoding``.

        An encoding this does not understand is returned as-is rather than
        raising: it will fail as a ParseError one layer up, which names the
        provider, instead of as an opaque decompression error here.
        """
        label = (encoding or "").strip().lower()
        try:
            if label == "gzip":
                payload = gzip.decompress(payload)
            elif label == "deflate":
                payload = zlib.decompress(payload, -zlib.MAX_WBITS)
        except (OSError, zlib.error):
            pass
        return payload.decode("utf-8", errors="replace")

    async def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: str | None,
        timeout_ms: int,
    ) -> HttpResponse:
        return await asyncio.to_thread(
            self._request_sync, method, url, dict(headers), body, timeout_ms
        )

    def _request_sync(
        self,
        method: str,
        url: str,
        headers: dict[str, str],
        body: str | None,
        timeout_ms: int,
    ) -> HttpResponse:
        data = body.encode("utf-8") if body is not None else None
        # Not merged over the caller's headers: a provider that sets its own
        # Accept-Encoding knows something this layer does not.
        headers = {"Accept-Encoding": "gzip, deflate", **headers}
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=timeout_ms / 1_000) as response:
                return HttpResponse(
                    status=response.status,
                    headers=dict(response.headers.items()),
                    text=self._decode(
                        response.read(), response.headers.get("Content-Encoding")
                    ),
                )
        except urllib.error.HTTPError as error:
            # A non-2xx is a normal answer here, not a transport failure: the
            # HttpClient decides what it means. The body still needs decoding -
            # Liquipedia's 406 explaining the gzip requirement arrives gzipped.
            return HttpResponse(
                status=error.code,
                headers=dict(error.headers.items()) if error.headers else {},
                text=self._decode(
                    error.read(),
                    error.headers.get("Content-Encoding") if error.headers else None,
                ),
            )

    async def aclose(self) -> None:
        return None


class HttpxTransport:
    """Transport backed by ``httpx``. Connection pooling, HTTP/2, real async."""

    def __init__(self, client: Any = None) -> None:
        if client is None:
            import httpx

            client = httpx.AsyncClient(follow_redirects=True)
        self._client = client

    async def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: str | None,
        timeout_ms: int,
    ) -> HttpResponse:
        response = await self._client.request(
            method,
            url,
            headers=dict(headers),
            content=body.encode("utf-8") if body is not None else None,
            timeout=timeout_ms / 1_000,
        )
        return HttpResponse(
            status=response.status_code,
            headers=dict(response.headers),
            text=response.text,
        )

    async def aclose(self) -> None:
        await self._client.aclose()


def default_transport() -> Transport:
    """``httpx`` when it is installed, the standard library otherwise.

    Preferring httpx silently is safe: both implementations answer the same
    questions, and the difference is only in how well they reuse connections.
    """
    try:
        import httpx  # noqa: F401  # type: ignore[import-not-found]
    except ImportError:
        return UrllibTransport()
    return HttpxTransport()


@dataclass(frozen=True)
class RequestSpec:
    """Everything a provider can vary about one request."""

    method: str = "GET"
    #: Appended to the URL. Encoding happens here, so pass raw values.
    query: Mapping[str, Any] = field(default_factory=dict)
    headers: Mapping[str, str] = field(default_factory=dict)
    #: Serialised as JSON with the matching Content-Type.
    json: Any = None
    #: Sent verbatim. Use for form bodies; set Content-Type yourself.
    body: str | None = None
    #: Treat a 404 as an empty answer instead of an error.
    #:
    #: A handful of endpoints - Riot's league entries, Supercell's club lookup -
    #: use 404 to mean "this player has none of these", which is a normal result
    #: and not a missing player.
    null_on_404: bool = False
    #: ``json`` (default) or ``text``.
    parse: str = "json"
    #: Overrides the client-wide timeout for one call.
    timeout_ms: int | None = None
    #: Longest the limiter may block this call before it gives up.
    max_wait_ms: float = 5_000

    def merged(self, **changes: Any) -> RequestSpec:
        from dataclasses import replace as _replace

        return _replace(self, **changes)


def redact_secrets(text: str, secrets: Sequence[str]) -> str:
    """Replace every known credential with ``***``.

    Sorted longest-first so a key that contains another as a prefix - a
    ``clientId:clientSecret`` pair and the id on its own, which is exactly how
    the Blizzard and osu! credentials are shaped - is redacted whole rather than
    leaving the tail exposed.

    Short values are skipped. A one-character "key" is a placeholder from a test
    or a misconfiguration, and redacting it would turn every message into
    asterisks and hide the actual problem.
    """
    output = text
    for secret in sorted(secrets, key=len, reverse=True):
        if len(secret) < 8:
            continue
        output = output.replace(secret, "***")
    return output


class HttpClient:
    """Rate limiting, retries, timeouts and error normalisation, once."""

    def __init__(
        self,
        *,
        transport: Transport,
        limiter: TokenBucketRateLimiter,
        logger: Any,
        retry: RetryConfig | None = None,
        timeout_ms: int | None = None,
        user_agent: str | None = None,
        random_source: random.Random | None = None,
        secrets: Sequence[str] = (),
    ) -> None:
        self._transport = transport
        self._limiter = limiter
        self._logger = logger
        self._attempts = (
            retry.attempts if retry and retry.attempts is not None else DEFAULT_RETRY_ATTEMPTS
        )
        self._base_delay_ms = (
            retry.base_delay_ms
            if retry and retry.base_delay_ms is not None
            else DEFAULT_RETRY_BASE_DELAY_MS
        )
        self._max_delay_ms = (
            retry.max_delay_ms
            if retry and retry.max_delay_ms is not None
            else DEFAULT_RETRY_MAX_DELAY_MS
        )
        self._retry_on: Sequence[int] = tuple(
            retry.retry_on if retry and retry.retry_on is not None else DEFAULT_RETRY_ON
        )
        self._respect_retry_after = retry.respect_retry_after if retry else True
        self._timeout_ms = timeout_ms or DEFAULT_TIMEOUT_MS
        self._user_agent = user_agent or DEFAULT_USER_AGENT
        self._random = random_source or random.Random()
        # Every configured credential, so nothing this layer emits can contain
        # one. Eight providers authenticate by query parameter, which puts the
        # key in the URL; errors here never carry the URL, but a transport error
        # message can be built from it and an upstream error body frequently
        # quotes the key back ("invalid api key: abc123"). Both end up in
        # somebody's log aggregator.
        self._secrets: tuple[str, ...] = tuple(
            value for value in secrets if isinstance(value, str) and value
        )

    def _safe(self, text: str) -> str:
        """Nothing this client reports may contain a credential."""
        return redact_secrets(text, self._secrets) if self._secrets else text

    async def send(self, provider_id: str, url: str, spec: RequestSpec | None = None) -> Any:
        """Send one request, with rate limiting, retries and normalised errors.

        Returns ``None`` only when ``null_on_404`` was set and the upstream
        answered 404, or when the body was empty.
        """
        spec = spec or RequestSpec()
        final_url = append_query(url, spec.query) if spec.query else url
        attempts = max(0, self._attempts) + 1
        last_error: Exception | None = None

        for attempt in range(attempts):
            # The limiter is inside the retry loop on purpose: a retry is a new
            # request against the provider's quota, not a free continuation.
            await self._limiter.acquire(provider_id, spec.max_wait_ms)
            try:
                return await self._attempt(provider_id, final_url, spec)
            except Exception as error:  # noqa: BLE001 - re-raised below
                last_error = error
                delay = self._retry_delay(error, attempt)
                if delay is None or attempt == attempts - 1:
                    raise
                self._logger.debug(
                    "[gsf] %s attempt %d/%d failed, retrying in %dms",
                    provider_id,
                    attempt + 1,
                    attempts,
                    delay,
                )
                await asyncio.sleep(delay / 1_000)

        # Unreachable: the loop above either returns or raises on its last pass.
        # Spelled out rather than asserted so a future change to the loop fails
        # loudly here instead of returning None to a caller expecting a payload.
        raise last_error or RuntimeError(  # pragma: no cover
            f"{provider_id}: retry loop ended without a result"
        )

    async def _attempt(self, provider_id: str, url: str, spec: RequestSpec) -> Any:
        timeout_ms = spec.timeout_ms or self._timeout_ms
        headers: dict[str, str] = {
            "Accept": "*/*" if spec.parse == "text" else "application/json",
            "User-Agent": self._user_agent,
            **spec.headers,
        }

        body: str | None = None
        if spec.json is not None:
            body = jsonlib.dumps(spec.json)
            headers.setdefault("Content-Type", "application/json")
        elif spec.body is not None:
            body = spec.body

        try:
            response = await asyncio.wait_for(
                self._transport.request(
                    spec.method,
                    url,
                    headers=headers,
                    body=body,
                    timeout_ms=timeout_ms,
                ),
                timeout=timeout_ms / 1_000 + 1,
            )
        except asyncio.TimeoutError as error:
            raise TimeoutError(provider_id, timeout_ms) from error
        except OSError as error:
            raise NetworkError(provider_id, self._safe(str(error)), error) from error

        if response.status == 404 and spec.null_on_404:
            return None
        if not 200 <= response.status < 300:
            raise self._to_error(provider_id, response)

        if spec.parse == "text":
            return response.text
        if response.status == 204 or not response.text:
            return None
        try:
            return jsonlib.loads(response.text)
        except ValueError as error:
            raise ParseError(provider_id, "response body was not valid JSON", error) from error

    def _to_error(self, provider_id: str, response: HttpResponse) -> Exception:
        """Map a non-2xx onto the class that says what actually went wrong."""
        body = response.text

        if response.status in (401, 403):
            # The likeliest place of all for a key to come back: an API that
            # answers "invalid api key: abc123" does it on exactly this status.
            return AuthenticationError(
                provider_id, self._safe(_truncate(body)) or "key rejected"
            )
        if response.status == 404:
            return NotFoundError(provider_id, "resource")
        if response.status == 429:
            retry_after_ms = parse_retry_after(response.header("Retry-After"))
            # Tell the limiter, so concurrent callers stop rather than pile on.
            self._limiter.penalize(provider_id, retry_after_ms or 1_000)
            return RateLimitError(provider_id, retry_after_ms)
        return HttpError(provider_id, response.status, self._safe(body))

    def _retry_delay(self, error: Exception, attempt: int) -> float | None:
        """How long to wait before the next attempt, or ``None`` to give up now."""
        status = error.status_code if isinstance(error, HttpError) else None
        retryable = isinstance(error, (NetworkError, TimeoutError, RateLimitError)) or (
            status is not None and status in self._retry_on
        )
        if not retryable:
            return None

        if (
            self._respect_retry_after
            and isinstance(error, RateLimitError)
            and error.retry_after_ms is not None
        ):
            # The provider knows when its window resets and we are guessing.
            return min(error.retry_after_ms, self._max_delay_ms)

        exponential = self._base_delay_ms * (2**attempt)
        # Full jitter. Without it, a fan-out of twenty match lookups that all hit
        # a 429 would retry in lockstep and hit the same wall again.
        jittered: float = self._random.random() * exponential
        return min(max(self._base_delay_ms / 2, jittered), float(self._max_delay_ms))


def append_query(url: str, query: Mapping[str, Any]) -> str:
    """Append query parameters, dropping empty ones and repeating list values."""
    parts: list[str] = []
    for key, value in query.items():
        if value is None:
            continue
        values = value if isinstance(value, (list, tuple)) else [value]
        for item in values:
            if item is None:
                continue
            rendered = _render_query_value(item)
            parts.append(f"{quote(str(key), safe='')}={quote(rendered, safe='')}")
    if not parts:
        return url
    separator = "&" if "?" in url else "?"
    return f"{url}{separator}{'&'.join(parts)}"


def _render_query_value(value: Any) -> str:
    """Render a value the way the TypeScript edition's ``String()`` would.

    Booleans are the trap: Python renders ``True``, JavaScript renders ``true``,
    and an API told ``include_appinfo=True`` treats it as a string rather than a
    flag.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def parse_retry_after(header: str | None) -> int | None:
    """Parse ``Retry-After``, which is either a delay in seconds or an HTTP date.

    Both forms appear in the wild - Riot sends seconds, and the Cloudflare in
    front of several community APIs sends a date.
    """
    if not header:
        return None
    try:
        return max(0, round(float(header) * 1_000))
    except ValueError:
        pass

    from email.utils import parsedate_to_datetime

    try:
        parsed = parsedate_to_datetime(header)
    except (TypeError, ValueError):
        return None
    import time as _time
    from datetime import timezone as _timezone

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_timezone.utc)
    return max(0, math.floor(parsed.timestamp() * 1_000 - _time.time() * 1_000))


def _truncate(text: str, limit: int = 200) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else f"{flat[:limit]}..."
