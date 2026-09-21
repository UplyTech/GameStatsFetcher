"""The cross-title esports providers, and the two tournament platforms.

These are what make a title like Tekken 8 or Mobile Legends usable in this
package at all. Bandai Namco publishes no player API, and neither does Moonton -
but the professional circuit around those games is documented in structured form
by somebody, and that is a real API serving real data.

=====================  ==================================================
Provider               Answers
=====================  ==================================================
PandaScore             fixtures, teams, players, standings, live scores
Abios                  the same, for callers who already have a contract
Esports Earnings       career prize money, for every title that paid any
Liquipedia             everything else, as wikitext
start.gg               the fighting-game circuit: sets and placements
Toornament, Challonge  grassroots brackets across every title
=====================  ==================================================
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

from ..constants import TTL
from ..errors import AuthenticationError, NotFoundError, ValidationError
from ..http import RequestSpec
from ..runtime import Runtime
from .base import ProviderClient

__all__ = [
    "PandaScoreProvider",
    "AbiosProvider",
    "EsportsEarningsProvider",
    "LiquipediaProvider",
    "StartGgProvider",
    "ToornamentProvider",
    "ChallongeProvider",
    "PANDASCORE_SLUGS",
]

#: This package's title ids mapped onto PandaScore's videogame slugs.
#:
#: A title absent from this table has no PandaScore coverage, and asking for its
#: fixtures through this provider raises rather than returning an empty list -
#: an empty list would read as "no matches this week".
PANDASCORE_SLUGS = {
    "cs2": "csgo",
    "dota2": "dota2",
    "league-of-legends": "lol",
    "valorant": "valorant",
    "overwatch-2": "ow",
    "rainbow-six-siege": "r6siege",
    "rocket-league": "rl",
    "call-of-duty": "codmw",
    "apex-legends": "apex-legends",
    "pubg": "pubg",
    "pubg-mobile": "pubgm",
    "mobile-legends": "mlbb",
    "honor-of-kings": "kog",
    "free-fire": "free-fire",
    "wild-rift": "lol-wild-rift",
    "ea-fc": "fifa",
    "starcraft-2": "starcraft-2",
    "starcraft-brood-war": "starcraft-brood-war",
    "street-fighter-6": "street-fighter",
    "teamfight-tactics": "lol",
    "halo-infinite": "halo",
    "fortnite": "fortnite",
}


class PandaScoreProvider(ProviderClient):
    def __init__(self, runtime: Runtime) -> None:
        super().__init__("pandascore", runtime)

    def slug(self, title_id: str) -> str:
        """The slug for a title, or a clear error naming what is covered."""
        slug = PANDASCORE_SLUGS.get(title_id)
        if not slug:
            raise ValidationError(
                f'PandaScore does not cover "{title_id}". '
                f"Covered titles: {', '.join(PANDASCORE_SLUGS)}"
            )
        return slug

    async def get_matches(
        self,
        title_id: str,
        *,
        bucket: str | None = None,
        page: int = 1,
        per_page: int = 50,
        since: int | None = None,
        until: int | None = None,
    ) -> list[dict[str, Any]]:
        """Fixtures.

        ``bucket`` picks the endpoint: ``running`` is live now, ``upcoming`` is
        scheduled, ``past`` is finished, and no bucket returns everything.
        """
        slug = self.slug(title_id)
        suffix = f"/{bucket}" if bucket else ""
        # Live fixtures move constantly; finished ones never change again.
        ttl = TTL["esportsMatchesLive"] if bucket == "running" else TTL["esportsMatches"]

        async def fetch() -> list[dict[str, Any]]:
            matches = await self.get(
                f"/{slug}/matches{suffix}",
                query={
                    "page": page,
                    "per_page": min(per_page, 100),
                    "range[begin_at]": _range_filter(since, until),
                    "sort": "-begin_at" if bucket == "past" else "begin_at",
                },
                null_on_404=True,
            )
            return self.rows(matches or [])

        return await self.cached(
            [slug, "matches", bucket or "all", page, per_page],
            "getEsportsMatches",
            title_id,
            ttl,
            fetch,
        )

    async def get_match(self, match_id: str, title_id: str) -> dict[str, Any]:
        """One fixture in full, with games and per-map results."""

        async def fetch() -> dict[str, Any]:
            match = await self.get(f"/matches/{match_id}", null_on_404=True)
            if not match:
                raise NotFoundError(self.id, f"match {match_id}", title_id)
            return dict(match)

        return await self.cached(
            ["match", match_id], "getMatch", title_id, TTL["match"], fetch
        )

    async def get_tournaments(
        self,
        title_id: str,
        *,
        bucket: str | None = None,
        page: int = 1,
        per_page: int = 50,
    ) -> list[dict[str, Any]]:
        """Tournaments, which PandaScore nests under leagues and series."""
        slug = self.slug(title_id)
        suffix = f"/{bucket}" if bucket else ""

        async def fetch() -> list[dict[str, Any]]:
            tournaments = await self.get(
                f"/{slug}/tournaments{suffix}",
                query={"page": page, "per_page": min(per_page, 100)},
                null_on_404=True,
            )
            return self.rows(tournaments or [])

        return await self.cached(
            [slug, "tournaments", bucket or "all", page],
            "getEsportsTournaments",
            title_id,
            TTL["esportsTournaments"],
            fetch,
        )

    async def get_teams(
        self,
        title_id: str,
        *,
        page: int = 1,
        per_page: int = 50,
        search: str | None = None,
    ) -> list[dict[str, Any]]:
        """Teams, with their current roster."""
        slug = self.slug(title_id)

        async def fetch() -> list[dict[str, Any]]:
            teams = await self.get(
                f"/{slug}/teams",
                query={
                    "page": page,
                    "per_page": min(per_page, 100),
                    "search[name]": search,
                },
                null_on_404=True,
            )
            return self.rows(teams or [])

        return await self.cached(
            [slug, "teams", page, search or "-"],
            "getEsportsTeams",
            title_id,
            TTL["esportsTeams"],
            fetch,
        )

    async def get_players(
        self,
        title_id: str,
        *,
        page: int = 1,
        per_page: int = 50,
        search: str | None = None,
    ) -> list[dict[str, Any]]:
        """Professional players."""
        slug = self.slug(title_id)

        async def fetch() -> list[dict[str, Any]]:
            players = await self.get(
                f"/{slug}/players",
                query={
                    "page": page,
                    "per_page": min(per_page, 100),
                    "search[name]": search,
                },
                null_on_404=True,
            )
            return self.rows(players or [])

        return await self.cached(
            [slug, "players", page, search or "-"],
            "getEsportsPlayers",
            title_id,
            TTL["esportsPlayers"],
            fetch,
        )

    async def get_standings(self, tournament_id: str, title_id: str) -> list[dict[str, Any]]:
        """Standings for one tournament."""

        async def fetch() -> list[dict[str, Any]]:
            standings = await self.get(
                f"/tournaments/{tournament_id}/standings", null_on_404=True
            )
            return self.rows(standings or [])

        return await self.cached(
            ["standings", tournament_id],
            "getStandings",
            title_id,
            TTL["standings"],
            fetch,
        )

    async def get_leagues(self, title_id: str, page: int = 1) -> list[dict[str, Any]]:
        """Leagues, the top level of PandaScore's hierarchy."""
        leagues = await self.get(
            f"/{self.slug(title_id)}/leagues",
            query={"page": page, "per_page": 100},
            null_on_404=True,
        )
        return self.rows(leagues or [])


class AbiosProvider(ProviderClient):
    """Abios Gaming (Atlas).

    A commercial alternative to PandaScore with broadly the same coverage.
    Included because a caller who already pays for one should not have to pay for
    the other; the normalised output is identical either way.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("abios", runtime)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        client_id, secret = self.require_key_parts(2, "clientId:secret")
        return spec.merged(
            headers={"Abios-Secret": secret, **spec.headers},
            query={"client_id": client_id, **spec.query},
        )

    async def get_games(self) -> list[dict[str, Any]]:
        """The Abios game ids, discovered once rather than hard-coded."""

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get("/games")
            return self.rows((response or {}).get("data") or [])

        return await self.cached(["games"], "getMetadata", "esports", TTL["metadata"], fetch)

    async def game_id(self, title_id: str, title_name: str) -> int:
        """Resolve a title onto an Abios game id by matching slug or title."""
        games = await self.get_games()

        def normalise(value: str) -> str:
            return "".join(character for character in value.lower() if character.isalnum())

        wanted = {normalise(title_id), normalise(title_name)}
        for game in games:
            if (
                normalise(str(game.get("slug") or "")) in wanted
                or normalise(str(game.get("title") or "")) in wanted
            ):
                return int(game["id"])
        raise ValidationError(f'Abios does not cover "{title_id}"')

    async def get_series(
        self, game_id: int, *, take: int = 50, skip: int = 0
    ) -> list[dict[str, Any]]:
        """Fixtures ("series" in Abios vocabulary).

        No date filter. Abios has one, but this method used to accept a ``since``
        it never sent - a parameter that silently does nothing is worse than one
        that is absent, because a caller filtering by date would get every
        fixture back and have no way to tell. Results are ordered newest first,
        so paging is the honest way to bound them for now.
        """
        response = await self.get(
            "/series",
            query={
                "filter[]": f"games.id={game_id}",
                "take": min(take, 50),
                "skip": skip,
                "order": "start desc",
            },
            null_on_404=True,
        )
        return self.rows((response or {}).get("data") or [])

    async def get_tournaments(self, game_id: int, take: int = 50) -> list[dict[str, Any]]:
        response = await self.get(
            "/tournaments",
            query={"filter[]": f"games.id={game_id}", "take": min(take, 50)},
            null_on_404=True,
        )
        return self.rows((response or {}).get("data") or [])

    async def get_teams(self, game_id: int, take: int = 50) -> list[dict[str, Any]]:
        response = await self.get(
            "/teams",
            query={"filter[]": f"game.id={game_id}", "take": min(take, 50)},
            null_on_404=True,
        )
        return self.rows((response or {}).get("data") or [])

    async def get_players(self, game_id: int, take: int = 50) -> list[dict[str, Any]]:
        response = await self.get(
            "/players",
            query={"filter[]": f"game.id={game_id}", "take": min(take, 50)},
            null_on_404=True,
        )
        return self.rows((response or {}).get("data") or [])


class EsportsEarningsProvider(ProviderClient):
    """Esports Earnings.

    Career prize money for every title that has ever paid any, which makes it the
    one provider that genuinely covers the whole industry - including titles that
    have no other structured data at all.

    Two conditions of use, both enforced rather than left to the caller: **at
    most one request per second** (the registry sets ``rps: 1, burst: 1``), and
    results come 100 at a time with an explicit ``offset``.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("esports-earnings", runtime)

    def auth_query_name(self) -> str:
        return "apikey"

    async def lookup_player_by_name(self, name: str) -> list[dict[str, Any]]:
        """Search players by handle."""

        async def fetch() -> list[dict[str, Any]]:
            players = await self.get(
                "/LookupPlayerByName",
                query={"format": "json", "name": name},
                null_on_404=True,
            )
            return self.rows(players or [])

        return await self.cached(
            ["player-name", name.lower()],
            "getEarnings",
            "esports",
            TTL["earnings"],
            fetch,
        )

    async def lookup_player_by_id(self, player_id: str | int) -> dict[str, Any]:
        """One player's totals, by their Esports Earnings id."""

        async def fetch() -> dict[str, Any]:
            player = await self.get(
                "/LookupPlayerById",
                query={"format": "json", "playerid": player_id},
                null_on_404=True,
            )
            if not player:
                raise NotFoundError(self.id, f"player {player_id}")
            return dict(player)

        return await self.cached(
            ["player", player_id], "getEarnings", "esports", TTL["earnings"], fetch
        )

    async def lookup_player_tournaments(
        self, player_id: str | int, offset: int = 0
    ) -> list[dict[str, Any]]:
        """Prize money split by game, for one player."""
        rows = await self.get(
            "/LookupPlayerTournaments",
            query={"format": "json", "playerid": player_id, "offset": offset},
            null_on_404=True,
        )
        return self.rows(rows or [])

    async def lookup_player_games(self, player_id: str | int) -> list[dict[str, Any]]:
        """Earnings by game - the breakdown a profile card wants."""

        async def fetch() -> list[dict[str, Any]]:
            return await self.lookup_player_tournaments(player_id, 0)

        return await self.cached(
            ["player-games", player_id],
            "getEarnings",
            "esports",
            TTL["earnings"],
            fetch,
        )

    async def get_highest_earning_players(self, offset: int = 0) -> list[dict[str, Any]]:
        """The highest-earning players overall, 100 at a time."""

        async def fetch() -> list[dict[str, Any]]:
            rows = await self.get(
                "/LookupHighestEarningPlayers",
                query={"format": "json", "offset": offset},
                null_on_404=True,
            )
            return self.rows(rows or [])

        return await self.cached(
            ["top-players", offset], "getEarnings", "esports", TTL["earnings"], fetch
        )

    async def get_highest_earning_players_for_game(
        self, game_id: str | int, offset: int = 0
    ) -> list[dict[str, Any]]:
        rows = await self.get(
            "/LookupHighestEarningPlayersByGame",
            query={"format": "json", "gameid": game_id, "offset": offset},
            null_on_404=True,
        )
        return self.rows(rows or [])

    async def get_games(self, offset: int = 0) -> list[dict[str, Any]]:
        """The game list, so a title can be matched onto an id."""

        async def fetch() -> list[dict[str, Any]]:
            rows = await self.get(
                "/LookupGameById",
                query={"format": "json", "offset": offset},
                null_on_404=True,
            )
            return self.rows(rows or [])

        return await self.cached(
            ["games", offset], "getMetadata", "esports", TTL["metadata"], fetch
        )

    async def get_game_by_id(self, game_id: str | int) -> dict[str, Any] | None:
        """Overall totals for one game, including the number of tournaments."""
        return await self.get_object(
            "/LookupGameById",
            query={"format": "json", "gameid": game_id},
            null_on_404=True,
        )


class LiquipediaProvider(ProviderClient):
    """Liquipedia, through the MediaWiki API.

    The catch-all. Every esports title has a Liquipedia wiki, including the ones
    with no structured data anywhere else, so this is what keeps the registry
    honest about coverage.

    What you get back is **wikitext**, not clean records - that is the trade-off
    for universal coverage, and it is why the title clients use Liquipedia for
    tournament listings and not for player statistics.

    The terms of use are not optional and are enforced here: at most one request
    every two seconds (``rps: 0.5``), a User-Agent naming your application and a
    contact address, and parsed results cached for 30 days.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("liquipedia", runtime)

    #: Deliberately long: the terms of use ask for aggressive caching.
    _CACHE_SECONDS = 30 * 86_400

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        return spec

    @staticmethod
    def wiki(title_id: str) -> str:
        """Liquipedia's wiki name for a title, which is not always the title id."""
        overrides = {
            "cs2": "counterstrike",
            "dota2": "dota2",
            "league-of-legends": "leagueoflegends",
            "teamfight-tactics": "teamfighttactics",
            "legends-of-runeterra": "legendsofruneterra",
            "wild-rift": "wildrift",
            "overwatch-2": "overwatch",
            "starcraft-2": "starcraft2",
            "starcraft-brood-war": "starcraft",
            "warcraft-3": "warcraft",
            "heroes-of-the-storm": "heroes",
            "world-of-warcraft": "worldofwarcraft",
            "destiny-2": "destiny",
            "halo-infinite": "halo",
            "team-fortress-2": "teamfortress",
            "rainbow-six-siege": "rainbowsix",
            "apex-legends": "apexlegends",
            "call-of-duty": "callofduty",
            "rocket-league": "rocketleague",
            "pubg-mobile": "pubgmobile",
            "mobile-legends": "mobilelegends",
            "honor-of-kings": "honorofkings",
            "arena-of-valor": "arenaofvalor",
            "free-fire": "freefire",
            "ea-fc": "easportsfc",
            "street-fighter-6": "fighters",
            "tekken-8": "fighters",
            "super-smash-bros-ultimate": "smash",
            "super-smash-bros-melee": "smash",
            "mortal-kombat-1": "fighters",
            "guilty-gear-strive": "fighters",
            "dragon-ball-fighterz": "fighters",
            "king-of-fighters-15": "fighters",
            "granblue-fantasy-versus-rising": "fighters",
            "age-of-empires-2": "ageofempires",
            "age-of-empires-4": "ageofempires",
            "company-of-heroes-3": "companyofheroes",
            "magic-the-gathering-arena": "magic",
            "world-of-tanks": "worldoftanks",
            "world-of-warships": "worldofwarships",
            "war-thunder": "warthunder",
            "guild-wars-2": "guildwars",
            "path-of-exile": "pathofexile",
            "albion-online": "albion",
            "beat-saber": "beatsaber",
            "the-finals": "thefinals",
            "marvel-rivals": "marvelrivals",
            "escape-from-tarkov": "escapefromtarkov",
            "assetto-corsa-competizione": "simracing",
            "gran-turismo-7": "simracing",
            "iracing": "simracing",
            "f1": "simracing",
            "nba-2k": "sports",
            "madden-nfl": "sports",
            "quake-champions": "quake",
            "point-blank": "pointblank",
            "dead-by-daylight": "deadbydaylight",
            "fall-guys": "fallguys",
            "naraka-bladepoint": "naraka",
            "pokemon-unite": "pokemon",
            "splatoon-3": "splatoon",
            "chess": "chess",
        }
        return overrides.get(title_id, title_id.replace("-", ""))

    async def search(self, title_id: str, query: str, limit: int = 10) -> list[dict[str, Any]]:
        """Search a wiki.

        ``list=search`` rather than ``action=parse``, because search results are
        cheap and parsing is the expensive call the terms ask you to cache.
        """
        wiki = self.wiki(title_id)

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                f"/{wiki}/api.php",
                query={
                    "action": "query",
                    "list": "search",
                    "srsearch": query,
                    "srlimit": min(limit, 50),
                    "format": "json",
                },
                null_on_404=True,
            )
            return self.rows(((response or {}).get("query") or {}).get("search") or [])

        return await self.cached(
            [wiki, "search", query.lower(), limit],
            "getEsportsTournaments",
            title_id,
            self._CACHE_SECONDS,
            fetch,
        )

    async def get_page(self, title_id: str, page: str) -> str:
        """The wikitext of one page."""
        wiki = self.wiki(title_id)

        async def fetch() -> str:
            response = await self.get(
                f"/{wiki}/api.php",
                query={
                    "action": "parse",
                    "page": page,
                    "prop": "wikitext",
                    "format": "json",
                },
                null_on_404=True,
            )
            text = ((response or {}).get("parse") or {}).get("wikitext", {}).get("*")
            if not isinstance(text, str):
                raise NotFoundError(self.id, f'Liquipedia page "{page}" on {wiki}', title_id)
            return text

        return await self.cached(
            [wiki, "page", page], "getMetadata", title_id, self._CACHE_SECONDS, fetch
        )

    async def get_category_members(
        self, title_id: str, category: str, limit: int = 50
    ) -> list[dict[str, Any]]:
        """Pages in a category - how tournament listings are retrieved.

        ``Category:Tournaments`` on any wiki is the index of that title's events.
        """
        wiki = self.wiki(title_id)
        full = category if category.startswith("Category:") else f"Category:{category}"

        async def fetch() -> list[dict[str, Any]]:
            response = await self.get(
                f"/{wiki}/api.php",
                query={
                    "action": "query",
                    "list": "categorymembers",
                    "cmtitle": full,
                    "cmlimit": min(limit, 500),
                    "format": "json",
                },
                null_on_404=True,
            )
            return self.rows(
                ((response or {}).get("query") or {}).get("categorymembers") or []
            )

        return await self.cached(
            [wiki, "category", category, limit],
            "getEsportsTournaments",
            title_id,
            self._CACHE_SECONDS,
            fetch,
        )

    def page_url(self, title_id: str, page: str) -> str:
        """The URL of a page, for linking a user to the source."""
        return (
            f"https://liquipedia.net/{self.wiki(title_id)}/"
            f"{quote(page.replace(' ', '_'), safe='')}"
        )


class StartGgProvider(ProviderClient):
    """start.gg (formerly smash.gg).

    GraphQL, 80 requests per minute, and one design decision worth explaining:
    **videogame ids are looked up rather than hard-coded.** start.gg's numeric
    ids are stable but undocumented, and a wrong constant would silently return
    another game's tournaments - far worse than one extra cached call.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("startgg", runtime)

    async def videogame_id(self, title_name: str) -> int:
        """Resolve a game name to a start.gg videogame id, once per runtime."""

        async def fetch() -> int:
            data = await self.graphql(
                """query Videogames($name: String!) {
                  videogames(query: { filter: { name: $name }, perPage: 8 }) {
                    nodes { id name displayName }
                  }
                }""",
                {"name": title_name},
            )
            nodes = self.rows((data.get("videogames") or {}).get("nodes") or [])

            def normalise(value: str) -> str:
                return "".join(c for c in value.lower() if c.isalnum())

            wanted = normalise(title_name)
            chosen = None
            for node in nodes:
                if (
                    normalise(str(node.get("name") or "")) == wanted
                    or normalise(str(node.get("displayName") or "")) == wanted
                ):
                    chosen = node
                    break
            chosen = chosen or (nodes[0] if nodes else None)
            if not chosen:
                raise ValidationError(f'start.gg has no videogame matching "{title_name}"')
            return int(chosen["id"])

        return await self.memo(f"videogame:{title_name.lower()}", 24 * 3_600 * 1_000, fetch)

    async def get_tournaments(
        self,
        title_id: str,
        title_name: str,
        *,
        page: int = 1,
        per_page: int = 25,
        since: int | None = None,
        until: int | None = None,
        upcoming: bool = False,
    ) -> list[dict[str, Any]]:
        """Tournaments for a game, ordered by start date."""
        videogame_id = await self.videogame_id(title_name)

        async def fetch() -> list[dict[str, Any]]:
            after = (
                since // 1_000
                if since
                else int(datetime.now(timezone.utc).timestamp())
                if upcoming
                else None
            )
            data = await self.graphql(
                """query Tournaments($videogameId: ID!, $page: Int!, $perPage: Int!,
                                    $afterDate: Timestamp, $beforeDate: Timestamp) {
                  tournaments(query: {
                    page: $page
                    perPage: $perPage
                    sortBy: "startAt asc"
                    filter: {
                      videogameIds: [$videogameId]
                      afterDate: $afterDate
                      beforeDate: $beforeDate
                    }
                  }) {
                    nodes {
                      id name slug startAt endAt numAttendees isOnline
                      countryCode city venueName
                      events { id name numEntrants videogame { id name } }
                    }
                  }
                }""",
                {
                    "videogameId": videogame_id,
                    "page": page,
                    "perPage": min(per_page, 50),
                    # start.gg takes seconds, and null means unbounded.
                    "afterDate": after,
                    "beforeDate": until // 1_000 if until else None,
                },
            )
            return self.rows((data.get("tournaments") or {}).get("nodes") or [])

        return await self.cached(
            [videogame_id, "tournaments", page, "up" if upcoming else "all"],
            "getEsportsTournaments",
            title_id,
            TTL["esportsTournaments"],
            fetch,
        )

    async def get_tournament(self, slug: str, title_id: str) -> dict[str, Any]:
        """One tournament by slug, with its events."""

        async def fetch() -> dict[str, Any]:
            data = await self.graphql(
                """query Tournament($slug: String!) {
                  tournament(slug: $slug) {
                    id name slug startAt endAt numAttendees isOnline
                    countryCode city venueName
                    events { id name slug numEntrants state videogame { id name } }
                  }
                }""",
                {"slug": slug},
            )
            tournament = data.get("tournament")
            if not tournament:
                raise NotFoundError(self.id, f'start.gg tournament "{slug}"', title_id)
            return dict(tournament)

        return await self.cached(
            ["tournament", slug],
            "getEsportsTournaments",
            title_id,
            TTL["esportsTournaments"],
            fetch,
        )

    async def get_event_sets(
        self,
        event_id: str | int,
        title_id: str,
        *,
        page: int = 1,
        per_page: int = 40,
    ) -> list[dict[str, Any]]:
        """Sets (matches) in one event.

        This is the fighting-game equivalent of a match list: two entrants, a
        score, a round and a bracket position.
        """

        async def fetch() -> list[dict[str, Any]]:
            data = await self.graphql(
                """query EventSets($eventId: ID!, $page: Int!, $perPage: Int!) {
                  event(id: $eventId) {
                    id name
                    sets(page: $page, perPage: $perPage, sortType: STANDARD) {
                      nodes {
                        id round fullRoundText startedAt completedAt winnerId displayScore
                        slots {
                          id
                          standing { placement stats { score { value } } }
                          entrant { id name participants { player { id gamerTag } } }
                        }
                      }
                    }
                  }
                }""",
                {
                    "eventId": event_id,
                    "page": page,
                    "perPage": min(per_page, 60),
                },
            )
            event = data.get("event") or {}
            return self.rows((event.get("sets") or {}).get("nodes") or [])

        return await self.cached(
            ["sets", event_id, page],
            "getEsportsMatches",
            title_id,
            TTL["esportsMatches"],
            fetch,
        )

    async def get_event_standings(
        self,
        event_id: str | int,
        title_id: str,
        *,
        page: int = 1,
        per_page: int = 32,
    ) -> list[dict[str, Any]]:
        """Final placements for one event."""

        async def fetch() -> list[dict[str, Any]]:
            data = await self.graphql(
                """query EventStandings($eventId: ID!, $page: Int!, $perPage: Int!) {
                  event(id: $eventId) {
                    standings(query: { page: $page, perPage: $perPage }) {
                      nodes {
                        placement
                        entrant {
                          id name
                          participants { player { id gamerTag } user { location { country } } }
                        }
                      }
                    }
                  }
                }""",
                {"eventId": event_id, "page": page, "perPage": min(per_page, 64)},
            )
            event = data.get("event") or {}
            return self.rows((event.get("standings") or {}).get("nodes") or [])

        return await self.cached(
            ["standings", event_id, page],
            "getStandings",
            title_id,
            TTL["standings"],
            fetch,
        )

    async def get_player(self, player_id: str | int, title_id: str) -> dict[str, Any]:
        """A player, by their start.gg id."""

        async def fetch() -> dict[str, Any]:
            data = await self.graphql(
                """query Player($id: ID!) {
                  player(id: $id) {
                    id gamerTag prefix
                    user {
                      name
                      location { country city }
                      authorizations { type externalUsername }
                    }
                  }
                }""",
                {"id": player_id},
            )
            player = data.get("player")
            if not player:
                raise NotFoundError(self.id, f"start.gg player {player_id}", title_id)
            return dict(player)

        return await self.cached(
            ["player", player_id],
            "getEsportsPlayers",
            title_id,
            TTL["esportsPlayers"],
            fetch,
        )

    async def search_players(self, gamer_tag: str) -> list[dict[str, Any]]:
        """Search players by gamer tag."""
        data = await self.graphql(
            """query SearchPlayers($tag: String!) {
              players(query: { filter: { gamerTag: $tag }, perPage: 20 }) {
                nodes { id gamerTag prefix user { name location { country } } }
              }
            }""",
            {"tag": gamer_tag},
        )
        return self.rows((data.get("players") or {}).get("nodes") or [])


class ToornamentProvider(ProviderClient):
    """Toornament.

    Grassroots and mid-tier events across every title. Authentication is two
    pieces at once: an ``X-Api-Key`` header *and* an OAuth2 bearer token, which
    is why the credential is three colon-separated values.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("toornament", runtime)

    async def _access_token(self) -> str:
        _, client_id, client_secret = self.require_key_parts(3, "apiKey:clientId:clientSecret")

        async def fetch() -> str:
            from urllib.parse import urlencode

            response = await self.runtime.http.send(
                self.id,
                "https://api.toornament.com/oauth/v2/token",
                RequestSpec(
                    method="POST",
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    body=urlencode(
                        {
                            "grant_type": "client_credentials",
                            "client_id": client_id,
                            "client_secret": client_secret,
                            "scope": "organizer:view",
                        }
                    ),
                ),
            )
            token = (response or {}).get("access_token")
            if not token:
                raise AuthenticationError(self.id, "token endpoint returned no access_token")
            return str(token)

        return await self.memo("token", 3_600 * 1_000, fetch)

    async def authorize(self, spec: RequestSpec) -> RequestSpec:
        api_key, _, _ = self.require_key_parts(3, "apiKey:clientId:clientSecret")
        token = await self._access_token()
        return spec.merged(
            headers={
                "X-Api-Key": api_key,
                "Authorization": f"Bearer {token}",
                **spec.headers,
            }
        )

    async def get_tournaments(
        self, discipline: str | None = None, *, range_header: str = "tournaments=0-49"
    ) -> list[dict[str, Any]]:
        """Featured tournaments, optionally filtered by discipline."""
        tournaments = await self.get(
            "/tournaments",
            query={"discipline": discipline},
            # Toornament pages with an HTTP Range header rather than query params.
            headers={"Range": range_header},
            null_on_404=True,
        )
        return self.rows(tournaments or [])

    async def get_matches(
        self, tournament_id: str, range_header: str = "matches=0-49"
    ) -> list[dict[str, Any]]:
        """Matches within one tournament."""
        matches = await self.get(
            f"/tournaments/{tournament_id}/matches",
            headers={"Range": range_header},
            null_on_404=True,
        )
        return self.rows(matches or [])

    async def get_standings(
        self, tournament_id: str, range_header: str = "rankings=0-49"
    ) -> list[dict[str, Any]]:
        """Stages, which carry the standings for one tournament."""
        rows = await self.get(
            f"/tournaments/{tournament_id}/stages",
            headers={"Range": range_header},
            null_on_404=True,
        )
        return self.rows(rows or [])

    async def get_participants(
        self, tournament_id: str, range_header: str = "participants=0-49"
    ) -> list[dict[str, Any]]:
        """Participants of one tournament."""
        rows = await self.get(
            f"/tournaments/{tournament_id}/participants",
            headers={"Range": range_header},
            null_on_404=True,
        )
        return self.rows(rows or [])

    async def get_disciplines(self) -> list[dict[str, Any]]:
        """The discipline list, which is Toornament's word for "title"."""

        async def fetch() -> list[dict[str, Any]]:
            rows = await self.get(
                "/disciplines",
                headers={"Range": "disciplines=0-99"},
                null_on_404=True,
            )
            return self.rows(rows or [])

        return await self.cached(
            ["disciplines"], "getMetadata", "esports", TTL["metadata"], fetch
        )


class ChallongeProvider(ProviderClient):
    """Challonge.

    Title-agnostic by design: a Challonge bracket does not know what game it is
    for. That makes it the right home for a community event in a title nothing
    else covers, and the wrong place to look for a title's whole circuit.
    """

    def __init__(self, runtime: Runtime) -> None:
        super().__init__("challonge", runtime)

    def auth_query_name(self) -> str:
        return "api_key"

    async def get_tournaments(
        self, *, state: str | None = None, created_after: str | None = None
    ) -> list[dict[str, Any]]:
        """Tournaments visible to the key's account."""
        rows = await self.get(
            "/tournaments.json",
            query={"state": state, "created_after": created_after},
            null_on_404=True,
        )
        return [row.get("tournament", row) for row in (rows or [])]

    async def get_tournament(self, id_or_url: str) -> dict[str, Any]:
        """One tournament by id or url slug."""
        response = await self.get(
            f"/tournaments/{id_or_url}.json",
            query={"include_participants": 1, "include_matches": 1},
            null_on_404=True,
        )
        tournament = (response or {}).get("tournament")
        if not tournament:
            raise NotFoundError(self.id, f'Challonge tournament "{id_or_url}"')
        return dict(tournament)

    async def get_matches(self, id_or_url: str) -> list[dict[str, Any]]:
        """Matches of one tournament."""
        rows = await self.get(f"/tournaments/{id_or_url}/matches.json", null_on_404=True)
        return [row.get("match", row) for row in (rows or [])]

    async def get_participants(self, id_or_url: str) -> list[dict[str, Any]]:
        """Participants of one tournament, with their final placement."""
        rows = await self.get(f"/tournaments/{id_or_url}/participants.json", null_on_404=True)
        return [row.get("participant", row) for row in (rows or [])]


def _range_filter(since: int | None, until: int | None) -> str | None:
    """PandaScore's ``range[begin_at]`` filter, or ``None`` when unbounded."""
    if since is None and until is None:
        return None
    from datetime import datetime as _datetime

    start = _datetime.fromtimestamp((since or 0) / 1_000, tz=timezone.utc).isoformat()
    end_ms = (
        until
        if until is not None
        else int((datetime.now(timezone.utc).timestamp() + 365 * 86_400) * 1_000)
    )
    end = _datetime.fromtimestamp(end_ms / 1_000, tz=timezone.utc).isoformat()
    return f"{start},{end}"
