"""Identifier plumbing.

The same human being is a SteamID64 to Valve, a 32-bit account id to OpenDota,
a ``Name#Tag`` to Riot, a ``Name-1234`` to the Overwatch career pages and a
``#2PP0JCVL`` to Supercell. Every one of those conversions is somewhere a bug
can hide, so they live here with tests rather than inline in twelve provider
modules.

``shared/vectors/identity.json`` pins these to the same answers as the
TypeScript edition. A player whose Steam id converts differently in a Python bot
and a Node service is two different people as far as a database is concerned.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from urllib.parse import quote

from .constants import STEAM_ID64_BASE
from .errors import ValidationError
from .types import PlayerQuery

__all__ = [
    "RiotId",
    "is_steam_id64",
    "to_steam_id64",
    "to_steam_account_id",
    "to_steam_id2",
    "to_steam_id3",
    "parse_riot_id",
    "format_riot_id",
    "to_battle_tag_path",
    "normalise_supercell_tag",
    "encode_supercell_tag",
    "dash_uuid",
    "undash_uuid",
    "pick_identifier",
    "expand_riot_query",
]

#: A SteamID64 is 17 digits and starts at the base offset.
_STEAM_ID64 = re.compile(r"^7656119[0-9]{10}$")
_STEAM_ID3 = re.compile(r"^\[?U:1:([0-9]+)\]?$")
_STEAM_ID2 = re.compile(r"^STEAM_[0-5]:([01]):([0-9]+)$")
_SUPERCELL_TAG = re.compile(r"^[0289PYLQGRJCUV]{3,12}$")
_UUID = re.compile(r"^[0-9a-f]{32}$")
_BATTLE_TAG = re.compile(r"^[^#-]+[#-][0-9]+$")


def is_steam_id64(value: str) -> bool:
    """True for a well-formed SteamID64."""
    return bool(_STEAM_ID64.match(value))


def to_steam_id64(value: str | int) -> str:
    """Turn any Steam identifier into a SteamID64.

    Accepts SteamID64, SteamID3 (``[U:1:123]``), SteamID2 (``STEAM_0:1:61``) and
    a bare 32-bit account id. Does *not* accept a vanity URL - that needs a
    network call, which belongs in the Steam provider and not in a pure function.
    """
    raw = str(value).strip()
    if is_steam_id64(raw):
        return raw

    id3 = _STEAM_ID3.match(raw)
    if id3:
        return str(int(id3.group(1)) + STEAM_ID64_BASE)

    id2 = _STEAM_ID2.match(raw)
    if id2:
        account = int(id2.group(2)) * 2 + int(id2.group(1))
        return str(account + STEAM_ID64_BASE)

    # A bare 32-bit account id. Bounded above so a truncated SteamID64 - the
    # failure mode of storing one in a float - is rejected rather than silently
    # converted into a different person's id.
    if raw.isdigit() and len(raw) <= 10:
        account = int(raw)
        if 0 < account < 4_294_967_296:
            return str(account + STEAM_ID64_BASE)

    raise ValidationError(f'"{raw}" is not a recognisable Steam identifier')


def to_steam_account_id(value: str | int) -> str:
    """The 32-bit account id, as a string.

    OpenDota, Ballchasing, Deadlock and logs.tf all key on this rather than on
    the 64-bit form.
    """
    return str(int(to_steam_id64(value)) - STEAM_ID64_BASE)


def to_steam_id2(value: str | int) -> str:
    """The legacy ``STEAM_0:Y:Z`` rendering, which tournament tools still use."""
    account = int(to_steam_account_id(value))
    return f"STEAM_0:{account % 2}:{account // 2}"


def to_steam_id3(value: str | int) -> str:
    """The ``[U:1:N]`` rendering used by Source engine server logs."""
    return f"[U:1:{to_steam_account_id(value)}]"


@dataclass(frozen=True)
class RiotId:
    """A Riot ID split into its two halves."""

    game_name: str
    tag_line: str


def parse_riot_id(value: str) -> RiotId:
    """Parse ``Name#Tag``.

    Splits on the *last* hash: game names may contain one, tag lines may not.
    Getting this backwards breaks exactly the accounts whose owners chose an
    awkward name, which is a bug that survives a long time in testing.
    """
    raw = value.strip()
    hash_at = raw.rfind("#")
    if hash_at <= 0 or hash_at == len(raw) - 1:
        raise ValidationError(f'"{value}" is not a Riot ID - expected the form Name#Tag')
    return RiotId(game_name=raw[:hash_at], tag_line=raw[hash_at + 1 :])


def format_riot_id(riot_id: RiotId) -> str:
    """Render a Riot ID back into ``Name#Tag``."""
    return f"{riot_id.game_name}#{riot_id.tag_line}"


def to_battle_tag_path(value: str) -> str:
    """Battle.net BattleTag as the web APIs want it.

    Blizzard's own endpoints take ``Name-1234``, and the Overwatch career pages
    that OverFast scrapes use the same form. Only the separator differs from what
    the user types, so this is the conversion that gets forgotten.
    """
    raw = value.strip()
    if not _BATTLE_TAG.match(raw):
        raise ValidationError(f'"{value}" is not a BattleTag - expected the form Name#1234')
    return raw.replace("#", "-")


def normalise_supercell_tag(value: str) -> str:
    """Supercell player tag, normalised.

    Supercell tags are upper case, always carry a leading hash in their canonical
    form, and use ``O`` nowhere - the character is always a zero. Users copy tags
    out of screenshots, so the letter/digit confusion is a real and frequent
    failure rather than a theoretical one.
    """
    raw = value.strip().upper().lstrip("#").replace("O", "0")
    if not _SUPERCELL_TAG.match(raw):
        raise ValidationError(
            f'"{value}" is not a Supercell player tag - '
            "they use only the characters 0289PYLQGRJCUV"
        )
    return f"#{raw}"


def encode_supercell_tag(value: str) -> str:
    """The same tag, URL-encoded for a path segment (``%23ABC``)."""
    return quote(normalise_supercell_tag(value), safe="")


def dash_uuid(value: str) -> str:
    """Minecraft UUIDs come back from Mojang undashed and are needed dashed."""
    raw = value.replace("-", "").lower()
    if not _UUID.match(raw):
        raise ValidationError(f'"{value}" is not a 32-character UUID')
    return f"{raw[:8]}-{raw[8:12]}-{raw[12:16]}-{raw[16:20]}-{raw[20:]}"


def undash_uuid(value: str) -> str:
    """The undashed form Hypixel expects."""
    return value.replace("-", "").lower()


def pick_identifier(query: PlayerQuery, accepted: Sequence[str]) -> tuple[str, str] | None:
    """The first identifier a query supplies from a title's accepted list.

    Titles list their identifiers best-first, so this implements "use the most
    reliable thing the caller gave us" without each title reimplementing it.
    """
    for key in accepted:
        value = query.get(key)
        if value is None or isinstance(value, (dict, list, tuple)):
            continue
        text = str(value).strip()
        if text:
            return key, text
    return None


def expand_riot_query(query: PlayerQuery) -> PlayerQuery:
    """Accept ``Name#Tag`` in the ``name`` field and split it into the Riot fields.

    Users paste their whole Riot ID into one box far more often than they fill
    two, and refusing that would be pedantry rather than validation.
    """
    if query.game_name and query.tag_line:
        return query
    if query.name and "#" in query.name:
        parsed = parse_riot_id(query.name)
        return query.replace(game_name=parsed.game_name, tag_line=parsed.tag_line)
    return query
