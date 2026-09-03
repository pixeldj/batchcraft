import hashlib
import os
import re
import stat
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from batchcraft.execution import ExecutionStateError, ExecutionStateStore, ResultRecord
from batchcraft.files._io import is_safe_filesystem_key
from batchcraft.files.assets import AssetStoreError, ProjectAssetStore
from batchcraft.files.batch_owners import BatchOwnerError, BatchOwnerStore
from batchcraft.files.models import AssetRecord, BatchIdentity, ProjectIdentity, PublishedRun
from batchcraft.files.project_owners import ProjectOwnerError, ProjectOwnerStore
from batchcraft.files.runs import RunFilesystemStore, RunStoreError

_RUN_DIRECTORY = re.compile(r"[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*")
IntegrityStatus = Literal["verified", "missing", "corrupt"]


@dataclass(frozen=True, slots=True)
class HistoryDiagnostic:
    scope: Literal["project", "asset", "batch", "run", "execution", "result"]
    filesystem_key: str | None
    entity_id: str | None
    code: str
    message: str


@dataclass(frozen=True, slots=True)
class ScannedAsset:
    record: AssetRecord
    integrity_status: IntegrityStatus


@dataclass(frozen=True, slots=True)
class ScannedResult:
    record: ResultRecord
    integrity_status: IntegrityStatus


@dataclass(frozen=True, slots=True)
class ScannedRun:
    run: PublishedRun
    execution_available: bool
    execution_status: str | None
    started_at: str | None
    completed_at: str | None
    job_execution: dict[
        str, tuple[str, str | None, str | None, str | None, str | None, tuple[str, ...]]
    ]
    results: tuple[ScannedResult, ...]
    referenced_assets: tuple[ScannedAsset, ...]
    integrity_status: Literal["verified", "degraded"]
    replayable: bool


@dataclass(frozen=True, slots=True)
class ProjectHistoryScan:
    project: ProjectIdentity
    project_path: Path
    batches: tuple[BatchIdentity, ...]
    assets: tuple[ScannedAsset, ...]
    runs: tuple[ScannedRun, ...]
    diagnostics: tuple[HistoryDiagnostic, ...]


class ProjectHistoryScanError(ValueError):
    """A Project cannot be identified safely enough to scan."""


class ProjectHistoryScanner:
    """Read candidate-v1 Project history without changing filesystem data."""

    def __init__(self, projects_root: Path) -> None:
        self.projects_root = projects_root
        self._run_store = RunFilesystemStore(projects_root)

    def scan(self, filesystem_key: str) -> ProjectHistoryScan:
        if not is_safe_filesystem_key(filesystem_key):
            raise ProjectHistoryScanError("Project filesystem key is not path-safe")
        if self.projects_root.is_symlink():
            raise ProjectHistoryScanError("Projects root must not be a symlink")
        project_path = self.projects_root / filesystem_key
        try:
            root = self.projects_root.resolve(strict=True)
            resolved = project_path.resolve(strict=True)
        except OSError as error:
            raise ProjectHistoryScanError("Project directory is missing or unsafe") from error
        if (
            project_path.is_symlink()
            or project_path.parent != self.projects_root
            or resolved.parent != root
        ):
            raise ProjectHistoryScanError(
                "Imported Project must be an immediate, non-symlink directory under Projects root"
            )
        try:
            project = ProjectOwnerStore(self.projects_root).read(filesystem_key)
        except ProjectOwnerError as error:
            raise ProjectHistoryScanError(f"Project owner identity is invalid: {error}") from error

        diagnostics: list[HistoryDiagnostic] = []
        assets = self._scan_assets(project_path, diagnostics)
        batches, runs = self._scan_batches(project_path, diagnostics)
        duplicate_run_ids = _duplicates(item.run.run_id for item in runs)
        if duplicate_run_ids:
            retained: list[ScannedRun] = []
            for item in runs:
                if item.run.run_id not in duplicate_run_ids:
                    retained.append(item)
                    continue
                diagnostics.append(
                    HistoryDiagnostic(
                        "run",
                        item.run.filesystem_key,
                        item.run.run_id,
                        "duplicate_run_id",
                        f"Run ID appears in more than one directory: {item.run.run_id}",
                    )
                )
            runs = retained
        assets_by_id = {item.record.asset_id: item for item in assets}
        for scanned_run in runs:
            for referenced_asset in scanned_run.referenced_assets:
                previous = assets_by_id.get(referenced_asset.record.asset_id)
                if previous is not None and previous.record != referenced_asset.record:
                    diagnostics.append(
                        HistoryDiagnostic(
                            "asset",
                            referenced_asset.record.sha256,
                            referenced_asset.record.asset_id,
                            "conflicting_asset_metadata",
                            "Asset ID has conflicting historical metadata: "
                            f"{referenced_asset.record.asset_id}",
                        )
                    )
                    continue
                if previous is None or previous.integrity_status == "verified":
                    assets_by_id[referenced_asset.record.asset_id] = referenced_asset
        return ProjectHistoryScan(
            project=project,
            project_path=project_path,
            batches=tuple(batches),
            assets=tuple(sorted(assets_by_id.values(), key=lambda item: item.record.asset_id)),
            runs=tuple(runs),
            diagnostics=tuple(diagnostics),
        )

    def _scan_assets(
        self, project_path: Path, diagnostics: list[HistoryDiagnostic]
    ) -> list[ScannedAsset]:
        root = project_path / "assets" / "sha256"
        if not root.exists():
            return []
        if root.is_symlink() or not root.is_dir():
            diagnostics.append(
                HistoryDiagnostic("asset", None, None, "unsafe_asset_root", "Asset root is unsafe")
            )
            return []
        store = ProjectAssetStore(project_path)
        assets: list[ScannedAsset] = []
        seen_ids: set[str] = set()
        for metadata_path in sorted(root.glob("*/*/asset.json")):
            digest = metadata_path.parent.name
            if any(
                path.is_symlink()
                for path in (metadata_path, metadata_path.parent, metadata_path.parent.parent)
            ):
                diagnostics.append(
                    HistoryDiagnostic(
                        "asset", digest, None, "unsafe_asset_path", "Asset path contains a symlink"
                    )
                )
                continue
            try:
                record = store.read_metadata(digest)
                status: IntegrityStatus = "verified"
                try:
                    store.load(digest)
                except AssetStoreError as error:
                    status = "corrupt"
                    diagnostics.append(
                        HistoryDiagnostic(
                            "asset", digest, record.asset_id, "invalid_asset_content", str(error)
                        )
                    )
            except AssetStoreError as error:
                diagnostics.append(
                    HistoryDiagnostic("asset", digest, None, "invalid_asset", str(error))
                )
                continue
            if record.asset_id in seen_ids:
                diagnostics.append(
                    HistoryDiagnostic(
                        "asset",
                        digest,
                        record.asset_id,
                        "duplicate_asset_id",
                        f"Asset ID appears more than once: {record.asset_id}",
                    )
                )
                assets = [item for item in assets if item.record.asset_id != record.asset_id]
                continue
            seen_ids.add(record.asset_id)
            assets.append(ScannedAsset(record, status))
        return assets

    def _scan_batches(
        self, project_path: Path, diagnostics: list[HistoryDiagnostic]
    ) -> tuple[list[BatchIdentity], list[ScannedRun]]:
        batches_root = project_path / "batches"
        if not batches_root.exists():
            return [], []
        if batches_root.is_symlink() or not batches_root.is_dir():
            diagnostics.append(
                HistoryDiagnostic(
                    "batch", None, None, "unsafe_batches_root", "Batches root is unsafe"
                )
            )
            return [], []
        batches: list[BatchIdentity] = []
        runs: list[ScannedRun] = []
        seen_batch_ids: set[str] = set()
        for batch_path in sorted(batches_root.iterdir()):
            if (
                not is_safe_filesystem_key(batch_path.name)
                or batch_path.is_symlink()
                or not batch_path.is_dir()
            ):
                continue
            try:
                batch = BatchOwnerStore(project_path).read(batch_path.name)
            except BatchOwnerError as error:
                diagnostics.append(
                    HistoryDiagnostic(
                        "batch", batch_path.name, None, "invalid_batch_owner", str(error)
                    )
                )
                continue
            if batch.id in seen_batch_ids:
                diagnostics.append(
                    HistoryDiagnostic(
                        "batch",
                        batch.filesystem_key,
                        batch.id,
                        "duplicate_batch_id",
                        f"Batch ID appears more than once: {batch.id}",
                    )
                )
                batches = [item for item in batches if item.id != batch.id]
                runs = [item for item in runs if item.run.batch.id != batch.id]
                continue
            seen_batch_ids.add(batch.id)
            batches.append(batch)
            for run_path in sorted(batch_path.iterdir()):
                if not _RUN_DIRECTORY.fullmatch(run_path.name):
                    continue
                if run_path.is_symlink() or not run_path.is_dir():
                    diagnostics.append(
                        HistoryDiagnostic(
                            "run", run_path.name, None, "unsafe_run_path", "Run path is unsafe"
                        )
                    )
                    continue
                scanned = self._scan_run(project_path, run_path, diagnostics)
                if scanned is not None:
                    runs.append(scanned)
        return batches, runs

    def _scan_run(
        self,
        project_path: Path,
        run_path: Path,
        diagnostics: list[HistoryDiagnostic],
    ) -> ScannedRun | None:
        try:
            run = self._run_store.load_historical_run(run_path)
        except (RunStoreError, OSError, ValueError) as error:
            diagnostics.append(
                HistoryDiagnostic("run", run_path.name, None, "invalid_run", str(error))
            )
            return None

        run_diagnostics: list[HistoryDiagnostic] = []
        replayable = True
        known_assets: dict[str, AssetRecord] = {}
        referenced_assets: dict[str, ScannedAsset] = {}
        store = ProjectAssetStore(project_path)
        for job in run.jobs:
            for image in job.image_inputs:
                asset = image.asset
                if asset is None:
                    continue
                prior = known_assets.get(asset.asset_id)
                if prior is not None and prior != asset:
                    replayable = False
                    run_diagnostics.append(
                        HistoryDiagnostic(
                            "asset",
                            asset.sha256,
                            asset.asset_id,
                            "conflicting_asset_metadata",
                            f"Run contains conflicting metadata for Asset {asset.asset_id}",
                        )
                    )
                    continue
                known_assets[asset.asset_id] = asset
                try:
                    store.validate_record(asset)
                except AssetStoreError as error:
                    replayable = False
                    status: IntegrityStatus = (
                        "missing" if "missing" in str(error).lower() else "corrupt"
                    )
                    referenced_assets[asset.asset_id] = ScannedAsset(asset, status)
                    run_diagnostics.append(
                        HistoryDiagnostic(
                            "asset",
                            asset.sha256,
                            asset.asset_id,
                            "invalid_referenced_asset",
                            str(error),
                        )
                    )
                else:
                    referenced_assets[asset.asset_id] = ScannedAsset(asset, "verified")

        execution_path = run_path / "execution.json"
        execution_available = False
        execution_status = started_at = completed_at = None
        job_execution: dict[
            str, tuple[str, str | None, str | None, str | None, str | None, tuple[str, ...]]
        ] = {}
        results: list[ScannedResult] = []
        if execution_path.exists() or execution_path.is_symlink():
            try:
                state = ExecutionStateStore(run_path).read_historical(run)
                execution_available = True
                execution_status = state.status.value
                started_at = state.started_at
                completed_at = state.completed_at
                for state_job in state.jobs:
                    job_execution[state_job.job_id] = (
                        state_job.status.value,
                        state_job.prompt_id,
                        state_job.started_at,
                        state_job.completed_at,
                        state_job.error,
                        state_job.diagnostics,
                    )
                    for result in state_job.results:
                        integrity, message = _result_integrity(run_path, result)
                        results.append(ScannedResult(result, integrity))
                        if message is not None:
                            run_diagnostics.append(
                                HistoryDiagnostic(
                                    "result",
                                    result.local_path,
                                    f"{result.job_id}:{result.artifact_ordinal}",
                                    f"{integrity}_result",
                                    message,
                                )
                            )
            except ExecutionStateError as error:
                run_diagnostics.append(
                    HistoryDiagnostic(
                        "execution", run.filesystem_key, run.run_id, "invalid_execution", str(error)
                    )
                )

        diagnostics.extend(run_diagnostics)
        return ScannedRun(
            run=run,
            execution_available=execution_available,
            execution_status=execution_status,
            started_at=started_at,
            completed_at=completed_at,
            job_execution=job_execution,
            results=tuple(results),
            referenced_assets=tuple(referenced_assets.values()),
            integrity_status="degraded" if run_diagnostics else "verified",
            replayable=replayable,
        )


def _duplicates(values: Iterable[str]) -> set[str]:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for value in values:
        if value in seen:
            duplicates.add(value)
        seen.add(value)
    return duplicates


def _result_integrity(run_path: Path, result: ResultRecord) -> tuple[IntegrityStatus, str | None]:
    path = run_path / result.local_path
    if path.is_symlink() or not path.exists():
        return "missing", f"Recorded Result is missing or unsafe: {result.local_path}"
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as file:
            if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
                return "corrupt", f"Recorded Result is not a regular file: {result.local_path}"
            digest = hashlib.sha256()
            size = 0
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                size += len(chunk)
                digest.update(chunk)
    except OSError as error:
        return "missing", f"Recorded Result cannot be read: {result.local_path}: {error}"
    if size != result.byte_size or digest.hexdigest() != result.sha256:
        return "corrupt", f"Recorded Result integrity does not match: {result.local_path}"
    return "verified", None
