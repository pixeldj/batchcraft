import os
from dataclasses import dataclass
from pathlib import Path

from batchcraft.execution import ExecutionConfig


@dataclass(frozen=True, slots=True)
class Settings:
    projects_root: Path
    comfyui_base_url: str
    comfyui_timeout_seconds: float
    websocket_timeout_seconds: float
    history_timeout_seconds: float
    history_poll_interval_seconds: float
    frontend_origin: str
    server_host: str
    server_port: int
    data_root: Path = Path("data")
    database_path: Path = Path("data/batchcraft.sqlite3")
    max_request_bytes: int = 64 * 1024 * 1024
    max_jobs: int = 10_000

    def __post_init__(self) -> None:
        if type(self.max_request_bytes) is not int or self.max_request_bytes <= 0:
            raise ValueError("max_request_bytes must be a positive integer")
        if type(self.max_jobs) is not int or self.max_jobs <= 0:
            raise ValueError("max_jobs must be a positive integer")

    @classmethod
    def from_env(cls) -> "Settings":
        data_root = Path(os.environ.get("BATCHCRAFT_DATA_ROOT", "data")).expanduser()
        return cls(
            projects_root=Path(
                os.environ.get("BATCHCRAFT_PROJECTS_ROOT", str(data_root / "projects"))
            ).expanduser(),
            comfyui_base_url=os.environ.get("BATCHCRAFT_COMFYUI_BASE_URL", "http://127.0.0.1:8188"),
            comfyui_timeout_seconds=_positive_float("BATCHCRAFT_COMFYUI_TIMEOUT", 30.0),
            websocket_timeout_seconds=_positive_float("BATCHCRAFT_WEBSOCKET_TIMEOUT", 21600.0),
            history_timeout_seconds=_positive_float("BATCHCRAFT_HISTORY_TIMEOUT", 21600.0),
            history_poll_interval_seconds=_positive_float("BATCHCRAFT_HISTORY_POLL_INTERVAL", 1.0),
            frontend_origin=os.environ.get("BATCHCRAFT_FRONTEND_ORIGIN", "http://localhost:5173"),
            server_host=os.environ.get("BATCHCRAFT_SERVER_HOST", "127.0.0.1"),
            server_port=_port("BATCHCRAFT_SERVER_PORT", 8000),
            max_request_bytes=int(os.environ.get("BATCHCRAFT_MAX_REQUEST_BYTES", 64 * 1024 * 1024)),
            max_jobs=_positive_integer("BATCHCRAFT_MAX_JOBS", 10_000),
            data_root=data_root,
            database_path=Path(
                os.environ.get("BATCHCRAFT_DATABASE_PATH", str(data_root / "batchcraft.sqlite3"))
            ).expanduser(),
        )

    @property
    def execution_config(self) -> ExecutionConfig:
        return ExecutionConfig(
            websocket_timeout_seconds=self.websocket_timeout_seconds,
            history_timeout_seconds=self.history_timeout_seconds,
            history_poll_interval_seconds=self.history_poll_interval_seconds,
        )


def _positive_integer(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError as error:
        raise ValueError(f"{name} must be a positive integer") from error
    if value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _positive_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    try:
        value = default if raw is None else float(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be a number") from error
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def _port(name: str, default: int) -> int:
    raw = os.environ.get(name)
    try:
        value = default if raw is None else int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if not 1 <= value <= 65535:
        raise ValueError(f"{name} must be between 1 and 65535")
    return value
