"""Riot Games API.

Serves League of Legends, Teamfight Tactics, VALORANT and Legends of Runeterra.

The thing that catches everybody is the **split routing**. Riot has two kinds of
host and they are not interchangeable:

* **Platform hosts** (``euw1``, ``na1``, ``kr``, ...) serve anything tied to a
  game account on one shard: summoners, league entries, spectator.
* **Regional clusters** (``europe``, ``americas``, ``asia``, ``sea``) serve the
  account API and, since Match-v5, all match data.

Calling the right endpoint on the wrong host returns 404, not a helpful error,
so the mapping lives here in one table rather than being guessed at each site.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ..constants import TTL
from ..errors import NotFoundError, ValidationError
from ..runtime import Runtime
from .base import ProviderClient

__all__ = ["RiotProvider", "PLATFORM_TO_CLUSTER", "VALORANT_SHARDS"]

#: Platform host to regional cluster. The table that prevents the 404s.
PLATFORM_TO_CLUSTER: dict[str, str] = {
    "br1": "americas",
    "la1": "americas",
    "la2": "americas",
    "na1": "americas",
    "oc1": "sea",
    "ru": "europe",
    "tr1": "europe",
    "eun1": "europe",
    "euw1": "europe",
    "me1": "europe",
    "jp1": "asia",
    "kr": "asia",
    "ph2": "sea",
    "sg2": "sea",
    "th2": "sea",
    "tw2": "sea",
    "vn2": "sea",
}

_CLUSTERS = {"americas", "europe", "asia", "sea"}

#: VALORANT uses its own shard names, which are not the platform hosts.
VALORANT_SHARDS = {"eu", "na", "ap", "kr", "latam", "br", "esports"}


class RiotProvider(ProviderClient):
    def __init__(self, runtime: Runtime) -> None:
        super().__init__("riot", runtime)

    def auth_header_name(self) -> str:
        return "X-Riot-Token"

    def cluster_for(self, platform: str) -> str:
        """The regional cluster a platform belongs to."""
        lowered = platform.lower()
        cluster = PLATFORM_TO_CLUSTER.get(lowered)
        if cluster:
            return cluster
        # A caller who already passed a cluster gets it back rather than an
        # error; "europe" is a legitimate thing to hand a match lookup.
        if lowered in _CLUSTERS:
            return lowered
        raise ValidationError(
            f'unknown Riot platform "{platform}". '
            f"Expected one of: {', '.join(PLATFORM_TO_CLUSTER)}"
        )

    def valorant_shard(self, shard: str) -> str:
        """Validate a VALORANT shard, a different vocabulary again."""
        lowered = shard.lower()
        if lowered not in VALORANT_SHARDS:
            raise ValidationError(
                f'unknown VALORANT shard "{shard}". '
                f"Expected one of: {', '.join(sorted(VALORANT_SHARDS))}"
            )
        return lowered

    @staticmethod
    def _host(routing: str) -> str:
        return f"https://{routing}.api.riotgames.com"

    # -----------------------------------------------------------------------
    # Account (regional cluster)
    # -----------------------------------------------------------------------

    async def get_account_by_riot_id(
        self, game_name: str, tag_line: str, routing: str, title_id: str
    ) -> dict[str, Any]:
        """Riot ID to PUUID. The entry point for every Riot title."""
        cluster = self.cluster_for(routing)

        async def fetch() -> dict[str, Any]:
            account = await self.get(
                f"{self._host(cluster)}/riot/account/v1/accounts/by-riot-id/"
                f"{quote(game_name, safe='')}/{quote(tag_line, safe='')}",
                null_on_404=True,
            )
            if not account or not account.get("puuid"):
                raise NotFoundError(self.id, f"Riot ID {game_name}#{tag_line}", title_id)
            return dict(account)

        return await self.cached(
            ["account", cluster, game_name.lower(), tag_line.lower()],
            "resolvePlayer",
            title_id,
            TTL["resolvePlayer"],
            fetch,
        )

    async def get_account_by_puuid(
        self, puuid: str, routing: str, title_id: str
    ) -> dict[str, Any]:
        """PUUID back to a Riot ID, for showing the current name of a stored id."""
        cluster = self.cluster_for(routing)

        async def fetch() -> dict[str, Any]:
            account = await self.get(
                f"{self._host(cluster)}/riot/account/v1/accounts/by-puuid/{puuid}",
                null_on_404=True,
            )
            if not account or not account.get("puuid"):
                raise NotFoundError(self.id, f"PUUID {puuid}", title_id)
            return dict(account)

        return await self.cached(
            ["account", cluster, puuid],
            "resolvePlayer",
            title_id,
            TTL["resolvePlayer"],
            fetch,
        )

    # -----------------------------------------------------------------------
    # League of Legends
    # -----------------------------------------------------------------------

    async def get_summoner_by_puuid(self, puuid: str, platform: str) -> dict[str, Any]:
        """Summoner record, which carries the account level."""

        async def fetch() -> dict[str, Any]:
            summoner = await self.get(
                f"{self._host(platform)}/lol/summoner/v4/summoners/by-puuid/{puuid}",
                null_on_404=True,
            )
            if not summoner:
                raise NotFoundError(
                    self.id, f"summoner {puuid} on {platform}", "league-of-legends"
                )
            return dict(summoner)

        return await self.cached(
            ["summoner", platform, puuid],
            "getPlayer",
            "league-of-legends",
            TTL["player"],
            fetch,
        )

    async def get_league_entries(self, puuid: str, platform: str) -> list[dict[str, Any]]:
        """Ranked entries - one per queue played this split."""

        async def fetch() -> list[dict[str, Any]]:
            entries = await self.get(
                f"{self._host(platform)}/lol/league/v4/entries/by-puuid/{puuid}",
                null_on_404=True,
            )
            # An unranked player is a 200 with an empty list, and an old account
            # can be a 404. Both mean "no rank", not "no player".
            return self.rows(entries or [])

        return await self.cached(
            ["league", platform, puuid],
            "getRank",
            "league-of-legends",
            TTL["rank"],
            fetch,
        )

    async def get_match_ids(
        self,
        puuid: str,
        routing: str,
        *,
        count: int = 20,
        start: int = 0,
        start_time: int | None = None,
        end_time: int | None = None,
        queue: int | None = None,
        type_: str | None = None,
    ) -> list[str]:
        """Match ids, newest first. Match-v5 lives on the cluster, not the platform."""
        cluster = self.cluster_for(routing)
        ids = await self.get(
            f"{self._host(cluster)}/lol/match/v5/matches/by-puuid/{puuid}/ids",
            query={
                "count": count,
                "start": start,
                # Riot wants seconds here while every other timestamp it returns
                # is in milliseconds.
                "startTime": start_time // 1_000 if start_time else None,
                "endTime": end_time // 1_000 if end_time else None,
                "queue": queue,
                "type": type_,
            },
            null_on_404=True,
        )
        return self.rows(ids or [])

    async def get_match(self, match_id: str, routing: str) -> dict[str, Any]:
        """One League match. Cached hard - a finished match never changes."""
        cluster = self.cluster_for(routing)

        async def fetch() -> dict[str, Any]:
            match = await self.get(
                f"{self._host(cluster)}/lol/match/v5/matches/{match_id}", null_on_404=True
            )
            if not match:
                raise NotFoundError(self.id, f"match {match_id}", "league-of-legends")
            return dict(match)

        return await self.cached(
            ["match", cluster, match_id],
            "getMatch",
            "league-of-legends",
            TTL["match"],
            fetch,
        )

    async def get_apex_league(
        self, tier: str, queue: str, platform: str
    ) -> dict[str, Any] | None:
        """The apex tiers, which are separate endpoints from the normal ladder."""
        return await self.get_object(
            f"{self._host(platform)}/lol/league/v4/{tier}leagues/by-queue/{queue}",
            null_on_404=True,
        )

    async def get_league_by_division(
        self, queue: str, tier: str, division: str, platform: str, page: int = 1
    ) -> list[dict[str, Any]]:
        """A page of one division, for walking the ladder below the apex tiers."""
        entries = await self.get(
            f"{self._host(platform)}/lol/league/v4/entries/{queue}/{tier}/{division}",
            query={"page": page},
            null_on_404=True,
        )
        return self.rows(entries or [])

    async def get_champion_mastery(self, puuid: str, platform: str) -> list[dict[str, Any]]:
        """Champion mastery, highest first."""
        rows = await self.get(
            f"{self._host(platform)}/lol/champion-mastery/v4/champion-masteries/"
            f"by-puuid/{puuid}",
            null_on_404=True,
        )
        return self.rows(rows or [])

    async def get_champion_rotation(self, platform: str) -> dict[str, Any] | None:
        """The free champion rotation."""

        async def fetch() -> dict[str, Any] | None:
            return await self.get_object(
                f"{self._host(platform)}/lol/platform/v3/champion-rotations",
                null_on_404=True,
            )

        return await self.cached(
            ["rotation", platform],
            "getMetadata",
            "league-of-legends",
            TTL["metadata"],
            fetch,
        )

    async def get_active_game(self, puuid: str, platform: str) -> dict[str, Any] | None:
        """The game the player is in right now, or ``None``."""
        return await self.get_object(
            f"{self._host(platform)}/lol/spectator/v5/active-games/by-summoner/{puuid}",
            null_on_404=True,
        )

    # -----------------------------------------------------------------------
    # Teamfight Tactics
    # -----------------------------------------------------------------------

    async def get_tft_summoner(self, puuid: str, platform: str) -> dict[str, Any]:
        summoner = await self.get(
            f"{self._host(platform)}/tft/summoner/v1/summoners/by-puuid/{puuid}",
            null_on_404=True,
        )
        if not summoner:
            raise NotFoundError(self.id, f"TFT summoner {puuid}", "teamfight-tactics")
        return dict(summoner)

    async def get_tft_league_entries(self, puuid: str, platform: str) -> list[dict[str, Any]]:
        async def fetch() -> list[dict[str, Any]]:
            entries = await self.get(
                f"{self._host(platform)}/tft/league/v1/by-puuid/{puuid}", null_on_404=True
            )
            return self.rows(entries or [])

        return await self.cached(
            ["tft", "league", platform, puuid],
            "getRank",
            "teamfight-tactics",
            TTL["rank"],
            fetch,
        )

    async def get_tft_match_ids(
        self, puuid: str, routing: str, *, count: int = 20, start: int = 0
    ) -> list[str]:
        cluster = self.cluster_for(routing)
        ids = await self.get(
            f"{self._host(cluster)}/tft/match/v1/matches/by-puuid/{puuid}/ids",
            query={"count": count, "start": start},
            null_on_404=True,
        )
        return self.rows(ids or [])

    async def get_tft_match(self, match_id: str, routing: str) -> dict[str, Any]:
        cluster = self.cluster_for(routing)

        async def fetch() -> dict[str, Any]:
            match = await self.get(
                f"{self._host(cluster)}/tft/match/v1/matches/{match_id}", null_on_404=True
            )
            if not match:
                raise NotFoundError(self.id, f"TFT match {match_id}", "teamfight-tactics")
            return dict(match)

        return await self.cached(
            ["tft", "match", cluster, match_id],
            "getMatch",
            "teamfight-tactics",
            TTL["match"],
            fetch,
        )

    async def get_tft_apex_league(self, tier: str, platform: str) -> dict[str, Any] | None:
        return await self.get_object(
            f"{self._host(platform)}/tft/league/v1/{tier}", null_on_404=True
        )

    # -----------------------------------------------------------------------
    # VALORANT (shard routing, production key required)
    # -----------------------------------------------------------------------

    async def get_valorant_match_list(self, puuid: str, shard: str) -> list[dict[str, Any]]:
        region = self.valorant_shard(shard)
        response = await self.get(
            f"{self._host(region)}/val/match/v1/matchlists/by-puuid/{puuid}",
            null_on_404=True,
        )
        return list((response or {}).get("history", []))

    async def get_valorant_match(self, match_id: str, shard: str) -> dict[str, Any]:
        region = self.valorant_shard(shard)

        async def fetch() -> dict[str, Any]:
            match = await self.get(
                f"{self._host(region)}/val/match/v1/matches/{match_id}", null_on_404=True
            )
            if not match:
                raise NotFoundError(self.id, f"VALORANT match {match_id}", "valorant")
            return dict(match)

        return await self.cached(
            ["val", "match", region, match_id], "getMatch", "valorant", TTL["match"], fetch
        )

    async def get_valorant_leaderboard(
        self, act_id: str, shard: str, *, size: int = 200, start_index: int = 0
    ) -> dict[str, Any] | None:
        """The act leaderboard. ``act_id`` comes from the content endpoint below."""
        region = self.valorant_shard(shard)
        return await self.get_object(
            f"{self._host(region)}/val/ranked/v1/leaderboards/by-act/{act_id}",
            query={"size": size, "startIndex": start_index},
            null_on_404=True,
        )

    async def get_valorant_content(self, shard: str) -> dict[str, Any] | None:
        """Agents, maps, acts and the rest of the static content."""
        region = self.valorant_shard(shard)

        async def fetch() -> dict[str, Any] | None:
            return await self.get_object(
                f"{self._host(region)}/val/content/v1/contents",
                query={"locale": "en-US"},
                null_on_404=True,
            )

        return await self.cached(
            ["val", "content", region], "getMetadata", "valorant", TTL["metadata"], fetch
        )

    # -----------------------------------------------------------------------
    # Legends of Runeterra
    # -----------------------------------------------------------------------

    async def get_lor_leaderboard(self, routing: str) -> list[dict[str, Any]]:
        cluster = self.cluster_for(routing)
        response = await self.get(
            f"{self._host(cluster)}/lor/ranked/v1/leaderboards", null_on_404=True
        )
        return list((response or {}).get("players", []))

    async def get_lor_match_ids(self, puuid: str, routing: str) -> list[str]:
        cluster = self.cluster_for(routing)
        ids = await self.get(
            f"{self._host(cluster)}/lor/match/v1/matches/by-puuid/{puuid}/ids",
            null_on_404=True,
        )
        return self.rows(ids or [])
