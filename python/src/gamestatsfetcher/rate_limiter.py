"""Per-provider token buckets.

Every provider in the registry declares its own ``rps`` and ``burst``, because
they are nowhere near each other: a Riot development key allows 20 requests per
second, Esports Earnings allows one per second and will ban an application that
ignores that, and Liquipedia allows one every two seconds *and* requires a
contact address in the User-Agent.

One global limit would have to be the smallest of those, which would make the
package unusable for the providers that are generous. So the bucket is keyed by
provider, and the registry supplies the numbers.

Buckets are shared across every title that uses a provider. That matters: asking
for CS2 and Dota 2 in the same second is two requests against one Steam quota,
and a limiter that did not know that would let both through.
"""

from __future__ import annotations

import asyncio
import math
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from .constants import DEFAULT_BURST, DEFAULT_RPS
from .errors import LocalRateLimitError
from .types import RateLimitConfig

__all__ = ["TokenBucketRateLimiter"]


@dataclass
class _Bucket:
    tokens: float
    last_refill: float
    rps: float
    burst: float
    #: Set when a 429 told us to stop until a point in time.
    blocked_until: float = 0.0


class TokenBucketRateLimiter:
    """A token bucket per provider, with an override for upstream 429s."""

    def __init__(
        self,
        *,
        fallback: RateLimitConfig | None = None,
        per_provider: Mapping[str, RateLimitConfig] | None = None,
        now: Callable[[], float] | None = None,
        sleep: Callable[[float], Awaitable[None]] | None = None,
    ) -> None:
        self._buckets: dict[str, _Bucket] = {}
        self._rps = fallback.rps if fallback else DEFAULT_RPS
        self._burst = fallback.burst if fallback else DEFAULT_BURST
        self._per_provider = dict(per_provider or {})
        # Injectable clock and sleep, so the tests do not have to wait in real
        # time. `monotonic` rather than `time()`: a clock adjustment mid-window
        # would otherwise let a burst through or stall one indefinitely.
        self._now = now or time.monotonic
        self._sleep = sleep or asyncio.sleep

    async def acquire(self, provider: str, max_wait_ms: float = 5_000) -> None:
        """Take one token, waiting for it if the wait is short enough.

        Raises :class:`LocalRateLimitError` rather than waiting when the wait
        would exceed ``max_wait_ms``. A caller that blocks for thirty seconds
        inside a slash command has already failed; better to say so now so they
        can queue the work or answer "try again shortly".
        """
        bucket = self._bucket_for(provider)
        now = self._now()

        # An upstream 429 outranks the local accounting: it is the provider
        # telling us our own model of its limit was wrong.
        if bucket.blocked_until > now:
            wait = (bucket.blocked_until - now) * 1_000
            if wait > max_wait_ms:
                raise LocalRateLimitError(provider, math.ceil(wait))
            await self._sleep(wait / 1_000)
            bucket.blocked_until = 0.0

        self._refill(bucket, self._now())
        if bucket.tokens >= 1:
            bucket.tokens -= 1
            return

        deficit = 1 - bucket.tokens
        wait_ms = math.ceil(deficit / bucket.rps * 1_000)
        if wait_ms > max_wait_ms:
            raise LocalRateLimitError(provider, wait_ms)

        await self._sleep(wait_ms / 1_000)
        self._refill(bucket, self._now())
        # The refill above put at least one token back; spend it without letting
        # a rounding error push the count below zero.
        bucket.tokens = max(0.0, bucket.tokens - 1)

    def try_acquire(self, provider: str) -> bool:
        """Take a token if one is free. Never waits, never raises."""
        bucket = self._bucket_for(provider)
        now = self._now()
        if bucket.blocked_until > now:
            return False
        self._refill(bucket, now)
        if bucket.tokens < 1:
            return False
        bucket.tokens -= 1
        return True

    def penalize(self, provider: str, retry_after_ms: float) -> None:
        """Record a 429 so nothing else is sent until it lifts.

        Without this, every concurrent caller keeps firing into a provider that
        has already said stop - which is how an application gets its key revoked
        rather than merely throttled.
        """
        bucket = self._bucket_for(provider)
        until = self._now() + max(0.0, retry_after_ms) / 1_000
        bucket.blocked_until = max(bucket.blocked_until, until)
        bucket.tokens = 0.0

    def available_in(self, provider: str) -> float:
        """Milliseconds until ``provider`` could serve a request. ``0`` when now."""
        bucket = self._bucket_for(provider)
        now = self._now()
        if bucket.blocked_until > now:
            return (bucket.blocked_until - now) * 1_000
        self._refill(bucket, now)
        if bucket.tokens >= 1:
            return 0.0
        return math.ceil((1 - bucket.tokens) / bucket.rps * 1_000)

    def configure(
        self, provider: str, *, rps: float | None = None, burst: float | None = None
    ) -> None:
        """Override the limits for one provider at runtime."""
        bucket = self._bucket_for(provider)
        if rps is not None:
            bucket.rps = rps
        if burst is not None:
            bucket.burst = burst
        bucket.tokens = min(bucket.tokens, bucket.burst)

    def reset(self, provider: str | None = None) -> None:
        """Drop one bucket, or all of them."""
        if provider is None:
            self._buckets.clear()
        else:
            self._buckets.pop(provider, None)

    def snapshot(self) -> dict[str, dict[str, float]]:
        """A snapshot for metrics or a ``/debug`` command."""
        now = self._now()
        out: dict[str, dict[str, float]] = {}
        for provider, bucket in self._buckets.items():
            self._refill(bucket, now)
            out[provider] = {
                "tokens": math.floor(bucket.tokens),
                "blockedForMs": max(0.0, (bucket.blocked_until - now) * 1_000),
            }
        return out

    def _refill(self, bucket: _Bucket, now: float) -> None:
        elapsed = now - bucket.last_refill
        if elapsed <= 0:
            return
        bucket.tokens = min(bucket.burst, bucket.tokens + elapsed * bucket.rps)
        bucket.last_refill = now

    def _bucket_for(self, provider: str) -> _Bucket:
        bucket = self._buckets.get(provider)
        if bucket is None:
            config = self._per_provider.get(provider)
            rps = config.rps if config else self._rps
            burst = config.burst if config else self._burst
            # A new bucket starts full. The provider has not heard from us yet,
            # so there is nothing to make up for.
            bucket = _Bucket(tokens=burst, last_refill=self._now(), rps=rps, burst=burst)
            self._buckets[provider] = bucket
        return bucket
