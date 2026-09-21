"""The cache layer.

Three drivers, one interface, and one rule that applies to all of them: **a
cache failure is never a request failure.** Every read that goes wrong returns a
miss and every write that goes wrong is dropped. The alternative - a Redis
hiccup taking down a Discord bot's stats command - is a worse outcome than
spending one extra call on the game API.

``memory`` is the default, so a caller who just wants to look up one player has
nothing to deploy. Redis is for when several processes should share one warm
cache.
"""

from __future__ import annotations

import contextlib
import json
import logging
import time
from collections import OrderedDict
from collections.abc import Mapping
from typing import Any, Protocol

from .constants import DEFAULT_MAX_CACHE_ENTRIES, DEFAULT_TTL_SECONDS
from .types import CacheConfig

__all__ = [
    "CacheAdapter",
    "MemoryCache",
    "NullCache",
    "RedisCache",
    "create_cache",
    "resolve_ttl",
]


#: What this module logs through.
#:
#: A Protocol was tried here and removed: ``logging.Logger``'s methods carry
#: keyword-only parameters with defaults, and any Protocol narrow enough to be
#: worth writing is one the real Logger does not satisfy. Naming the concrete
#: type is both honest and shorter - a Logger is what every caller passes.
_Logger = logging.Logger


class CacheAdapter(Protocol):
    """What every driver implements."""

    driver: str

    async def get(self, key: str) -> Any: ...
    async def set(self, key: str, value: Any, ttl_seconds: int) -> None: ...
    async def delete(self, key: str) -> None: ...
    async def clear(self) -> None: ...
    async def disconnect(self) -> None: ...


class MemoryCache:
    """In-process LRU with per-entry expiry.

    An ``OrderedDict`` gives both properties at once: a hit moves the key to the
    end, and eviction pops from the front. No dependency, no background task -
    expired entries are dropped when they are next read, and the size bound takes
    care of the ones nobody reads again.
    """

    driver = "memory"

    def __init__(self, max_entries: int | None = None) -> None:
        self._store: OrderedDict[str, tuple[Any, float]] = OrderedDict()
        self._max_entries = max(1, max_entries or DEFAULT_MAX_CACHE_ENTRIES)

    async def get(self, key: str) -> Any:
        entry = self._store.get(key)
        if entry is None:
            return None
        value, expires_at = entry
        if expires_at <= time.monotonic():
            del self._store[key]
            return None
        self._store.move_to_end(key)
        return value

    async def set(self, key: str, value: Any, ttl_seconds: int) -> None:
        if ttl_seconds <= 0:
            return
        self._store[key] = (value, time.monotonic() + ttl_seconds)
        self._store.move_to_end(key)
        while len(self._store) > self._max_entries:
            self._store.popitem(last=False)

    async def delete(self, key: str) -> None:
        self._store.pop(key, None)

    async def clear(self) -> None:
        self._store.clear()

    async def disconnect(self) -> None:
        self._store.clear()

    def size(self) -> int:
        """Current entry count, expired ones included. Tests and metrics use it."""
        return len(self._store)


class NullCache:
    """Every cache call is a no-op. What ``driver="none"`` gets you."""

    driver = "none"

    async def get(self, key: str) -> Any:
        return None

    async def set(self, key: str, value: Any, ttl_seconds: int) -> None:
        return None

    async def delete(self, key: str) -> None:
        return None

    async def clear(self) -> None:
        return None

    async def disconnect(self) -> None:
        return None


class RedisCache:
    """Redis-backed cache.

    Takes an already-connected client, which is why ``redis`` can stay an
    optional dependency: the caller constructs it, this package only speaks to
    it. :func:`create_cache` will build one when given a host.

    The client is expected to be ``redis.asyncio``-shaped: ``get``, ``set``,
    ``delete``, ``scan`` and ``aclose``/``close`` as coroutines.
    """

    driver = "redis"

    def __init__(self, client: Any, prefix: str, logger: _Logger) -> None:
        self._client = client
        self._prefix = prefix
        self._logger = logger

    def _full(self, key: str) -> str:
        return f"{self._prefix}{key}"

    async def get(self, key: str) -> Any:
        try:
            raw = await self._client.get(self._full(key))
            if raw is None:
                return None
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8")
            return json.loads(raw)
        except Exception as error:  # noqa: BLE001 - a miss is always safe
            self._logger.debug("[gsf] cache read failed, treating as miss: %s", error)
            return None

    async def set(self, key: str, value: Any, ttl_seconds: int) -> None:
        if ttl_seconds <= 0:
            return
        try:
            await self._client.set(
                self._full(key), json.dumps(value, default=str), ex=ttl_seconds
            )
        except Exception as error:  # noqa: BLE001 - dropping a write is safe
            self._logger.debug("[gsf] cache write failed, dropping: %s", error)

    async def delete(self, key: str) -> None:
        # A failed delete leaves a stale entry that will expire on its own, so
        # there is nothing here worth failing a request over.
        with contextlib.suppress(Exception):
            await self._client.delete(self._full(key))

    async def clear(self) -> None:
        """Delete every key under this prefix. Scans, so it never blocks the server."""
        try:
            cursor = 0
            while True:
                cursor, keys = await self._client.scan(
                    cursor=cursor, match=f"{self._prefix}*", count=500
                )
                if keys:
                    await self._client.delete(*keys)
                if cursor == 0:
                    break
        except Exception as error:  # noqa: BLE001
            self._logger.debug("[gsf] cache clear failed: %s", error)

    async def disconnect(self) -> None:
        for method in ("aclose", "close"):
            closer = getattr(self._client, method, None)
            if closer is None:
                continue
            try:
                result = closer()
                if hasattr(result, "__await__"):
                    await result
            except Exception:  # noqa: BLE001
                pass
            return


def create_cache(config: CacheConfig | None, logger: _Logger) -> CacheAdapter:
    """Build the adapter a config asks for.

    Falls back to memory rather than raising when Redis is requested but the
    ``redis`` package is not installed. The warning says what happened; refusing
    to start would turn an optional dependency into a required one at the worst
    possible moment.
    """
    driver = (config.driver if config else None) or "memory"
    prefix = (config.key_prefix if config else None) or "gsf:"

    if driver == "none":
        return NullCache()
    if driver == "memory":
        return MemoryCache(config.max_entries if config else None)

    redis_config = config.redis if config else None
    if redis_config is not None and redis_config.client is not None:
        return RedisCache(redis_config.client, prefix, logger)

    client = _try_create_redis_client(redis_config, logger)
    if client is not None:
        return RedisCache(client, prefix, logger)

    logger.warning("[gsf] redis cache requested but unavailable - using memory")
    return MemoryCache(config.max_entries if config else None)


def _try_create_redis_client(config: Any, logger: _Logger) -> Any:
    """Load ``redis.asyncio`` without making it a hard dependency."""
    if config is None or not config.host:
        return None
    try:
        import redis.asyncio as redis_asyncio
    except ImportError as error:
        logger.debug("[gsf] redis package not installed: %s", error)
        return None

    kwargs: dict[str, Any] = {"host": config.host, "port": config.port}
    if config.password:
        kwargs["password"] = config.password
    if config.db is not None:
        kwargs["db"] = config.db
    if config.tls:
        kwargs["ssl"] = True
    return redis_asyncio.Redis(**kwargs)


def resolve_ttl(
    overrides: Mapping[str, int],
    title_id: str,
    method: str,
    method_default: int | None,
    client_default: int,
) -> int:
    """Resolve the TTL for one call.

    Order: an override for this exact ``title:method``, then an override for the
    method alone, then the method's own default, then the client default. The
    two-level override exists because "cache ranks for 10 s" and "cache
    *Valorant* ranks for 10 s" are both things operators legitimately want.
    """
    scoped = overrides.get(f"{title_id}:{method}")
    if isinstance(scoped, int):
        return scoped
    global_override = overrides.get(method)
    if isinstance(global_override, int):
        return global_override
    if method_default is not None:
        return method_default
    return client_default or DEFAULT_TTL_SECONDS
