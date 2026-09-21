"""Provider construction.

Every provider is built lazily and memoised on the runtime, so a client that
only touches Valorant never constructs the other fifty - and two titles that
share a provider share the object, which is what makes one Steam quota be spent
once rather than twice.

Each function here takes the runtime and returns the memoised provider:

    >>> from gamestatsfetcher import providers
    >>> steam = providers.steam(runtime)          # doctest: +SKIP
"""

from __future__ import annotations

from ..runtime import Runtime
from .base import ProviderClient, use_provider
from .blizzard import DESTINY_PLATFORMS, BlizzardProvider, BungieProvider, PubgProvider
from .dota import (
    HenrikDevProvider,
    OpenDotaProvider,
    StratzProvider,
    dota_rank_name,
)
from .esports_data import (
    PANDASCORE_SLUGS,
    AbiosProvider,
    ChallongeProvider,
    EsportsEarningsProvider,
    LiquipediaProvider,
    PandaScoreProvider,
    StartGgProvider,
    ToornamentProvider,
)
from .faceit import FACEIT_GAME_IDS, TRACKER_GAME_IDS, FaceitProvider, TrackerProvider
from .persistent import EveProvider, JagexProvider, RuneScapeGame
from .racing import BrawlhallaProvider, IRacingProvider, TrackmaniaProvider
from .riot import PLATFORM_TO_CLUSTER, VALORANT_SHARDS, RiotProvider
from .rocket_league import BallchasingProvider, OctaneProvider
from .shooters import (
    ApexProvider,
    DeadlockProvider,
    FortniteProvider,
    HaloProvider,
    MarvelRivalsProvider,
    OverFastProvider,
    TheFinalsProvider,
)
from .skill import (
    BeatLeaderProvider,
    ChessComProvider,
    LichessProvider,
    OsuProvider,
    ScoreSaberProvider,
)
from .steam import SteamProvider
from .strategy import (
    Aoe4WorldProvider,
    HeroesProfileProvider,
    RelicProvider,
    Sc2PulseProvider,
    W3ChampionsProvider,
)
from .supercell import (
    BrawlStarsProvider,
    ClashOfClansProvider,
    ClashRoyaleProvider,
)
from .wargaming import HiRezProvider, WargamingProvider
from .worlds import (
    AlbionProvider,
    GuildWars2Provider,
    HypixelProvider,
    LogsTfProvider,
    MojangProvider,
    PathOfExileProvider,
    RaiderIoProvider,
)

__all__ = [
    # Base
    "ProviderClient",
    "use_provider",
    # Constants re-exported for callers mapping their own ids
    "DESTINY_PLATFORMS",
    "FACEIT_GAME_IDS",
    "TRACKER_GAME_IDS",
    "PANDASCORE_SLUGS",
    "PLATFORM_TO_CLUSTER",
    "VALORANT_SHARDS",
    "dota_rank_name",
    # Factories
    "steam",
    "riot",
    "blizzard",
    "bungie",
    "pubg",
    "clash_royale",
    "clash_of_clans",
    "brawl_stars",
    "wargaming",
    "hirez",
    "faceit",
    "tracker",
    "opendota",
    "stratz",
    "henrikdev",
    "overfast",
    "apex",
    "fortnite",
    "halo",
    "the_finals",
    "marvel_rivals",
    "deadlock",
    "ballchasing",
    "octane",
    "sc2pulse",
    "w3champions",
    "relic",
    "aoe4world",
    "heroes_profile",
    "osu",
    "scoresaber",
    "beatleader",
    "chess_com",
    "lichess",
    "mojang",
    "hypixel",
    "guild_wars_2",
    "path_of_exile",
    "albion",
    "raiderio",
    "logstf",
    "iracing",
    "trackmania",
    "brawlhalla",
    "pandascore",
    "abios",
    "esports_earnings",
    "liquipedia",
    "startgg",
    "toornament",
    "challonge",
    "jagex",
    "eve",
    "RuneScapeGame",
]


def steam(runtime: Runtime) -> SteamProvider:
    return use_provider(runtime, "steam", SteamProvider)


def riot(runtime: Runtime) -> RiotProvider:
    return use_provider(runtime, "riot", RiotProvider)


def blizzard(runtime: Runtime) -> BlizzardProvider:
    return use_provider(runtime, "blizzard", BlizzardProvider)


def bungie(runtime: Runtime) -> BungieProvider:
    return use_provider(runtime, "bungie", BungieProvider)


def jagex(runtime: Runtime) -> JagexProvider:
    return use_provider(runtime, "jagex", JagexProvider)


def eve(runtime: Runtime) -> EveProvider:
    return use_provider(runtime, "eve-esi", EveProvider)


def pubg(runtime: Runtime) -> PubgProvider:
    return use_provider(runtime, "pubg", PubgProvider)


def clash_royale(runtime: Runtime) -> ClashRoyaleProvider:
    return use_provider(runtime, "supercell-clash-royale", ClashRoyaleProvider)


def clash_of_clans(runtime: Runtime) -> ClashOfClansProvider:
    return use_provider(runtime, "supercell-clash-of-clans", ClashOfClansProvider)


def brawl_stars(runtime: Runtime) -> BrawlStarsProvider:
    return use_provider(runtime, "supercell-brawl-stars", BrawlStarsProvider)


def wargaming(runtime: Runtime) -> WargamingProvider:
    return use_provider(runtime, "wargaming", WargamingProvider)


def hirez(runtime: Runtime) -> HiRezProvider:
    return use_provider(runtime, "hirez", HiRezProvider)


def faceit(runtime: Runtime) -> FaceitProvider:
    return use_provider(runtime, "faceit", FaceitProvider)


def tracker(runtime: Runtime) -> TrackerProvider:
    return use_provider(runtime, "tracker", TrackerProvider)


def opendota(runtime: Runtime) -> OpenDotaProvider:
    return use_provider(runtime, "opendota", OpenDotaProvider)


def stratz(runtime: Runtime) -> StratzProvider:
    return use_provider(runtime, "stratz", StratzProvider)


def henrikdev(runtime: Runtime) -> HenrikDevProvider:
    return use_provider(runtime, "henrikdev", HenrikDevProvider)


def overfast(runtime: Runtime) -> OverFastProvider:
    return use_provider(runtime, "overfast", OverFastProvider)


def apex(runtime: Runtime) -> ApexProvider:
    return use_provider(runtime, "apex-legends-api", ApexProvider)


def fortnite(runtime: Runtime) -> FortniteProvider:
    return use_provider(runtime, "fortnite-api", FortniteProvider)


def halo(runtime: Runtime) -> HaloProvider:
    return use_provider(runtime, "halodotapi", HaloProvider)


def the_finals(runtime: Runtime) -> TheFinalsProvider:
    return use_provider(runtime, "the-finals-api", TheFinalsProvider)


def marvel_rivals(runtime: Runtime) -> MarvelRivalsProvider:
    return use_provider(runtime, "marvel-rivals", MarvelRivalsProvider)


def deadlock(runtime: Runtime) -> DeadlockProvider:
    return use_provider(runtime, "deadlock-api", DeadlockProvider)


def ballchasing(runtime: Runtime) -> BallchasingProvider:
    return use_provider(runtime, "ballchasing", BallchasingProvider)


def octane(runtime: Runtime) -> OctaneProvider:
    return use_provider(runtime, "octane", OctaneProvider)


def sc2pulse(runtime: Runtime) -> Sc2PulseProvider:
    return use_provider(runtime, "sc2pulse", Sc2PulseProvider)


def w3champions(runtime: Runtime) -> W3ChampionsProvider:
    return use_provider(runtime, "w3champions", W3ChampionsProvider)


def relic(runtime: Runtime) -> RelicProvider:
    return use_provider(runtime, "relic", RelicProvider)


def aoe4world(runtime: Runtime) -> Aoe4WorldProvider:
    return use_provider(runtime, "aoe4world", Aoe4WorldProvider)


def heroes_profile(runtime: Runtime) -> HeroesProfileProvider:
    return use_provider(runtime, "heroesprofile", HeroesProfileProvider)


def osu(runtime: Runtime) -> OsuProvider:
    return use_provider(runtime, "osu", OsuProvider)


def scoresaber(runtime: Runtime) -> ScoreSaberProvider:
    return use_provider(runtime, "scoresaber", ScoreSaberProvider)


def beatleader(runtime: Runtime) -> BeatLeaderProvider:
    return use_provider(runtime, "beatleader", BeatLeaderProvider)


def chess_com(runtime: Runtime) -> ChessComProvider:
    return use_provider(runtime, "chess-com", ChessComProvider)


def lichess(runtime: Runtime) -> LichessProvider:
    return use_provider(runtime, "lichess", LichessProvider)


def mojang(runtime: Runtime) -> MojangProvider:
    return use_provider(runtime, "mojang", MojangProvider)


def hypixel(runtime: Runtime) -> HypixelProvider:
    return use_provider(runtime, "hypixel", HypixelProvider)


def guild_wars_2(runtime: Runtime) -> GuildWars2Provider:
    return use_provider(runtime, "guild-wars-2", GuildWars2Provider)


def path_of_exile(runtime: Runtime) -> PathOfExileProvider:
    return use_provider(runtime, "path-of-exile", PathOfExileProvider)


def albion(runtime: Runtime) -> AlbionProvider:
    return use_provider(runtime, "albion", AlbionProvider)


def raiderio(runtime: Runtime) -> RaiderIoProvider:
    return use_provider(runtime, "raiderio", RaiderIoProvider)


def logstf(runtime: Runtime) -> LogsTfProvider:
    return use_provider(runtime, "logstf", LogsTfProvider)


def iracing(runtime: Runtime) -> IRacingProvider:
    return use_provider(runtime, "iracing", IRacingProvider)


def trackmania(runtime: Runtime) -> TrackmaniaProvider:
    return use_provider(runtime, "trackmania-io", TrackmaniaProvider)


def brawlhalla(runtime: Runtime) -> BrawlhallaProvider:
    return use_provider(runtime, "brawlhalla", BrawlhallaProvider)


def pandascore(runtime: Runtime) -> PandaScoreProvider:
    return use_provider(runtime, "pandascore", PandaScoreProvider)


def abios(runtime: Runtime) -> AbiosProvider:
    return use_provider(runtime, "abios", AbiosProvider)


def esports_earnings(runtime: Runtime) -> EsportsEarningsProvider:
    return use_provider(runtime, "esports-earnings", EsportsEarningsProvider)


def liquipedia(runtime: Runtime) -> LiquipediaProvider:
    return use_provider(runtime, "liquipedia", LiquipediaProvider)


def startgg(runtime: Runtime) -> StartGgProvider:
    return use_provider(runtime, "startgg", StartGgProvider)


def toornament(runtime: Runtime) -> ToornamentProvider:
    return use_provider(runtime, "toornament", ToornamentProvider)


def challonge(runtime: Runtime) -> ChallongeProvider:
    return use_provider(runtime, "challonge", ChallongeProvider)
