"""Opt-in BC-007 SQL metadata benchmark; from backend/:

    uv run python tests/db/check_history_browser.py [--repeats 20] [--explain]

Always creates and removes only its own TemporaryDirectory SQLite database. No
Settings, server, Project files, environment database paths, or ComfyUI are used.
Rows follow test_history_query/test_history_provenance and the projection writer;
this measures an already indexed synthetic history, not filesystem reconciliation.
No timing assertions, additional dependencies, thumbnails, or image bytes.
"""

import argparse
import json
import math
import os
import platform
import resource
import sqlite3
import statistics
import sys
from collections.abc import Callable
from contextlib import ExitStack, closing
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from functools import partial
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter
from unittest.mock import patch

from batchcraft.db import (
    apply_migrations,
    history_choices,
    history_diagnostics,
    history_query,
    open_connection,
)
from batchcraft.db.history import HistoricalProjectionStore
from batchcraft.db.history_choices import HistoryChoices, query_choices
from batchcraft.db.history_diagnostics import query_diagnostics
from batchcraft.db.history_query import HistoryPage, HistoryQuery, query_results, query_runs

RUNS, JOBS, ARTIFACTS = 200, 50, 2
PROJECT = "synthetic-project"
GENERATION = "a" * 32
SCANNED_AT = "2026-09-08T12:00:00Z"
TEXT_VALUES = (None, "", "soft", "sharp", "film")


def seed(database: Path) -> None:
    # Keep normal configured WAL/FULL behavior and all shipped indexes. One seed
    # transaction avoids benchmarking one fsync per row. No ANALYZE tuning.
    with closing(open_connection(database)) as connection:
        apply_migrations(connection)
        connection.execute(
            "INSERT INTO project VALUES (?, ?, ?, NULL, ?, ?, NULL)",
            (PROJECT, PROJECT, "Synthetic history", SCANNED_AT, SCANNED_AT),
        )
        connection.execute(
            "INSERT INTO historical_projection_state VALUES (?, ?, ?)",
            (PROJECT, GENERATION, SCANNED_AT),
        )
        connection.execute(
            "INSERT INTO historical_provenance_state VALUES (?, ?)", (PROJECT, GENERATION)
        )
        for batch in range(10):
            connection.execute(
                "INSERT INTO historical_batch VALUES (?, ?, ?, ?, 'verified')",
                (PROJECT, f"batch-{batch}", f"batch-{batch}", f"Batch {batch}"),
            )
        for run in range(RUNS):
            run_id, batch_id = f"run-{run:04d}", f"batch-{run % 10}"
            number = run // 10 + 1
            key = f"{number:03d}-synthetic"
            # Paired timestamps exercise the ascending identity tie-breaker.
            created = (datetime(2026, 1, 1, tzinfo=UTC) + timedelta(minutes=run // 2)).isoformat()
            connection.execute(
                "INSERT INTO historical_run VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    run_id,
                    PROJECT,
                    batch_id,
                    batch_id,
                    f"Batch {run % 10}",
                    number,
                    key,
                    f"Synthetic {run:04d}",
                    "portrait sweep " + "notes " * 40,
                    created,
                    f"batches/{batch_id}/runs/{key}",
                    JOBS,
                    1,
                    "succeeded",
                    created,
                    created,
                    "verified",
                    1,
                ),
            )
            connection.execute(
                "INSERT INTO historical_run_provenance VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    PROJECT,
                    run_id,
                    "workflow-v1",
                    "Workflow",
                    "1",
                    "profile-v1",
                    "Profile",
                    "1",
                    batch_id,
                    f"Batch {run % 10}",
                    "1",
                ),
            )
            connection.execute(
                "INSERT INTO historical_prompt_snapshot VALUES (?, ?, ?, ?, ?, ?)",
                (PROJECT, run_id, "prompt-v1", "prompt", "Portrait", "1"),
            )
            for index in range(JOBS):
                ordinal = index + 1
                job_id = f"{run_id}-job-{ordinal}"
                connection.execute(
                    "INSERT INTO historical_job VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        PROJECT,
                        run_id,
                        job_id,
                        ordinal,
                        "prompt-v1",
                        "A synthetic portrait",
                        "[]",
                        "[]",
                        index,
                        f"{run_id}/{job_id}",
                        "succeeded",
                        f"remote-{job_id}",
                        created,
                        created,
                        None,
                        "[]",
                    ),
                )
                # Three independent dimensions: 5 integers x 2 booleans x 5 text/Base states.
                for position, (parameter, kind, value) in enumerate(
                    (
                        ("number", "integer", index // 10),
                        ("enabled", "boolean", bool((index // 5) % 2)),
                        ("style", "string", TEXT_VALUES[index % 5]),
                    ),
                    1,
                ):
                    connection.execute(
                        "INSERT INTO historical_parameter_value VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            PROJECT,
                            run_id,
                            job_id,
                            parameter,
                            parameter.title(),
                            kind,
                            int(value is None),
                            value if kind == "string" else None,
                            value if kind == "integer" else None,
                            None,
                            value if kind == "boolean" else None,
                        ),
                    )
                    connection.execute(
                        "INSERT INTO historical_resolved_parameter VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (
                            PROJECT,
                            run_id,
                            job_id,
                            position,
                            parameter,
                            parameter.title(),
                            json.dumps(value),
                        ),
                    )
                connection.executemany(
                    "INSERT INTO historical_result VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        (
                            PROJECT,
                            run_id,
                            job_id,
                            ordinal,
                            artifact,
                            "9",
                            "images",
                            f"{job_id}-{artifact}.png",
                            "",
                            "output",
                            f"outputs/{job_id}-{artifact}.png",
                            "image/png",
                            1024 * 1024,
                            f"{run * JOBS * ARTIFACTS + index * ARTIFACTS + artifact:064x}",
                            "verified",
                        )
                        for artifact in range(1, ARTIFACTS + 1)
                    ),
                )
            # Invalid, unindexed Run directories are separate from the valid Runs.
            connection.execute(
                "INSERT INTO historical_diagnostic VALUES (?, ?, 'run', ?, NULL, 'invalid_run', ?)",
                (PROJECT, run + 1, f"broken-{run:04d}", "Synthetic invalid Run"),
            )
        connection.commit()
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert not connection.execute("PRAGMA foreign_key_check").fetchall()
        for table, expected in (
            ("historical_run", RUNS),
            ("historical_job", RUNS * JOBS),
            ("historical_result", RUNS * JOBS * ARTIFACTS),
            ("historical_parameter_value", RUNS * JOBS * 3),
            ("historical_resolved_parameter", RUNS * JOBS * 3),
            ("historical_diagnostic", RUNS),
        ):
            assert connection.execute(f"SELECT count(*) FROM {table}").fetchone() == (expected,)
            print(f"{table}: {expected}")


def verify(database: Path) -> dict[str, HistoryQuery]:
    ordered = sorted(range(RUNS), key=lambda run: (-(run // 2), run))
    query = HistoryQuery(limit=48)
    bookmarks = {"results_first": query}
    seen: list[tuple[str, int, int]] = []
    while True:
        page = query_results(database, PROJECT, query)
        assert page.generation == GENERATION and page.scanned_at == SCANNED_AT
        assert 0 < len(page.items) <= query.limit
        for item in page.items:
            result = item.result
            assert item.run.project_id == PROJECT and item.run.run_id == result.run_id
            assert result.job_id == f"{result.run_id}-job-{result.job_ordinal}"
            seen.append((result.run_id, result.job_ordinal, result.artifact_ordinal))
        if len(seen) >= RUNS * JOBS * ARTIFACTS // 2:
            bookmarks.setdefault("results_middle", query)
        if not page.has_more:
            bookmarks["results_last"] = query
            break
        assert len(seen) < RUNS * JOBS * ARTIFACTS and page.next_cursor is not None
        query = replace(query, cursor=page.next_cursor)
    assert seen == [
        (f"run-{run:04d}", job, artifact)
        for run in ordered
        for job in range(1, JOBS + 1)
        for artifact in range(1, ARTIFACTS + 1)
    ]
    runs: list[str] = []
    query = HistoryQuery(limit=25)
    while True:
        page_runs = query_runs(database, PROJECT, query)
        assert len(page_runs.items) <= 25
        assert all(item.result_count == JOBS * ARTIFACTS for item in page_runs.items)
        runs.extend(item.run.run_id for item in page_runs.items)
        if not page_runs.has_more:
            break
        assert len(runs) < RUNS
        query = replace(query, cursor=page_runs.next_cursor)
    assert runs == [f"run-{run:04d}" for run in ordered]
    basic = HistoryQuery(limit=48, batch_id="batch-3", q="portrait", execution_status="succeeded")
    bookmarks["results_basic_filter"] = basic
    basic_runs = [run for run in ordered if run % 10 == 3]
    assert [item.run.run_id for item in query_runs(database, PROJECT, basic).items] == [
        f"run-{run:04d}" for run in basic_runs
    ]
    assert [
        (item.result.run_id, item.result.job_ordinal, item.result.artifact_ordinal)
        for item in query_results(database, PROJECT, basic).items
    ] == [
        (f"run-{basic_runs[0]:04d}", job, artifact) for job in range(1, 25) for artifact in (1, 2)
    ]

    predicates = [
        {"key": "number", "value_type": "integer", "mode": "equals", "value": 0},
        {"key": "enabled", "value_type": "boolean", "mode": "equals", "value": False},
        {"key": "style", "value_type": "string", "mode": "equals", "value": ""},
    ]
    for label, filters, jobs in (
        ("results_parameters", {"parameters": predicates}, [2]),
        ("results_parameters_seed", {"parameters": predicates, "seed": 1}, [2]),
        ("results_same_job_miss", {"parameters": predicates, "seed": 0}, []),
        (
            "results_base",
            {"parameters": [{"key": "style", "value_type": "string", "mode": "base"}]},
            list(range(1, JOBS + 1, 5)),
        ),
        (
            "results_override",
            {"parameters": [{"key": "style", "value_type": "string", "mode": "override"}]},
            [job for job in range(1, JOBS + 1) if (job - 1) % 5 != 0],
        ),
        (
            "results_wrong_type",
            {
                "parameters": [
                    {"key": "enabled", "value_type": "integer", "mode": "equals", "value": 0}
                ]
            },
            [],
        ),
    ):
        query = HistoryQuery(limit=48, filters=json.dumps(filters))
        bookmarks[label] = query
        # Full unfiltered and selective-filter traversals above/below cover global
        # identities; check broad Base/override values in one complete Run instead
        # of repeating another 20,000-Result walk.
        selected_runs = ordered
        if label in ("results_base", "results_override"):
            selected_runs = ordered[:1]
            query = replace(query, run_id=f"run-{selected_runs[0]:04d}")
        filtered: list[tuple[str, int, int]] = []
        while True:
            page = query_results(database, PROJECT, query)
            assert len(page.items) <= 48
            filtered.extend(
                (item.result.run_id, item.result.job_ordinal, item.result.artifact_ordinal)
                for item in page.items
            )
            if not page.has_more:
                break
            assert len(filtered) < RUNS * len(jobs) * ARTIFACTS
            query = replace(query, cursor=page.next_cursor)
        assert filtered == [
            (f"run-{run:04d}", job, artifact)
            for run in selected_runs
            for job in jobs
            for artifact in (1, 2)
        ]
        run_page = query_runs(database, PROJECT, replace(bookmarks[label], limit=25))
        assert [item.run.run_id for item in run_page.items] == (
            [f"run-{run:04d}" for run in ordered[:25]] if jobs else []
        )

    choices = query_choices(database, PROJECT, "parameter")
    assert choices.generation == GENERATION and not choices.has_more
    assert [(item.value, item.label, item.value_type) for item in choices.items] == [
        ("enabled", "Enabled", "boolean"),
        ("number", "Number", "integer"),
        ("style", "Style", "string"),
    ]
    assert query_choices(database, PROJECT, "parameter", limit=2).has_more
    assert [
        item.value for item in query_choices(database, PROJECT, "parameter", q="STYLE").items
    ] == ["style"]
    assert not query_choices(database, PROJECT, "parameter", q="%").items
    batches = query_choices(database, PROJECT, "batch", limit=7)
    assert batches.has_more and [item.value for item in batches.items] == [
        f"batch-{i}" for i in range(7)
    ]
    assert query_choices(database, PROJECT, "prompt_version").items[0].label == "Portrait v1"
    ordinals: list[int] = []
    cursor = None
    while True:
        diagnostics = query_diagnostics(database, PROJECT, cursor=cursor)
        assert diagnostics.generation == GENERATION and diagnostics.scanned_at == SCANNED_AT
        assert len(diagnostics.items) <= 25
        for diagnostic in diagnostics.items:
            assert diagnostic.name_excerpt == f"broken-{diagnostic.ordinal - 1:04d}"
            assert diagnostic.code == "invalid_run" and diagnostic.entity_id is None
            ordinals.append(diagnostic.ordinal)
        if not diagnostics.has_more:
            break
        assert len(ordinals) < RUNS
        cursor = diagnostics.next_cursor
    assert ordinals == list(range(1, RUNS + 1))
    return bookmarks


def measure[T](
    name: str, operation: Callable[[], HistoryPage[T] | HistoryChoices], repeats: int, explain: bool
) -> None:
    expected = operation()  # Untimed warm-up; fresh connection on every invocation.
    samples = []
    for _ in range(repeats):
        start = perf_counter()
        actual = operation()
        samples.append((perf_counter() - start) * 1000)
        assert actual == expected
    print(
        f"{name:28} rows={len(expected.items):2d} more={str(expected.has_more):5} "
        f"p50={statistics.median(samples):8.3f}ms "
        f"p95={sorted(samples)[math.ceil(repeats * 0.95) - 1]:8.3f}ms"
    )
    if explain:
        statements: list[str] = []
        paths: list[Path] = []

        def traced(path: Path) -> sqlite3.Connection:
            paths.append(path)
            connection = open_connection(path)
            connection.set_trace_callback(statements.append)
            return connection

        with ExitStack() as stack:
            for module in (history_query, history_choices, history_diagnostics):
                stack.enter_context(patch.object(module, "open_connection", traced))
            operation()
        # Explain the actual expanded production page SQL, not a simplified proxy.
        sql = next(
            statement
            for statement in reversed(statements)
            if statement.startswith(("SELECT", "WITH"))
        )
        assert len(paths) == 1
        with closing(open_connection(paths[0])) as connection:
            connection.create_function("history_casefold", 1, str.casefold, deterministic=True)
            for row in connection.execute("EXPLAIN QUERY PLAN " + sql):
                print(f"  {row[3]}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=20)
    parser.add_argument("--explain", action="store_true")
    args = parser.parse_args()
    if args.repeats < 2:
        parser.error("--repeats must be at least 2")
    if not __debug__:
        parser.error("Run without -O: correctness assertions are required")
    start = perf_counter()
    print(f"{platform.platform()} {platform.machine()} logical_cpus={os.cpu_count()}")
    print(
        f"Python {platform.python_version()} SQLite {sqlite3.sqlite_version}; repeats={args.repeats}"
    )
    with TemporaryDirectory(prefix="batchcraft-history-check-") as temporary:
        database = Path(temporary) / "history.sqlite3"
        seed(database)
        print(f"Seed + migrations + integrity checks: {perf_counter() - start:.3f}s")
        print(f"SQLite file: {database.stat().st_size / 1024**2:.2f} MiB")

        def forbidden(*args: object, **kwargs: object) -> None:
            raise AssertionError("History metadata must not read or scan Run files")

        verification_start = perf_counter()
        with ExitStack() as stack:
            for name in (
                "open",
                "read_bytes",
                "read_text",
                "iterdir",
                "stat",
                "lstat",
                "resolve",
                "glob",
                "rglob",
            ):
                stack.enter_context(patch.object(Path, name, forbidden))
            for name in ("list_runs", "list_results", "list_diagnostics"):
                stack.enter_context(patch.object(HistoricalProjectionStore, name, forbidden))
            bookmarks = verify(database)
        print(
            f"Correctness + guarded SQL-only reads: passed ({perf_counter() - verification_start:.3f}s)"
        )
        for name, query in bookmarks.items():
            measure(
                name,
                partial(query_results, database, PROJECT, query),
                args.repeats,
                args.explain,
            )
        measure(
            "runs_newest",
            lambda: query_runs(database, PROJECT, HistoryQuery(limit=25)),
            args.repeats,
            args.explain,
        )
        measure(
            "runs_basic_filter",
            lambda: query_runs(
                database,
                PROJECT,
                HistoryQuery(
                    limit=25, batch_id="batch-3", q="portrait", execution_status="succeeded"
                ),
            ),
            args.repeats,
            args.explain,
        )
        measure(
            "runs_parameters_seed",
            lambda: query_runs(
                database, PROJECT, replace(bookmarks["results_parameters_seed"], limit=25)
            ),
            args.repeats,
            args.explain,
        )
        measure(
            "choices_parameters",
            lambda: query_choices(database, PROJECT, "parameter"),
            args.repeats,
            args.explain,
        )
        measure(
            "choices_parameter_search",
            lambda: query_choices(database, PROJECT, "parameter", q="STYLE"),
            args.repeats,
            args.explain,
        )
        measure(
            "choices_batches",
            lambda: query_choices(database, PROJECT, "batch", limit=7),
            args.repeats,
            args.explain,
        )
        first = query_diagnostics(database, PROJECT)
        measure(
            "diagnostics_first",
            lambda: query_diagnostics(database, PROJECT),
            args.repeats,
            args.explain,
        )
        measure(
            "diagnostics_next",
            lambda: query_diagnostics(database, PROJECT, cursor=first.next_cursor),
            args.repeats,
            args.explain,
        )
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    rss_mib = rss / (1024**2 if sys.platform == "darwin" else 1024)
    print(
        f"Total: {perf_counter() - start:.3f}s; process peak RSS: {rss_mib:.2f} MiB; temporary data removed"
    )
    print(
        "p50=median; p95=nearest rank. Warm OS cache, fresh SQLite connections, sequential reads."
    )
    print(
        "RSS includes imports, seeding and full-identity correctness lists; not per-page/browser memory."
    )
    print(
        "DB query API only: no HTTP/DTO cost, concurrent writes, scans, thumbnails, image network or decode."
    )


if __name__ == "__main__":
    main()
