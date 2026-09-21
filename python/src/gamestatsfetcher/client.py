"""The root client.

Construct one and keep it: the cache, the rate limiter, the transport and every
provider live on it, so two clients means two of each and a Steam quota spent
twice.

There are two ways in, and they are the same objects underneath::

    client.cs2                 # typed accessor
    client.title("csgo")       # registry lookup, accepts ids and aliases

The accessors exist for the titles people reach for constantly. The registry
lookup exists because there are 83 titles and nobody wants 83 properties - and
because a Discord bot taking a title from user input needs the string form
anyway.

It is an async context manager, which is the tidiest way to be sure the
transport is closed::

    async with GameStatsClient(api_keys={"riot": key}) as client:
        ranks = await client.lol.get_rank("Faker#KR1")
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from . import providers as provider_factories
from .games import (
    AgeOfEmpires2Client,
    AgeOfEmpires4Client,
    AlbionClient,
    ApexLegendsClient,
    BattlefieldClient,
    BeatSaberClient,
    BrawlhallaClient,
    BrawlStarsClient,
    CallOfDutyClient,
    ChessClient,
    ClashOfClansClient,
    ClashRoyaleClient,
    CompanyOfHeroes3Client,
    CS2Client,
    DeadlockClient,
    Destiny2Client,
    Dota2Client,
    FortniteClient,
    GuildWars2Client,
    HaloInfiniteClient,
    HearthstoneClient,
    HeroesOfTheStormClient,
    IRacingClient,
    LeagueOfLegendsClient,
    LegendsOfRuneterraClient,
    MarvelRivalsClient,
    MinecraftClient,
    OsuClient,
    Overwatch2Client,
    PaladinsClient,
    PathOfExileClient,
    PubgClient,
    RainbowSixClient,
    RocketLeagueClient,
    SmiteClient,
    SplitgateClient,
    StarCraft2Client,
    TeamfightTacticsClient,
    TeamFortress2Client,
    TheFinalsClient,
    TrackmaniaClient,
    ValorantClient,
    Warcraft3Client,
    WorldOfTanksClient,
    WorldOfWarcraftClient,
    WorldOfWarshipsClient,
    create_title_client,
    dedicated_title_ids,
)
from .http import Transport
from .registry import (
    find_provider,
    find_title,
    get_title,
    list_providers,
    list_titles,
    search_titles,
    title_count,
    titles_by_capability,
    titles_by_genre,
    titles_by_provider,
)
from .runtime import Runtime, create_runtime
from .title_client import TitleClient
from .types import (
    CacheConfig,
    ProviderDescriptor,
    RateLimitConfig,
    RetryConfig,
    TitleDescriptor,
)

__all__ = ["GameStatsClient", "ProviderDiagnostic"]


@dataclass(frozen=True)
class ProviderDiagnostic:
    """What :meth:`GameStatsClient.diagnostics` reports about one provider."""

    id: str
    label: str
    kind: str
    #: True when a credential is configured, or the provider needs none.
    ready: bool
    #: The ``api_keys`` field to set, when one is missing.
    missing_key: str | None
    docs_url: str
    #: Titles that would stop working without this provider.
    titles: Sequence[str]


class GameStatsClient:
    """One client for every esports title."""

    def __init__(
        self,
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
    ) -> None:
        self.runtime: Runtime = create_runtime(
            api_keys=api_keys,
            cache=cache,
            rate_limit=rate_limit,
            retry=retry,
            transport=transport,
            logger=logger,
            fallback=fallback,
            timeout_ms=timeout_ms,
            user_agent=user_agent,
        )

    # -----------------------------------------------------------------------
    # Generic access
    # -----------------------------------------------------------------------

    def title(self, id_or_alias: str) -> TitleClient:
        """The client for any registered title, by id or alias.

        ``client.title("csgo")``, ``client.title("CS:GO")`` and ``client.cs2``
        all return the same object. An unknown id raises ``UnknownTitleError``
        with the closest matches in the message rather than returning ``None``.
        """
        descriptor = get_title(id_or_alias)
        return create_title_client(descriptor.id, self.runtime)

    def try_title(self, id_or_alias: str) -> TitleClient | None:
        """The client for a title, or ``None`` when the id is unknown."""
        descriptor = find_title(id_or_alias)
        return create_title_client(descriptor.id, self.runtime) if descriptor else None

    def titles(self) -> tuple[TitleDescriptor, ...]:
        """Every registered title descriptor."""
        return list_titles()

    def title_count(self) -> int:
        """How many titles the registry holds."""
        return title_count()

    def search(self, query: str, limit: int = 10) -> tuple[TitleDescriptor, ...]:
        """Free-text search across ids, names and aliases. For autocomplete."""
        return search_titles(query, limit)

    def by_genre(self, genre: str) -> tuple[TitleDescriptor, ...]:
        """Titles of one genre."""
        return titles_by_genre(genre)

    def by_capability(self, capability: str) -> tuple[TitleDescriptor, ...]:
        """Titles that support a capability - "which have real ranks?"."""
        return titles_by_capability(capability)

    def by_provider(self, provider_id: str) -> tuple[TitleDescriptor, ...]:
        """Titles served by a provider - "what breaks if Riot goes down?"."""
        return titles_by_provider(provider_id)

    def providers(self) -> tuple[ProviderDescriptor, ...]:
        """Every provider descriptor."""
        return list_providers()

    @property
    def raw(self) -> Any:
        """The provider factories, for endpoints the canonical model does not model.

        ``client.raw.opendota(client.runtime).request_parse(match_id)``
        """
        return provider_factories

    # -----------------------------------------------------------------------
    # Diagnostics
    # -----------------------------------------------------------------------

    def diagnostics(self) -> tuple[ProviderDiagnostic, ...]:
        """What is configured and what is not.

        The answer to "why is this title returning nothing?" almost always. Run it
        at startup and log the not-ready rows: a missing key found at boot is a
        five-minute fix, and the same key found at 3am is an incident.
        """
        rows = []
        for provider in self.providers():
            key = provider.key_name
            configured = bool(self.runtime.api_keys.get(key)) if key else True
            # A provider whose key only raises the quota counts as ready without
            # one; reporting OpenDota as broken because nobody signed up for an
            # optional key would bury the rows that actually need attention.
            optional = provider.auth == "none" or provider.optional_auth
            rows.append(
                ProviderDiagnostic(
                    id=provider.id,
                    label=provider.label,
                    kind=provider.kind,
                    ready=optional or configured,
                    missing_key=None if (configured or optional) else key,
                    docs_url=provider.docs_url,
                    titles=tuple(title.id for title in titles_by_provider(provider.id)),
                )
            )
        return tuple(rows)

    def usable_titles(self) -> tuple[TitleDescriptor, ...]:
        """Titles this configuration can serve for what they are *for*.

        The test is deliberately stricter than "any provider is ready". Every
        title lists Liquipedia, which needs no key, so a loose test would report
        every title as usable with no credentials at all - technically true and
        useless as a deployment check.

        So a title that has a player API counts as usable only when a provider
        that serves *player data* is ready; a title that has none counts as
        usable when any of its esports providers is.
        """
        ready = {row.id for row in self.diagnostics() if row.ready}

        usable = []
        for title in self.titles():
            needs_player_data = "resolvePlayer" in title.capabilities
            if needs_player_data:
                relevant = [
                    provider_id
                    for provider_id in title.providers
                    if (found := find_provider(provider_id))
                    and found.kind in ("first-party", "community")
                ]
            else:
                relevant = list(title.providers)
            if any(provider_id in ready for provider_id in relevant):
                usable.append(title)
        return tuple(usable)

    def dedicated_titles(self) -> tuple[str, ...]:
        """Titles this package ships a bespoke client for."""
        return dedicated_title_ids()

    def rate_limit_snapshot(self) -> dict[str, dict[str, float]]:
        """Rate-limiter state per provider. For a ``/debug`` command or a metric."""
        return self.runtime.limiter.snapshot()

    # -----------------------------------------------------------------------
    # Lifecycle
    # -----------------------------------------------------------------------

    async def clear_cache(self) -> None:
        """Drop every cached entry under this client's prefix."""
        await self.runtime.cache.clear()

    async def aclose(self) -> None:
        """Release resources: the cache connection and the transport.

        Safe to call more than once; a process that forgets it will keep a socket
        open until it exits.
        """
        await self.runtime.cache.disconnect()
        await self.runtime.transport.aclose()
        self.runtime.state.clear()

    async def __aenter__(self) -> GameStatsClient:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    # -----------------------------------------------------------------------
    # Typed accessors
    # -----------------------------------------------------------------------

    @property
    def cs2(self) -> CS2Client:
        """Counter-Strike 2."""
        return self.title("cs2")  # type: ignore[return-value]

    @property
    def dota2(self) -> Dota2Client:
        """Dota 2."""
        return self.title("dota2")  # type: ignore[return-value]

    @property
    def tf2(self) -> TeamFortress2Client:
        """Team Fortress 2."""
        return self.title("team-fortress-2")  # type: ignore[return-value]

    @property
    def deadlock(self) -> DeadlockClient:
        """Deadlock."""
        return self.title("deadlock")  # type: ignore[return-value]

    @property
    def lol(self) -> LeagueOfLegendsClient:
        """League of Legends."""
        return self.title("league-of-legends")  # type: ignore[return-value]

    @property
    def tft(self) -> TeamfightTacticsClient:
        """Teamfight Tactics."""
        return self.title("teamfight-tactics")  # type: ignore[return-value]

    @property
    def valorant(self) -> ValorantClient:
        """VALORANT."""
        return self.title("valorant")  # type: ignore[return-value]

    @property
    def runeterra(self) -> LegendsOfRuneterraClient:
        """Legends of Runeterra."""
        return self.title("legends-of-runeterra")  # type: ignore[return-value]

    @property
    def overwatch(self) -> Overwatch2Client:
        """Overwatch 2."""
        return self.title("overwatch-2")  # type: ignore[return-value]

    @property
    def starcraft2(self) -> StarCraft2Client:
        """StarCraft II."""
        return self.title("starcraft-2")  # type: ignore[return-value]

    @property
    def warcraft3(self) -> Warcraft3Client:
        """Warcraft III."""
        return self.title("warcraft-3")  # type: ignore[return-value]

    @property
    def hots(self) -> HeroesOfTheStormClient:
        """Heroes of the Storm."""
        return self.title("heroes-of-the-storm")  # type: ignore[return-value]

    @property
    def wow(self) -> WorldOfWarcraftClient:
        """World of Warcraft."""
        return self.title("world-of-warcraft")  # type: ignore[return-value]

    @property
    def hearthstone(self) -> HearthstoneClient:
        """Hearthstone."""
        return self.title("hearthstone")  # type: ignore[return-value]

    @property
    def apex(self) -> ApexLegendsClient:
        """Apex Legends."""
        return self.title("apex-legends")  # type: ignore[return-value]

    @property
    def fortnite(self) -> FortniteClient:
        """Fortnite."""
        return self.title("fortnite")  # type: ignore[return-value]

    @property
    def pubg(self) -> PubgClient:
        """PUBG: Battlegrounds."""
        return self.title("pubg")  # type: ignore[return-value]

    @property
    def rainbow_six(self) -> RainbowSixClient:
        """Rainbow Six Siege."""
        return self.title("rainbow-six-siege")  # type: ignore[return-value]

    @property
    def call_of_duty(self) -> CallOfDutyClient:
        """Call of Duty."""
        return self.title("call-of-duty")  # type: ignore[return-value]

    @property
    def battlefield(self) -> BattlefieldClient:
        """Battlefield."""
        return self.title("battlefield")  # type: ignore[return-value]

    @property
    def splitgate(self) -> SplitgateClient:
        """Splitgate."""
        return self.title("splitgate")  # type: ignore[return-value]

    @property
    def halo(self) -> HaloInfiniteClient:
        """Halo Infinite."""
        return self.title("halo-infinite")  # type: ignore[return-value]

    @property
    def destiny2(self) -> Destiny2Client:
        """Destiny 2."""
        return self.title("destiny-2")  # type: ignore[return-value]

    @property
    def the_finals(self) -> TheFinalsClient:
        """The Finals."""
        return self.title("the-finals")  # type: ignore[return-value]

    @property
    def marvel_rivals(self) -> MarvelRivalsClient:
        """Marvel Rivals."""
        return self.title("marvel-rivals")  # type: ignore[return-value]

    @property
    def rocket_league(self) -> RocketLeagueClient:
        """Rocket League."""
        return self.title("rocket-league")  # type: ignore[return-value]

    @property
    def clash_royale(self) -> ClashRoyaleClient:
        """Clash Royale."""
        return self.title("clash-royale")  # type: ignore[return-value]

    @property
    def clash_of_clans(self) -> ClashOfClansClient:
        """Clash of Clans."""
        return self.title("clash-of-clans")  # type: ignore[return-value]

    @property
    def brawl_stars(self) -> BrawlStarsClient:
        """Brawl Stars."""
        return self.title("brawl-stars")  # type: ignore[return-value]

    @property
    def smite(self) -> SmiteClient:
        """SMITE."""
        return self.title("smite")  # type: ignore[return-value]

    @property
    def paladins(self) -> PaladinsClient:
        """Paladins."""
        return self.title("paladins")  # type: ignore[return-value]

    @property
    def aoe2(self) -> AgeOfEmpires2Client:
        """Age of Empires II: Definitive Edition."""
        return self.title("age-of-empires-2")  # type: ignore[return-value]

    @property
    def aoe4(self) -> AgeOfEmpires4Client:
        """Age of Empires IV."""
        return self.title("age-of-empires-4")  # type: ignore[return-value]

    @property
    def coh3(self) -> CompanyOfHeroes3Client:
        """Company of Heroes 3."""
        return self.title("company-of-heroes-3")  # type: ignore[return-value]

    @property
    def osu(self) -> OsuClient:
        """osu!."""
        return self.title("osu")  # type: ignore[return-value]

    @property
    def beat_saber(self) -> BeatSaberClient:
        """Beat Saber."""
        return self.title("beat-saber")  # type: ignore[return-value]

    @property
    def chess(self) -> ChessClient:
        """Chess, on Chess.com or Lichess."""
        return self.title("chess")  # type: ignore[return-value]

    @property
    def minecraft(self) -> MinecraftClient:
        """Minecraft, through Hypixel."""
        return self.title("minecraft")  # type: ignore[return-value]

    @property
    def brawlhalla(self) -> BrawlhallaClient:
        """Brawlhalla."""
        return self.title("brawlhalla")  # type: ignore[return-value]

    @property
    def iracing(self) -> IRacingClient:
        """iRacing."""
        return self.title("iracing")  # type: ignore[return-value]

    @property
    def trackmania(self) -> TrackmaniaClient:
        """Trackmania."""
        return self.title("trackmania")  # type: ignore[return-value]

    @property
    def guild_wars_2(self) -> GuildWars2Client:
        """Guild Wars 2."""
        return self.title("guild-wars-2")  # type: ignore[return-value]

    @property
    def path_of_exile(self) -> PathOfExileClient:
        """Path of Exile."""
        return self.title("path-of-exile")  # type: ignore[return-value]

    @property
    def albion(self) -> AlbionClient:
        """Albion Online."""
        return self.title("albion-online")  # type: ignore[return-value]

    @property
    def world_of_tanks(self) -> WorldOfTanksClient:
        """World of Tanks."""
        return self.title("world-of-tanks")  # type: ignore[return-value]

    @property
    def world_of_warships(self) -> WorldOfWarshipsClient:
        """World of Warships."""
        return self.title("world-of-warships")  # type: ignore[return-value]

    # The fighting games, the mobile MOBAs and the sports titles have no player
    # API, so they get no accessor - `client.title("tekken-8")` is the way in,
    # and its esports surface is the whole of what exists.

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<GameStatsClient titles={self.title_count()}>"
