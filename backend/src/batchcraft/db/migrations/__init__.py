import hashlib
import re
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib import resources
from importlib.resources.abc import Traversable

MIGRATION_FILENAME = re.compile(r"(?P<version>\d{4})_(?P<name>[a-z][a-z0-9_]*)\.sql")
MIGRATION_PACKAGE = "batchcraft.db.migrations"


class MigrationError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class Migration:
    version: int
    name: str
    checksum: str
    sql: bytes


def discover_migrations(package: str = MIGRATION_PACKAGE) -> tuple[Migration, ...]:
    root = resources.files(package)
    migrations: list[Migration] = []
    versions: set[int] = set()

    for resource in sorted(root.iterdir(), key=lambda item: item.name):
        if not resource.is_file() or not resource.name.lower().endswith(".sql"):
            continue
        match = MIGRATION_FILENAME.fullmatch(resource.name)
        if match is None:
            raise MigrationError(f"malformed SQL migration filename: {resource.name}")

        version = int(match.group("version"))
        if version in versions:
            raise MigrationError(f"duplicate migration version: {version:04d}")
        versions.add(version)
        migrations.append(_read_migration(resource, version, match.group("name")))

    if not migrations:
        raise MigrationError("no SQL migrations found")

    migrations.sort(key=lambda migration: migration.version)
    actual_versions = [migration.version for migration in migrations]
    expected_versions = list(range(1, len(migrations) + 1))
    if actual_versions != expected_versions:
        raise MigrationError(
            "migration versions must be contiguous from 0001: "
            + ", ".join(f"{version:04d}" for version in actual_versions)
        )
    return tuple(migrations)


def apply_migrations(
    connection: sqlite3.Connection,
    *,
    package: str = MIGRATION_PACKAGE,
    clock: Callable[[], datetime] | None = None,
) -> None:
    migrations = discover_migrations(package)
    if connection.in_transaction:
        raise MigrationError("cannot apply migrations inside an existing transaction")

    now = clock or (lambda: datetime.now(UTC))
    connection.execute("BEGIN IMMEDIATE")
    try:
        _create_history_table(connection)
        applied = _read_history(connection)
        _validate_history(applied, migrations)

        for migration in migrations[len(applied) :]:
            _execute_migration(connection, migration)
            connection.execute(
                """
                INSERT INTO schema_migration (version, name, checksum, applied_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    migration.version,
                    migration.name,
                    migration.checksum,
                    _timestamp(now()),
                ),
            )
        connection.commit()
    except BaseException as error:
        connection.rollback()
        if isinstance(error, MigrationError):
            raise
        if isinstance(error, sqlite3.Error):
            raise MigrationError(f"failed to apply database migrations: {error}") from error
        raise


def _read_migration(resource: Traversable, version: int, name: str) -> Migration:
    sql = resource.read_bytes()
    return Migration(
        version=version,
        name=name,
        checksum=hashlib.sha256(sql).hexdigest(),
        sql=sql,
    )


def _create_history_table(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migration (
            version INTEGER PRIMARY KEY CHECK (version >= 1),
            name TEXT NOT NULL CHECK (length(trim(name)) > 0),
            checksum TEXT NOT NULL CHECK (
                length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'
            ),
            applied_at TEXT NOT NULL CHECK (length(trim(applied_at)) > 0)
        ) STRICT
        """
    )


def _read_history(connection: sqlite3.Connection) -> list[tuple[int, str, str]]:
    rows = connection.execute(
        "SELECT version, name, checksum FROM schema_migration ORDER BY version"
    ).fetchall()
    history: list[tuple[int, str, str]] = []
    for row in rows:
        version, name, checksum = row
        if (
            not isinstance(version, int)
            or not isinstance(name, str)
            or not isinstance(checksum, str)
        ):
            raise MigrationError("schema_migration contains invalid history")
        history.append((version, name, checksum))
    return history


def _validate_history(
    applied: list[tuple[int, str, str]], migrations: tuple[Migration, ...]
) -> None:
    versions = [version for version, _name, _checksum in applied]
    if len(versions) != len(set(versions)):
        raise MigrationError("schema_migration contains duplicate versions")
    if versions != list(range(1, len(versions) + 1)):
        raise MigrationError("schema_migration history has a version gap")
    if versions and versions[-1] > migrations[-1].version:
        raise MigrationError(
            f"database schema version {versions[-1]:04d} is newer than application version "
            f"{migrations[-1].version:04d}"
        )

    for version, name, checksum in applied:
        migration = migrations[version - 1]
        if name != migration.name:
            raise MigrationError(
                f"migration {version:04d} name changed: {name!r} != {migration.name!r}"
            )
        if checksum != migration.checksum:
            raise MigrationError(f"migration {version:04d}_{name} checksum changed")


def _execute_migration(connection: sqlite3.Connection, migration: Migration) -> None:
    try:
        sql = migration.sql.decode("utf-8")
    except UnicodeDecodeError as error:
        raise MigrationError(
            f"migration {migration.version:04d}_{migration.name} is not UTF-8"
        ) from error

    def deny_transaction_control(
        action: int,
        _arg1: str | None,
        _arg2: str | None,
        _database: str | None,
        _trigger: str | None,
    ) -> int:
        if action in {sqlite3.SQLITE_TRANSACTION, sqlite3.SQLITE_SAVEPOINT}:
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    pending = ""
    connection.set_authorizer(deny_transaction_control)
    try:
        for character in sql:
            pending += character
            if character == ";" and sqlite3.complete_statement(pending):
                connection.execute(pending)
                pending = ""
        if pending.strip():
            connection.execute(pending)
    except sqlite3.Error as error:
        raise MigrationError(
            f"migration {migration.version:04d}_{migration.name} failed: {error}"
        ) from error
    finally:
        connection.set_authorizer(None)


def _timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        raise MigrationError("migration clock must return a timezone-aware datetime")
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


__all__ = [
    "Migration",
    "MigrationError",
    "apply_migrations",
    "discover_migrations",
]
