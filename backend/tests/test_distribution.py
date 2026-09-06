from pathlib import Path
from typing import Literal

import pytest

from tools import check_distribution
from tools.check_distribution import build_packages, check_contents, read_package


@pytest.fixture(scope="module")
def packages(tmp_path_factory: pytest.TempPathFactory) -> dict[str, dict[str, bytes]]:
    wheel, sdist = build_packages(tmp_path_factory.mktemp("distribution"))
    return {"wheel": read_package(wheel), "sdist": read_package(sdist)}


@pytest.mark.parametrize("kind", ["wheel", "sdist"])
def test_actual_package_licenses_and_inputs(
    packages: dict[str, dict[str, bytes]], kind: Literal["wheel", "sdist"]
) -> None:
    check_contents(packages[kind], kind)


@pytest.mark.parametrize("kind", ["wheel", "sdist"])
@pytest.mark.parametrize("damage", ["missing", "truncated", "spdx", "path", "private"])
def test_package_check_rejects_damaged_notices_and_private_data(
    packages: dict[str, dict[str, bytes]], kind: Literal["wheel", "sdist"], damage: str
) -> None:
    files = packages[kind].copy()
    license_path = next(name for name in files if Path(name).name == "LICENSE")
    metadata_path = next(name for name in files if Path(name).name in {"METADATA", "PKG-INFO"})
    if damage == "missing":
        del files[license_path]
    elif damage == "truncated":
        files[license_path] = b"GNU GENERAL PUBLIC LICENSE"
    elif damage == "spdx":
        files[metadata_path] = files[metadata_path].replace(b"GPL-3.0-only", b"GPL-3.0-or-later")
    elif damage == "path":
        files[metadata_path] = files[metadata_path].replace(
            b"License-File: LICENSE", b"License-File: ../LICENSE"
        )
    else:
        files["batchcraft/private.sqlite3"] = b"synthetic private data"
    with pytest.raises(ValueError):
        check_contents(files, kind)


def test_backend_license_copy_cannot_drift(
    packages: dict[str, dict[str, bytes]], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "LICENSE").write_bytes(b"different canonical license")
    monkeypatch.setattr(check_distribution, "ROOT", tmp_path)
    with pytest.raises(ValueError, match="backend/LICENSE differs from root"):
        check_contents(packages["wheel"], "wheel")
