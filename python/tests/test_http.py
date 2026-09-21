"""The transport layer.

Every request in the package goes through here, so this is where rate limiting,
retries, timeouts and error normalisation are proven once instead of fifty
times. The transport is a Protocol precisely so these tests need no network and
no mocking framework.
"""

from __future__ import annotations

import asyncio
import json
import random
from collections.abc import Mapping
from typing import Any

import pytest

from conftest import MockTransport, Route
from conftest import test_options as client_options
from gamestatsfetcher import (
    AuthenticationError,
    GameStatsClient,
    GameStatsError,
    HttpClient,
    HttpError,
    HttpResponse,
    NetworkError,
    NotFoundError,
    ParseError,
    RateLimitConfig,
    RateLimitError,
    RequestSpec,
    RetryConfig,
    TimeoutError,
    UrllibTransport,
    append_query,
    default_transport,
    parse_retry_after,
    redact_secrets,
    silent_logger,
)
from gamestatsfetcher.rate_limiter import TokenBucketRateLimiter

LOG = silent_logger()


class StubTransport:
    """Returns canned responses in order, recording what it was asked."""

    def __init__(self, *responses: HttpResponse | Exception) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, str, Mapping[str, str], str | None, int]] = []
        self.closed = False

    async def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: str | None,
        timeout_ms: int,
    ) -> HttpResponse:
        self.calls.append((method, url, dict(headers), body, timeout_ms))
        item = self.responses[min(len(self.calls) - 1, len(self.responses) - 1)]
        if isinstance(item, Exception):
            raise item
        return item

    async def aclose(self) -> None:
        self.closed = True


def ok(body: Any = None, status: int = 200, **headers: str) -> HttpResponse:
    return HttpResponse(
        status=status,
        headers={"Content-Type": "application/json", **headers},
        text="" if body is None else json.dumps(body),
    )


def client(
    transport: StubTransport,
    *,
    retry: RetryConfig | None = None,
    limiter: TokenBucketRateLimiter | None = None,
    **kwargs: Any,
) -> HttpClient:
    return HttpClient(
        transport=transport,
        limiter=limiter
        or TokenBucketRateLimiter(fallback=RateLimitConfig(rps=1_000, burst=1_000)),
        logger=LOG,
        retry=retry or RetryConfig(attempts=0),
        # A fixed seed makes the jittered backoff reproducible.
        random_source=random.Random(0),
        **kwargs,
    )


class TestSuccess:
    async def test_parses_json(self) -> None:
        transport = StubTransport(ok({"id": 1}))
        assert await client(transport).send("p", "https://x/y") == {"id": 1}

    async def test_returns_text_when_asked_to(self) -> None:
        # Liquipedia's wikitext and a few CSV endpoints are not JSON.
        transport = StubTransport(HttpResponse(status=200, headers={}, text="plain words"))
        result = await client(transport).send("p", "https://x/y", RequestSpec(parse="text"))
        assert result == "plain words"

    async def test_an_empty_body_is_none_not_a_parse_error(self) -> None:
        transport = StubTransport(HttpResponse(status=200, headers={}, text=""))
        assert await client(transport).send("p", "https://x/y") is None

    async def test_204_is_none(self) -> None:
        transport = StubTransport(HttpResponse(status=204, headers={}, text=""))
        assert await client(transport).send("p", "https://x/y") is None

    async def test_the_user_agent_is_always_sent(self) -> None:
        # Liquipedia requires a descriptive one as a condition of use, and
        # several providers block the default urllib agent outright.
        transport = StubTransport(ok({}))
        await client(transport).send("p", "https://x/y")
        assert "GameStatsFetcher/" in transport.calls[0][2]["User-Agent"]

    async def test_a_provider_can_override_the_headers(self) -> None:
        transport = StubTransport(ok({}))
        await client(transport).send("p", "https://x/y", RequestSpec(headers={"X-Key": "abc"}))
        assert transport.calls[0][2]["X-Key"] == "abc"

    async def test_a_json_body_sets_its_own_content_type(self) -> None:
        transport = StubTransport(ok({}))
        await client(transport).send(
            "p", "https://x/y", RequestSpec(method="POST", json={"q": 1})
        )
        _, _, headers, body, _ = transport.calls[0]
        assert headers["Content-Type"] == "application/json"
        assert json.loads(body or "") == {"q": 1}

    async def test_a_raw_body_is_sent_verbatim(self) -> None:
        # Form bodies, for the OAuth token endpoints.
        transport = StubTransport(ok({}))
        await client(transport).send(
            "p",
            "https://x/y",
            RequestSpec(
                method="POST",
                body="grant_type=client_credentials",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            ),
        )
        assert transport.calls[0][3] == "grant_type=client_credentials"

    async def test_query_parameters_are_appended(self) -> None:
        transport = StubTransport(ok({}))
        await client(transport).send("p", "https://x/y", RequestSpec(query={"limit": 10}))
        assert transport.calls[0][1] == "https://x/y?limit=10"


class TestErrorMapping:
    """A status is not an error message. This is where it becomes one."""

    async def test_401_and_403_are_authentication_failures(self) -> None:
        for status in (401, 403):
            transport = StubTransport(ok({"error": "nope"}, status=status))
            with pytest.raises(AuthenticationError):
                await client(transport).send("p", "https://x/y")

    async def test_404_is_not_found(self) -> None:
        transport = StubTransport(ok(None, status=404))
        with pytest.raises(NotFoundError):
            await client(transport).send("p", "https://x/y")

    async def test_404_can_mean_an_empty_answer_instead(self) -> None:
        # Riot's league entries and Supercell's club lookup use 404 for "this
        # player has none of these", which is a normal result.
        transport = StubTransport(ok(None, status=404))
        result = await client(transport).send(
            "p", "https://x/y", RequestSpec(null_on_404=True)
        )
        assert result is None

    async def test_429_becomes_a_rate_limit_error(self) -> None:
        transport = StubTransport(ok({}, status=429, **{"Retry-After": "2"}))
        with pytest.raises(RateLimitError) as caught:
            await client(transport).send("p", "https://x/y")
        assert caught.value.retry_after_ms == 2_000

    async def test_a_429_penalises_the_shared_bucket(self) -> None:
        # The one that matters: every concurrent caller for this provider stops,
        # not just the one that received the 429.
        limiter = TokenBucketRateLimiter(fallback=RateLimitConfig(rps=1_000, burst=1_000))
        transport = StubTransport(ok({}, status=429, **{"Retry-After": "5"}))
        with pytest.raises(RateLimitError):
            await client(transport, limiter=limiter).send("p", "https://x/y")
        assert limiter.available_in("p") > 0

    async def test_a_500_is_an_http_error_carrying_the_status(self) -> None:
        transport = StubTransport(ok({"msg": "boom"}, status=500))
        with pytest.raises(HttpError) as caught:
            await client(transport).send("p", "https://x/y")
        assert caught.value.status_code == 500
        assert caught.value.provider == "p"

    async def test_malformed_json_is_a_parse_error_not_an_http_error(self) -> None:
        # A schema drift should be visible in logs as itself. The upstream
        # answered fine; it is the body this package cannot use.
        transport = StubTransport(
            HttpResponse(status=200, headers={}, text="<html>oops</html>")
        )
        with pytest.raises(ParseError):
            await client(transport).send("p", "https://x/y")

    async def test_a_socket_failure_is_a_network_error(self) -> None:
        transport = StubTransport(OSError("connection reset"))
        with pytest.raises(NetworkError):
            await client(transport).send("p", "https://x/y")

    async def test_a_hung_request_is_a_timeout(self) -> None:
        class Hanging:
            async def request(self, *args: Any, **kwargs: Any) -> HttpResponse:
                await asyncio.sleep(10)
                raise AssertionError("unreachable")

            async def aclose(self) -> None: ...

        http = HttpClient(
            transport=Hanging(),
            limiter=TokenBucketRateLimiter(fallback=RateLimitConfig(rps=1_000, burst=1_000)),
            logger=LOG,
            retry=RetryConfig(attempts=0),
            timeout_ms=10,
        )
        with pytest.raises(TimeoutError):
            await http.send("p", "https://x/y")


class TestRetries:
    async def test_a_500_is_retried(self) -> None:
        transport = StubTransport(ok({}, status=500), ok({"ok": True}))
        result = await client(transport, retry=RetryConfig(attempts=1)).send(
            "p", "https://x/y"
        )
        assert result == {"ok": True}
        assert len(transport.calls) == 2

    async def test_a_404_is_not_retried(self) -> None:
        # A player who does not exist will not exist on the second attempt, and
        # asking again spends quota to learn nothing.
        transport = StubTransport(ok(None, status=404))
        with pytest.raises(NotFoundError):
            await client(transport, retry=RetryConfig(attempts=3)).send("p", "https://x/y")
        assert len(transport.calls) == 1

    async def test_a_400_is_not_retried(self) -> None:
        transport = StubTransport(ok({"error": "bad query"}, status=400))
        with pytest.raises(HttpError):
            await client(transport, retry=RetryConfig(attempts=3)).send("p", "https://x/y")
        assert len(transport.calls) == 1

    async def test_attempts_are_bounded(self) -> None:
        transport = StubTransport(ok({}, status=503))
        with pytest.raises(HttpError):
            await client(transport, retry=RetryConfig(attempts=2, base_delay_ms=1)).send(
                "p", "https://x/y"
            )
        assert len(transport.calls) == 3  # the first, plus two retries

    async def test_a_retry_spends_a_token_of_its_own(self) -> None:
        # A retry is a new request against the provider's quota, not a free
        # continuation of the first - so the limiter sits inside the retry loop.
        # The refill rate is effectively zero so the backoff sleep cannot put
        # the tokens back before the assertion reads them.
        limiter = TokenBucketRateLimiter(fallback=RateLimitConfig(rps=0.0001, burst=10))
        transport = StubTransport(ok({}, status=500), ok({"ok": True}))
        await client(
            transport, retry=RetryConfig(attempts=1, base_delay_ms=1), limiter=limiter
        ).send("p", "https://x/y")
        assert limiter.snapshot()["p"]["tokens"] == 8

    async def test_a_network_error_is_retried(self) -> None:
        transport = StubTransport(OSError("reset"), ok({"ok": True}))
        result = await client(transport, retry=RetryConfig(attempts=1, base_delay_ms=1)).send(
            "p", "https://x/y"
        )
        assert result == {"ok": True}


class TestRetryAfter:
    @pytest.mark.parametrize(
        ("header", "expected"),
        [("2", 2_000), ("0", 0), ("", None), (None, None), ("soon", None)],
    )
    def test_seconds_and_junk(self, header: str | None, expected: int | None) -> None:
        assert parse_retry_after(header) == expected

    def test_an_http_date(self) -> None:
        # Several providers answer with a date rather than a delta.
        from datetime import datetime, timedelta, timezone
        from email.utils import format_datetime

        future = datetime.now(timezone.utc) + timedelta(seconds=30)
        parsed = parse_retry_after(format_datetime(future))
        assert parsed is not None and 25_000 <= parsed <= 31_000

    def test_a_date_in_the_past_is_zero_not_negative(self) -> None:
        from datetime import datetime, timedelta, timezone
        from email.utils import format_datetime

        past = datetime.now(timezone.utc) - timedelta(seconds=30)
        assert parse_retry_after(format_datetime(past)) == 0


class TestAppendQuery:
    def test_drops_absent_values(self) -> None:
        # So a provider can pass every optional parameter unconditionally.
        assert append_query("https://x", {"a": 1, "b": None}) == "https://x?a=1"

    def test_keeps_an_explicit_zero_and_empty_string(self) -> None:
        # offset=0 is a real parameter; dropping it would silently page wrong.
        assert append_query("https://x", {"offset": 0}) == "https://x?offset=0"

    def test_repeats_list_values(self) -> None:
        # The convention Riot, PandaScore and start.gg all use for multi-valued
        # filters.
        assert append_query("https://x", {"id": [1, 2]}) == "https://x?id=1&id=2"

    def test_renders_booleans_the_way_javascript_does(self) -> None:
        # Python renders "True". An API told include_appinfo=True treats that as
        # a string rather than a flag, and the TypeScript edition sends "true".
        assert append_query("https://x", {"flag": True}) == "https://x?flag=true"
        assert append_query("https://x", {"flag": False}) == "https://x?flag=false"

    def test_renders_a_whole_float_without_a_decimal_point(self) -> None:
        # limit=10.0 would be rejected by several of these APIs.
        assert append_query("https://x", {"limit": 10.0}) == "https://x?limit=10"

    def test_escapes_values(self) -> None:
        assert append_query("https://x", {"n": "a b&c"}) == "https://x?n=a%20b%26c"

    def test_respects_an_existing_query_string(self) -> None:
        assert append_query("https://x?a=1", {"b": 2}) == "https://x?a=1&b=2"

    def test_an_empty_mapping_leaves_the_url_alone(self) -> None:
        assert append_query("https://x", {}) == "https://x"


class TestTransportSelection:
    def test_the_default_transport_needs_nothing_installed(self) -> None:
        # The zero-dependency promise. This must work in a bare virtualenv.
        transport = default_transport()
        assert hasattr(transport, "request")
        assert hasattr(transport, "aclose")

    def test_urllib_transport_satisfies_the_protocol(self) -> None:
        transport = UrllibTransport()
        assert callable(transport.request)
        assert callable(transport.aclose)

    async def test_closing_is_idempotent(self) -> None:
        # The client closes on __aexit__, and callers close explicitly too.
        transport = UrllibTransport()
        await transport.aclose()
        await transport.aclose()


class TestHttpResponse:
    def test_header_lookup_ignores_case(self) -> None:
        # HTTP header casing is not stable across these providers, and
        # "Retry-After" arriving as "retry-after" must not lose the penalty.
        response = HttpResponse(status=200, headers={"retry-after": "5"}, text="")
        assert response.header("Retry-After") == "5"

    def test_a_missing_header_is_none(self) -> None:
        assert HttpResponse(status=200, headers={}, text="").header("X") is None


class TestCompression:
    """The urllib transport, which has to do its own decompression.

    This is not an optimisation. Liquipedia answers **406 Gzip encoding is
    required for API requests** to anything that does not ask for it, and
    Liquipedia is the keyless provider serving the tournament tier for all 83
    titles - so without this the package's widest promise fails in production
    while every offline test passes.

    `httpx` and `fetch` both negotiate compression themselves, which is why only
    this transport needs the behaviour and only this transport needs the test.
    """

    class FakeOpener:
        """Stands in for urllib's opener, one canned response deep."""

        def __init__(self, payload: bytes, encoding: str | None) -> None:
            self.payload = payload
            self.encoding = encoding
            self.sent: dict[str, str] = {}

        def open(self, request: Any, timeout: float) -> Any:  # noqa: ARG002
            self.sent = dict(request.headers)
            return self._response(self.payload, self.encoding)

        @staticmethod
        def _response(payload: bytes, encoding: str | None) -> Any:
            import email.message
            from contextlib import nullcontext

            headers = email.message.Message()
            headers["Content-Type"] = "application/json"
            if encoding:
                headers["Content-Encoding"] = encoding

            class Response:
                status = 200

                def __init__(self) -> None:
                    self.headers = headers

                def read(self) -> bytes:
                    return payload

                def __enter__(self) -> Response:
                    return self

                def __exit__(self, *args: object) -> None:
                    return None

            _ = nullcontext
            return Response()

    async def test_it_asks_for_compression(self) -> None:
        import gzip

        transport = UrllibTransport()
        opener = self.FakeOpener(gzip.compress(b'{"ok":true}'), "gzip")
        transport._opener = opener  # type: ignore[assignment]

        await transport.request("GET", "https://x/y", headers={}, body=None, timeout_ms=1_000)

        # urllib title-cases header names on the Request object.
        assert opener.sent.get("Accept-encoding") == "gzip, deflate"

    async def test_it_decompresses_a_gzip_body(self) -> None:
        import gzip

        transport = UrllibTransport()
        transport._opener = self.FakeOpener(  # type: ignore[assignment]
            gzip.compress(b'{"ok":true}'), "gzip"
        )

        response = await transport.request(
            "GET", "https://x/y", headers={}, body=None, timeout_ms=1_000
        )

        assert response.text == '{"ok":true}'

    async def test_it_decompresses_a_deflate_body(self) -> None:
        import zlib

        compressor = zlib.compressobj(wbits=-zlib.MAX_WBITS)
        raw = compressor.compress(b'{"ok":true}') + compressor.flush()

        transport = UrllibTransport()
        transport._opener = self.FakeOpener(raw, "deflate")  # type: ignore[assignment]

        response = await transport.request(
            "GET", "https://x/y", headers={}, body=None, timeout_ms=1_000
        )

        assert response.text == '{"ok":true}'

    async def test_an_uncompressed_body_passes_through(self) -> None:
        transport = UrllibTransport()
        transport._opener = self.FakeOpener(b'{"ok":true}', None)  # type: ignore[assignment]

        response = await transport.request(
            "GET", "https://x/y", headers={}, body=None, timeout_ms=1_000
        )

        assert response.text == '{"ok":true}'

    async def test_an_encoding_it_cannot_undo_is_left_alone(self) -> None:
        # Failing here would surface as a decompression error with no provider
        # attached. Passing the bytes on makes it a ParseError one layer up,
        # which names the provider that started sending brotli.
        transport = UrllibTransport()
        transport._opener = self.FakeOpener(b"not-brotli", "br")  # type: ignore[assignment]

        response = await transport.request(
            "GET", "https://x/y", headers={}, body=None, timeout_ms=1_000
        )

        assert response.text == "not-brotli"

    async def test_a_provider_can_set_its_own_accept_encoding(self) -> None:
        # A provider that overrides it knows something this layer does not.
        transport = UrllibTransport()
        opener = self.FakeOpener(b'{"ok":true}', None)
        transport._opener = opener  # type: ignore[assignment]

        await transport.request(
            "GET",
            "https://x/y",
            headers={"Accept-Encoding": "identity"},
            body=None,
            timeout_ms=1_000,
        )

        assert opener.sent.get("Accept-encoding") == "identity"


class TestSecretRedaction:
    """No credential this client was given may leave it inside a message.

    Eight of the providers authenticate by query parameter, so their key is in
    the URL. Errors here never carry the URL - but two things they do carry can
    still hold a key: a transport error message, which some failures build from
    the URL, and an upstream error body, because a surprising number of APIs
    answer "invalid api key: abc123" with the key quoted back.

    Both of those end up in a log aggregator, which is why the value is replaced
    when the error is *constructed* rather than when it is printed.
    """

    def test_a_key_is_replaced_wherever_it_appears(self) -> None:
        text = "GET https://api.test/v1?api_key=sk-live-abcdef123456 failed"
        assert redact_secrets(text, ["sk-live-abcdef123456"]) == (
            "GET https://api.test/v1?api_key=*** failed"
        )

    def test_the_longest_match_wins(self) -> None:
        # Blizzard and osu! credentials are `clientId:clientSecret` pairs. A
        # naive pass would redact the id and leave the secret sitting next to
        # three asterisks, which is worse than not redacting at all.
        secrets = ["client-id-value", "client-id-value:super-secret-value"]
        assert redact_secrets("using client-id-value:super-secret-value", secrets) == (
            "using ***"
        )

    def test_a_short_placeholder_is_left_alone(self) -> None:
        # A one-character key is a test fixture or a misconfiguration. Redacting
        # it would turn every message into asterisks and hide the real problem.
        assert redact_secrets("no route for k", ["k"]) == "no route for k"

    async def test_an_upstream_error_body_cannot_leak_the_key(self) -> None:
        key = "sk-live-abcdef123456"
        transport = MockTransport(
            [
                Route(
                    match="/players",
                    status=403,
                    body={"error": f"invalid api key: {key}"},
                )
            ]
        )
        client = GameStatsClient(**client_options(transport, api_keys={"steam": key}))
        with pytest.raises(GameStatsError) as caught:
            await client.title("cs2").get_player({"steam_id": "76561197960287930"})
        assert key not in str(caught.value)
        assert "***" in str(caught.value)
        await client.aclose()

    async def test_a_transport_failure_cannot_leak_the_key(self) -> None:
        key = "sk-live-abcdef123456"

        class Failing:
            async def request(self, method: str, url: str, **kwargs: object) -> HttpResponse:
                # urllib and httpx both put the URL in the message for some
                # failures, and the URL is where a query key lives.
                raise OSError(f"connection refused for {url}?api_key={key}")

            async def aclose(self) -> None:
                return None

        client = GameStatsClient(**client_options(Failing(), api_keys={"steam": key}))
        with pytest.raises(GameStatsError) as caught:
            await client.title("cs2").get_player({"steam_id": "76561197960287930"})
        assert key not in str(caught.value)
        await client.aclose()
