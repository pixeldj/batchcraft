from types import SimpleNamespace
from typing import cast

import pytest
import test_api
from api_client import LoopbackTestClient
from httpx import Response


@pytest.mark.parametrize(
    ("statuses", "expected", "timeout_seconds", "http_status", "failure"),
    [
        (["running", "succeeded"], "succeeded", None, 200, None),
        (["running"] * 5, "succeeded", None, 200, "timed out"),
        (["running"], "succeeded", 2, 200, "timed out"),
        *[
            ([status], "succeeded", None, 200, "unexpected terminal status")
            for status in ("failed", "blocked", "cancelled")
        ],
        (["succeeded"], "running", None, 200, "unexpected terminal status"),
        *[([status], status, None, 200, None) for status in ("failed", "blocked", "cancelled")],
        (["running"], "succeeded", None, 503, "HTTP 503"),
    ],
)
def test_wait_for_status_budget_and_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
    statuses: list[str],
    expected: str,
    timeout_seconds: float | None,
    http_status: int,
    failure: str | None,
) -> None:
    # Each request takes 2.2 virtual seconds; no real clock or sleeps are used.
    now = 100.0
    sleeps: list[float] = []
    responses: list[Response] = []
    pending = iter(statuses)

    def monotonic() -> float:
        return now

    def sleep(seconds: float) -> None:
        nonlocal now
        sleeps.append(seconds)
        now += seconds

    def get(url: str) -> Response:
        nonlocal now
        assert url == "/api/runs/test-run/execution"
        now += 2.2
        status = next(pending)
        response = Response(
            http_status,
            json={
                "run_id": "test-run",
                "status": status,
                "execution_task_active": status == "running",
                "started_at": "started",
                "completed_at": None,
                "current_job_ordinal": 4,
                "error": "test diagnostic",
                "diagnostics": ["test detail"],
                "jobs": [
                    {
                        "ordinal": 4,
                        "status": status,
                        "prompt_id": "prompt-4",
                        "started_at": "started",
                        "completed_at": None,
                        "error": None,
                        "diagnostics": [],
                        "result_count": 2,
                    }
                ],
            },
        )
        responses.append(response)
        return response

    # Replace only this test module's clock, not time.monotonic process-wide.
    monkeypatch.setattr(test_api, "time", SimpleNamespace(monotonic=monotonic, sleep=sleep))
    http = cast(LoopbackTestClient, SimpleNamespace(get=get))
    options = {} if timeout_seconds is None else {"timeout_seconds": timeout_seconds}
    if failure is None:
        result = test_api._wait_for_status(http, "test-run", expected, **options)
        assert result.status == expected
        assert result.jobs[0].result_count == 2
        assert now == pytest.approx(104.41 if len(statuses) == 2 else 102.2)
    else:
        with pytest.raises(AssertionError, match=failure) as raised:
            test_api._wait_for_status(http, "test-run", expected, **options)
        message = str(raised.value)
        assert f"did not reach {expected!r}" in message
        assert f"after {now - 100:.3f}s" in message
        assert f"budget {timeout_seconds or 10:g}s" in message
        assert message.endswith(f"last response: {responses[-1].text}")
    assert len(responses) == len(statuses)
    assert sleeps == [0.01] * (len(statuses) if failure == "timed out" else len(statuses) - 1)
    assert now - 100 == pytest.approx(len(responses) * 2.2 + len(sleeps) * 0.01)
