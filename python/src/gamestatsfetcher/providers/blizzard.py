"""Blizzard Battle.net API, and the Bungie and PUBG first-party APIs.

Three publishers, three authentication schemes, and each one has exactly one
trap worth stating:

* **Blizzard** is OAuth2 client credentials. The token lives 24 hours and is
  memoised, because minting one per request would triple the call count against
  the same quota.
* **Bungie** wraps everything: a *failed* call is a 200 with a different
  ``ErrorCode``, so a plain HTTP check would treat "player not found" as success.
* **PUBG** allows ten requests a minute on a standard key - the tightest
  first-party quota in this package - and answers 415 without the JSON:API
  accept header.
"""

from __future__ import annotations

import base64
from typing import Any
from urllib.parse import quote

from ..constants import TTL
from ..errors import (
    AuthenticationError,
    NotFoundError,
    ParseError,
    PrivateProfileError,
    ValidationError,
)
from ..http import RequestSpec
from ..identity import parse_riot_id
from ..runtime import Runtime
from .base import ProviderClient

__all__ = ["BlizzardProvider", "BungieProvider", "PubgProvider", "DESTINY_PLATFORMS"]


# ---------------------------------------------------------------------------
# Blizzard
# ---------------------------------------------------------------------------

#: Regions Blizzard serves, and the host each one answers on.
_REGION_HOSTS = {
    "us": "https://us.api.blizzard.com",
    "eu": "https://eu.api.blizzard.com",
    "kr": "https://kr.api.blizzard.com",
    "tw": "https://tw.api.blizzard.com",
    "cn": "https://gateway.battlenet.com.cn",
}

#: The token endpoint is region-specific too, and mainland China differs.
_TOKEN_HOSTS = {
    "us": "https://oauth.battle.net/token",
    "eu": "https://oauth.battle.net/token",
    "kr": "https://oauth.battle.net/token",
    "tw": "https://oauth.battle.net/token",
    "cn": "https://oauth.battlenet.com.cn/token",
}


class BlizzardProvider(ProviderClient):
    """StarCraft II, World of Warcraft and the Hearthstone card database."""

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("blizzard", runtime)

    def host(self, region: str) -> str:
        """Region host, validated so a typo fails here rather than as a DNS error."""
        host = _REGION_HOSTS.get(region.lower())
        if not host:
            raise ValidationError(
                f'unknown Blizzard region "{region}". '
                f"Expected one of: {', '.join(_REGION_HOSTS)}"
            )
        return host

    async def _access_token(self, region: str) -> str:
        """Fetch and cache an access token.

        Held for an hour less than Blizzard says, so a token cannot expire
        between the check and the request that uses it.
        """
        client_id, client_secret = self.require_key_parts(2, "clientId:clientSecret")
        token_host = _TOKEN_HOSTS.get(region.lower(), _TOKEN_HOSTS["us"])

        async def fetch() -> str:
            credentials = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode(
                "ascii"
            )
            response = await self.runtime.http.send(
                self.id,
                token_host,
                RequestSpec(
                    method="POST",
                    headers={
                        "Authorization": f"Basic {credentials}",
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body="grant_type=client_credentials",
                ),
            )
            token = (response or {}).get("access_token")
            if not token:
                raise AuthenticationError(self.id, "token endpoint returned no access_token")
            return str(token)

        return await self.memo(f"token:{region}", 23 * 3_600 * 1_000, fetch)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        """Attach the bearer token.

        The region rides along on the spec's query so this method knows which
        token to mint; it is stripped again before the request goes out, because
        Blizzard rejects the unexpected parameter on some endpoints.
        """
        region = str(spec.query.get("__region", "us"))
        token = await self._access_token(region)
        query = {key: value for key, value in spec.query.items() if key != "__region"}
        return spec.merged(
            query=query, headers={"Authorization": f"Bearer {token}", **spec.headers}
        )

    async def _call(self, region: str, path: str, **kwargs: Any) -> Any:
        query = {**kwargs.pop("query", {}), "__region": region}
        return await self.get(f"{self.host(region)}{path}", query=query, **kwargs)

    async def _call_object(
        self, region: str, path: str, **kwargs: Any
    ) -> dict[str, Any] | None:
        """:meth:`_call` for the endpoints that answer with a single object."""
        return self.as_object(await self._call(region, path, **kwargs), path)

    # -- StarCraft II -------------------------------------------------------

    async def get_sc2_profile(
        self, region: str, region_id: int, realm_id: int, profile_id: str
    ) -> dict[str, Any]:
        """A StarCraft II profile.

        Blizzard's SC2 endpoints are keyed by ``regionId/realmId/profileId``, not
        by BattleTag, which is why SC2Pulse is the preferred provider for this
        title and this is the fallback.
        """

        async def fetch() -> dict[str, Any]:
            profile = await self._call(
                region,
                f"/sc2/profile/{region_id}/{realm_id}/{profile_id}",
                query={"locale": "en_US"},
                null_on_404=True,
            )
            if not profile:
                raise NotFoundError(self.id, f"SC2 profile {profile_id}", "starcraft-2")
            return dict(profile)

        return await self.cached(
            ["sc2", region, region_id, realm_id, profile_id],
            "getPlayer",
            "starcraft-2",
            TTL["player"],
            fetch,
        )

    async def get_sc2_ladder_summary(
        self, region: str, region_id: int, realm_id: int, profile_id: str
    ) -> dict[str, Any] | None:
        """Ladder standings for one profile."""
        return await self._call_object(
            region,
            f"/sc2/profile/{region_id}/{realm_id}/{profile_id}/ladder/summary",
            query={"locale": "en_US"},
            null_on_404=True,
        )

    async def get_sc2_grandmaster_ladder(
        self, region: str, region_id: int
    ) -> dict[str, Any] | None:
        """The one SC2 ladder Blizzard publishes whole."""
        return await self._call_object(
            region, f"/sc2/ladder/grandmaster/{region_id}", null_on_404=True
        )

    # -- World of Warcraft --------------------------------------------------

    async def get_wow_character(
        self, region: str, realm_slug: str, character_name: str
    ) -> dict[str, Any]:
        """A character profile summary. ``realm_slug`` is the slug, not the name."""
        name = character_name.lower()

        async def fetch() -> dict[str, Any]:
            profile = await self._call(
                region,
                f"/profile/wow/character/{realm_slug}/{name}",
                query={"namespace": f"profile-{region}", "locale": "en_US"},
                null_on_404=True,
            )
            if not profile:
                raise NotFoundError(
                    self.id,
                    f"WoW character {character_name}-{realm_slug}",
                    "world-of-warcraft",
                )
            return dict(profile)

        return await self.cached(
            ["wow", region, realm_slug, name],
            "getPlayer",
            "world-of-warcraft",
            TTL["player"],
            fetch,
        )

    async def get_wow_pvp_bracket(
        self, region: str, realm_slug: str, character_name: str, bracket: str
    ) -> dict[str, Any] | None:
        """PvP bracket statistics: 2v2, 3v3, rbg, shuffle."""
        return await self._call_object(
            region,
            f"/profile/wow/character/{realm_slug}/{character_name.lower()}"
            f"/pvp-bracket/{bracket}",
            query={"namespace": f"profile-{region}", "locale": "en_US"},
            null_on_404=True,
        )

    async def get_wow_pvp_leaderboard(
        self, region: str, season: int, bracket: str
    ) -> dict[str, Any] | None:
        """A PvP leaderboard for a season and bracket."""
        return await self._call_object(
            region,
            f"/data/wow/pvp-season/{season}/pvp-leaderboard/{bracket}",
            query={"namespace": f"dynamic-{region}", "locale": "en_US"},
            null_on_404=True,
        )

    # -- Hearthstone (metadata only - there is no player API) ---------------

    async def get_hearthstone_cards(
        self, region: str, query: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        """Card search. The only Hearthstone data Blizzard exposes publicly."""

        async def fetch() -> dict[str, Any] | None:
            return await self._call_object(
                region,
                "/hearthstone/cards",
                query={"locale": "en_US", **(query or {})},
                null_on_404=True,
            )

        return await self.cached(
            ["hs", "cards", region, str(sorted((query or {}).items()))],
            "getMetadata",
            "hearthstone",
            TTL["metadata"],
            fetch,
        )

    async def get_hearthstone_metadata(self, region: str) -> dict[str, Any] | None:
        """Sets, classes, rarities and the rest of the card metadata."""

        async def fetch() -> dict[str, Any] | None:
            return await self._call_object(
                region,
                "/hearthstone/metadata",
                query={"locale": "en_US"},
                null_on_404=True,
            )

        return await self.cached(
            ["hs", "metadata", region], "getMetadata", "hearthstone", TTL["metadata"], fetch
        )

    # -- Diablo III ---------------------------------------------------------
    #
    # The oldest of Blizzard's community APIs and the only one of their games
    # here whose ladder is a *leaderboard of parties*: a Greater Rift record
    # belongs to the group that set it, so a four-player entry names four
    # characters and one clear time.
    #
    # Diablo IV has no equivalent. Blizzard publishes no player API for it, so
    # it is not in the registry - an absent title is a fact about the industry
    # rather than a gap here.

    async def get_d3_profile(self, region: str, battle_tag: str) -> dict[str, Any]:
        """A career profile: every hero, the paragon level, and the account totals.

        BattleTags carry a ``#`` that has to survive into the path, which
        Blizzard spells as ``-``. Passing the ``#`` form is the normal mistake,
        so it is converted here rather than rejected.
        """
        tag = battle_tag.replace("#", "-")

        async def fetch() -> dict[str, Any]:
            profile = await self._call_object(
                region,
                f"/d3/profile/{quote(tag, safe='')}/",
                query={"locale": "en_US"},
                null_on_404=True,
            )
            if not profile:
                raise NotFoundError(self.id, f"Diablo III career {battle_tag}", "diablo-3")
            return profile

        return await self.cached(
            ["d3", "profile", region, tag.lower()],
            "getPlayer",
            "diablo-3",
            TTL["player"],
            fetch,
        )

    async def get_d3_hero(
        self, region: str, battle_tag: str, hero_id: str | int
    ) -> dict[str, Any] | None:
        """One hero in detail: skills, followers, the stats the career omits."""
        tag = battle_tag.replace("#", "-")

        async def fetch() -> dict[str, Any] | None:
            return await self._call_object(
                region,
                f"/d3/profile/{quote(tag, safe='')}/hero/{quote(str(hero_id), safe='')}",
                query={"locale": "en_US"},
                null_on_404=True,
            )

        return await self.cached(
            ["d3", "hero", region, tag.lower(), hero_id],
            "getPlayerStats",
            "diablo-3",
            TTL["playerStats"],
            fetch,
        )

    async def get_d3_season_leaderboard(
        self, region: str, season: int, board: str
    ) -> dict[str, Any] | None:
        """A season leaderboard.

        ``board`` is Blizzard's own key - ``rift-barbarian``, ``rift-team-4``,
        and so on. It is passed through rather than validated against a list,
        because the set changes every season and a hard-coded list would start
        refusing boards that exist.
        """

        async def fetch() -> dict[str, Any] | None:
            return await self._call_object(
                region,
                f"/data/d3/season/{season}/leaderboard/{quote(board, safe='')}",
                query={"locale": "en_US"},
                null_on_404=True,
            )

        return await self.cached(
            ["d3", "leaderboard", region, season, board],
            "getLeaderboard",
            "diablo-3",
            TTL["leaderboard"],
            fetch,
        )

    async def get_d3_season_index(self, region: str) -> dict[str, Any] | None:
        """Which seasons exist, so a caller can ask for "the current one"."""

        async def fetch() -> dict[str, Any] | None:
            return await self._call_object(
                region, "/data/d3/season/", query={"locale": "en_US"}, null_on_404=True
            )

        return await self.cached(
            ["d3", "seasons", region], "getMetadata", "diablo-3", TTL["metadata"], fetch
        )


# ---------------------------------------------------------------------------
# Bungie
# ---------------------------------------------------------------------------

#: ``membershipType`` values. ``-1`` means "all platforms", which is usually right.
DESTINY_PLATFORMS = {
    "xbox": 1,
    "playstation": 2,
    "steam": 3,
    "battlenet": 4,
    "stadia": 5,
    "epic": 6,
    "all": -1,
}

#: The component numbers this package asks for, named.
_COMPONENTS = {
    "profiles": 100,
    "characters": 200,
    "characterActivities": 204,
    "records": 900,
    "metrics": 1100,
}


class BungieProvider(ProviderClient):
    """Destiny 2."""

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("bungie", runtime)

    def auth_header_name(self) -> str:
        return "X-API-Key"

    def _unwrap(self, envelope: Any, what: str) -> Any:
        """Unwrap the envelope, turning a non-1 ``ErrorCode`` into a real error.

        Error code 1 is success. 217 and 1601 mean the account or profile is not
        there; the privacy codes mean it is there and closed.
        """
        if not envelope:
            raise NotFoundError(self.id, what, "destiny-2")
        if envelope.get("ErrorCode") == 1 and envelope.get("Response") is not None:
            return envelope["Response"]

        status = str(envelope.get("ErrorStatus") or "unknown")
        if status == "DestinyAccountNotFound" or envelope.get("ErrorCode") == 1601:
            raise NotFoundError(self.id, what, "destiny-2")
        if "Privacy" in status or status == "DestinyPrivacyRestriction":
            raise PrivateProfileError(self.id, what, "destiny-2")
        raise ParseError(self.id, f"{status}: {envelope.get('Message', 'no message')}")

    async def search_by_bungie_name(
        self, bungie_name: str, membership_type: int = DESTINY_PLATFORMS["all"]
    ) -> list[dict[str, Any]]:
        """Find memberships from a Bungie Name (``Guardian#1234``).

        Bungie splits the name and the four-digit code into two body fields, so
        the Riot ID parser is reused - the format is the same shape.
        """
        parsed = parse_riot_id(bungie_name)
        try:
            code = int(parsed.tag_line)
        except ValueError as error:
            raise NotFoundError(self.id, f"Bungie name {bungie_name}", "destiny-2") from error

        async def fetch() -> list[dict[str, Any]]:
            envelope = await self.post(
                f"/Destiny2/SearchDestinyPlayerByBungieName/{membership_type}/",
                {"displayName": parsed.game_name, "displayNameCode": code},
            )
            return self.rows(self._unwrap(envelope, f"Bungie name {bungie_name}") or [])

        return await self.cached(
            ["search", parsed.game_name.lower(), code, membership_type],
            "resolvePlayer",
            "destiny-2",
            TTL["resolvePlayer"],
            fetch,
        )

    async def get_primary_membership(self, bungie_name: str) -> dict[str, Any]:
        """The primary membership for an account, following cross-save."""
        memberships = await self.search_by_bungie_name(bungie_name)
        if not memberships:
            raise NotFoundError(self.id, f"Bungie name {bungie_name}", "destiny-2")
        # With cross-save on, only the overridden platform holds live data; the
        # others are shells that answer with empty character lists.
        for membership in memberships:
            override = membership.get("crossSaveOverride")
            if override == 0 or override == membership.get("membershipType"):
                return membership
        return memberships[0]

    async def get_profile(
        self,
        membership_type: int,
        membership_id: str,
        components: list[int] | None = None,
    ) -> dict[str, Any]:
        """Profile with the components this package needs."""
        wanted = components or [_COMPONENTS["profiles"], _COMPONENTS["characters"]]
        joined = ",".join(str(component) for component in wanted)

        async def fetch() -> dict[str, Any]:
            envelope = await self.get(
                f"/Destiny2/{membership_type}/Profile/{membership_id}/",
                query={"components": joined},
            )
            return dict(self._unwrap(envelope, f"Destiny profile {membership_id}"))

        return await self.cached(
            ["profile", membership_type, membership_id, joined],
            "getPlayer",
            "destiny-2",
            TTL["player"],
            fetch,
        )

    async def get_character_ids(self, membership_type: int, membership_id: str) -> list[str]:
        """Character ids, newest played first."""
        profile = await self.get_profile(
            membership_type, membership_id, [_COMPONENTS["profiles"]]
        )
        data = (profile.get("profile") or {}).get("data") or {}
        return list(data.get("characterIds", []))

    async def get_account_stats(
        self, membership_type: int, membership_id: str
    ) -> dict[str, Any]:
        """Account-wide aggregate, merging every character."""

        async def fetch() -> dict[str, Any]:
            envelope = await self.get(
                f"/Destiny2/{membership_type}/Account/{membership_id}/Stats/",
                query={"groups": "General"},
            )
            return dict(self._unwrap(envelope, f"account stats for {membership_id}"))

        return await self.cached(
            ["account-stats", membership_type, membership_id],
            "getPlayerStats",
            "destiny-2",
            TTL["playerStats"],
            fetch,
        )

    async def get_activity_history(
        self,
        membership_type: int,
        membership_id: str,
        character_id: str,
        *,
        count: int = 25,
        page: int = 0,
        mode: int | None = None,
    ) -> list[dict[str, Any]]:
        """Recent activities for one character. ``mode`` 5 is all PvP."""
        envelope = await self.get(
            f"/Destiny2/{membership_type}/Account/{membership_id}"
            f"/Character/{character_id}/Stats/Activities/",
            query={"count": count, "page": page, "mode": mode},
        )
        unwrapped = self._unwrap(envelope, f"activities for {character_id}")
        return list((unwrapped or {}).get("activities", []))

    async def get_post_game_carnage_report(self, activity_id: str) -> dict[str, Any]:
        """The full scoreboard for one activity."""

        async def fetch() -> dict[str, Any]:
            # The PGCR endpoint lives on a stats host, not the main platform one.
            envelope = await self.get(
                "https://stats.bungie.net/Platform/Destiny2/Stats/"
                f"PostGameCarnageReport/{activity_id}/"
            )
            return dict(self._unwrap(envelope, f"activity {activity_id}"))

        return await self.cached(
            ["pgcr", activity_id], "getMatch", "destiny-2", TTL["match"], fetch
        )

    async def get_manifest(self) -> dict[str, Any]:
        """The Destiny manifest, for turning hashes into names."""

        async def fetch() -> dict[str, Any]:
            envelope = await self.get("/Destiny2/Manifest/")
            return dict(self._unwrap(envelope, "manifest"))

        return await self.cached(
            ["manifest"], "getMetadata", "destiny-2", TTL["metadata"], fetch
        )


# ---------------------------------------------------------------------------
# PUBG
# ---------------------------------------------------------------------------

PUBG_SHARDS = ("steam", "kakao", "console", "psn", "xbox", "stadia", "tournament")


class PubgProvider(ProviderClient):
    """PUBG: Battlegrounds.

    JSON:API shaped - everything comes back as ``{data, included, links}`` with
    relationships pointing between them, so the useful work here is flattening
    that into something a caller can read.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("pubg", runtime)

    @staticmethod
    def _json_api(extra: dict[str, str] | None = None) -> dict[str, str]:
        """PUBG insists on the JSON:API accept header and answers 415 without it."""
        return {"Accept": "application/vnd.api+json", **(extra or {})}

    async def get_players_by_name(self, shard: str, names: list[str]) -> list[dict[str, Any]]:
        """Look several players up by name in one request - the quota saver."""
        if not names:
            return []
        response = await self.get(
            f"/shards/{shard}/players",
            query={"filter[playerNames]": ",".join(names)},
            headers=self._json_api(),
            null_on_404=True,
        )
        return list((response or {}).get("data", []))

    async def get_player_by_name(self, shard: str, name: str) -> dict[str, Any]:
        async def fetch() -> dict[str, Any]:
            players = await self.get_players_by_name(shard, [name])
            if not players:
                raise NotFoundError(self.id, f"PUBG player {name}", "pubg")
            return players[0]

        return await self.cached(
            [shard, "player", name.lower()],
            "resolvePlayer",
            "pubg",
            TTL["resolvePlayer"],
            fetch,
        )

    async def get_player_by_id(self, shard: str, account_id: str) -> dict[str, Any]:
        async def fetch() -> dict[str, Any]:
            response = await self.get(
                f"/shards/{shard}/players/{account_id}",
                headers=self._json_api(),
                null_on_404=True,
            )
            data = (response or {}).get("data")
            if not data:
                raise NotFoundError(self.id, f"PUBG account {account_id}", "pubg")
            return dict(data)

        return await self.cached(
            [shard, "player-id", account_id], "getPlayer", "pubg", TTL["player"], fetch
        )

    async def get_seasons(self, shard: str) -> list[dict[str, Any]]:
        """Seasons for a shard. The current one carries ``isCurrentSeason``."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(f"/shards/{shard}/seasons", headers=self._json_api())
            return list((response or {}).get("data", []))

        return await self.cached(
            [shard, "seasons"], "getMetadata", "pubg", TTL["metadata"], fetch
        )

    async def get_current_season_id(self, shard: str) -> str:
        seasons = await self.get_seasons(shard)
        for season in seasons:
            if season.get("attributes", {}).get("isCurrentSeason"):
                return str(season["id"])
        raise NotFoundError(self.id, f"current season on {shard}", "pubg")

    async def get_lifetime_stats(
        self, shard: str, account_id: str
    ) -> dict[str, dict[str, Any]]:
        """Lifetime stats across every season, split by game mode."""

        async def fetch() -> dict[str, dict[str, Any]]:
            response = await self.get(
                f"/shards/{shard}/players/{account_id}/seasons/lifetime",
                headers=self._json_api(),
                null_on_404=True,
            )
            attributes = ((response or {}).get("data") or {}).get("attributes") or {}
            return dict(attributes.get("gameModeStats", {}))

        return await self.cached(
            [shard, "lifetime", account_id],
            "getPlayerStats",
            "pubg",
            TTL["playerStats"],
            fetch,
        )

    async def get_season_stats(
        self, shard: str, account_id: str, season_id: str
    ) -> dict[str, dict[str, Any]]:
        """Career stats for one season, split by game mode."""

        async def fetch() -> dict[str, dict[str, Any]]:
            response = await self.get(
                f"/shards/{shard}/players/{account_id}/seasons/{season_id}",
                headers=self._json_api(),
                null_on_404=True,
            )
            attributes = ((response or {}).get("data") or {}).get("attributes") or {}
            return dict(attributes.get("gameModeStats", {}))

        return await self.cached(
            [shard, "season-stats", account_id, season_id],
            "getPlayerStats",
            "pubg",
            TTL["playerStats"],
            fetch,
        )

    async def get_ranked_stats(
        self, shard: str, account_id: str, season_id: str
    ) -> dict[str, dict[str, Any]]:
        """Ranked stats, a separate endpoint with a different shape."""

        async def fetch() -> dict[str, dict[str, Any]]:
            response = await self.get(
                f"/shards/{shard}/players/{account_id}/seasons/{season_id}/ranked",
                headers=self._json_api(),
                null_on_404=True,
            )
            attributes = ((response or {}).get("data") or {}).get("attributes") or {}
            return dict(attributes.get("rankedGameModeStats", {}))

        return await self.cached(
            [shard, "ranked", account_id, season_id], "getRank", "pubg", TTL["rank"], fetch
        )

    async def get_match(self, shard: str, match_id: str) -> dict[str, Any]:
        """One match, with participants and rosters kept alongside the data.

        Matches expire from the API after 14 days, so a 404 here is usually age
        rather than a wrong id.
        """

        async def fetch() -> dict[str, Any]:
            response = await self.get(
                f"/shards/{shard}/matches/{match_id}",
                headers=self._json_api(),
                null_on_404=True,
            )
            if not response or not response.get("data"):
                raise NotFoundError(
                    self.id,
                    f"match {match_id} (matches are dropped after 14 days)",
                    "pubg",
                )
            return {
                "data": response["data"],
                "included": list(response.get("included", [])),
            }

        return await self.cached(
            [shard, "match", match_id], "getMatch", "pubg", TTL["match"], fetch
        )

    async def get_leaderboard(
        self, shard: str, season_id: str, game_mode: str, page: int = 0
    ) -> list[dict[str, Any]]:
        """Ranked leaderboard for a season and mode."""
        response = await self.get(
            f"/shards/{shard}/leaderboards/{season_id}/{game_mode}",
            query={"page[number]": page},
            headers=self._json_api(),
            null_on_404=True,
        )
        return list((response or {}).get("included", []))
