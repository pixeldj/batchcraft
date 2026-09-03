from importlib.metadata import version


def batchcraft_version() -> str:
    return version("batchcraft")
