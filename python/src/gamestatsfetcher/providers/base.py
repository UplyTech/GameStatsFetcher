"""The base every provider module extends.

A provider knows one upstream API: its base URL, how it authenticates, and how
to turn its payloads into something the title clients can map. It does not know
about titles - ``CS2Client`` and ``Dota2Client`` both talk to the same
``SteamProvider``, and that is what keeps one Steam quota being spent once.

Providers are constructed lazily and memoised per runtime, so an application
that only ever asks about Valorant never builds the other fifty.
"""

from __future__ import annotations

import base64
import time
from collections.abc import Awaitable, Callable, Sequence
from typing import Any, TypeVar

from ..cache import resolve_ttl
from ..errors import MissingCredentialError, ParseError, ValidationError
from ..http import RequestSpec
from ..registry import get_provider
from ..runtime import Runtime
from ..types import ProviderDescriptor

__all__ = ["ProviderClient", "use_provider"]

T = TypeVar("T")
P = TypeVar("P", bound="ProviderClient")


class ProviderClient:
    """Credentials, transport and caching for one upstream API."""

    def __init__(self, provider_id: str, runtime: Runtime) -> None:
        self.descriptor: ProviderDescriptor = get_provider(provider_id)
        self.runtime = runtime

    @property
    def id(self) -> str:
        """Short id, used in cache keys and error messages."""
        return self.descriptor.id

    # -----------------------------------------------------------------------
    # Credentials
    # -----------------------------------------------------------------------

    def has_credentials(self) -> bool:
        """True when this provider has everything it needs to make a call."""
        if self.descriptor.auth == "none" or self.descriptor.optional_auth:
            return True
        key_name = self.descriptor.key_name
        if not key_name:
            return True
        return bool(self.runtime.api_keys.get(key_name))

    def require_key(self, title_id: str | None = None) -> str:
        """The configured credential, or an error naming the option and the page."""
        key_name = self.descriptor.key_name
        if not key_name:
            raise ValidationError(f"{self.id} does not use an API key")
        value = self.runtime.api_keys.get(key_name)
        if not value:
            raise MissingCredentialError(self.id, key_name, self.descriptor.docs_url, title_id)
        return value

    def require_key_parts(
        self, count: int, labels: str, title_id: str | None = None
    ) -> list[str]:
        """Split a colon-joined credential such as ``clientId:clientSecret``.

        Blizzard, Abios, osu!, Hi-Rez, iRacing and Toornament all need two or
        three values, and one option per provider pair would double the size of
        the key mapping for no gain.
        """
        raw = self.require_key(title_id)
        parts = raw.split(":")
        if len(parts) < count:
            raise ValidationError(
                f'api_keys.{self.descriptor.key_name} must be "{labels}" '
                f'({count} values joined by ":")'
            )
        if len(parts) > count:
            # Rejoin any overflow into the last part: an iRacing password may
            # contain a colon, and splitting one off would corrupt it silently.
            head = parts[: count - 1]
            head.append(":".join(parts[count - 1 :]))
            return head
        return parts

    # -----------------------------------------------------------------------
    # Transport
    # -----------------------------------------------------------------------

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        """Attach this provider's credential.

        The default covers the four mechanical auth kinds. Providers with a
        session or an OAuth exchange override it - see ``BlizzardProvider`` and
        ``HiRezProvider``.
        """
        auth = self.descriptor.auth
        if auth == "none":
            return spec
        if auth == "bearer":
            return spec.merged(
                headers={"Authorization": f"Bearer {self.require_key()}", **spec.headers}
            )
        if auth == "header-key":
            return spec.merged(
                headers={self.auth_header_name(): self.require_key(), **spec.headers}
            )
        if auth == "query-key":
            return spec.merged(
                query={self.auth_query_name(): self.require_key(), **spec.query}
            )
        if auth == "basic":
            encoded = base64.b64encode(self.require_key().encode("utf-8")).decode("ascii")
            return spec.merged(headers={"Authorization": f"Basic {encoded}", **spec.headers})
        # The session-based kinds must override this; reaching here is a bug in
        # the provider module rather than in the caller's code.
        raise ValidationError(f"{self.id} uses {auth} auth but does not implement authorize()")

    def auth_header_name(self) -> str:
        """Header the credential goes in, for ``header-key`` providers."""
        return "Authorization"

    def auth_query_name(self) -> str:
        """Query parameter the credential goes in, for ``query-key`` providers."""
        return "key"

    async def request(self, path: str, spec: RequestSpec | None = None) -> Any:
        """Send a request to this provider.

        ``path`` may be absolute - several providers answer with a URL to follow,
        and PUBG's telemetry lives on a different host entirely.
        """
        spec = spec or RequestSpec()
        url = path if path.startswith("http") else f"{self.descriptor.base_url}{path}"
        authorized = await self.authorize(spec)
        return await self.runtime.http.send(self.id, url, authorized)

    async def get(self, path: str, **kwargs: Any) -> Any:
        """``GET``, which is almost every call in this package.

        Returns ``Any`` on purpose: what comes back is whatever the upstream
        sent, and pretending otherwise would be a claim this layer cannot check.
        Use :meth:`get_object` where a single JSON object is expected.
        """
        return await self.request(path, RequestSpec(method="GET", **kwargs))

    async def get_object(self, path: str, **kwargs: Any) -> dict[str, Any] | None:
        """``GET`` an endpoint that answers with one JSON object.

        The type is the smaller half of what this does. The larger half is that
        a provider which starts answering with a list, a bare string or an error
        envelope where an object used to be is caught *here*, named as a
        :class:`~gamestatsfetcher.errors.ParseError` against the provider that
        changed - rather than surfacing forty lines later as an ``AttributeError``
        on a payload nobody can identify.

        ``None`` still means "nothing there", which is what ``null_on_404`` and
        an empty body both produce.
        """
        return self.as_object(await self.get(path, **kwargs), path)

    def as_object(self, payload: Any, what: str) -> dict[str, Any] | None:
        """Narrow a payload that is meant to be a single JSON object.

        Split out from :meth:`get_object` because several providers do not go
        through it - Blizzard mints a token first, Wargaming unwraps an envelope,
        OpenDota posts - and all of them want the same guarantee.
        """
        if payload is None or isinstance(payload, dict):
            return payload
        raise ParseError(
            self.id, f"expected a JSON object from {what}, got {type(payload).__name__}"
        )

    async def post(self, path: str, json: Any = None, **kwargs: Any) -> Any:
        """``POST`` with a JSON body."""
        return await self.request(path, RequestSpec(method="POST", json=json, **kwargs))

    async def graphql(
        self, query: str, variables: dict[str, Any] | None = None, path: str = ""
    ) -> Any:
        """One GraphQL request.

        start.gg and STRATZ are GraphQL-only, and both report errors in a 200
        response body - so a plain ``post`` would treat a failed query as a
        success and hand the caller a payload full of nulls.
        """
        response = await self.post(path, {"query": query, "variables": variables or {}})
        if isinstance(response, dict) and response.get("errors"):
            detail = "; ".join(
                str(error.get("message", "unknown")) for error in response["errors"]
            )
            raise ParseError(self.id, f"GraphQL error: {detail}")
        if not isinstance(response, dict) or response.get("data") is None:
            raise ParseError(self.id, "GraphQL response contained no data")
        return response["data"]

    # -----------------------------------------------------------------------
    # Shape guards
    # -----------------------------------------------------------------------

    def rows(self, value: Any) -> list[Any]:
        """The list an endpoint documented - or a :class:`ParseError` if it sent
        something else.

        ``list()`` is dangerously accommodating: on a mapping it quietly yields
        the *keys*, on a string the characters. So a provider that starts
        answering an array endpoint with ``{"error": "..."}`` used to surface
        three frames later inside a normaliser as ``AttributeError: 'str' object
        has no attribute 'get'`` - an exception naming neither the provider nor
        the endpoint, and not a :class:`GameStatsError` at all, so a caller's
        ``except GameStatsError`` never saw it.

        Absent and empty stay empty: an endpoint with nothing to report is not a
        schema change. Anything else is.
        """
        if not value:
            return []
        if isinstance(value, (list, tuple)):
            return list(value)
        raise ParseError(
            self.id,
            f"expected a list, got {type(value).__name__}",
        )

    def records(self, value: Any) -> list[dict[str, Any]]:
        """:meth:`rows`, for a list whose entries are mapped field by field.

        Used where the entries go straight into a normaliser that reads keys off
        them. A list of ids is fine for :meth:`rows` and wrong here, which is
        why the two are separate rather than one function with a flag.
        """
        items = self.rows(value)
        for item in items:
            if not isinstance(item, dict):
                raise ParseError(
                    self.id,
                    f"expected a list of objects, found a {type(item).__name__} in it",
                )
        return items

    def record(self, value: Any) -> dict[str, Any]:
        """One object, or a :class:`ParseError`. The singular of :meth:`records`."""
        if not isinstance(value, dict):
            raise ParseError(
                self.id,
                f"expected an object, got {type(value).__name__}",
            )
        return value

    # -----------------------------------------------------------------------
    # Caching
    # -----------------------------------------------------------------------

    async def cached(
        self,
        parts: Sequence[Any],
        method: str,
        title_id: str,
        method_default_ttl: int | None,
        fetcher: Callable[[], Awaitable[T]],
    ) -> T:
        """Read through the shared cache.

        The key is namespaced by provider so two providers serving the same title
        cannot collide - ``steam:cs2:stats:76561…`` and ``faceit:cs2:stats:76561…``
        are different answers to the same question and both are worth keeping.
        """
        key = ":".join([self.id, *(str(part) for part in parts)])
        hit = await self.runtime.cache.get(key)
        if hit is not None:
            self.runtime.logger.debug("[gsf] cache hit %s", key)
            return hit  # type: ignore[no-any-return]
        fresh = await fetcher()
        ttl = resolve_ttl(
            self.runtime.ttl_overrides,
            title_id,
            method,
            method_default_ttl,
            self.runtime.default_ttl_seconds,
        )
        await self.runtime.cache.set(key, fresh, ttl)
        return fresh

    async def memo(self, key: str, ttl_ms: float, factory: Callable[[], Awaitable[T]]) -> T:
        """Remember a value for the life of the client - OAuth tokens, sessions."""
        scoped = f"{self.id}:{key}"
        existing = self.runtime.state.get(scoped)
        if existing is not None:
            value, expires_at = existing
            if expires_at > time.monotonic() * 1_000:
                return value  # type: ignore[no-any-return]
        value = await factory()
        self.runtime.state[scoped] = (value, time.monotonic() * 1_000 + ttl_ms)
        return value


def use_provider(runtime: Runtime, provider_id: str, factory: Callable[[Runtime], P]) -> P:
    """Lazily construct and memoise a provider.

    Keyed by provider id on the runtime, so a client that touches ten titles
    across four providers builds four provider objects and no more.
    """
    key = f"provider:{provider_id}"
    existing = runtime.state.get(key)
    if existing is not None:
        return existing  # type: ignore[no-any-return]
    created = factory(runtime)
    runtime.state[key] = created
    return created
