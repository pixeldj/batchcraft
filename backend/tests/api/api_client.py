"""Use a valid local Host in API tests without altering production request policy."""

from fastapi.testclient import TestClient
from starlette.types import ASGIApp


class LoopbackTestClient(TestClient):
    def __init__(self, app: ASGIApp, *, raise_server_exceptions: bool = True) -> None:
        super().__init__(
            app,
            base_url="http://127.0.0.1",
            raise_server_exceptions=raise_server_exceptions,
        )
