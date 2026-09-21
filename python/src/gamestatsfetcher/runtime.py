"""The shared runtime.

One object, built once by :class:`~gamestatsfetcher.client.GameStatsClient` and
handed to every provider and every title client. It exists so that the cache,
the rate limiter and the transport are genuinely shared rather than merely
configured the same way in fifty places - which is what version 2 did, and why
asking for CS2 and Dota 2 in the same second used two independent Steam buckets
and got the caller a 429.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from .cache import CacheAdapter, create_cache
from .constants import DEFAULT_TIMEOUT_MS, DEFAULT_TTL_SECONDS, DEFAULT_USER_AGENT
from .http import HttpClient, Transport, default_transport
from .rate_limiter import TokenBucketRateLimiter
from .registry import rate_limit_table
from .types import CacheConfig, RateLimitConfig, RetryConfig

__all__ = ["Runtime", "create_runtime", "silent_logger", "make_logger"]


@dataclass
class Runtime:
    """Everything a provider or title client needs, built once."""

    api_keys: Mapping[str, str]
    http: HttpClient
    cache: CacheAdapter
    limiter: TokenBucketRateLimiter
    logger: logging.Logger
    transport: Transport
    #: Try the next provider in a title's list when the preferred one fails.
    fallback: bool
    user_agent: str
    timeout_ms: int
    default_ttl_seconds: int
    ttl_overrides: Mapping[str, int]
    #: Scratch space shared across providers, for things worth computing once:
    #: OAuth tokens, Hi-Rez sessions, iRacing cookies, provider instances.
    state: dict[str, Any] = field(default_factory=dict)


def silent_logger() -> logging.Logger:
    """A logger that emits nothing.

    The default, and what the tests use. A library that logs by default is a
    library that writes into somebody else's log format uninvited.
    """
    logger = logging.getLogger("gamestatsfetcher.silent")
    logger.addHandler(logging.NullHandler())
    logger.propagate = False
    logger.setLevel(logging.CRITICAL + 1)
    return logger


def make_logger(level: str | int | logging.Logger | None) -> logging.Logger:
    """Accept a level name, a level, a logger, or nothing at all."""
    if isinstance(level, logging.Logger):
        return level
    if level is None or level == "silent":
        return silent_logger()

    logger = logging.getLogger("gamestatsfetcher")
    if isinstance(level, str):
        logger.setLevel(getattr(logging, level.upper(), logging.WARNING))
    else:
        logger.setLevel(level)
    if not logger.handlers:
        logger.addHandler(logging.NullHandler())
    return logger


def create_runtime(
    *,
    api_keys: Mapping[str, str] | None = None,
    cache: CacheConfig | None = None,
    rate_limit: RateLimitConfig | None = None,
    retry: RetryConfig | None = None,
    transport: Transport | None = None,
    logger: str | int | logging.Logger | None = None,
    fallback: bool = False,
    timeout_ms: int | None = None,
    user_agent: str | None = None,
) -> Runtime:
    """Build the runtime from the caller's options, filling in every default."""
    resolved_logger = make_logger(logger)
    resolved_transport = transport or default_transport()
    limiter = TokenBucketRateLimiter(
        fallback=rate_limit,
        per_provider=rate_limit_table(),
    )
    resolved_user_agent = user_agent or DEFAULT_USER_AGENT
    resolved_timeout = timeout_ms or DEFAULT_TIMEOUT_MS

    http = HttpClient(
        transport=resolved_transport,
        limiter=limiter,
        logger=resolved_logger,
        retry=retry,
        timeout_ms=resolved_timeout,
        user_agent=resolved_user_agent,
        # Every configured credential, so a transport error or an upstream error
        # body cannot carry one into a caller's logs.
        secrets=tuple(
            value for value in (api_keys or {}).values() if isinstance(value, str) and value
        ),
    )

    return Runtime(
        # Keys are copied, not referenced: a caller mutating their own dict
        # afterwards should not silently change what this client authenticates
        # with.
        api_keys=dict(api_keys or {}),
        http=http,
        cache=create_cache(cache, resolved_logger),
        limiter=limiter,
        logger=resolved_logger,
        transport=resolved_transport,
        fallback=fallback,
        user_agent=resolved_user_agent,
        timeout_ms=resolved_timeout,
        default_ttl_seconds=(cache.default_ttl_seconds if cache else None)
        or DEFAULT_TTL_SECONDS,
        ttl_overrides=dict(cache.ttl_overrides if cache else {}),
    )
