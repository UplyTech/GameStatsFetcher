"""RuneScape and EVE Online: two first-party APIs for games with no circuit.

Both are here for the reason the package exists rather than for the reason most
of its titles are: there is a real, published, unauthenticated API that answers
"how is this player doing", and the package's rule is that such an API belongs
in the registry whether or not anybody runs a tournament for the game.

The Python edition mirrors ``typescript/src/providers/jagex.ts`` and
``eve.ts`` method for method.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from ..constants import TTL
from ..errors import NotFoundError, ParseError
from ..http import RequestSpec
from ..runtime import Runtime
from .base import ProviderClient

__all__ = [
    "RuneScapeGame",
    "JagexProvider",
    "EveProvider",
]

#: Which of the two RuneScape hiscore tables a call is about.
RuneScapeGame = Literal["osrs", "rs3"]

#: The path segment Jagex uses for each game.
_GAME_PREFIX: dict[str, str] = {
    "osrs": "m=hiscore_oldschool",
    "rs3": "m=hiscore",
}

#: The skill order of the CSV form, which carries no names.
#:
#: Only used by the fallback below. The order is fixed by Jagex and has only
#: ever been appended to - a new skill arrives at the end, which is why reading
#: this table positionally is safe and why a position past it comes back as
#: ``Skill 30`` rather than as a guess.
_CSV_SKILLS: tuple[str, ...] = (
    "Overall",
    "Attack",
    "Defence",
    "Strength",
    "Hitpoints",
    "Ranged",
    "Prayer",
    "Magic",
    "Cooking",
    "Woodcutting",
    "Fletching",
    "Fishing",
    "Firemaking",
    "Crafting",
    "Smithing",
    "Mining",
    "Herblore",
    "Agility",
    "Thieving",
    "Slayer",
    "Farming",
    "Runecraft",
    "Hunter",
    "Construction",
)


def _ranked(value: Any) -> int | None:
    """``-1`` is the hiscores' spelling of "unranked". Never report it as a rank."""
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        return None
    return None if numeric < 0 else numeric


class JagexProvider(ProviderClient):
    """Jagex's RuneScape hiscores.

    Two games on one host, distinguished only by a path prefix. Both have
    published the same lite endpoint for two decades, which makes this one of
    the most stable player APIs anywhere.

    A hiscore entry is a **rank, a level and an experience total per skill**,
    plus a rank and a score per tracked activity. There is no match history and
    no profile: the hiscores are a ladder, and the registry says so rather than
    implying more. The *ranked* pages are HTML and are therefore out of scope -
    this package does not scrape.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("jagex", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    async def get_hiscores(self, game: RuneScapeGame, name: str) -> dict[str, Any]:
        """A player's hiscores entry.

        Asks for the JSON form first, because it carries the skill and activity
        names inline: when Jagex adds a skill - and they do - a name-carrying
        response stays correct while a positional one silently shifts every
        column after it. The CSV form is the fallback, and the only reason it
        exists here is that it is the form that has been stable the longest.
        """
        title_id = "old-school-runescape" if game == "osrs" else "runescape"

        async def fetch() -> dict[str, Any]:
            prefix = _GAME_PREFIX[game]
            query = {"player": name}

            payload = await self.get(
                f"/{prefix}/index_lite.json", query=query, null_on_404=True
            )
            if isinstance(payload, dict) and isinstance(payload.get("skills"), list):
                return self._from_json(payload)

            csv = await self.get(
                f"/{prefix}/index_lite.ws", query=query, null_on_404=True, parse="text"
            )
            if not isinstance(csv, str) or not csv.strip():
                raise NotFoundError(self.id, f'RuneScape player "{name}"', title_id)
            return self._from_csv(csv)

        return await self.cached(
            ["hiscores", game, name.lower()], "getRank", title_id, TTL["rank"], fetch
        )

    def _from_json(self, payload: dict[str, Any]) -> dict[str, Any]:
        """The JSON form: names come from the upstream, so nothing is positional."""
        skills = []
        for index, raw in enumerate(payload.get("skills") or []):
            row = raw if isinstance(raw, dict) else {}
            skills.append(
                {
                    "id": row["id"] if isinstance(row.get("id"), int) else index,
                    "name": row.get("name")
                    if isinstance(row.get("name"), str)
                    else f"Skill {index}",
                    "rank": _ranked(row.get("rank")),
                    "level": _ranked(row.get("level")),
                    "xp": _ranked(row.get("xp")),
                }
            )
        activities = []
        for index, raw in enumerate(payload.get("activities") or []):
            row = raw if isinstance(raw, dict) else {}
            activities.append(
                {
                    "id": row["id"] if isinstance(row.get("id"), int) else index,
                    "name": row.get("name")
                    if isinstance(row.get("name"), str)
                    else f"Activity {index}",
                    "rank": _ranked(row.get("rank")),
                    "score": _ranked(row.get("score")),
                }
            )
        return {"skills": skills, "activities": activities}

    def _from_csv(self, csv: str) -> dict[str, Any]:
        """The CSV form: ``rank,level,xp`` per skill, then ``rank,score`` per activity.

        The boundary between the two is where the rows stop having three
        columns, which is how the format has always been read. Activities are
        numbered rather than named because the CSV carries no names and
        inventing them from a table Jagex reorders would be worse than admitting
        the gap.
        """
        rows = [
            [cell.strip() for cell in line.split(",")]
            for line in re.split(r"\r?\n", csv.strip())
        ]
        rows = [cells for cells in rows if len(cells) >= 2]

        skills: list[dict[str, Any]] = []
        activities: list[dict[str, Any]] = []
        for index, cells in enumerate(rows):
            if len(cells) >= 3 and len(skills) == index:
                skills.append(
                    {
                        "id": index,
                        "name": _CSV_SKILLS[index]
                        if index < len(_CSV_SKILLS)
                        else f"Skill {index}",
                        "rank": _ranked(cells[0]),
                        "level": _ranked(cells[1]),
                        "xp": _ranked(cells[2]),
                    }
                )
                continue
            position = len(activities)
            activities.append(
                {
                    "id": position,
                    "name": f"Activity {position}",
                    "rank": _ranked(cells[0]),
                    "score": _ranked(cells[1]),
                }
            )

        if not skills:
            raise ParseError(self.id, "the hiscores returned no skill rows")
        return {"skills": skills, "activities": activities}


class EveProvider(ProviderClient):
    """CCP's EVE Swagger Interface (ESI).

    The public half only: a character's own record, the corporation and alliance
    behind it, and the server status. Everything private - assets, wallet, mail
    - needs that character's own OAuth token and is deliberately out of scope.

    ESI is keyed on numeric character ids, and names are **not stable over
    time**: a character can be renamed and the id is what survives. That is why
    ``resolve_character`` returns the id and why the profile carries it rather
    than the name it was looked up by.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("eve-esi", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    async def resolve_character(self, name: str) -> dict[str, Any]:
        """A character name to its id.

        ``/universe/ids/`` answers across every category, so a name that exists
        only as a corporation comes back with an empty ``characters`` list -
        which is a missing *character*, not a missing name, and is reported as
        such.
        """

        async def fetch() -> dict[str, Any]:
            found = await self.post(
                "/universe/ids/", [name], query={"datasource": "tranquility"}
            )
            characters = (found or {}).get("characters") or []
            for entry in characters:
                if (
                    isinstance(entry, dict)
                    and isinstance(entry.get("id"), int)
                    and entry["id"] > 0
                ):
                    return {"id": entry["id"], "name": entry.get("name") or name}
            raise NotFoundError(self.id, f'EVE character "{name}"', "eve-online")

        return await self.cached(
            ["character-id", name.lower()],
            "resolvePlayer",
            "eve-online",
            TTL["resolvePlayer"],
            fetch,
        )

    async def get_character(self, character_id: int) -> dict[str, Any]:
        """The public half of a character record."""

        async def fetch() -> dict[str, Any]:
            row = await self.get(
                f"/characters/{character_id}/",
                query={"datasource": "tranquility"},
                null_on_404=True,
            )
            if not row:
                raise NotFoundError(self.id, f"EVE character {character_id}", "eve-online")
            return {
                "id": character_id,
                "name": row.get("name")
                if isinstance(row.get("name"), str)
                else str(character_id),
                "corporationId": row.get("corporation_id")
                if isinstance(row.get("corporation_id"), int)
                else None,
                "allianceId": row.get("alliance_id")
                if isinstance(row.get("alliance_id"), int)
                else None,
                "birthday": row.get("birthday")
                if isinstance(row.get("birthday"), str)
                else None,
                "securityStatus": row.get("security_status")
                if isinstance(row.get("security_status"), (int, float))
                else None,
                "raceId": row.get("race_id") if isinstance(row.get("race_id"), int) else None,
                "description": row.get("description")
                if isinstance(row.get("description"), str)
                else None,
            }

        return await self.cached(
            ["character", character_id], "getPlayer", "eve-online", TTL["player"], fetch
        )

    async def get_corporation(self, corporation_id: int) -> dict[str, Any] | None:
        """A corporation, as much of it as is public."""

        async def fetch() -> dict[str, Any] | None:
            row = await self.get(
                f"/corporations/{corporation_id}/",
                query={"datasource": "tranquility"},
                null_on_404=True,
            )
            if not row:
                return None
            return {
                "id": corporation_id,
                "name": row.get("name")
                if isinstance(row.get("name"), str)
                else str(corporation_id),
                "ticker": row.get("ticker") if isinstance(row.get("ticker"), str) else None,
                "memberCount": row.get("member_count")
                if isinstance(row.get("member_count"), int)
                else None,
                "founded": row.get("date_founded")
                if isinstance(row.get("date_founded"), str)
                else None,
            }

        return await self.cached(
            ["corporation", corporation_id],
            "getPlayer",
            "eve-online",
            TTL["metadata"],
            fetch,
        )

    async def get_alliance(self, alliance_id: int) -> dict[str, Any] | None:
        """An alliance. Same shape as a corporation; EVE reports fewer fields."""

        async def fetch() -> dict[str, Any] | None:
            row = await self.get(
                f"/alliances/{alliance_id}/",
                query={"datasource": "tranquility"},
                null_on_404=True,
            )
            if not row:
                return None
            return {
                "id": alliance_id,
                "name": row.get("name")
                if isinstance(row.get("name"), str)
                else str(alliance_id),
                "ticker": row.get("ticker") if isinstance(row.get("ticker"), str) else None,
                "memberCount": None,
                "founded": row.get("date_founded")
                if isinstance(row.get("date_founded"), str)
                else None,
            }

        return await self.cached(
            ["alliance", alliance_id], "getPlayer", "eve-online", TTL["metadata"], fetch
        )

    async def get_server_status(self) -> dict[str, Any]:
        """The server's own status: players online, and which build they are on."""

        async def fetch() -> dict[str, Any]:
            row = await self.get(
                "/status/", query={"datasource": "tranquility"}, null_on_404=True
            )
            return row or {}

        return await self.cached(["status"], "getMetadata", "eve-online", 60, fetch)
