"""Shared test fixtures: a transport stand-in, and options that keep tests offline.

``Transport`` is a Protocol with exactly one interesting method, which is why it
is a Protocol - a fake needs no base class, no mocking framework and no network.
Routes are matched by substring in declaration order, so a test reads as "the
URL containing this bit answers with that".

This mirrors ``typescript/tests/helpers.ts`` closely enough that a test written
against one edition is recognisable in the other.
"""

from __future__ import annotations

import json as jsonlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import pytest

from gamestatsfetcher import (
    CacheConfig,
    GameStatsClient,
    HttpResponse,
    RetryConfig,
    list_providers,
)


@dataclass
class Route:
    """One canned answer.

    ``sequence`` exists for the retry tests: a route that answers 500 then 200
    proves the retry actually happened, which a single fixed status cannot.
    """

    #: Substring the request URL must contain.
    match: str
    status: int = 200
    #: Serialised as JSON unless ``text`` is set.
    body: Any = None
    text: str | None = None
    headers: Mapping[str, str] = field(default_factory=dict)
    #: Answer differently on each call. The last entry repeats.
    sequence: Sequence[Mapping[str, Any]] | None = None


class MockTransport:
    """Answers from a route table and records everything it was asked."""

    def __init__(self, routes: Sequence[Route]) -> None:
        self.routes = list(routes)
        #: Every (method, url) requested, in order.
        self.calls: list[tuple[str, str]] = []
        #: Every header mapping, in order - for asserting auth is attached.
        self.headers: list[Mapping[str, str]] = []
        #: Every request body, in order.
        self.bodies: list[str | None] = []
        self.closed = False
        self._sequence_index: dict[str, int] = {}

    async def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: str | None,
        timeout_ms: int,
    ) -> HttpResponse:
        self.calls.append((method, url))
        self.headers.append(dict(headers))
        self.bodies.append(body)

        route = next((r for r in self.routes if r.match in url), None)
        if route is None:
            # 599 rather than 404: an unrouted URL is a broken test, and a 404
            # would be silently absorbed by the null_on_404 handling.
            return HttpResponse(
                status=599,
                headers={"Content-Type": "application/json"},
                text=jsonlib.dumps({"error": "no route", "url": url}),
            )

        if route.sequence:
            index = self._sequence_index.get(route.match, 0)
            self._sequence_index[route.match] = index + 1
            step = route.sequence[min(index, len(route.sequence) - 1)]
            return _build(
                int(step.get("status", 200)),
                step.get("body"),
                step.get("headers", {}),
            )

        if route.text is not None:
            return HttpResponse(
                status=route.status,
                headers={"Content-Type": "text/plain", **route.headers},
                text=route.text,
            )

        return _build(route.status, route.body, route.headers)

    async def aclose(self) -> None:
        self.closed = True

    def count_of(self, match: str) -> int:
        """How many times a URL containing ``match`` was requested."""
        return sum(1 for _, url in self.calls if match in url)

    def url_containing(self, match: str) -> str:
        """The first URL containing ``match``. Fails the test if there is none."""
        for _, url in self.calls:
            if match in url:
                return url
        raise AssertionError(f"no request contained {match!r}; got {self.calls!r}")

    @property
    def last_url(self) -> str:
        return self.calls[-1][1]


def _build(status: int, body: Any, headers: Mapping[str, str]) -> HttpResponse:
    return HttpResponse(
        status=status,
        headers={"Content-Type": "application/json", **headers},
        text="" if body is None else jsonlib.dumps(body),
    )


def test_options(transport: MockTransport, **overrides: Any) -> dict[str, Any]:
    """Client options that keep tests fast, quiet and offline."""
    options: dict[str, Any] = {
        "transport": transport,
        "cache": CacheConfig(driver="none"),
        # Retries would turn a deliberate 500 into three requests and a slow
        # test. The retry tests opt back in explicitly.
        "retry": RetryConfig(attempts=0),
        "logger": "silent",
    }
    options.update(overrides)
    return options


def make_client(
    routes: Sequence[Route], **overrides: Any
) -> tuple[GameStatsClient, MockTransport]:
    """A client wired to a route table, plus the transport for assertions."""
    transport = MockTransport(routes)
    return GameStatsClient(**test_options(transport, **overrides)), transport


def unthrottled(client: GameStatsClient) -> GameStatsClient:
    """Lift the published rate limits for a test that makes thousands of calls.

    Two reasons, and the second matters more than the first. A bucket at the
    published 2 rps really does ``await asyncio.sleep(0.5)`` between calls, so a
    sweep over every title takes an hour. And once a bucket empties, ``acquire``
    stops waiting and raises ``LocalRateLimitError`` instead - which is a
    ``GameStatsError``, so a test asserting "this failed as a GameStatsError"
    would pass without the request ever being made. A sweep has to lift the
    limits or it is measuring the rate limiter.
    """
    for descriptor in list_providers():
        client.runtime.limiter.configure(descriptor.id, rps=1e6, burst=1e6)
    return client


@pytest.fixture
def routes() -> list[Route]:
    """An empty route table for tests that fill it in themselves."""
    return []
