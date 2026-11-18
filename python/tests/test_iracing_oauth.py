"""iRacing over OAuth 2.0: the authorization URL, the token exchange, renewal.

iRacing retired the email/password login on 9 December 2025. These tests pin the
replacement: Authorization Code with PKCE, refresh tokens that rotate, a bearer
token on every Data API call - and no password anywhere.

Hosts are compared after parsing, never by substring, so a test cannot pass on
a look-alike host.

It mirrors ``typescript/tests/iracing-oauth.test.ts`` case for case.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
from urllib.parse import parse_qs, urlparse

import pytest

from conftest import MockTransport, Route
from conftest import test_options as client_options
from gamestatsfetcher import (
    AuthenticationError,
    GameStatsClient,
    MissingCredentialError,
    ValidationError,
)
from gamestatsfetcher.providers import IRacingTokens, create_pkce_pair
from gamestatsfetcher.providers.racing import IRACING_TOKEN_URL

TOKEN = {
    "access_token": "access-1",
    "token_type": "Bearer",
    "expires_in": 600,
    "refresh_token": "refresh-2",
    "refresh_token_expires_in": 604800,
    "scope": "iracing.auth",
}

MEMBER = {"members": [{"cust_id": 1, "display_name": "Probe Driver"}]}


def client_with(
    routes: list[Route], key: str = "my-client"
) -> tuple[GameStatsClient, MockTransport]:
    transport = MockTransport(routes)
    client = GameStatsClient(**client_options(transport, api_keys={"iracing": key}))
    return client, transport


def form_of(transport: MockTransport, index: int) -> dict[str, str]:
    body = transport.bodies[index] or ""
    return {key: values[0] for key, values in parse_qs(body).items()}


def host_of(url: str) -> str:
    return urlparse(url).hostname or ""


class TestPkce:
    def test_challenge_is_the_s256_of_the_verifier(self) -> None:
        verifier, challenge = create_pkce_pair()
        expected = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .decode()
            .rstrip("=")
        )
        assert challenge == expected
        assert 43 <= len(verifier) <= 128

    def test_pairs_are_not_reused(self) -> None:
        first, _ = create_pkce_pair()
        second, _ = create_pkce_pair()
        assert first != second


class TestAuthorizationUrl:
    def test_carries_client_redirect_pkce_state_and_scope(self) -> None:
        client, _ = client_with([])
        started = client.iracing_auth().authorization_url(
            "https://app.example/callback", state="xyz"
        )
        parsed = urlparse(started.url)
        query = {key: values[0] for key, values in parse_qs(parsed.query).items()}

        assert parsed.scheme == "https"
        assert host_of(started.url) == "oauth.iracing.com"
        assert parsed.path == "/oauth2/authorize"
        assert query["client_id"] == "my-client"
        assert query["redirect_uri"] == "https://app.example/callback"
        assert query["response_type"] == "code"
        assert query["code_challenge_method"] == "S256"
        assert query["scope"] == "iracing.auth"
        assert query["state"] == "xyz"
        assert started.state == "xyz"
        expected = (
            base64.urlsafe_b64encode(hashlib.sha256(started.code_verifier.encode()).digest())
            .decode()
            .rstrip("=")
        )
        assert query["code_challenge"] == expected

    def test_generates_a_state_when_none_is_given(self) -> None:
        client, _ = client_with([])
        first = client.iracing_auth().authorization_url("https://app.example/cb")
        second = client.iracing_auth().authorization_url("https://app.example/cb")
        assert first.state
        assert second.state
        assert first.state != second.state

    def test_without_a_client_id_names_the_missing_option(self) -> None:
        transport = MockTransport([])
        auth = GameStatsClient(**client_options(transport)).iracing_auth()
        with pytest.raises(MissingCredentialError):
            auth.authorization_url("https://app.example/cb")

    def test_a_client_secret_is_refused(self) -> None:
        # Public clients only: PKCE replaces the secret.
        client, _ = client_with([], key="my-client:a-secret")
        auth = client.iracing_auth()
        with pytest.raises(ValidationError, match="public"):
            auth.authorization_url("https://app.example/cb")


class TestTokenExchange:
    async def test_exchange_code_posts_the_documented_form(self) -> None:
        client, transport = client_with([Route(match="/oauth2/token", body=TOKEN)])
        seen: list[IRacingTokens] = []
        auth = client.iracing_auth()
        auth.on_tokens(seen.append)

        tokens = await auth.exchange_code("the-code", "https://app.example/cb", "verifier")

        method, url = transport.calls[0]
        assert method == "POST"
        assert url == IRACING_TOKEN_URL
        assert transport.headers[0]["Content-Type"] == "application/x-www-form-urlencoded"
        assert form_of(transport, 0) == {
            "grant_type": "authorization_code",
            "code": "the-code",
            "redirect_uri": "https://app.example/cb",
            "code_verifier": "verifier",
            "client_id": "my-client",
        }
        assert tokens.access_token == "access-1"
        assert tokens.refresh_token == "refresh-2"
        assert tokens.expires_in == 600
        assert tokens.refresh_token_expires_in == 604800
        assert tokens.scope == "iracing.auth"
        assert seen == [tokens]

    async def test_a_token_response_without_access_token_is_an_auth_error(self) -> None:
        client, _ = client_with([Route(match="/oauth2/token", body={"error": "x"})])
        auth = client.iracing_auth()
        with pytest.raises(AuthenticationError):
            await auth.exchange_code("c", "https://app.example/cb", "v")

    async def test_async_listeners_are_awaited(self) -> None:
        client, _ = client_with([Route(match="/oauth2/token", body=TOKEN)])
        stored: list[str] = []

        async def persist(tokens: IRacingTokens) -> None:
            await asyncio.sleep(0)
            stored.append(tokens.refresh_token or "")

        auth = client.iracing_auth()
        auth.on_tokens(persist)
        await auth.exchange_code("c", "https://app.example/cb", "v")
        assert stored == ["refresh-2"]


class TestDataApi:
    async def test_without_tokens_the_call_fails_before_any_request(self) -> None:
        client, transport = client_with([])
        with pytest.raises(AuthenticationError, match="use_tokens"):
            await client.iracing.get_player({"account_id": "1"})
        assert transport.calls == []

    async def test_a_stored_refresh_token_is_renewed_and_sent_as_bearer(self) -> None:
        client, transport = client_with(
            [
                Route(match="/oauth2/token", body=TOKEN),
                Route(match="/data/member/get", body=MEMBER),
            ]
        )
        rotated: list[str | None] = []
        auth = client.iracing_auth()
        auth.use_tokens("refresh-1")
        auth.on_tokens(lambda tokens: rotated.append(tokens.refresh_token))

        player = await client.iracing.get_player({"account_id": "1"})

        assert player.display_name == "Probe Driver"
        assert form_of(transport, 0) == {
            "grant_type": "refresh_token",
            "refresh_token": "refresh-1",
            "client_id": "my-client",
        }
        data_index = next(
            index
            for index, (_, url) in enumerate(transport.calls)
            if host_of(url) == "members-ng.iracing.com"
        )
        assert transport.headers[data_index]["Authorization"] == "Bearer access-1"
        assert "Cookie" not in transport.headers[data_index]
        assert rotated == ["refresh-2"]

    async def test_a_valid_access_token_is_reused_without_a_refresh(self) -> None:
        client, transport = client_with([Route(match="/data/member/get", body=MEMBER)])
        client.iracing_auth().use_tokens("refresh-1", access_token="live", expires_in=600)

        await client.iracing.get_player({"account_id": "1"})

        assert transport.count_of("/oauth2/token") == 0
        assert transport.headers[0]["Authorization"] == "Bearer live"

    async def test_concurrent_calls_spend_the_refresh_token_once(self) -> None:
        client, transport = client_with(
            [
                Route(match="/oauth2/token", body=TOKEN),
                Route(match="/data/", body=MEMBER),
            ]
        )
        client.iracing_auth().use_tokens("refresh-1")
        await asyncio.gather(
            client.iracing.get_player({"account_id": "1"}),
            client.iracing.get_player({"account_id": "2"}),
        )
        assert transport.count_of("/oauth2/token") == 1

    async def test_the_rotated_refresh_token_is_used_next_time(self) -> None:
        second = {**TOKEN, "access_token": "access-2", "refresh_token": "refresh-3"}
        client, transport = client_with(
            [Route(match="/oauth2/token", sequence=[{"body": TOKEN}, {"body": second}])]
        )
        auth = client.iracing_auth()
        auth.use_tokens("refresh-1")
        await auth.refresh()
        renewed = await auth.refresh()

        assert form_of(transport, 1)["refresh_token"] == "refresh-2"
        assert renewed.access_token == "access-2"

    async def test_s3_links_are_followed_without_the_bearer_token(self) -> None:
        client, transport = client_with(
            [
                Route(
                    match="/data/member/get",
                    body={"link": "https://scorpio-assets.s3.amazonaws.com/x.json"},
                ),
                Route(match="scorpio-assets", body=MEMBER),
            ]
        )
        client.iracing_auth().use_tokens("refresh-1", access_token="live", expires_in=600)

        await client.iracing.get_player({"account_id": "1"})

        s3_index = next(
            index
            for index, (_, url) in enumerate(transport.calls)
            if host_of(url) == "scorpio-assets.s3.amazonaws.com"
        )
        assert "Authorization" not in transport.headers[s3_index]
