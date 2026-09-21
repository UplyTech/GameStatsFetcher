"""Every call, against an upstream answering nonsense, must fail as a GameStatsError.

This is the counterpart to ``test_contract.py``. That file answers 503 to
everything and checks the *contract*: a declared capability must not raise
``UnsupportedCapabilityError``. This one answers **200 with a body no mapper was
written for** and checks the *boundary*: whatever the mapper then hits, what
leaves the package is something a caller's ``except GameStatsError`` catches.

Why that matters more than it sounds. Sixty-odd title clients map several
hundred upstream payloads, each written against a shape its provider documents.
Providers change without notice, gateways return HTML error pages with a 200,
and a caller behind a hostile or misconfigured proxy gets whatever that proxy
felt like. Before the boundary translation in ``title_client.py``, a payload of
the wrong shape escaped as ``AttributeError: 'str' object has no attribute
'get'`` - naming neither the title nor the call, and not a ``GameStatsError``,
so an application that carefully wrapped every call still crashed.

87 titles x 14 methods x 10 payload shapes is 5,500 calls, which is not a number
anybody would write by hand, and is exactly why it is generated. Every payload
here was chosen because a real API answers with it under some failure:

- ``{}`` and ``[]``: an empty page, or an endpoint that has been emptied
- ``null``: a JSON body of literal null, which several CDNs cache for 404s
- ``{"data": []}`` / ``{"data": {}}``: the envelope with the wrong middle
- ``["x"]`` and ``{"data": ["x"], ...}``: a list of ids where objects were
  documented - the shape that used to reach a normaliser and explode
- ``1`` and ``"boom"``: a scalar body, which is what an error page becomes after
  a proxy has JSON-encoded it
"""

from __future__ import annotations

import json as jsonlib
from typing import Any

import pytest

from conftest import test_options as client_options
from conftest import unthrottled
from gamestatsfetcher import GameStatsClient, GameStatsError, HttpResponse, list_titles
from test_contract import ALL_KEYS, CALLS

#: Bodies no mapper is written for. See the module docstring for why each one.
HOSTILE_BODIES: dict[str, Any] = {
    "empty-object": {},
    "empty-list": [],
    "null": None,
    "data-empty-list": {"data": []},
    "data-empty-object": {"data": {}},
    "wrong-types": {"data": "x", "response": 1, "items": "y", "results": 0},
    "poisoned-rows": {
        "data": ["x"],
        "matches": ["x"],
        "players": ["x"],
        "results": ["x"],
        "items": ["x"],
        "entries": ["x"],
        "teams": ["x"],
        "response": ["x"],
    },
    "scalar-list": ["x"],
    "number": 1,
    "string": "boom",
}

TITLES = list_titles()


class _Always:
    """Answers 200 with the same body to every request, whatever was asked."""

    def __init__(self, body: Any) -> None:
        self.body = body
        #: Counted so a sweep can prove it actually reached the mappers.
        self.requests = 0

    async def request(self, method: str, url: str, **kwargs: Any) -> HttpResponse:
        self.requests += 1
        return HttpResponse(
            status=200,
            headers={"Content-Type": "application/json"},
            text=jsonlib.dumps(self.body),
        )

    async def aclose(self) -> None:
        return None


@pytest.mark.parametrize("label", sorted(HOSTILE_BODIES))
async def test_no_payload_escapes_as_anything_but_a_gamestatserror(label: str) -> None:
    """Nothing a server can send turns into an exception a caller cannot catch."""
    body = HOSTILE_BODIES[label]
    transport = _Always(body)
    client = unthrottled(GameStatsClient(**client_options(transport, api_keys=dict(ALL_KEYS))))
    escapes: list[str] = []
    calls = 0
    try:
        for title in TITLES:
            title_client = client.title(title.id)
            for capability, call in CALLS.items():
                if capability not in title.capabilities:
                    continue
                calls += 1
                try:
                    await call(title_client)
                except GameStatsError:
                    # The whole point: every failure is one of ours, carrying a
                    # provider, a code and a message a caller can act on.
                    pass
                except Exception as error:  # noqa: BLE001 - that is what is under test
                    escapes.append(f"{title.id}.{capability}: {type(error).__name__}: {error}")
    finally:
        await client.aclose()

    assert calls > 500, f"only {calls} calls - has the registry shrunk?"
    # Without this the test could pass by never reaching a mapper at all:
    # a rate limiter that refused every call raises a GameStatsError too.
    assert transport.requests > calls // 2, (
        f"only {transport.requests} requests for {calls} calls - "
        "the mappers are not being reached"
    )
    assert not escapes, (
        f"{len(escapes)} of {calls} calls escaped as a non-GameStatsError "
        f"for body {label!r}:\n  " + "\n  ".join(escapes[:20])
    )


async def test_the_translation_says_which_call_could_not_be_mapped() -> None:
    """A ParseError from the boundary is useful, not just correctly typed."""
    client = unthrottled(
        GameStatsClient(**client_options(_Always({"data": ["x"]}), api_keys=dict(ALL_KEYS)))
    )
    with pytest.raises(GameStatsError) as caught:
        await client.title("valorant").get_leaderboard()
    message = str(caught.value)
    # The title and the call, both in the message: enough for a bug report
    # without a stack trace, which is what an operator reading a log has.
    assert "valorant" in message
    assert "get_leaderboard" in message
    assert "could not map" in message
    # The original exception is kept, so the traceback still points at the line
    # that actually broke rather than at the wrapper.
    assert caught.value.__cause__ is not None
    await client.aclose()


async def test_a_deliberate_error_is_not_relabelled() -> None:
    """UnsupportedCapabilityError still leaves as itself, not as a ParseError."""
    from gamestatsfetcher import UnsupportedCapabilityError

    client = unthrottled(
        GameStatsClient(**client_options(_Always({}), api_keys=dict(ALL_KEYS)))
    )
    tekken = next(t for t in TITLES if "getPlayer" not in t.capabilities)
    with pytest.raises(UnsupportedCapabilityError):
        await client.title(tekken.id).get_player({"name": "probe"})
    await client.aclose()
