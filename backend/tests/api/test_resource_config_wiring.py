from dataclasses import replace
from pathlib import Path
from typing import Any, cast
from unittest.mock import Mock

import pytest
from api_client import LoopbackTestClient as TestClient
from test_api import (
    FakeComfyUIClient,
    _batch_request,
    _publish_project_owner,
    _settings,
    _sync_batch_snapshot,
)

from batchcraft.api import Settings, create_app
from batchcraft.api.app import _create_comfyui_client

LIMITS = (
    ("max_prompt_bytes", "BATCHCRAFT_MAX_PROMPT_BYTES", 1024 * 1024),
    ("max_resolved_text_bytes", "BATCHCRAFT_MAX_RESOLVED_TEXT_BYTES", 32 * 1024 * 1024),
    (
        "comfyui_max_json_response_bytes",
        "BATCHCRAFT_COMFYUI_MAX_JSON_RESPONSE_BYTES",
        8 * 1024 * 1024,
    ),
    ("comfyui_max_artifact_bytes", "BATCHCRAFT_COMFYUI_MAX_ARTIFACT_BYTES", 256 * 1024 * 1024),
    (
        "comfyui_max_websocket_message_bytes",
        "BATCHCRAFT_COMFYUI_MAX_WEBSOCKET_MESSAGE_BYTES",
        4 * 1024 * 1024,
    ),
)


@pytest.mark.parametrize(("field", "env", "default"), LIMITS)
def test_resource_limit_defaults_and_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, field: str, env: str, default: int
) -> None:
    monkeypatch.delenv(env, raising=False)
    assert getattr(_settings(tmp_path), field) == default
    assert getattr(Settings.from_env(), field) == default
    monkeypatch.setenv(env, "12345")
    assert getattr(Settings.from_env(), field) == 12345


@pytest.mark.parametrize(("field", "env", "default"), LIMITS)
@pytest.mark.parametrize("value", [0, -1, True, 1.5, "2", None])
def test_resource_limits_require_strict_positive_integers(
    tmp_path: Path, field: str, env: str, default: int, value: object
) -> None:
    with pytest.raises(ValueError, match=f"{field} must be a positive integer"):
        replace(_settings(tmp_path), **{field: cast(Any, value)})


@pytest.mark.parametrize(("field", "env", "default"), LIMITS)
@pytest.mark.parametrize("value", ["0", "-1", "true", "1.5", "", "nan"])
def test_resource_limit_environment_rejects_invalid_values(
    monkeypatch: pytest.MonkeyPatch, field: str, env: str, default: int, value: str
) -> None:
    monkeypatch.setenv(env, value)
    with pytest.raises(ValueError, match=f"{env} must be a positive integer"):
        Settings.from_env()


def test_default_client_factory_receives_configured_limits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = replace(
        _settings(tmp_path),
        comfyui_max_json_response_bytes=123,
        comfyui_max_artifact_bytes=456,
        comfyui_max_websocket_message_bytes=789,
    )
    constructor = Mock()
    monkeypatch.setattr("batchcraft.api.app.ComfyUIClient", constructor)
    assert _create_comfyui_client(settings) is constructor.return_value
    constructor.assert_called_once_with(
        settings.comfyui_base_url,
        timeout=settings.comfyui_timeout_seconds,
        max_json_response_bytes=123,
        max_artifact_bytes=456,
        max_websocket_message_bytes=789,
    )


def test_service_receives_configured_plan_limits(tmp_path: Path) -> None:
    settings = replace(
        _settings(tmp_path), max_jobs=7, max_prompt_bytes=123, max_resolved_text_bytes=456
    )
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app):
        assert app.state.service.max_jobs == 7
        assert app.state.service.max_prompt_bytes == 123
        assert app.state.service.max_resolved_text_bytes == 456


def test_custom_request_body_cap_rejects_before_handler(tmp_path: Path) -> None:
    settings = replace(_settings(tmp_path), max_request_bytes=32)
    with TestClient(create_app(settings, client_factory=lambda _: FakeComfyUIClient())) as http:
        response = http.post("/api/batches/preview", json=_batch_request(()))
    assert response.status_code == 413
    assert not (settings.projects_root / "project_key").exists()


@pytest.mark.parametrize("route", ["preview", "random_preview", "create"])
@pytest.mark.parametrize("limit", ["max_jobs", "max_prompt_bytes", "max_resolved_text_bytes"])
def test_api_configured_preflight_precedes_range_allocation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, route: str, limit: str
) -> None:
    settings = replace(_settings(tmp_path), **{limit: cast(Any, 1)})
    _publish_project_owner(settings)
    request = _batch_request(())
    profile, workflow = request["workflow_profile"], request["workflow"]
    assert isinstance(profile, dict) and isinstance(workflow, dict)
    profile["parameters"] = [
        {
            "key": "width",
            "label": "Width",
            "node_id": "7",
            "input_name": "width",
            "value_type": "integer",
        }
    ]
    workflow["7"]["inputs"]["width"] = 1
    request["parameter_bindings"] = [
        {
            "parameter_key": "width",
            "mode": "range",
            "include_base": False,
            "range": {"start": "0", "end": "3", "step": "1"},
        }
    ]
    if route == "random_preview":
        request["seeds"] = {"mode": "random", "random_seed_count": 3, "values": []}
        snapshot = request["batch_snapshot"]
        assert isinstance(snapshot, dict)
        snapshot["seed_intent"] = request["seeds"]
    _sync_batch_snapshot(request)
    allocation = Mock(side_effect=AssertionError("Range allocation before API preflight"))
    monkeypatch.setattr("batchcraft.domain.parameter_intents._materialize_range", allocation)
    app = create_app(settings, client_factory=lambda _: FakeComfyUIClient())
    with TestClient(app) as http:
        response = http.post(
            "/api/runs" if route == "create" else "/api/batches/preview", json=request
        )
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "invalid_batch", response.text
    allocation.assert_not_called()
    assert not (settings.projects_root / "project_key" / "batches").exists()


@pytest.mark.parametrize(
    ("field", "cap", "status"),
    [
        ("max_prompt_bytes", 14, 422),
        ("max_prompt_bytes", 15, 200),
        ("max_resolved_text_bytes", 71, 422),
        ("max_resolved_text_bytes", 72, 200),
    ],
)
def test_api_custom_text_cap_boundary(tmp_path: Path, field: str, cap: int, status: int) -> None:
    settings = replace(_settings(tmp_path), **{field: cast(Any, cap)})
    _publish_project_owner(settings)
    with TestClient(create_app(settings, client_factory=lambda _: FakeComfyUIClient())) as http:
        response = http.post("/api/batches/preview", json=_batch_request(()))
    assert response.status_code == status, response.text
