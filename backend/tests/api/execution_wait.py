"""Functional execution polling shared by API tests."""

import time

from api_client import LoopbackTestClient as TestClient

from batchcraft.api.schemas import ExecutionResponse


def _wait_for_status(
    http: TestClient, run_id: str, expected: str, *, timeout_seconds: float = 10
) -> ExecutionResponse:
    # Functional completion budget, not a disk/runner performance assertion.
    started = time.monotonic()
    deadline = started + timeout_seconds
    last_response = "<no response>"
    reason = "timed out"
    while time.monotonic() < deadline:
        response = http.get(f"/api/runs/{run_id}/execution")
        last_response = response.text
        if response.status_code != 200:
            reason = f"HTTP {response.status_code}"
            break
        body = ExecutionResponse.model_validate(response.json())
        if body.status == expected:
            return body
        if body.status in {"succeeded", "failed", "blocked", "cancelled"}:
            reason = f"unexpected terminal status {body.status!r}"
            break
        time.sleep(0.01)
    raise AssertionError(
        f"Run {run_id} did not reach {expected!r}: {reason} after "
        f"{time.monotonic() - started:.3f}s (budget {timeout_seconds:g}s); "
        f"last response: {last_response}"
    )
