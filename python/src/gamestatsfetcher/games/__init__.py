"""Title client construction.

The table below is the whole of the wiring: a title id maps to the class that
knows how to serve it, and everything absent from the table falls back to the
plain :class:`~gamestatsfetcher.title_client.TitleClient` - which is not a stub.
A fallback title still has the complete esports surface, served by whichever
provider its registry entry names. That is how Tekken 8, Mobile Legends and EA
Sports FC work here without a line of bespoke code each.
"""

from __future__ import annotations

from ..registry import get_title
from ..runtime import Runtime
from ..title_client import TitleClient
from .blizzard import (
    HearthstoneClient,
    HeroesOfTheStormClient,
    Overwatch2Client,
    StarCraft2Client,
    Warcraft3Client,
    WorldOfWarcraftClient,
)
from .hirez import PaladinsClient, SmiteClient
from .mobile import BrawlStarsClient, ClashOfClansClient, ClashRoyaleClient
from .persistent import (
    DiabloThreeClient,
    EveOnlineClient,
    OldSchoolRuneScapeClient,
    RuneScapeClient,
)
from .racing import BrawlhallaClient, IRacingClient, TrackmaniaClient
from .riot import (
    LeagueOfLegendsClient,
    LegendsOfRuneterraClient,
    TeamfightTacticsClient,
    ValorantClient,
)
from .rocket_league import RocketLeagueClient
from .shooters import (
    ApexLegendsClient,
    BattlefieldClient,
    CallOfDutyClient,
    Destiny2Client,
    FortniteClient,
    HaloInfiniteClient,
    MarvelRivalsClient,
    PubgClient,
    RainbowSixClient,
    SplitgateClient,
    TheFinalsClient,
    TrackerBackedClient,
)
from .skill import BeatSaberClient, ChessClient, MinecraftClient, OsuClient
from .strategy import (
    AgeOfEmpires2Client,
    AgeOfEmpires4Client,
    CompanyOfHeroes3Client,
)
from .valve import (
    CS2Client,
    DeadlockClient,
    Dota2Client,
    SteamStatsClient,
    TeamFortress2Client,
)
from .worlds import (
    AlbionClient,
    GuildWars2Client,
    PathOfExileClient,
    WorldOfTanksClient,
    WorldOfWarshipsClient,
)

__all__ = [
    "create_title_client",
    "has_dedicated_client",
    "dedicated_title_ids",
    # Valve
    "CS2Client",
    "Dota2Client",
    "TeamFortress2Client",
    "DeadlockClient",
    "SteamStatsClient",
    # Riot
    "LeagueOfLegendsClient",
    "TeamfightTacticsClient",
    "ValorantClient",
    "LegendsOfRuneterraClient",
    # Blizzard
    "Overwatch2Client",
    "StarCraft2Client",
    "Warcraft3Client",
    "HeroesOfTheStormClient",
    "WorldOfWarcraftClient",
    "HearthstoneClient",
    # Shooters
    "TrackerBackedClient",
    "RainbowSixClient",
    "CallOfDutyClient",
    "BattlefieldClient",
    "SplitgateClient",
    "ApexLegendsClient",
    "FortniteClient",
    "PubgClient",
    "HaloInfiniteClient",
    "Destiny2Client",
    "TheFinalsClient",
    "MarvelRivalsClient",
    # Sports and cars
    "RocketLeagueClient",
    "IRacingClient",
    "TrackmaniaClient",
    # Supercell
    "ClashRoyaleClient",
    "ClashOfClansClient",
    "BrawlStarsClient",
    # Hi-Rez
    "SmiteClient",
    "PaladinsClient",
    # Strategy
    "AgeOfEmpires2Client",
    "AgeOfEmpires4Client",
    "CompanyOfHeroes3Client",
    # Skill and mind sports
    "OsuClient",
    "BeatSaberClient",
    "ChessClient",
    "MinecraftClient",
    "BrawlhallaClient",
    # Persistent worlds and vehicles
    "GuildWars2Client",
    "PathOfExileClient",
    "AlbionClient",
    "WorldOfTanksClient",
    "WorldOfWarshipsClient",
    # Persistent worlds with a first-party API and no circuit
    "OldSchoolRuneScapeClient",
    "RuneScapeClient",
    "EveOnlineClient",
    "DiabloThreeClient",
]

#: Title id to the class that serves it. Absent means "esports only".
_CLIENTS: dict[str, type[TitleClient]] = {
    # Valve
    "cs2": CS2Client,
    "dota2": Dota2Client,
    "team-fortress-2": TeamFortress2Client,
    "deadlock": DeadlockClient,
    # Riot
    "league-of-legends": LeagueOfLegendsClient,
    "teamfight-tactics": TeamfightTacticsClient,
    "valorant": ValorantClient,
    "legends-of-runeterra": LegendsOfRuneterraClient,
    # Blizzard
    "overwatch-2": Overwatch2Client,
    "starcraft-2": StarCraft2Client,
    "warcraft-3": Warcraft3Client,
    "heroes-of-the-storm": HeroesOfTheStormClient,
    "world-of-warcraft": WorldOfWarcraftClient,
    "hearthstone": HearthstoneClient,
    # Shooters
    "apex-legends": ApexLegendsClient,
    "fortnite": FortniteClient,
    "pubg": PubgClient,
    "rainbow-six-siege": RainbowSixClient,
    "call-of-duty": CallOfDutyClient,
    "battlefield": BattlefieldClient,
    "splitgate": SplitgateClient,
    "halo-infinite": HaloInfiniteClient,
    "destiny-2": Destiny2Client,
    "the-finals": TheFinalsClient,
    "marvel-rivals": MarvelRivalsClient,
    # Sports and cars
    "rocket-league": RocketLeagueClient,
    "iracing": IRacingClient,
    "trackmania": TrackmaniaClient,
    # Supercell
    "clash-royale": ClashRoyaleClient,
    "clash-of-clans": ClashOfClansClient,
    "brawl-stars": BrawlStarsClient,
    # Hi-Rez
    "smite": SmiteClient,
    "paladins": PaladinsClient,
    # Strategy
    "age-of-empires-2": AgeOfEmpires2Client,
    "age-of-empires-4": AgeOfEmpires4Client,
    "company-of-heroes-3": CompanyOfHeroes3Client,
    # Skill and mind sports
    "osu": OsuClient,
    "beat-saber": BeatSaberClient,
    "chess": ChessClient,
    "minecraft": MinecraftClient,
    "brawlhalla": BrawlhallaClient,
    # Persistent worlds and vehicles
    "guild-wars-2": GuildWars2Client,
    "path-of-exile": PathOfExileClient,
    "albion-online": AlbionClient,
    "world-of-tanks": WorldOfTanksClient,
    "world-of-warships": WorldOfWarshipsClient,
    # Worlds where progress is the rank: no matchmaking, and a first-party
    # API that answers "how am I doing" anyway.
    "old-school-runescape": OldSchoolRuneScapeClient,
    "runescape": RuneScapeClient,
    "eve-online": EveOnlineClient,
    "diablo-3": DiabloThreeClient,
    # Steam career totals and nothing more
    "rust": SteamStatsClient,
    "war-thunder": SteamStatsClient,
    "naraka-bladepoint": SteamStatsClient,
    "dead-by-daylight": SteamStatsClient,
}


def create_title_client(title_id: str, runtime: Runtime) -> TitleClient:
    """Build the client for a title.

    Memoised per runtime, so ``client.cs2`` and ``client.title("csgo")`` are the
    same object and share its provider instances.
    """
    key = f"title:{title_id}"
    existing = runtime.state.get(key)
    if existing is not None:
        return existing  # type: ignore[no-any-return]

    descriptor = get_title(title_id)
    factory = _CLIENTS.get(descriptor.id, TitleClient)
    client = factory(descriptor, runtime)
    runtime.state[key] = client
    # Aliases resolve to the same instance, so `client.title("csgo")` twice does
    # not build two clients.
    runtime.state[f"title:{descriptor.id}"] = client
    return client


def has_dedicated_client(title_id: str) -> bool:
    """True when this package ships a bespoke client rather than esports-only."""
    return title_id in _CLIENTS


def dedicated_title_ids() -> tuple[str, ...]:
    """Every title id with a bespoke client. Used by the docs and the tests."""
    return tuple(_CLIENTS)
