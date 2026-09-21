"""The cross-title esports layer.

Every title in the registry gets the same six esports methods, whatever data
exists behind them. Which provider actually answers is decided here, from three
things in order:

1. an explicit ``provider`` in the call options,
2. the title's own provider list, best first,
3. whether the credential for that provider was configured.

That last point matters more than it looks. A caller with a PandaScore token and
no start.gg token gets PandaScore for Street Fighter 6; a caller with only
start.gg gets start.gg. Neither has to know which one this package prefers, and
neither gets a confusing "missing credential" for a provider they never intended
to use.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from . import providers as provider_factories
from .errors import (
    AllProvidersFailedError,
    GameStatsError,
    NotFoundError,
    UnsupportedCapabilityError,
)
from .normalize import as_int, as_list, as_str, num, ts
from .registry import esports_providers_for, find_title
from .runtime import Runtime
from .types import (
    EsportsMatch,
    EsportsMatchStatus,
    EsportsOpponent,
    EsportsPlayer,
    EsportsQueryOptions,
    EsportsStanding,
    EsportsStream,
    EsportsTeam,
    EsportsTournament,
    EsportsTournamentRef,
    PrizeEarnings,
    PrizeEarningsByTitle,
    TitleDescriptor,
)

__all__ = ["EsportsLayer", "providers_for", "normalise_status"]

T = TypeVar("T")


def providers_for(title: TitleDescriptor, capability: str) -> tuple[str, ...]:
    """The providers that could serve one capability for one title, best first.

    The table lives in the registry because it is generated alongside it: a
    title's declared esports capabilities are intersected with it, so the
    registry cannot promise something no provider for that title can do.
    """
    return esports_providers_for(title.providers, capability) or ()


class EsportsLayer:
    """Provider selection and normalisation for the professional circuit."""

    def __init__(self, runtime: Runtime, title: TitleDescriptor) -> None:
        self.runtime = runtime
        self.title = title

    # -----------------------------------------------------------------------
    # Provider selection
    # -----------------------------------------------------------------------

    def _candidates(self, capability: str, explicit: str | None) -> list[str]:
        """The providers worth trying, in order.

        A provider that needs a key nobody configured is dropped rather than
        tried and failed: it would cost a round trip to learn what the registry
        already knows.
        """
        if explicit:
            return [explicit]
        return [
            provider_id
            for provider_id in providers_for(self.title, capability)
            if self._has_credentials(provider_id)
        ]

    def _has_credentials(self, provider_id: str) -> bool:
        provider = self._build(provider_id)
        return provider.has_credentials() if provider else False

    def _build(self, provider_id: str) -> Any:
        """Construct one provider, or ``None`` when this package has no client."""
        factory = {
            "pandascore": provider_factories.pandascore,
            "abios": provider_factories.abios,
            "startgg": provider_factories.startgg,
            "octane": provider_factories.octane,
            "opendota": provider_factories.opendota,
            "faceit": provider_factories.faceit,
            "toornament": provider_factories.toornament,
            "challonge": provider_factories.challonge,
            "liquipedia": provider_factories.liquipedia,
            "esports-earnings": provider_factories.esports_earnings,
        }.get(provider_id)
        return factory(self.runtime) if factory else None

    async def _race(
        self,
        capability: str,
        explicit: str | None,
        attempt: Callable[[str], Awaitable[T]],
    ) -> T:
        """Run ``attempt`` against each candidate until one succeeds.

        Every failure is kept, because the first is rarely the interesting one:
        "no key" then "429" then "500" is three separate things to fix, and an
        error reporting only the last would hide two of them.
        """
        candidates = self._candidates(capability, explicit)
        if not candidates:
            able = providers_for(self.title, capability)
            detail = (
                f"{capability} (no provider for this title serves it - "
                f"it is covered by {', '.join(self.title.providers)})"
                if not able
                else f"{capability} ({' or '.join(able)} could serve it, "
                "but no credential is configured)"
            )
            raise UnsupportedCapabilityError(self.title.id, detail, self.title.capabilities)

        failures: list[tuple[str, GameStatsError]] = []
        for provider_id in candidates:
            try:
                return await attempt(provider_id)
            except GameStatsError as error:
                failures.append((provider_id, error))
                # Without fallback the first provider's failure is the answer:
                # silently switching sources changes whose terms of service apply.
                if not self.runtime.fallback:
                    raise
        raise AllProvidersFailedError(self.title.id, capability, failures)

    # -----------------------------------------------------------------------
    # Fixtures
    # -----------------------------------------------------------------------

    async def get_matches(
        self, options: EsportsQueryOptions | None = None
    ) -> list[EsportsMatch]:
        """Professional fixtures for this title."""
        opts = options or EsportsQueryOptions()

        async def attempt(provider_id: str) -> list[EsportsMatch]:
            if provider_id == "pandascore":
                raw = await provider_factories.pandascore(self.runtime).get_matches(
                    self.title.id,
                    bucket=_bucket_for(opts.status),
                    page=opts.page or 1,
                    per_page=opts.limit or 50,
                    since=opts.since,
                    until=opts.until,
                )
                return [self._from_pandascore(match) for match in raw]
            if provider_id == "octane":
                raw = await provider_factories.octane(self.runtime).get_matches(
                    page=opts.page or 1, per_page=opts.limit or 50
                )
                return [self._from_octane(match) for match in raw]
            if provider_id == "startgg":
                return await self._startgg_matches(opts)
            if provider_id == "opendota":
                raw = await provider_factories.opendota(self.runtime).get_pro_matches()
                return [self._from_opendota_pro(match) for match in raw[: opts.limit or 50]]
            if provider_id == "abios":
                abios = provider_factories.abios(self.runtime)
                game_id = await abios.game_id(self.title.id, self.title.name)
                raw = await abios.get_series(game_id, take=opts.limit or 50)
                return [self._from_abios(series) for series in raw]
            raise UnsupportedCapabilityError(
                self.title.id,
                f"getEsportsMatches via {provider_id}",
                self.title.capabilities,
            )

        return await self._race("getEsportsMatches", opts.provider, attempt)

    async def _startgg_matches(self, opts: EsportsQueryOptions) -> list[EsportsMatch]:
        """start.gg has no fixture list at title level - sets live inside events."""
        startgg = provider_factories.startgg(self.runtime)
        tournaments = await startgg.get_tournaments(
            self.title.id,
            self.title.name,
            page=opts.page or 1,
            per_page=min(opts.limit or 10, 25),
            since=opts.since,
            until=opts.until,
        )
        matches: list[EsportsMatch] = []
        for tournament in tournaments[:3]:
            events = as_list(tournament.get("events"))
            if not events:
                continue
            sets = await startgg.get_event_sets(events[0]["id"], self.title.id, per_page=20)
            matches.extend(self._from_startgg_set(one, tournament) for one in sets)
        return matches

    async def get_tournaments(
        self, options: EsportsQueryOptions | None = None
    ) -> list[EsportsTournament]:
        """Tournaments and events."""
        opts = options or EsportsQueryOptions()

        async def attempt(provider_id: str) -> list[EsportsTournament]:
            if provider_id == "pandascore":
                raw = await provider_factories.pandascore(self.runtime).get_tournaments(
                    self.title.id,
                    bucket=_bucket_for(opts.status),
                    page=opts.page or 1,
                    per_page=opts.limit or 50,
                )
                return [self._tournament_from_pandascore(row) for row in raw]
            if provider_id == "startgg":
                raw = await provider_factories.startgg(self.runtime).get_tournaments(
                    self.title.id,
                    self.title.name,
                    page=opts.page or 1,
                    per_page=opts.limit or 25,
                    since=opts.since,
                    until=opts.until,
                    upcoming=opts.status == EsportsMatchStatus.SCHEDULED,
                )
                return [self._tournament_from_startgg(row) for row in raw]
            if provider_id == "octane":
                raw = await provider_factories.octane(self.runtime).get_events(
                    page=opts.page or 1, per_page=opts.limit or 50
                )
                return [self._tournament_from_octane(row) for row in raw]
            if provider_id == "toornament":
                raw = await provider_factories.toornament(self.runtime).get_tournaments()
                return [self._tournament_from_toornament(row) for row in raw]
            if provider_id == "liquipedia":
                pages = await provider_factories.liquipedia(self.runtime).get_category_members(
                    self.title.id, "Tournaments", opts.limit or 50
                )
                return [self._tournament_from_liquipedia(page) for page in pages]
            raise UnsupportedCapabilityError(
                self.title.id,
                f"getEsportsTournaments via {provider_id}",
                self.title.capabilities,
            )

        return await self._race("getEsportsTournaments", opts.provider, attempt)

    async def get_teams(self, options: EsportsQueryOptions | None = None) -> list[EsportsTeam]:
        """Professional rosters."""
        opts = options or EsportsQueryOptions()

        async def attempt(provider_id: str) -> list[EsportsTeam]:
            if provider_id == "pandascore":
                raw = await provider_factories.pandascore(self.runtime).get_teams(
                    self.title.id, page=opts.page or 1, per_page=opts.limit or 50
                )
                return [self._team_from_pandascore(row) for row in raw]
            if provider_id == "octane":
                raw = await provider_factories.octane(self.runtime).get_teams()
                return [self._team_from_octane(row) for row in raw[: opts.limit or 50]]
            if provider_id == "opendota":
                raw = await provider_factories.opendota(self.runtime).get_teams()
                return [self._team_from_opendota(row) for row in raw[: opts.limit or 50]]
            if provider_id == "abios":
                abios = provider_factories.abios(self.runtime)
                game_id = await abios.game_id(self.title.id, self.title.name)
                raw = await abios.get_teams(game_id, opts.limit or 50)
                return [self._team_from_abios(row) for row in raw]
            raise UnsupportedCapabilityError(
                self.title.id,
                f"getEsportsTeams via {provider_id}",
                self.title.capabilities,
            )

        return await self._race("getEsportsTeams", opts.provider, attempt)

    async def get_players(
        self, options: EsportsQueryOptions | None = None
    ) -> list[EsportsPlayer]:
        """Professional players."""
        opts = options or EsportsQueryOptions()

        async def attempt(provider_id: str) -> list[EsportsPlayer]:
            if provider_id == "pandascore":
                raw = await provider_factories.pandascore(self.runtime).get_players(
                    self.title.id, page=opts.page or 1, per_page=opts.limit or 50
                )
                return [self._player_from_pandascore(row) for row in raw]
            if provider_id == "octane":
                raw = await provider_factories.octane(self.runtime).get_players()
                return [self._player_from_octane(row) for row in raw[: opts.limit or 50]]
            if provider_id == "opendota":
                raw = await provider_factories.opendota(self.runtime).get_pro_players()
                return [self._player_from_opendota(row) for row in raw[: opts.limit or 50]]
            if provider_id == "abios":
                abios = provider_factories.abios(self.runtime)
                game_id = await abios.game_id(self.title.id, self.title.name)
                raw = await abios.get_players(game_id, opts.limit or 50)
                return [self._player_from_abios(row) for row in raw]
            raise UnsupportedCapabilityError(
                self.title.id,
                f"getEsportsPlayers via {provider_id}",
                self.title.capabilities,
            )

        return await self._race("getEsportsPlayers", opts.provider, attempt)

    async def get_standings(
        self, tournament_id: str, options: EsportsQueryOptions | None = None
    ) -> list[EsportsStanding]:
        """Standings for one tournament or event."""
        opts = options or EsportsQueryOptions()

        async def attempt(provider_id: str) -> list[EsportsStanding]:
            if provider_id == "pandascore":
                raw = await provider_factories.pandascore(self.runtime).get_standings(
                    tournament_id, self.title.id
                )
                return [
                    EsportsStanding(
                        position=as_int(row.get("rank")) or index + 1,
                        team_id=as_str((row.get("team") or {}).get("id")),
                        team_name=as_str((row.get("team") or {}).get("name")),
                        wins=as_int(row.get("wins")),
                        losses=as_int(row.get("losses")),
                        draws=as_int(row.get("ties")),
                        points=as_int(row.get("points")),
                        raw=row,
                    )
                    for index, row in enumerate(raw)
                ]
            if provider_id == "startgg":
                raw = await provider_factories.startgg(self.runtime).get_event_standings(
                    tournament_id, self.title.id, per_page=opts.limit or 32
                )
                return [
                    EsportsStanding(
                        position=as_int(row.get("placement")) or index + 1,
                        team_id=as_str((row.get("entrant") or {}).get("id")),
                        team_name=as_str((row.get("entrant") or {}).get("name")),
                        raw=row,
                    )
                    for index, row in enumerate(raw)
                ]
            if provider_id == "challonge":
                raw = await provider_factories.challonge(self.runtime).get_participants(
                    tournament_id
                )
                return [
                    EsportsStanding(
                        position=as_int(row.get("final_rank")) or index + 1,
                        team_id=as_str(row.get("id")),
                        team_name=as_str(row.get("name")),
                        raw=row,
                    )
                    for index, row in enumerate(raw)
                ]
            raise UnsupportedCapabilityError(
                self.title.id,
                f"getStandings via {provider_id}",
                self.title.capabilities,
            )

        return await self._race("getStandings", opts.provider, attempt)

    async def get_earnings(self, handle: str) -> PrizeEarnings:
        """Career prize money.

        Always Esports Earnings, whatever the title - it is the only source that
        covers the whole industry, and there is nothing to choose between.
        """
        provider = provider_factories.esports_earnings(self.runtime)
        matches = await provider.lookup_player_by_name(handle)
        if not matches:
            raise NotFoundError("esports-earnings", f'player "{handle}"', self.title.id)

        first = matches[0]
        player_id = str(first.get("PlayerId") or first.get("playerid") or "")
        detail = await provider.lookup_player_by_id(player_id)
        by_game = await provider.lookup_player_games(player_id)

        by_title = [
            PrizeEarningsByTitle(
                title_id=(
                    found.id if (found := find_title(str(row.get("GameName") or ""))) else None
                ),
                title_name=str(row.get("GameName") or "unknown"),
                # Esports Earnings reports whole dollars; the model stores cents.
                total_usd_cents=round((num(row.get("TotalUSDPrize")) or 0) * 100),
                tournaments=as_int(row.get("TotalTournaments")),
            )
            for row in by_game
        ]

        full_name = " ".join(
            part for part in (detail.get("NameFirst"), detail.get("NameLast")) if part
        )
        return PrizeEarnings(
            player_id=player_id,
            handle=str(detail.get("CurrentHandle") or first.get("CurrentHandle") or handle),
            name=as_str(full_name),
            country=as_str(detail.get("CountryCode")),
            total_usd_cents=round((num(detail.get("TotalUSDPrize")) or 0) * 100),
            by_title=tuple(by_title),
            raw={"player": detail, "games": by_game},
        )

    # -----------------------------------------------------------------------
    # Normalisers
    # -----------------------------------------------------------------------

    def _from_pandascore(self, match: dict[str, Any]) -> EsportsMatch:
        results = {
            entry.get("team_id") or entry.get("player_id"): entry.get("score")
            for entry in as_list(match.get("results"))
        }
        opponents = []
        for entry in as_list(match.get("opponents")):
            opponent = entry.get("opponent") or {}
            opponents.append(
                EsportsOpponent(
                    id=str(opponent.get("id") or ""),
                    name=str(opponent.get("name") or "unknown"),
                    acronym=as_str(opponent.get("acronym")),
                    logo_url=as_str(opponent.get("image_url")),
                    score=results.get(opponent.get("id")),
                    kind="player" if entry.get("type") == "Player" else "team",
                )
            )

        streams = [
            EsportsStream(
                url=str(stream["raw_url"]),
                language=as_str(stream.get("language")),
                official=bool(stream.get("official")),
            )
            for stream in as_list(match.get("streams_list"))
            if stream.get("raw_url")
        ]

        tournament = match.get("tournament") or {}
        league = match.get("league") or {}
        return EsportsMatch(
            id=str(match.get("id") or ""),
            title_id=self.title.id,
            name=as_str(match.get("name")),
            status=normalise_status(as_str(match.get("status"))),
            scheduled_at=ts(match.get("scheduled_at")),
            started_at=ts(match.get("begin_at")),
            ended_at=ts(match.get("end_at")),
            best_of=as_int(match.get("number_of_games")),
            opponents=tuple(opponents),
            winner_id=as_str(match.get("winner_id")),
            tournament=(
                EsportsTournamentRef(
                    id=str(tournament["id"]),
                    name=str(tournament.get("name") or league.get("name") or "unknown"),
                    slug=as_str(tournament.get("slug")),
                )
                if tournament.get("id")
                else None
            ),
            streams=tuple(streams),
            provider_id="pandascore",
            raw=match,
        )

    def _from_octane(self, match: dict[str, Any]) -> EsportsMatch:
        def side(entry: dict[str, Any] | None) -> EsportsOpponent | None:
            if not entry:
                return None
            team = (entry.get("team") or {}).get("team") or {}
            return EsportsOpponent(
                id=str(team.get("_id") or ""),
                name=str(team.get("name") or "unknown"),
                acronym=as_str(team.get("slug")),
                logo_url=as_str(team.get("image")),
                score=as_int(entry.get("score")),
                kind="team",
            )

        opponents = [
            side(match.get("blue")),
            side(match.get("orange")),
        ]
        present = [entry for entry in opponents if entry is not None]
        event = match.get("event") or {}
        winner = None
        if len(present) == 2:
            winner = (
                present[0].id
                if (present[0].score or 0) > (present[1].score or 0)
                else present[1].id
            )

        return EsportsMatch(
            id=str(match.get("_id") or match.get("id") or ""),
            title_id=self.title.id,
            name=as_str(event.get("name")),
            status=(
                EsportsMatchStatus.FINISHED
                if match.get("blue") and match.get("orange")
                else EsportsMatchStatus.SCHEDULED
            ),
            scheduled_at=ts(match.get("date")),
            started_at=ts(match.get("date")),
            best_of=as_int((match.get("format") or {}).get("length")),
            opponents=tuple(present),
            winner_id=winner,
            tournament=(
                EsportsTournamentRef(
                    id=str(event["_id"]),
                    name=str(event.get("name") or "unknown"),
                    slug=as_str(event.get("slug")),
                )
                if event.get("_id")
                else None
            ),
            provider_id="octane",
            raw=match,
        )

    def _from_startgg_set(
        self, one_set: dict[str, Any], tournament: dict[str, Any]
    ) -> EsportsMatch:
        opponents = []
        for slot in as_list(one_set.get("slots")):
            entrant = slot.get("entrant") or {}
            standing = slot.get("standing") or {}
            score = ((standing.get("stats") or {}).get("score") or {}).get("value")
            opponents.append(
                EsportsOpponent(
                    id=str(entrant.get("id") or ""),
                    name=str(entrant.get("name") or "TBD"),
                    score=as_int(score),
                    # Fighting games are 1v1, so an entrant is a person.
                    kind="player",
                )
            )

        return EsportsMatch(
            id=str(one_set.get("id") or ""),
            title_id=self.title.id,
            name=as_str(one_set.get("fullRoundText")),
            status=(
                EsportsMatchStatus.FINISHED
                if one_set.get("completedAt")
                else EsportsMatchStatus.LIVE
                if one_set.get("startedAt")
                else EsportsMatchStatus.SCHEDULED
            ),
            scheduled_at=ts(one_set.get("startedAt")),
            started_at=ts(one_set.get("startedAt")),
            ended_at=ts(one_set.get("completedAt")),
            opponents=tuple(opponents),
            winner_id=as_str(one_set.get("winnerId")),
            tournament=(
                EsportsTournamentRef(
                    id=str(tournament["id"]),
                    name=str(tournament.get("name") or "unknown"),
                    slug=as_str(tournament.get("slug")),
                )
                if tournament.get("id")
                else None
            ),
            provider_id="startgg",
            raw={"set": one_set, "tournament": tournament},
        )

    def _from_opendota_pro(self, match: dict[str, Any]) -> EsportsMatch:
        radiant_win = match.get("radiant_win") is True
        opponents = (
            EsportsOpponent(
                id=str(match.get("radiant_team_id") or "radiant"),
                name=str(match.get("radiant_name") or "Radiant"),
                score=as_int(match.get("radiant_score")),
                kind="team",
            ),
            EsportsOpponent(
                id=str(match.get("dire_team_id") or "dire"),
                name=str(match.get("dire_name") or "Dire"),
                score=as_int(match.get("dire_score")),
                kind="team",
            ),
        )
        return EsportsMatch(
            id=str(match.get("match_id") or ""),
            title_id=self.title.id,
            name=as_str(match.get("league_name")),
            status=EsportsMatchStatus.FINISHED,
            scheduled_at=ts(match.get("start_time")),
            started_at=ts(match.get("start_time")),
            opponents=opponents,
            winner_id=opponents[0].id if radiant_win else opponents[1].id,
            tournament=(
                EsportsTournamentRef(
                    id=str(match["leagueid"]),
                    name=str(match.get("league_name") or "unknown"),
                )
                if match.get("leagueid")
                else None
            ),
            provider_id="opendota",
            raw=match,
        )

    def _from_abios(self, series: dict[str, Any]) -> EsportsMatch:
        opponents = []
        for participant in as_list(series.get("participants")):
            roster = participant.get("roster") or {}
            team = roster.get("team") or {}
            opponents.append(
                EsportsOpponent(
                    id=str(team.get("id") or roster.get("id") or ""),
                    name=str(team.get("name") or "unknown"),
                    acronym=as_str(team.get("short_name")),
                    logo_url=as_str((team.get("images") or {}).get("default")),
                    score=as_int(participant.get("score")),
                    kind="team",
                )
            )
        return EsportsMatch(
            id=str(series.get("id") or ""),
            title_id=self.title.id,
            name=as_str(series.get("title")),
            status=normalise_status(as_str(series.get("lifecycle"))),
            scheduled_at=ts(series.get("start")),
            started_at=ts(series.get("start")),
            ended_at=ts(series.get("end")),
            best_of=as_int(series.get("best_of")),
            opponents=tuple(opponents),
            winner_id=as_str((series.get("winner") or {}).get("id")),
            provider_id="abios",
            raw=series,
        )

    def _tournament_from_pandascore(self, row: dict[str, Any]) -> EsportsTournament:
        league = row.get("league") or {}
        prize = as_str(row.get("prizepool"))
        return EsportsTournament(
            id=str(row.get("id") or ""),
            name=str(row.get("name") or league.get("name") or "unknown"),
            title_id=self.title.id,
            slug=as_str(row.get("slug")),
            tier=as_str(row.get("tier")),
            begin_at=ts(row.get("begin_at")),
            end_at=ts(row.get("end_at")),
            prize_pool_minor=_parse_prize_pool(prize),
            prize_pool_currency=_parse_prize_currency(prize),
            region=as_str(row.get("region")),
            provider_id="pandascore",
            raw=row,
        )

    def _tournament_from_startgg(self, row: dict[str, Any]) -> EsportsTournament:
        online = row.get("isOnline")
        return EsportsTournament(
            id=str(row.get("id") or ""),
            name=str(row.get("name") or "unknown"),
            title_id=self.title.id,
            slug=as_str(row.get("slug")),
            begin_at=ts(row.get("startAt")),
            end_at=ts(row.get("endAt")),
            region=as_str(row.get("countryCode")),
            online=online if isinstance(online, bool) else None,
            provider_id="startgg",
            raw=row,
        )

    def _tournament_from_octane(self, row: dict[str, Any]) -> EsportsTournament:
        prize = row.get("prize") or {}
        amount = num(prize.get("amount"))
        lan = row.get("lan")
        return EsportsTournament(
            id=str(row.get("_id") or ""),
            name=str(row.get("name") or "unknown"),
            title_id=self.title.id,
            slug=as_str(row.get("slug")),
            tier=as_str(row.get("tier")),
            begin_at=ts(row.get("startDate")),
            end_at=ts(row.get("endDate")),
            prize_pool_minor=None if amount is None else round(amount * 100),
            prize_pool_currency=as_str(prize.get("currency")),
            region=as_str(row.get("region")),
            online=(not lan) if isinstance(lan, bool) else None,
            provider_id="octane",
            raw=row,
        )

    def _tournament_from_toornament(self, row: dict[str, Any]) -> EsportsTournament:
        online = row.get("online")
        return EsportsTournament(
            id=str(row.get("id") or ""),
            name=str(row.get("name") or row.get("full_name") or "unknown"),
            title_id=self.title.id,
            begin_at=ts(row.get("scheduled_date_start")),
            end_at=ts(row.get("scheduled_date_end")),
            region=as_str(row.get("country")),
            online=online if isinstance(online, bool) else None,
            provider_id="toornament",
            raw=row,
        )

    def _tournament_from_liquipedia(self, row: dict[str, Any]) -> EsportsTournament:
        title = str(row.get("title") or "")
        return EsportsTournament(
            id=str(row.get("pageid") or ""),
            name=title,
            title_id=self.title.id,
            slug=title.replace(" ", "_"),
            provider_id="liquipedia",
            raw=row,
        )

    def _team_from_pandascore(self, row: dict[str, Any]) -> EsportsTeam:
        return EsportsTeam(
            id=str(row.get("id") or ""),
            title_id=self.title.id,
            name=str(row.get("name") or "unknown"),
            acronym=as_str(row.get("acronym")),
            logo_url=as_str(row.get("image_url")),
            country=as_str(row.get("location")),
            players=tuple(
                self._player_from_pandascore(player, str(row.get("id") or ""))
                for player in as_list(row.get("players"))
            ),
            provider_id="pandascore",
            raw=row,
        )

    def _team_from_octane(self, row: dict[str, Any]) -> EsportsTeam:
        return EsportsTeam(
            id=str(row.get("_id") or ""),
            title_id=self.title.id,
            name=str(row.get("name") or "unknown"),
            acronym=as_str(row.get("slug")),
            logo_url=as_str(row.get("image")),
            country=as_str((row.get("location") or {}).get("nationality")),
            provider_id="octane",
            raw=row,
        )

    def _team_from_opendota(self, row: dict[str, Any]) -> EsportsTeam:
        return EsportsTeam(
            id=str(row.get("team_id") or ""),
            title_id=self.title.id,
            name=str(row.get("name") or "unknown"),
            acronym=as_str(row.get("tag")),
            logo_url=as_str(row.get("logo_url")),
            provider_id="opendota",
            raw=row,
        )

    def _team_from_abios(self, row: dict[str, Any]) -> EsportsTeam:
        return EsportsTeam(
            id=str(row.get("id") or ""),
            title_id=self.title.id,
            name=str(row.get("name") or "unknown"),
            acronym=as_str(row.get("short_name")),
            logo_url=as_str((row.get("images") or {}).get("default")),
            country=as_str((row.get("country") or {}).get("name")),
            provider_id="abios",
            raw=row,
        )

    def _player_from_pandascore(
        self, row: dict[str, Any], team_id: str | None = None
    ) -> EsportsPlayer:
        return EsportsPlayer(
            id=str(row.get("id") or ""),
            title_id=self.title.id,
            nickname=str(row.get("name") or row.get("slug") or "unknown"),
            first_name=as_str(row.get("first_name")),
            last_name=as_str(row.get("last_name")),
            country=as_str(row.get("nationality")),
            role=as_str(row.get("role")),
            team_id=team_id or as_str((row.get("current_team") or {}).get("id")),
            provider_id="pandascore",
            raw=row,
        )

    def _player_from_octane(self, row: dict[str, Any]) -> EsportsPlayer:
        name = row.get("name") or {}
        return EsportsPlayer(
            id=str(row.get("_id") or ""),
            title_id=self.title.id,
            nickname=str(row.get("tag") or "unknown"),
            first_name=as_str(name.get("first")),
            last_name=as_str(name.get("last")),
            country=as_str(row.get("country")),
            team_id=as_str((row.get("team") or {}).get("_id")),
            provider_id="octane",
            raw=row,
        )

    def _player_from_opendota(self, row: dict[str, Any]) -> EsportsPlayer:
        return EsportsPlayer(
            id=str(row.get("account_id") or ""),
            title_id=self.title.id,
            nickname=str(row.get("name") or row.get("personaname") or "unknown"),
            country=as_str(row.get("loccountrycode")),
            team_id=as_str(row.get("team_id")),
            provider_id="opendota",
            raw=row,
        )

    def _player_from_abios(self, row: dict[str, Any]) -> EsportsPlayer:
        return EsportsPlayer(
            id=str(row.get("id") or ""),
            title_id=self.title.id,
            nickname=str(row.get("nick_name") or row.get("name") or "unknown"),
            first_name=as_str(row.get("first_name")),
            last_name=as_str(row.get("last_name")),
            country=as_str((row.get("country") or {}).get("name")),
            role=as_str(row.get("role")),
            team_id=as_str((row.get("team") or {}).get("id")),
            provider_id="abios",
            raw=row,
        )


def _bucket_for(status: EsportsMatchStatus | None) -> str | None:
    """Map a canonical status onto PandaScore's bucket endpoints."""
    return (
        {
            EsportsMatchStatus.LIVE: "running",
            EsportsMatchStatus.SCHEDULED: "upcoming",
            EsportsMatchStatus.FINISHED: "past",
        }.get(status)
        if status
        else None
    )


def normalise_status(status: str | None) -> EsportsMatchStatus:
    """Every provider spells match status differently. This is the one vocabulary."""
    lowered = (status or "").lower()
    if lowered in ("running", "live", "started"):
        return EsportsMatchStatus.LIVE
    if lowered in ("finished", "over", "ended", "completed"):
        return EsportsMatchStatus.FINISHED
    if lowered in ("not_started", "upcoming", "scheduled", "unscheduled"):
        return EsportsMatchStatus.SCHEDULED
    if lowered in ("postponed", "delayed"):
        return EsportsMatchStatus.POSTPONED
    if lowered in ("canceled", "cancelled"):
        return EsportsMatchStatus.CANCELLED
    return EsportsMatchStatus.UNKNOWN


def _parse_prize_pool(value: str | None) -> int | None:
    """PandaScore reports a prize pool as free text: ``"1000000 United States Dollar"``.

    The number becomes minor units; anything unparseable becomes ``None`` rather
    than a guess, because a wrong prize pool is worse than a missing one.
    """
    if not value:
        return None
    import re

    match = re.search(r"([0-9][0-9.,]*)", value)
    if not match:
        return None
    try:
        amount = float(match.group(1).replace(",", ""))
    except ValueError:
        return None
    return round(amount * 100)


def _parse_prize_currency(value: str | None) -> str | None:
    """The currency half of the same free-text field, as an ISO code where known."""
    if not value:
        return None
    text = value.lower()
    if "united states dollar" in text or "usd" in text:
        return "USD"
    if "euro" in text or "eur" in text:
        return "EUR"
    if "pound" in text:
        return "GBP"
    if "yuan" in text or "renminbi" in text:
        return "CNY"
    if "won" in text:
        return "KRW"
    if "yen" in text:
        return "JPY"
    return None
