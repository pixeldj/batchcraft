import hashlib
import importlib
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import pytest

from batchcraft.db import MigrationError, apply_migrations, discover_migrations, open_connection

FIXED_TIME = datetime(2026, 8, 28, 12, 30, tzinfo=UTC)


def test_initial_migration_creates_schema_and_history(tmp_path: Path) -> None:
    connection = open_connection(tmp_path / "batchcraft.sqlite3")
    try:
        apply_migrations(connection, clock=lambda: FIXED_TIME)

        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_schema WHERE type = 'table'"
            ).fetchall()
        }
        assert {"schema_migration", "project", "prompt", "prompt_version"} <= tables

        migration_path = (
            Path(__file__).parents[2]
            / "src"
            / "batchcraft"
            / "db"
            / "migrations"
            / "0001_initial.sql"
        )
        assert connection.execute(
            "SELECT version, name, checksum, applied_at FROM schema_migration"
        ).fetchone() == (
            1,
            "initial",
            hashlib.sha256(migration_path.read_bytes()).hexdigest(),
            "2026-08-28T12:30:00.000000Z",
        )

        apply_migrations(connection, clock=lambda: pytest.fail("no migration should run"))
        assert connection.execute("SELECT count(*) FROM schema_migration").fetchone() == (1,)
    finally:
        connection.close()


def test_initial_schema_enforces_relationships_constraints_and_immutability(
    tmp_path: Path,
) -> None:
    connection = open_connection(tmp_path / "batchcraft.sqlite3")
    try:
        apply_migrations(connection)
        connection.execute(
            "INSERT INTO project VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("project-1", "project_key", "Project", None, "created", "updated", None),
        )
        connection.execute(
            "INSERT INTO prompt VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("prompt-1", "project-1", "Prompt", None, "created", "updated", None),
        )
        connection.execute(
            "INSERT INTO prompt_version VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("version-1", "prompt-1", 1, "Prompt", "Text", None, "created", None),
        )

        connection.execute(
            "UPDATE prompt_version SET archived_at = 'archived' WHERE id = 'version-1'"
        )
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute("UPDATE prompt_version SET text = 'Changed' WHERE id = 'version-1'")
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            connection.execute(
                """
                INSERT INTO prompt_version VALUES
                    ('version-2', 'prompt-1', 1, 'Prompt', 'Text', NULL, 'created', NULL)
                """
            )
        with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
            connection.execute(
                """
                INSERT INTO prompt VALUES
                    ('orphan', 'missing', 'Prompt', NULL, 'created', 'updated', NULL)
                """
            )
    finally:
        connection.close()


def test_changed_checksum_is_rejected(tmp_path: Path) -> None:
    connection = open_connection(tmp_path / "batchcraft.sqlite3")
    try:
        apply_migrations(connection)
        connection.execute("UPDATE schema_migration SET checksum = ?", ("0" * 64,))
        connection.commit()

        with pytest.raises(MigrationError, match="checksum changed"):
            apply_migrations(connection)
    finally:
        connection.close()


def test_concurrent_startup_serializes_migration_application(tmp_path: Path) -> None:
    database_path = tmp_path / "batchcraft.sqlite3"
    barrier = threading.Barrier(2)

    def migrate() -> None:
        barrier.wait()
        connection = open_connection(database_path)
        try:
            apply_migrations(connection)
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        tuple(executor.map(lambda _index: migrate(), range(2)))

    connection = open_connection(database_path)
    try:
        assert connection.execute("SELECT count(*) FROM schema_migration").fetchone() == (1,)
    finally:
        connection.close()


def test_unknown_newer_database_and_history_gap_are_rejected(tmp_path: Path) -> None:
    newer = open_connection(tmp_path / "newer.sqlite3")
    gap = open_connection(tmp_path / "gap.sqlite3")
    try:
        apply_migrations(newer)
        newer.execute("INSERT INTO schema_migration VALUES (2, 'future', ?, 'now')", ("0" * 64,))
        newer.commit()
        with pytest.raises(MigrationError, match="newer than application"):
            apply_migrations(newer)

        gap.execute(
            """
            CREATE TABLE schema_migration (
                version INTEGER, name TEXT, checksum TEXT, applied_at TEXT
            )
            """
        )
        gap.execute("INSERT INTO schema_migration VALUES (2, 'future', ?, 'now')", ("0" * 64,))
        gap.commit()
        with pytest.raises(MigrationError, match="version gap"):
            apply_migrations(gap)
    finally:
        newer.close()
        gap.close()


def test_discovery_rejects_gaps_duplicates_and_malformed_names(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    gap_package = _migration_package(tmp_path, "gap_migrations", {"0002_late.sql": "SELECT 1;"})
    duplicate_package = _migration_package(
        tmp_path,
        "duplicate_migrations",
        {"0001_first.sql": "SELECT 1;", "0001_second.sql": "SELECT 2;"},
    )
    malformed_package = _migration_package(
        tmp_path, "malformed_migrations", {"1_initial.sql": "SELECT 1;"}
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    importlib.invalidate_caches()

    with pytest.raises(MigrationError, match="contiguous from 0001"):
        discover_migrations(gap_package)
    with pytest.raises(MigrationError, match="duplicate migration version"):
        discover_migrations(duplicate_package)
    with pytest.raises(MigrationError, match="malformed SQL migration filename"):
        discover_migrations(malformed_package)


def test_first_migration_failure_rolls_back_schema_and_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    package = _migration_package(
        tmp_path,
        "broken_migrations",
        {
            "0001_broken.sql": """
                CREATE TABLE should_rollback (id INTEGER PRIMARY KEY);
                INSERT INTO table_that_does_not_exist VALUES (1);
            """
        },
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    importlib.invalidate_caches()
    connection = open_connection(tmp_path / "batchcraft.sqlite3")
    try:
        with pytest.raises(MigrationError, match="0001_broken failed"):
            apply_migrations(connection, package=package)

        names = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_schema WHERE type = 'table'"
            ).fetchall()
        }
        assert "should_rollback" not in names
        assert "schema_migration" not in names
    finally:
        connection.close()


def test_migration_transaction_control_is_rejected_without_partial_schema(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    package = _migration_package(
        tmp_path,
        "committing_migrations",
        {
            "0001_committing.sql": """
                CREATE TABLE should_rollback (id INTEGER PRIMARY KEY);
                COMMIT;
                CREATE TABLE must_not_exist (id INTEGER PRIMARY KEY);
            """
        },
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    importlib.invalidate_caches()
    connection = open_connection(tmp_path / "batchcraft.sqlite3")
    try:
        with pytest.raises(MigrationError, match="not authorized"):
            apply_migrations(connection, package=package)

        names = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_schema WHERE type = 'table'"
            ).fetchall()
        }
        assert "should_rollback" not in names
        assert "must_not_exist" not in names
        assert "schema_migration" not in names
    finally:
        connection.close()


def _migration_package(tmp_path: Path, name: str, files: dict[str, str]) -> str:
    package = tmp_path / name
    package.mkdir()
    (package / "__init__.py").write_text("")
    for filename, content in files.items():
        (package / filename).write_text(content)
    return name
