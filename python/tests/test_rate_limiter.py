"""The rate limiter.

Rate limits here are conditions of use, not tuning: exceeding Liquipedia's or
Esports Earnings' published limit is a breach of their terms, and exceeding a
publisher's is how an application gets its key revoked rather than throttled.

The clock and the sleep are injectable, so every test below runs in microseconds
and none of them depend on wall-clock timing.
"""

from __future__ import annotations

import pytest

from gamestatsfetcher import LocalRateLimitError, RateLimitConfig
from gamestatsfetcher.rate_limiter import TokenBucketRateLimiter


class Clock:
    """A hand-cranked monotonic clock, plus a sleep that advances it."""

    def __init__(self) -> None:
        self.now = 1_000.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds

    @property
    def total_slept(self) -> float:
        return sum(self.slept)


def limiter(
    rps: float = 10, burst: float = 10, **per_provider: RateLimitConfig
) -> tuple[TokenBucketRateLimiter, Clock]:
    clock = Clock()
    return (
        TokenBucketRateLimiter(
            fallback=RateLimitConfig(rps=rps, burst=burst),
            per_provider=per_provider,
            now=clock,
            sleep=clock.sleep,
        ),
        clock,
    )


class TestBurst:
    async def test_a_fresh_bucket_is_full(self) -> None:
        # The provider has not heard from us yet, so there is nothing to make up
        # for. Starting empty would make the first call of a process wait.
        bucket, clock = limiter(rps=1, burst=5)
        for _ in range(5):
            await bucket.acquire("p")
        assert clock.total_slept == 0

    async def test_the_burst_is_the_ceiling(self) -> None:
        bucket, clock = limiter(rps=1, burst=3)
        for _ in range(3):
            await bucket.acquire("p")
        await bucket.acquire("p")
        assert clock.total_slept == pytest.approx(1.0)

    async def test_tokens_come_back_over_time(self) -> None:
        bucket, clock = limiter(rps=2, burst=2)
        await bucket.acquire("p")
        await bucket.acquire("p")
        clock.now += 1  # 2 rps -> two tokens back
        await bucket.acquire("p")
        await bucket.acquire("p")
        assert clock.total_slept == 0

    async def test_refill_never_exceeds_the_burst(self) -> None:
        # An idle process must not accumulate an hour's worth of tokens and then
        # spend them all in one second.
        bucket, clock = limiter(rps=1, burst=2)
        clock.now += 3_600
        await bucket.acquire("p")
        await bucket.acquire("p")
        await bucket.acquire("p")
        assert clock.total_slept == pytest.approx(1.0)


class TestPerProvider:
    async def test_a_provider_uses_its_own_declared_limit(self) -> None:
        bucket, clock = limiter(rps=100, burst=100, slow=RateLimitConfig(rps=1, burst=1))
        await bucket.acquire("slow")
        await bucket.acquire("slow")
        assert clock.total_slept == pytest.approx(1.0)

    async def test_buckets_are_shared_across_titles_not_per_title(self) -> None:
        # The bug in version 2 of this package. Asking about CS2 and Dota 2 in
        # the same second is two requests against one Steam quota, and a limiter
        # keyed per title would let both through.
        bucket, clock = limiter(rps=1, burst=1)
        await bucket.acquire("steam")  # on behalf of cs2
        await bucket.acquire("steam")  # on behalf of dota2
        assert clock.total_slept == pytest.approx(1.0)

    async def test_providers_do_not_interfere(self) -> None:
        bucket, clock = limiter(rps=1, burst=1)
        await bucket.acquire("a")
        await bucket.acquire("b")
        assert clock.total_slept == 0


class TestMaxWait:
    async def test_a_wait_longer_than_the_budget_raises_instead(self) -> None:
        # A caller blocked for thirty seconds inside a slash command has already
        # failed. Better to say so now so they can queue or answer "try again".
        bucket, _ = limiter(rps=0.1, burst=1)
        await bucket.acquire("p")
        with pytest.raises(LocalRateLimitError) as caught:
            await bucket.acquire("p", max_wait_ms=100)
        assert caught.value.provider == "p"
        assert caught.value.retry_after_ms > 100

    async def test_a_wait_inside_the_budget_is_taken(self) -> None:
        bucket, clock = limiter(rps=1, burst=1)
        await bucket.acquire("p")
        await bucket.acquire("p", max_wait_ms=5_000)
        assert clock.total_slept == pytest.approx(1.0)


class TestPenalty:
    async def test_a_429_stops_everyone_not_just_the_caller_who_got_it(self) -> None:
        # Without this, every concurrent caller keeps firing into a provider that
        # has already said stop - which is how a key gets revoked.
        bucket, clock = limiter(rps=100, burst=100)
        bucket.penalize("p", 2_000)
        await bucket.acquire("p")
        assert clock.total_slept == pytest.approx(2.0)

    async def test_the_penalty_outranks_a_full_bucket(self) -> None:
        # It is the provider telling us our own model of its limit was wrong.
        bucket, _ = limiter(rps=100, burst=100)
        bucket.penalize("p", 10_000)
        assert bucket.try_acquire("p") is False

    async def test_a_longer_penalty_wins_over_a_shorter_one(self) -> None:
        # Two concurrent 429s must not let the shorter one shorten the block.
        bucket, clock = limiter()
        bucket.penalize("p", 5_000)
        bucket.penalize("p", 1_000)
        assert bucket.available_in("p") == pytest.approx(5_000)

    async def test_a_penalty_beyond_the_budget_raises(self) -> None:
        bucket, _ = limiter()
        bucket.penalize("p", 60_000)
        with pytest.raises(LocalRateLimitError):
            await bucket.acquire("p", max_wait_ms=1_000)

    async def test_the_penalty_lifts(self) -> None:
        bucket, clock = limiter(rps=100, burst=100)
        bucket.penalize("p", 1_000)
        clock.now += 2
        assert bucket.try_acquire("p") is True

    def test_a_negative_retry_after_does_not_travel_backwards(self) -> None:
        # Clock skew between us and the provider produces these. The block must
        # clamp to "now" rather than to a point in the past, which would leave
        # `blocked_until` behind the clock forever.
        bucket, _ = limiter(rps=1, burst=10)
        bucket.penalize("p", -5_000)
        assert bucket.snapshot()["p"]["blockedForMs"] == 0

    def test_a_429_drains_the_bucket_whatever_the_header_said(self) -> None:
        # The 429 itself is the evidence: our accounting of this provider's
        # limit was wrong, so the tokens we thought we had were not there. That
        # holds even when the provider says we may retry immediately.
        bucket, _ = limiter(rps=1, burst=10)
        bucket.penalize("p", 0)
        assert bucket.try_acquire("p") is False
        assert bucket.available_in("p") == pytest.approx(1_000)


class TestTryAcquire:
    def test_it_never_waits(self) -> None:
        bucket, clock = limiter(rps=1, burst=1)
        assert bucket.try_acquire("p") is True
        assert bucket.try_acquire("p") is False
        assert clock.total_slept == 0

    def test_it_recovers_with_the_clock(self) -> None:
        bucket, clock = limiter(rps=1, burst=1)
        bucket.try_acquire("p")
        clock.now += 1
        assert bucket.try_acquire("p") is True


class TestIntrospection:
    def test_available_in_is_zero_when_a_token_is_free(self) -> None:
        bucket, _ = limiter()
        assert bucket.available_in("p") == 0

    def test_available_in_reports_the_wait(self) -> None:
        bucket, _ = limiter(rps=1, burst=1)
        bucket.try_acquire("p")
        assert bucket.available_in("p") == pytest.approx(1_000)

    def test_snapshot_reports_what_a_debug_command_needs(self) -> None:
        bucket, _ = limiter(rps=10, burst=10)
        bucket.try_acquire("p")
        snapshot = bucket.snapshot()
        assert snapshot["p"]["tokens"] == 9
        assert snapshot["p"]["blockedForMs"] == 0

    def test_snapshot_shows_a_penalty(self) -> None:
        bucket, _ = limiter()
        bucket.penalize("p", 3_000)
        assert bucket.snapshot()["p"]["blockedForMs"] == pytest.approx(3_000)

    def test_snapshot_only_lists_providers_actually_used(self) -> None:
        # 51 rows of zeroes in a /debug output is not information.
        bucket, _ = limiter()
        bucket.try_acquire("p")
        assert list(bucket.snapshot()) == ["p"]


class TestRuntimeChanges:
    def test_configure_tightens_a_limit_immediately(self) -> None:
        # For the case where a provider answers 429 with a lower published quota
        # than the registry recorded.
        bucket, _ = limiter(rps=10, burst=10)
        bucket.configure("p", rps=1, burst=1)
        assert bucket.try_acquire("p") is True
        assert bucket.try_acquire("p") is False

    def test_reset_clears_one_provider(self) -> None:
        bucket, _ = limiter(rps=1, burst=1)
        bucket.try_acquire("p")
        bucket.reset("p")
        assert bucket.try_acquire("p") is True

    def test_reset_clears_everything(self) -> None:
        bucket, _ = limiter(rps=1, burst=1)
        bucket.try_acquire("a")
        bucket.try_acquire("b")
        bucket.reset()
        assert bucket.try_acquire("a") is True
        assert bucket.try_acquire("b") is True
