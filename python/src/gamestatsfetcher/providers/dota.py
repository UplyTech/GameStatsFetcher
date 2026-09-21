"""Dota 2's two community APIs, and HenrikDev for VALORANT.

Valve's own match API exists and is in :class:`SteamProvider`, but it is thin:
no per-minute economy, no lane assignment, no aggregate hero performance. Both
Dota providers here re-parse replays and expose what the game actually recorded.

OpenDota is first because it works with no key at all. STRATZ needs a token and
speaks GraphQL, but answers questions OpenDota cannot.

HenrikDev shares this module because it plays the same role for VALORANT that
OpenDota plays for Dota 2: it serves data the publisher gates behind an approved
production key.
"""

from __future__ import annotations

from typing import Any

from ..constants import TTL
from ..errors import NotFoundError, ParseError
from ..http import RequestSpec
from ..identity import to_steam_account_id
from ..runtime import Runtime
from .base import ProviderClient

__all__ = ["OpenDotaProvider", "StratzProvider", "HenrikDevProvider", "dota_rank_name"]

#: Dota 2 rank tiers are a two-digit code: tens are the medal, units the star.
#: ``55`` is Legend 5, ``80`` is Immortal.
_MEDALS = (
    "Uncalibrated",
    "Herald",
    "Guardian",
    "Crusader",
    "Archon",
    "Legend",
    "Ancient",
    "Divine",
    "Immortal",
)


def dota_rank_name(rank_tier: int | None) -> str | None:
    """Turn a ``rank_tier`` into the label a player would recognise."""
    if rank_tier is None:
        return None
    index = rank_tier // 10
    if index >= len(_MEDALS):
        return None
    medal = _MEDALS[index]
    star = rank_tier % 10
    if medal in ("Immortal", "Uncalibrated") or star == 0:
        return medal
    return f"{medal} {star}"


class OpenDotaProvider(ProviderClient):
    def __init__(self, runtime: Runtime) -> None:
        super().__init__("opendota", runtime)

    def auth_query_name(self) -> str:
        return "api_key"

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        """OpenDota works without a key, so the credential is opportunistic.

        The generic authoriser would raise for a missing key; here a missing key
        just means the lower free-tier quota.
        """
        key = self.runtime.api_keys.get("opendota")
        if not key:
            return spec
        return spec.merged(query={"api_key": key, **spec.query})

    async def get_player(self, steam_or_account_id: str) -> dict[str, Any]:
        """Player profile and rank. Keyed on the 32-bit account id."""
        account_id = to_steam_account_id(steam_or_account_id)

        async def fetch() -> dict[str, Any]:
            player = await self.get(f"/players/{account_id}", null_on_404=True)
            # OpenDota answers 200 with `{}` for an account it has never seen.
            if not player or not player.get("profile"):
                raise NotFoundError(self.id, f"Dota 2 account {account_id}", "dota2")
            return dict(player)

        return await self.cached([account_id], "getPlayer", "dota2", TTL["player"], fetch)

    async def get_win_loss(
        self,
        steam_or_account_id: str,
        *,
        limit: int | None = None,
        lobby_type: int | None = None,
    ) -> dict[str, int]:
        """Career wins and losses."""
        account_id = to_steam_account_id(steam_or_account_id)

        async def fetch() -> dict[str, int]:
            result = await self.get(
                f"/players/{account_id}/wl",
                query={"limit": limit, "lobby_type": lobby_type},
                null_on_404=True,
            )
            return dict(result or {"win": 0, "lose": 0})

        return await self.cached(
            [account_id, "wl", limit or 0, lobby_type if lobby_type is not None else -1],
            "getPlayerStats",
            "dota2",
            TTL["playerStats"],
            fetch,
        )

    async def get_matches(
        self,
        steam_or_account_id: str,
        *,
        limit: int = 20,
        offset: int = 0,
        hero_id: int | None = None,
        date: int | None = None,
    ) -> list[dict[str, Any]]:
        """Recent matches, newest first."""
        account_id = to_steam_account_id(steam_or_account_id)

        async def fetch() -> list[dict[str, Any]]:
            matches = await self.get(
                f"/players/{account_id}/matches",
                query={
                    "limit": limit,
                    "offset": offset,
                    "hero_id": hero_id,
                    # OpenDota's `date` is "how many days back", not a timestamp.
                    "date": date,
                },
                null_on_404=True,
            )
            return self.rows(matches or [])

        return await self.cached(
            [account_id, "matches", limit, offset, hero_id or 0],
            "getMatchHistory",
            "dota2",
            TTL["matchHistory"],
            fetch,
        )

    async def get_hero_performance(self, steam_or_account_id: str) -> list[dict[str, Any]]:
        """Per-hero career performance."""
        account_id = to_steam_account_id(steam_or_account_id)
        heroes = await self.get(f"/players/{account_id}/heroes", null_on_404=True)
        return self.rows(heroes or [])

    async def get_totals(self, steam_or_account_id: str) -> list[dict[str, Any]]:
        """Career totals: last hits, GPM, damage and the rest."""
        account_id = to_steam_account_id(steam_or_account_id)
        totals = await self.get(f"/players/{account_id}/totals", null_on_404=True)
        return self.rows(totals or [])

    async def get_match(self, match_id: str) -> dict[str, Any]:
        """Full match detail, including the per-player breakdown."""

        async def fetch() -> dict[str, Any]:
            match = await self.get(f"/matches/{match_id}", null_on_404=True)
            if not match:
                raise NotFoundError(self.id, f"Dota 2 match {match_id}", "dota2")
            return dict(match)

        return await self.cached(["match", match_id], "getMatch", "dota2", TTL["match"], fetch)

    async def get_pro_matches(
        self, less_than_match_id: str | None = None
    ) -> list[dict[str, Any]]:
        """The professional match feed."""
        matches = await self.get(
            "/proMatches",
            query={"less_than_match_id": less_than_match_id},
            null_on_404=True,
        )
        return self.rows(matches or [])

    async def get_pro_players(self) -> list[dict[str, Any]]:
        """Professional players, with their team affiliation."""

        async def fetch() -> list[dict[str, Any]]:
            players = await self.get("/proPlayers", null_on_404=True)
            return self.rows(players or [])

        return await self.cached(
            ["proPlayers"], "getEsportsPlayers", "dota2", TTL["esportsPlayers"], fetch
        )

    async def get_teams(self) -> list[dict[str, Any]]:
        """Professional teams, ranked by rating."""

        async def fetch() -> list[dict[str, Any]]:
            teams = await self.get("/teams", null_on_404=True)
            return self.rows(teams or [])

        return await self.cached(
            ["teams"], "getEsportsTeams", "dota2", TTL["esportsTeams"], fetch
        )

    async def get_heroes(self) -> list[dict[str, Any]]:
        """Hero metadata, for turning hero ids into names."""

        async def fetch() -> list[dict[str, Any]]:
            return self.rows(await self.get("/heroes") or [])

        return await self.cached(["heroes"], "getMetadata", "dota2", TTL["metadata"], fetch)

    async def get_leaderboard(self, region: str) -> dict[str, Any] | None:
        """Public leaderboard: ``europe``, ``americas``, ``se_asia``, ``china``."""
        return await self.get_object(
            "/leaderboard", query={"region": region}, null_on_404=True
        )

    async def request_parse(self, match_id: str) -> dict[str, Any] | None:
        """Ask OpenDota to parse a match's replay.

        Unparsed matches have no per-minute data at all. Parsing is queued and
        takes minutes, so this returns the job rather than the result.
        """
        return self.as_object(await self.post(f"/request/{match_id}", {}), "request parse")


class StratzProvider(ProviderClient):
    """STRATZ.

    GraphQL, and generous about what it exposes - but the free tier requires the
    ``STRATZ_API`` User-Agent and quietly returns nothing without it. That header
    is set here rather than left to the caller.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("stratz", runtime)

    async def query(self, query: str, variables: dict[str, Any] | None = None) -> Any:
        """Run a query against STRATZ, with the required User-Agent attached."""
        response = await self.request(
            "",
            RequestSpec(
                method="POST",
                headers={"User-Agent": "STRATZ_API"},
                json={"query": query, "variables": variables or {}},
            ),
        )
        if isinstance(response, dict) and response.get("errors"):
            detail = "; ".join(
                str(error.get("message", "unknown")) for error in response["errors"]
            )
            raise ParseError(self.id, detail)
        if not isinstance(response, dict) or response.get("data") is None:
            raise ParseError(self.id, "query returned no data")
        return response["data"]

    async def get_player(self, steam_or_account_id: str) -> dict[str, Any]:
        """Player summary, with the behaviour and imp figures OpenDota lacks."""
        account_id = int(to_steam_account_id(steam_or_account_id))

        async def fetch() -> dict[str, Any]:
            data = await self.query(
                """query Player($id: Long!) {
                  player(steamAccountId: $id) {
                    steamAccount { id name avatar profileUri seasonRank seasonLeaderboardRank isAnonymous }
                    matchCount
                    winCount
                    behaviorScore
                    firstMatchDate
                    lastMatchDate
                    imp
                  }
                }""",
                {"id": account_id},
            )
            player = data.get("player")
            if not player:
                raise NotFoundError(self.id, f"Dota 2 account {account_id}", "dota2")
            return dict(player)

        return await self.cached(
            [account_id, "player"], "getPlayer", "dota2", TTL["player"], fetch
        )

    async def get_matches(
        self, steam_or_account_id: str, limit: int = 20
    ) -> list[dict[str, Any]]:
        """Recent matches with the fields STRATZ adds on top of the replay."""
        account_id = int(to_steam_account_id(steam_or_account_id))
        data = await self.query(
            """query Matches($id: Long!, $take: Int!) {
              player(steamAccountId: $id) {
                matches(request: { take: $take }) {
                  id didRadiantWin durationSeconds startDateTime lobbyType gameMode
                  players(steamAccountId: $id) {
                    heroId kills deaths assists networth goldPerMinute
                    experiencePerMinute imp isVictory
                  }
                }
              }
            }""",
            {"id": account_id, "take": limit},
        )
        return self.rows((data.get("player") or {}).get("matches") or [])

    async def get_match(self, match_id: str) -> dict[str, Any]:
        """Full match detail."""

        async def fetch() -> dict[str, Any]:
            data = await self.query(
                """query Match($id: Long!) {
                  match(id: $id) {
                    id didRadiantWin durationSeconds startDateTime gameMode lobbyType
                    players {
                      steamAccountId heroId isRadiant kills deaths assists networth
                      goldPerMinute experiencePerMinute heroDamage towerDamage imp role lane
                    }
                  }
                }""",
                {"id": int(match_id)},
            )
            match = data.get("match")
            if not match:
                raise NotFoundError(self.id, f"Dota 2 match {match_id}", "dota2")
            return dict(match)

        return await self.cached(["match", match_id], "getMatch", "dota2", TTL["match"], fetch)


class HenrikDevProvider(ProviderClient):
    """HenrikDev VALORANT API.

    Riot's own VALORANT endpoints need an approved *production* key, granted per
    application and not to most callers. This provider serves the same data -
    MMR, full match detail, act leaderboards - to anyone with a free tiered key,
    which is why VALORANT lists it directly after ``riot``.

    Region here is VALORANT's own vocabulary (``eu``, ``na``, ``ap``, ``kr``,
    ``latam``, ``br``), not a Riot platform host.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("henrikdev", runtime)

    def auth_header_name(self) -> str:
        # HenrikDev takes the key in a bare Authorization header, without Bearer.
        return "Authorization"

    async def get_account(self, name: str, tag: str) -> dict[str, Any]:
        """Account by Riot ID, which is also how a PUUID is obtained here."""
        from urllib.parse import quote

        async def fetch() -> dict[str, Any]:
            response = await self.get(
                f"/v1/account/{quote(name, safe='')}/{quote(tag, safe='')}",
                null_on_404=True,
            )
            data = (response or {}).get("data")
            if not data or not data.get("puuid"):
                raise NotFoundError(self.id, f"Riot ID {name}#{tag}", "valorant")
            return dict(data)

        return await self.cached(
            ["account", name.lower(), tag.lower()],
            "resolvePlayer",
            "valorant",
            TTL["resolvePlayer"],
            fetch,
        )

    async def get_account_by_puuid(self, puuid: str) -> dict[str, Any]:
        """Account by PUUID, for refreshing the display name of a stored ref."""
        response = await self.get(f"/v1/by-puuid/account/{puuid}", null_on_404=True)
        data = (response or {}).get("data")
        if not data or not data.get("puuid"):
            raise NotFoundError(self.id, f"PUUID {puuid}", "valorant")
        return dict(data)

    async def get_mmr(self, region: str, puuid: str) -> dict[str, Any]:
        """Competitive rank and RR."""

        async def fetch() -> dict[str, Any]:
            response = await self.get(f"/v2/by-puuid/mmr/{region}/{puuid}", null_on_404=True)
            return dict((response or {}).get("data") or {})

        return await self.cached(
            ["mmr", region, puuid], "getRank", "valorant", TTL["rank"], fetch
        )

    async def get_mmr_history(self, region: str, puuid: str) -> list[dict[str, Any]]:
        """RR changes match by match - the "why did I lose 20 RR" endpoint."""
        response = await self.get(
            f"/v1/by-puuid/mmr-history/{region}/{puuid}", null_on_404=True
        )
        return self.rows((response or {}).get("data") or [])

    async def get_matches(
        self,
        region: str,
        puuid: str,
        *,
        size: int = 10,
        mode: str | None = None,
        map_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """Recent matches with the full scoreboard attached."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                f"/v3/by-puuid/matches/{region}/{puuid}",
                query={
                    # The upstream caps this at 10 and errors above it rather
                    # than clamping, so it is clamped here.
                    "size": min(size, 10),
                    "mode": mode,
                    "map": map_name,
                },
                null_on_404=True,
            )
            return self.rows((response or {}).get("data") or [])

        return await self.cached(
            ["matches", region, puuid, size, mode or "-"],
            "getMatchHistory",
            "valorant",
            TTL["matchHistory"],
            fetch,
        )

    async def get_match(self, match_id: str) -> dict[str, Any]:
        """One match by id."""

        async def fetch() -> dict[str, Any]:
            response = await self.get(f"/v2/match/{match_id}", null_on_404=True)
            data = (response or {}).get("data")
            if not data:
                raise NotFoundError(self.id, f"VALORANT match {match_id}", "valorant")
            return dict(data)

        return await self.cached(
            ["match", match_id], "getMatch", "valorant", TTL["match"], fetch
        )

    async def get_leaderboard(
        self,
        region: str,
        *,
        size: int = 100,
        start_index: int = 0,
        season: str | None = None,
    ) -> list[dict[str, Any]]:
        """The act leaderboard for a region."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                f"/v3/leaderboard/{region}/pc",
                query={
                    "size": min(size, 1_000),
                    "start": start_index,
                    "season": season,
                },
                null_on_404=True,
            )
            return self.rows(((response or {}).get("data") or {}).get("players") or [])

        return await self.cached(
            ["leaderboard", region, season or "current", size],
            "getLeaderboard",
            "valorant",
            TTL["leaderboard"],
            fetch,
        )

    async def get_content(self) -> dict[str, Any] | None:
        """Agents, maps and weapons."""

        async def fetch() -> dict[str, Any] | None:
            return await self.get_object(
                "/v1/content", query={"locale": "en-US"}, null_on_404=True
            )

        return await self.cached(
            ["content"], "getMetadata", "valorant", TTL["metadata"], fetch
        )

    async def get_esports_schedule(
        self, region: str | None = None, league: str | None = None
    ) -> list[dict[str, Any]]:
        """The professional schedule Riot publishes for VALORANT."""
        response = await self.get(
            "/v1/esports/schedule",
            query={"region": region, "league": league},
            null_on_404=True,
        )
        return self.rows((response or {}).get("data") or [])
