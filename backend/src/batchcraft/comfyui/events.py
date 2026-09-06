import json
from collections.abc import AsyncIterable, AsyncIterator
from typing import cast

from batchcraft.comfyui.errors import ExecutionObservationError
from batchcraft.comfyui.models import ExecutionEvent


def parse_execution_event(message: str | bytes, prompt_id: str) -> ExecutionEvent | None:
    if isinstance(message, bytes):
        return None
    try:
        value: object = json.loads(message)
    except (ValueError, RecursionError) as error:
        raise ExecutionObservationError("ComfyUI WebSocket returned invalid JSON") from error
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ExecutionObservationError("ComfyUI WebSocket event must be a JSON object")
    event = cast(dict[str, object], value)
    event_type = event.get("type")
    data_value = event.get("data")
    if not isinstance(event_type, str) or not event_type:
        raise ExecutionObservationError("ComfyUI WebSocket event has no valid type")
    if not isinstance(data_value, dict) or not all(isinstance(key, str) for key in data_value):
        raise ExecutionObservationError("ComfyUI WebSocket event has no valid data object")
    data = cast(dict[str, object], data_value)
    if data.get("prompt_id") != prompt_id:
        return None
    node = data.get("node")
    if node is not None and not isinstance(node, (str, int)):
        raise ExecutionObservationError("ComfyUI WebSocket event has an invalid node ID")
    return ExecutionEvent(
        event_type=event_type,
        prompt_id=prompt_id,
        node_id=None if node is None else str(node),
        data=data,
    )


async def correlated_execution_events(
    messages: AsyncIterable[str | bytes], prompt_id: str
) -> AsyncIterator[ExecutionEvent]:
    async for message in messages:
        event = parse_execution_event(message, prompt_id)
        if event is not None:
            yield event
