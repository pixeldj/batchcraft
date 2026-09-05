"""Offline BC-025 artifact checks, not a complete distribution-compliance audit.

Run from the checkout root: uv run --offline --no-sync --directory backend python -m
tools.check_distribution. Requires an existing frontend dist and installed locked
development dependencies. Builds only in a new temporary directory, never installs
the package or reads application data. --backend-only omits the frontend checks.
"""

from __future__ import annotations

import argparse
import subprocess
import tarfile
import tempfile
import tomllib
import zipfile
from email.parser import BytesParser
from pathlib import Path
from typing import Literal

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def check_contents(files: dict[str, bytes], kind: Literal["wheel", "sdist"]) -> None:
    project = tomllib.loads((BACKEND / "pyproject.toml").read_text())["project"]
    license_bytes = (ROOT / "LICENSE").read_bytes()
    require(
        (BACKEND / "LICENSE").read_bytes() == license_bytes, "backend/LICENSE differs from root"
    )
    require(project["license"] == "GPL-3.0-only", "Incorrect project SPDX expression")
    require(project["license-files"] == ["LICENSE"], "license-files must declare LICENSE")
    version = project["version"]
    prefix = f"batchcraft-{version}"
    info = f"batchcraft-{version}.dist-info"
    metadata_path = f"{info}/METADATA" if kind == "wheel" else f"{prefix}/PKG-INFO"
    license_path = f"{info}/licenses/LICENSE" if kind == "wheel" else f"{prefix}/LICENSE"
    require(files.get(license_path) == license_bytes, f"Missing or changed {license_path}")
    require(metadata_path in files, f"Missing {metadata_path}")
    metadata = BytesParser().parsebytes(files[metadata_path])
    require(
        metadata.get_all("License-Expression") == ["GPL-3.0-only"],
        "Incorrect metadata SPDX expression",
    )
    require(metadata.get_all("License-File") == ["LICENSE"], "Incorrect metadata license paths")
    require(metadata["Name"] == "batchcraft" and metadata["Version"] == version, "Wrong identity")
    require(tuple(map(int, metadata["Metadata-Version"].split("."))) >= (2, 4), "Requires PEP 639")
    require(
        len(metadata.get_all("Requires-Dist", [])) == len(project["dependencies"]),
        "Runtime dependencies must remain metadata, not vendored packages",
    )

    # Git ignore rules are not honored by uv_build. Compare every packaged source
    # against non-ignored checkout inputs so ignored data cannot slip into src/.
    candidates = (
        subprocess.check_output(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "backend/src"],
            cwd=ROOT,
        )
        .decode()
        .split("\0")
    )
    sources = {
        name: (ROOT / name).read_bytes() for name in candidates if name and (ROOT / name).is_file()
    }
    for name in sources:
        require(
            Path(name).suffix in {".py", ".sql"} or Path(name).name == "py.typed",
            f"Review new package source type: {name}",
        )
        require(not (ROOT / name).is_symlink(), f"Symlink package source: {name}")
    source_prefix = "" if kind == "wheel" else f"{prefix}/src/"
    expected = {
        source_prefix + name.removeprefix("backend/src/"): content
        for name, content in sources.items()
    }
    expected[license_path] = license_bytes
    if kind == "sdist":
        original = (BACKEND / "pyproject.toml").read_bytes()
        packaged = f"{prefix}/pyproject.toml"
        if f"{packaged}.orig" in files:
            expected[f"{packaged}.orig"] = original
            require(
                tomllib.loads(files[packaged].decode()) == tomllib.loads(original.decode()),
                "Changed sdist pyproject metadata",
            )
            expected[packaged] = files[packaged]
        else:
            expected[packaged] = original
    generated = (
        {metadata_path}
        if kind == "sdist"
        else {
            metadata_path,
            f"{info}/WHEEL",
            f"{info}/RECORD",
            f"{info}/entry_points.txt",
        }
    )
    require(
        set(files) == set(expected) | generated,
        f"Unexpected or missing {kind} members: {sorted(set(files) ^ (set(expected) | generated))}",
    )
    for name, content in expected.items():
        require(files[name] == content, f"Changed packaged bytes: {name}")


def read_package(package: Path) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    if package.suffix == ".whl":
        with zipfile.ZipFile(package) as wheel:
            for entry in wheel.infolist():
                if entry.is_dir():
                    continue
                require(entry.filename not in files, "Duplicate wheel member")
                files[entry.filename] = wheel.read(entry)
    else:
        with tarfile.open(package) as sdist:
            for member in sdist.getmembers():
                if member.isdir():
                    continue
                require(member.isfile(), f"Non-regular sdist member: {member.name}")
                require(member.name not in files, "Duplicate sdist member")
                stream = sdist.extractfile(member)
                require(stream is not None, f"Unreadable sdist member: {member.name}")
                assert stream is not None
                files[member.name] = stream.read()
    return files


def build_packages(directory: Path) -> tuple[Path, Path]:
    subprocess.run(
        ["uv", "build", "--offline", "--no-sources", str(BACKEND), "--out-dir", str(directory)],
        cwd=ROOT,
        check=True,
    )
    wheels, sdists = sorted(directory.glob("*.whl")), sorted(directory.glob("*.tar.gz"))
    require(len(wheels) == len(sdists) == 1, "Expected one wheel and one sdist")
    return wheels[0], sdists[0]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend-only", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="batchcraft-packaging-") as directory:
        wheel, sdist = build_packages(Path(directory))
        check_contents(read_package(wheel), "wheel")
        check_contents(read_package(sdist), "sdist")
    if not args.backend_only:
        subprocess.run(
            ["npm", "run", "check:distribution"],
            cwd=ROOT / "frontend",
            check=True,
        )
    print("Distribution notice checks passed; no application installed or user data accessed.")


if __name__ == "__main__":
    main()
