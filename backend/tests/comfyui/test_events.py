import asyncio
import json
from collections.abc import AsyncIterator
from typing import cast

import pytest
from websockets.asyncio.client import ClientConnection

from batchcraft.comfyui import (
    ExecutionEventStream,
    ExecutionObservationError,
    correlated_execution_events,
)


async def _messages(*values: str | bytes) -> AsyncIterator[str | bytes]:
    for value in values:
        yield value


class _ClosedConnection:
    def __aiter__(self) -> AsyncIterator[str | bytes]:
        return _messages()


def test_events_are_correlated_to_owned_prompt_only() -> None:
    async def scenario() -> None:
        messages = _messages(
            json.dumps({"type": "executing", "data": {"prompt_id": "other", "node": "7"}}),
            b"binary preview",
            json.dumps({"type": "executing", "data": {"prompt_id": "owned", "node": "7"}}),
            json.dumps({"type": "executing", "data": {"prompt_id": "owned", "node": None}}),
            json.dumps({"type": "execution_success", "data": {"prompt_id": "owned", "node": None}}),
        )
        events = [event async for event in correlated_execution_events(messages, "owned")]

        assert [event.event_type for event in events] == [
            "executing",
            "executing",
            "execution_success",
        ]
        assert all(event.prompt_id == "owned" for event in events)
        assert events[1].node_id is None
        assert events[1].is_terminal_advisory
        assert events[2].is_terminal_advisory

    asyncio.run(scenario())


def test_malformed_websocket_event_fails_actionably() -> None:
    async def scenario() -> None:
        with pytest.raises(ExecutionObservationError, match="invalid JSON"):
            _ = [event async for event in correlated_execution_events(_messages("not-json"), "p")]

    asyncio.run(scenario())


def test_clean_websocket_closure_is_an_observation_error() -> None:
    async def scenario() -> None:
        stream = ExecutionEventStream(cast(ClientConnection, _ClosedConnection()))
        with pytest.raises(ExecutionObservationError, match="closed while observing prompt"):
            _ = [event async for event in stream.events("owned")]

    asyncio.run(scenario())
