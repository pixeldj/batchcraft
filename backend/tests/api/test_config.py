from pathlib import Path

import pytest

from batchcraft.api import Settings


def test_settings_are_parsed_centrally_from_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BATCHCRAFT_PROJECTS_ROOT", str(tmp_path / "projects"))
    monkeypatch.setenv("BATCHCRAFT_COMFYUI_BASE_URL", "http://comfyui.test:8188")
    monkeypatch.setenv("BATCHCRAFT_HISTORY_TIMEOUT", "12.5")
    monkeypatch.setenv("BATCHCRAFT_SERVER_PORT", "9000")

    settings = Settings.from_env()

    assert settings.projects_root == tmp_path / "projects"
    assert settings.comfyui_base_url == "http://comfyui.test:8188"
    assert settings.execution_config.history_timeout_seconds == 12.5
    assert settings.server_port == 9000


def test_settings_reject_invalid_timing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BATCHCRAFT_HISTORY_TIMEOUT", "0")

    with pytest.raises(ValueError, match="BATCHCRAFT_HISTORY_TIMEOUT must be positive"):
        Settings.from_env()
