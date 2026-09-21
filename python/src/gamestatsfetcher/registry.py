"""The title and provider registries.

Both are loaded from the JSON in ``gamestatsfetcher/data/``, which is a copy of
``shared/registry/`` - the same files the TypeScript edition generates.

Why this edition loads data instead of declaring it
---------------------------------------------------

RankMode's two editions each implement the logic and prove they agree through
shared test vectors. That is the right shape for *behaviour*. A registry is not
behaviour, it is **data**: 83 titles, 51 providers, and which capability each
one serves.

Re-declaring 134 records in a second language would create exactly one thing:
the opportunity for them to disagree. So there is one source - the TypeScript
registry, which is where the reconciliation logic lives - one generated
artefact in ``shared/registry/``, and this module reads it.

The consequence worth knowing: ``python/scripts/sync_registry.py`` copies the
files, and ``tests/test_registry_sync.py`` fails the build if the copy has
drifted. The two editions cannot report different coverage.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from functools import lru_cache
from importlib import resources
from typing import Any

from .errors import UnknownProviderError, UnknownTitleError
from .types import ProviderDescriptor, RateLimitConfig, TitleDescriptor

__all__ = [
    "REGISTRY_FORMAT_VERSION",
    "ESPORTS_CAPABILITY_PROVIDERS",
    "esports_providers_for",
    "list_titles",
    "title_count",
    "find_title",
    "get_title",
    "supports",
    "titles_by_genre",
    "titles_by_provider",
    "titles_by_capability",
    "titles_by_platform",
    "search_titles",
    "suggest_titles",
    "register_title",
    "list_providers",
    "find_provider",
    "get_provider",
    "providers_by_kind",
    "register_provider",
    "rate_limit_table",
]

#: Layout of the data files this module can read. Asserted at load, so a file
#: from a future layout fails loudly instead of being half-parsed.
REGISTRY_FORMAT_VERSION = 1


def _load(name: str) -> dict[str, Any]:
    raw = resources.files("gamestatsfetcher.data").joinpath(name).read_text("utf-8")
    payload: dict[str, Any] = json.loads(raw)
    version = payload.get("formatVersion")
    if version != REGISTRY_FORMAT_VERSION:
        raise RuntimeError(
            f"gamestatsfetcher/data/{name} has formatVersion {version!r}, "
            f"expected {REGISTRY_FORMAT_VERSION}. "
            "Run python/scripts/sync_registry.py against a matching shared/registry."
        )
    return payload


_TITLES_RAW = _load("titles.json")
_PROVIDERS_RAW = _load("providers.json")

#: Which provider can answer which esports question.
#:
#: Generated alongside the registries, so the two editions cannot disagree about
#: it. A provider missing from a capability's list is *skipped* by the esports
#: layer, not failed - see :mod:`gamestatsfetcher.esports`.
ESPORTS_CAPABILITY_PROVIDERS: Mapping[str, tuple[str, ...]] = {
    capability: tuple(providers)
    for capability, providers in _PROVIDERS_RAW["esportsCapabilities"].items()
}


def esports_providers_for(
    provider_ids: Sequence[str], capability: str
) -> tuple[str, ...] | None:
    """The providers from ``provider_ids`` that could serve ``capability``.

    Returns ``None`` for a capability that is not an esports one, so callers can
    tell "no provider can do this" from "this is not the table's business".
    """
    able = ESPORTS_CAPABILITY_PROVIDERS.get(capability)
    if able is None:
        return None
    return tuple(provider_id for provider_id in provider_ids if provider_id in able)


def _title_from_json(row: Mapping[str, Any]) -> TitleDescriptor:
    return TitleDescriptor(
        id=row["id"],
        name=row["name"],
        aliases=tuple(row["aliases"]),
        genre=row["genre"],
        publisher=row["publisher"],
        release_year=row["releaseYear"],
        status=row["status"],
        providers=tuple(row["providers"]),
        capabilities=tuple(row["capabilities"]),
        identifiers=tuple(row["identifiers"]),
        regions=tuple(row["regions"]),
        platforms=tuple(row["platforms"]),
        dedicated_client=bool(row.get("dedicatedClient", False)),
    )


def _provider_from_json(row: Mapping[str, Any]) -> ProviderDescriptor:
    return ProviderDescriptor(
        id=row["id"],
        label=row["label"],
        kind=row["kind"],
        base_url=row["baseUrl"],
        auth=row["auth"],
        key_name=row["keyName"],
        docs_url=row["docsUrl"],
        rps=float(row["rps"]),
        burst=float(row["burst"]),
        requires_user_agent=bool(row["requiresUserAgent"]),
        optional_auth=bool(row.get("optionalAuth", False)),
        notes=row.get("notes"),
    )


_TITLES: dict[str, TitleDescriptor] = {
    row["id"]: _title_from_json(row) for row in _TITLES_RAW["titles"]
}
_PROVIDERS: dict[str, ProviderDescriptor] = {
    row["id"]: _provider_from_json(row) for row in _PROVIDERS_RAW["providers"]
}


def _normalise(value: str) -> str:
    """Lower-case and strip everything that is not a letter or a digit."""
    return "".join(character for character in value.lower() if character.isalnum())


_ALIASES: dict[str, str] = {}
for _title in _TITLES.values():
    _ALIASES[_normalise(_title.id)] = _title.id
    _ALIASES[_normalise(_title.name)] = _title.id
    for _alias in _title.aliases:
        _ALIASES[_normalise(_alias)] = _title.id


# ---------------------------------------------------------------------------
# Titles
# ---------------------------------------------------------------------------


def list_titles() -> tuple[TitleDescriptor, ...]:
    """Every title, in registration order."""
    return tuple(_TITLES.values())


def title_count() -> int:
    """How many titles the registry holds."""
    return len(_TITLES)


def find_title(id_or_alias: str) -> TitleDescriptor | None:
    """Resolve an id, a name or an alias to a descriptor.

    Case and punctuation insensitive: ``"CS:GO"``, ``"csgo"`` and ``"cs go"`` all
    find Counter-Strike 2. Returns ``None`` rather than raising, for the callers
    doing a lookup where a miss is a normal answer.
    """
    canonical = _ALIASES.get(_normalise(id_or_alias))
    return _TITLES.get(canonical) if canonical else None


def get_title(id_or_alias: str) -> TitleDescriptor:
    """Resolve, or raise with the closest matches in the message."""
    found = find_title(id_or_alias)
    if found is not None:
        return found
    raise UnknownTitleError(id_or_alias, suggest_titles(id_or_alias, 3))


def supports(title: TitleDescriptor, capability: str) -> bool:
    """True when the title supports the capability. The check the client runs."""
    return capability in title.capabilities


def titles_by_genre(genre: str) -> tuple[TitleDescriptor, ...]:
    """Titles of one genre."""
    return tuple(title for title in _TITLES.values() if title.genre == genre)


def titles_by_provider(provider_id: str) -> tuple[TitleDescriptor, ...]:
    """Titles served by a provider. Answers "what breaks if Riot goes down?"."""
    return tuple(title for title in _TITLES.values() if provider_id in title.providers)


def titles_by_capability(capability: str) -> tuple[TitleDescriptor, ...]:
    """Titles supporting a capability. Answers "which have real ranks?"."""
    return tuple(title for title in _TITLES.values() if capability in title.capabilities)


def titles_by_platform(platform: str) -> tuple[TitleDescriptor, ...]:
    """Titles playable on a platform."""
    return tuple(title for title in _TITLES.values() if platform in title.platforms)


def search_titles(query: str, limit: int = 10) -> tuple[TitleDescriptor, ...]:
    """Free-text search across ids, names and aliases.

    Substring first, then an edit-distance fallback so a typo still finds
    something. Deliberately simple - this is for a Discord autocomplete handler,
    not for a search engine.
    """
    needle = _normalise(query)
    if not needle:
        return tuple(_TITLES.values())[:limit]

    scored: list[tuple[int, str, TitleDescriptor]] = []
    for title in _TITLES.values():
        best = None
        for haystack in (title.id, title.name, *title.aliases):
            hay = _normalise(haystack)
            if hay == needle:
                score = 0
            elif hay.startswith(needle):
                score = 1
            elif needle in hay:
                score = 2
            else:
                score = 3 + _distance(needle, hay)
            best = score if best is None else min(best, score)
        # 3 + distance means an unrelated title scores at least 4; anything above
        # 6 is noise a user would not recognise as a match.
        if best is not None and best <= 6:
            scored.append((best, title.id, title))

    scored.sort(key=lambda entry: (entry[0], entry[1]))
    return tuple(title for _, _, title in scored[:limit])


def suggest_titles(query: str, limit: int = 3) -> tuple[str, ...]:
    """The "did you mean" list on :class:`UnknownTitleError`."""
    return tuple(title.id for title in search_titles(query, limit))


@lru_cache(maxsize=4096)
def _distance(a: str, b: str) -> int:
    """Levenshtein distance.

    Two rows rather than a full matrix, and memoised: the longest string here is
    about thirty characters and this runs on every keystroke of an autocomplete.
    """
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)

    previous = list(range(len(b) + 1))
    for i, char_a in enumerate(a, start=1):
        current = [i]
        for j, char_b in enumerate(b, start=1):
            current.append(
                min(
                    previous[j - 1] + (0 if char_a == char_b else 1),
                    current[j - 1] + 1,
                    previous[j] + 1,
                )
            )
        previous = current
    return previous[len(b)]


def register_title(descriptor: TitleDescriptor) -> None:
    """Add a title at runtime.

    For a title this package does not ship yet, or a private one. The id must be
    new: replacing a built-in would silently change what an existing call
    returns.

    Reconciled like a built-in - a registered title cannot promise an esports
    capability its providers do not serve.
    """
    if descriptor.id in _TITLES:
        raise ValueError(
            f'title "{descriptor.id}" is already registered - pick a different id'
        )
    reconciled = _reconcile(descriptor)
    _TITLES[reconciled.id] = reconciled
    _ALIASES[_normalise(reconciled.id)] = reconciled.id
    _ALIASES[_normalise(reconciled.name)] = reconciled.id
    for alias in reconciled.aliases:
        _ALIASES[_normalise(alias)] = reconciled.id


def _reconcile(title: TitleDescriptor) -> TitleDescriptor:
    """Drop esports capabilities none of the title's providers can serve.

    The shipped registry is already reconciled by the generator; this exists for
    titles registered at runtime, so both routes produce the same guarantee.
    """
    from dataclasses import replace

    kept = tuple(
        capability
        for capability in title.capabilities
        if (able := esports_providers_for(title.providers, capability)) is None or able
    )
    return title if len(kept) == len(title.capabilities) else replace(title, capabilities=kept)


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------


def list_providers() -> tuple[ProviderDescriptor, ...]:
    """Every provider, in declaration order."""
    return tuple(_PROVIDERS.values())


def find_provider(provider_id: str) -> ProviderDescriptor | None:
    """Look one up, or ``None``."""
    return _PROVIDERS.get(provider_id)


def get_provider(provider_id: str) -> ProviderDescriptor:
    """Look one up, or raise. Used where a missing id is a bug."""
    provider = _PROVIDERS.get(provider_id)
    if provider is None:
        raise UnknownProviderError(provider_id)
    return provider


def providers_by_kind(kind: str) -> tuple[ProviderDescriptor, ...]:
    """Providers of one kind: first-party, community, esports-data, tournament."""
    return tuple(provider for provider in _PROVIDERS.values() if provider.kind == kind)


def register_provider(descriptor: ProviderDescriptor) -> None:
    """Add a provider at runtime.

    The seam for a private or regional API this package does not ship. The id
    must be new; silently replacing a built-in would change the terms of service
    a caller is operating under without them noticing.
    """
    if descriptor.id in _PROVIDERS:
        raise ValueError(
            f'provider "{descriptor.id}" is already registered - pick a different id'
        )
    _PROVIDERS[descriptor.id] = descriptor


def rate_limit_table() -> dict[str, RateLimitConfig]:
    """The ``{rps, burst}`` map the rate limiter is built from."""
    return {
        provider.id: RateLimitConfig(rps=provider.rps, burst=provider.burst)
        for provider in _PROVIDERS.values()
    }


def _iter_capabilities() -> Iterable[str]:  # pragma: no cover - documentation aid
    """Every capability any title declares. Useful when writing a coverage table."""
    seen: set[str] = set()
    for title in _TITLES.values():
        for capability in title.capabilities:
            if capability not in seen:
                seen.add(capability)
                yield capability
