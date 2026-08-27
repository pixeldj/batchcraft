import uvicorn

from .app import create_app
from .config import Settings


def main() -> None:
    settings = Settings.from_env()
    uvicorn.run(
        create_app(settings),
        host=settings.server_host,
        port=settings.server_port,
    )
