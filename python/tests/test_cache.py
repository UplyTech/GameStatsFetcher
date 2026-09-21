"""The cache.

Caching here is a correctness feature before it is a performance one: a rank
cached for an hour is a rank that is wrong for an hour. So these tests are as
interested in what is *not* cached, and for how long, as in the hit path.
"""

from __future__ import annotations

import time
from typing import Any

import pytest

from gamestatsfetcher import (
    TTL,
    CacheConfig,
    MemoryCache,
    NullCache,
    RedisCache,
    RedisConfig,
    create_cache,
    resolve_ttl,
    silent_logger,
)
from gamestatsfetcher.constants import DEFAULT_TTL_SECONDS

LOG = silent_logger()


class TestMemoryCache:
    async def test_round_trip(self) -> None:
        cache = MemoryCache()
        await cache.set("k", {"v": 1}, 60)
        assert await cache.get("k") == {"v": 1}

    async def test_a_miss_is_none(self) -> None:
        assert await MemoryCache().get("nothing") is None

    async def test_an_expired_entry_is_a_miss(self, monkeypatch: Any) -> None:
        cache = MemoryCache()
        await cache.set("k", "v", 60)

        # Moving the clock rather than sleeping: a test that waits 60 s is a
        # test nobody runs.
        base = time.monotonic()
        monkeypatch.setattr(time, "monotonic", lambda: base + 61)
        assert await cache.get("k") is None

    async def test_an_expired_entry_is_dropped_not_just_hidden(self, monkeypatch: Any) -> None:
        # Otherwise the store grows without bound for keys nobody asks for twice.
        cache = MemoryCache()
        await cache.set("k", "v", 60)
        base = time.monotonic()
        monkeypatch.setattr(time, "monotonic", lambda: base + 61)
        await cache.get("k")
        assert cache.size() == 0

    async def test_a_zero_ttl_is_not_stored(self) -> None:
        # "Do not cache this" must not become "cache it forever".
        cache = MemoryCache()
        await cache.set("k", "v", 0)
        assert await cache.get("k") is None
        assert cache.size() == 0

    async def test_it_evicts_the_least_recently_used(self) -> None:
        cache = MemoryCache(max_entries=2)
        await cache.set("a", 1, 60)
        await cache.set("b", 2, 60)
        await cache.get("a")  # a is now the most recent
        await cache.set("c", 3, 60)  # evicts b

        assert await cache.get("a") == 1
        assert await cache.get("b") is None
        assert await cache.get("c") == 3

    async def test_the_bound_is_respected_exactly(self) -> None:
        cache = MemoryCache(max_entries=3)
        for index in range(50):
            await cache.set(f"k{index}", index, 60)
        assert cache.size() == 3

    async def test_a_nonsense_bound_still_stores_something(self) -> None:
        # max_entries=0 would otherwise evict every write immediately, turning
        # a misconfiguration into a silent cache-off.
        cache = MemoryCache(max_entries=0)
        await cache.set("k", "v", 60)
        assert await cache.get("k") == "v"

    async def test_delete_and_clear(self) -> None:
        cache = MemoryCache()
        await cache.set("a", 1, 60)
        await cache.set("b", 2, 60)
        await cache.delete("a")
        assert await cache.get("a") is None
        await cache.clear()
        assert cache.size() == 0

    async def test_deleting_a_key_that_is_not_there_is_fine(self) -> None:
        await MemoryCache().delete("nothing")


class TestNullCache:
    async def test_it_never_remembers(self) -> None:
        cache = NullCache()
        await cache.set("k", "v", 60)
        assert await cache.get("k") is None

    async def test_every_method_is_safe_to_call(self) -> None:
        # It is a real adapter, not a stub: the client calls delete() and
        # disconnect() on it during shutdown like any other.
        cache = NullCache()
        await cache.delete("k")
        await cache.clear()
        await cache.disconnect()


class FakeRedis:
    """Enough of redis.asyncio to exercise RedisCache without a server."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.closed = False
        self.fail = False

    async def get(self, key: str) -> str | None:
        if self.fail:
            raise ConnectionError("redis is down")
        return self.store.get(key)

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        if self.fail:
            raise ConnectionError("redis is down")
        self.store[key] = value

    async def delete(self, key: str) -> None:
        self.store.pop(key, None)

    async def scan(self, cursor: int, match: str, count: int) -> tuple[int, list[str]]:
        prefix = match.rstrip("*")
        return 0, [k for k in self.store if k.startswith(prefix)]

    async def aclose(self) -> None:
        self.closed = True

    async def close(self) -> None:  # older redis-py
        self.closed = True


class TestRedisCache:
    async def test_round_trip_through_json(self) -> None:
        redis = FakeRedis()
        cache = RedisCache(redis, "gsf:", LOG)
        await cache.set("k", {"v": 1}, 60)
        assert await cache.get("k") == {"v": 1}

    async def test_keys_carry_the_prefix(self) -> None:
        # So several applications can share one Redis without colliding, and so
        # clear() can find this client's keys and nobody else's.
        redis = FakeRedis()
        await RedisCache(redis, "myapp:", LOG).set("k", 1, 60)
        assert list(redis.store) == ["myapp:k"]

    async def test_a_redis_outage_is_a_miss_not_an_outage(self) -> None:
        # The cache is an optimisation. Taking the whole call down because the
        # cache is unreachable turns an optional dependency into a required one.
        redis = FakeRedis()
        cache = RedisCache(redis, "gsf:", LOG)
        redis.fail = True
        assert await cache.get("k") is None
        await cache.set("k", "v", 60)  # must not raise either

    async def test_clear_only_removes_this_prefix(self) -> None:
        redis = FakeRedis()
        redis.store["other:key"] = "1"
        cache = RedisCache(redis, "gsf:", LOG)
        await cache.set("mine", 1, 60)
        await cache.clear()
        assert "other:key" in redis.store

    async def test_disconnect_closes_the_connection(self) -> None:
        redis = FakeRedis()
        await RedisCache(redis, "gsf:", LOG).disconnect()
        assert redis.closed is True


class TestCreateCache:
    def test_the_default_is_memory(self) -> None:
        assert isinstance(create_cache(None, LOG), MemoryCache)

    def test_none_gives_the_null_adapter(self) -> None:
        assert isinstance(create_cache(CacheConfig(driver="none"), LOG), NullCache)

    def test_an_injected_redis_client_is_used_as_is(self) -> None:
        redis = FakeRedis()
        config = CacheConfig(driver="redis", redis=RedisConfig(client=redis))
        assert isinstance(create_cache(config, LOG), RedisCache)

    def test_redis_without_a_host_falls_back_to_memory(self) -> None:
        # Warns and keeps going. Refusing to start because an optional cache is
        # unavailable is the wrong trade at boot time.
        assert isinstance(create_cache(CacheConfig(driver="redis"), LOG), MemoryCache)


class TestResolveTtl:
    def test_the_method_default_wins_over_the_client_default(self) -> None:
        assert resolve_ttl({}, "cs2", "rank", TTL["rank"], 300) == TTL["rank"]

    def test_a_global_override_beats_the_method_default(self) -> None:
        assert resolve_ttl({"rank": 10}, "cs2", "rank", TTL["rank"], 300) == 10

    def test_a_title_scoped_override_beats_a_global_one(self) -> None:
        # "cache ranks for 10 s" and "cache *Valorant* ranks for 10 s" are both
        # things operators legitimately want, so both levels exist.
        overrides = {"rank": 10, "valorant:rank": 5}
        assert resolve_ttl(overrides, "valorant", "rank", TTL["rank"], 300) == 5
        assert resolve_ttl(overrides, "cs2", "rank", TTL["rank"], 300) == 10

    def test_it_falls_through_to_the_client_default(self) -> None:
        assert resolve_ttl({}, "cs2", "somethingNew", None, 42) == 42

    def test_and_then_to_the_package_default(self) -> None:
        assert resolve_ttl({}, "cs2", "x", None, 0) == DEFAULT_TTL_SECONDS

    def test_an_override_of_zero_is_honoured(self) -> None:
        # 0 means "do not cache this", which is a real thing to configure and
        # must not be read as "unset".
        assert resolve_ttl({"rank": 0}, "cs2", "rank", TTL["rank"], 300) == 0


class TestTtlTable:
    def test_a_finished_match_is_cached_for_a_day(self) -> None:
        # It will never change again. The single biggest quota saver here.
        assert TTL["match"] == 86_400

    def test_a_rank_is_cached_for_a_minute_at_most(self) -> None:
        # A bot showing a stale rank right after a promotion is the complaint
        # this package exists to avoid.
        assert TTL["rank"] <= 60

    def test_live_fixtures_are_cached_for_seconds(self) -> None:
        assert TTL["esportsMatchesLive"] <= 30
        assert TTL["esportsMatchesLive"] < TTL["esportsMatches"]

    @pytest.mark.parametrize("key", list(TTL))
    def test_every_ttl_is_positive(self, key: str) -> None:
        # A zero here would silently disable caching for one method and nobody
        # would notice until a quota ran out.
        assert TTL[key] > 0
