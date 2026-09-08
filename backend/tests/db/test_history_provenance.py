import json
from contextlib import closing
from pathlib import Path
from typing import Any

import pytest

from batchcraft.db import open_connection
from batchcraft.db.history import HistoricalProjectionStore
from batchcraft.db.history_choices import query_choices
from batchcraft.db.history_filters import (
    HistoryQueryError,
    HistoryReindexRequiredError,
    parse_filters,
)
from batchcraft.db.history_query import HistoryQuery, query_results, query_runs

from .test_history_query import GENERATION, _scan, _seed_run
from .test_history_query import database as database


@pytest.mark.parametrize(
    "data",
    [
        {"seed": True},
        {"seed": -1},
        {"seed": 2**53},
        {"wat": 1},
        {"prompt_id": None},
        {"created_from": "bad"},
        {"created_from": "2026-01-02", "created_before": "2026-01-01"},
        {"parameters": [{"key": "x", "value_type": "integer", "mode": "equals", "value": True}]},
        {"parameters": [{"key": "x", "value_type": "boolean", "mode": "equals", "value": 1}]},
        {"parameters": [{"key": "x", "value_type": "string", "mode": "base", "value": ""}]},
        {"parameters": [{"key": "Bad Key", "value_type": "string", "mode": "base"}]},
        {
            "parameters": [
                {"key": "x", "value_type": "float", "mode": "equals", "value": float("inf")}
            ]
        },
        {"image_inputs": [{"slot_key": "x", "mode": "base", "asset_id": "asset"}]},
        {"parameters": [{}] * 9},
        {"image_inputs": [{}] * 5},
    ],
)
def test_strict_filters(data: dict[str, Any]) -> None:
    with pytest.raises(HistoryQueryError):
        parse_filters(json.dumps(data))


def test_canonical_filters() -> None:
    assert parse_filters('{"parameters":[],"image_inputs":[]}') == {}
    assert parse_filters('{"created_from":"2026-01-01T01:00:00+01:00"}') == parse_filters(
        '{"created_from":"2026-01-01T00:00:00Z"}'
    )
    assert parse_filters(json.dumps({"prompt_id": "x" * 1000}))["prompt_id"] == "x" * 1000
    with pytest.raises(HistoryQueryError):
        parse_filters('{"seed":1,"seed":2}')
    with pytest.raises(HistoryQueryError):
        parse_filters(" " * 16385)


def test_same_job_typed_conjunctions_and_choices(database: Path) -> None:
    with closing(open_connection(database)) as connection:
        connection.execute(
            "INSERT INTO historical_provenance_state VALUES (?, ?)", ("project", GENERATION)
        )
        _seed_run(connection, "run")
        for ordinal in (1, 2):
            job = f"run-job-{ordinal}"
            for key, kind, value in (
                ("number", "integer", ordinal),
                ("text", "string", ""),
                ("bool", "boolean", ordinal == 2),
                ("zero", "integer", 0),
                ("one", "string", "1"),
                ("real", "float", 7),
                ("base", "string", None),
            ):
                connection.execute(
                    "INSERT INTO historical_parameter_value VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        "project",
                        "run",
                        job,
                        key,
                        "Frozen " + key,
                        kind,
                        int(value is None),
                        value if kind == "string" else None,
                        value if kind == "integer" else None,
                        value if kind == "float" else None,
                        value if kind == "boolean" else None,
                    ),
                )
            connection.execute(
                "INSERT INTO historical_image_input VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("project", "run", job, 1, "image", "Image", None if ordinal == 1 else "asset"),
            )
            connection.execute(
                "INSERT INTO historical_image_input VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("project", "run", job, 2, "second", "Second", None),
            )
        connection.execute(
            "INSERT INTO historical_asset_use VALUES (?, ?, ?, ?, ?)",
            ("project", "asset", "run", "run-job-2", "image"),
        )
        connection.execute("UPDATE historical_job SET seed = 2 WHERE job_id = 'run-job-2'")
        connection.commit()

    def query(data: dict[str, Any]) -> HistoryQuery:
        return HistoryQuery(filters=json.dumps(data))

    one = {"key": "number", "value_type": "integer", "mode": "equals", "value": 1}
    assert not query_runs(
        database, "project", query({"parameters": [one], "asset_id": "asset"})
    ).items
    assert not query_runs(database, "project", query({"seed": 1, "asset_id": "asset"})).items
    for key, kind, value, expected in (
        ("bool", "boolean", True, {"run-job-2"}),
        ("bool", "integer", 1, set()),
        ("one", "string", "1", {"run-job-1", "run-job-2"}),
        ("one", "integer", 1, set()),
        ("zero", "integer", 0, {"run-job-1", "run-job-2"}),
    ):
        page = query_results(
            database,
            "project",
            query(
                {"parameters": [{"key": key, "value_type": kind, "mode": "equals", "value": value}]}
            ),
        )
        assert {item.result.job_id for item in page.items} == expected
    assert not query_results(
        database,
        "project",
        query(
            {
                "parameters": [one],
                "image_inputs": [{"slot_key": "image", "mode": "asset", "asset_id": "asset"}],
            }
        ),
    ).items
    for kind, key, filter_value in (
        ("string", "text", ""),
        ("boolean", "bool", False),
        ("float", "real", 7.0),
    ):
        filtered = query(
            {
                "parameters": [
                    one,
                    {"key": key, "value_type": kind, "mode": "equals", "value": filter_value},
                ],
                "image_inputs": [
                    {"slot_key": "image", "mode": "base"},
                    {"slot_key": "second", "mode": "base"},
                ],
            }
        )
        assert len(query_runs(database, "project", filtered).items) == 1
        assert {
            item.result.job_id for item in query_results(database, "project", filtered).items
        } == {"run-job-1"}
    for key, mode, matches in (
        ("base", "base", True),
        ("base", "override", False),
        ("missing", "base", False),
    ):
        assert (
            bool(
                query_runs(
                    database,
                    "project",
                    query({"parameters": [{"key": key, "value_type": "string", "mode": mode}]}),
                ).items
            )
            == matches
        )
    choices = query_choices(database, "project", "parameter", limit=2)
    assert choices.generation == GENERATION and choices.has_more and len(choices.items) == 2
    assert query_choices(database, "project", "asset").items[0].value == "asset"
    assert not query_choices(database, "project", "parameter", q="%").items
    assert (
        query_choices(database, "project", "parameter", q="FROZEN real").items[0].value_type
        == "float"
    )
    first = query_results(
        database, "project", HistoryQuery(limit=1, filters=json.dumps({"seed": 1}))
    )
    with pytest.raises(HistoryQueryError):
        query_results(
            database,
            "project",
            HistoryQuery(cursor=first.next_cursor, filters=json.dumps({"seed": 2})),
        )


def test_unready_and_empty_filters(database: Path) -> None:
    with closing(open_connection(database)) as connection:
        _seed_run(connection, "run")
        connection.commit()
    first = query_runs(database, "project", HistoryQuery())
    assert query_runs(database, "project", HistoryQuery(filters="{}")).items == first.items
    for project in ("project", "other"):
        with pytest.raises(HistoryReindexRequiredError):
            query_runs(database, project, HistoryQuery(filters='{"seed":1}'))
        with pytest.raises(HistoryReindexRequiredError):
            query_choices(database, project, "batch")
    HistoricalProjectionStore(database).replace_project(_scan(database), register=False)
    assert not query_runs(database, "project", HistoryQuery(filters='{"seed":1}')).items
    assert not query_choices(database, "project", "batch").items


def test_frozen_ancestry_dates_and_scope(database: Path) -> None:
    long_id = "historical-" + "x" * 1000
    with closing(open_connection(database)) as connection:
        for project in ("project", "other"):
            connection.execute(
                "INSERT INTO historical_provenance_state VALUES (?, ?)", (project, GENERATION)
            )
            _seed_run(connection, project, "2026-09-07T13:00:00.123456+01:00", project_id=project)
            connection.execute(
                "INSERT INTO historical_run_provenance VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    project,
                    project,
                    long_id,
                    "W" * 1000,
                    2,
                    "profile",
                    "Profile",
                    3,
                    "saved",
                    "Saved",
                    4,
                ),
            )
            connection.execute(
                "INSERT INTO historical_prompt_snapshot VALUES (?, ?, ?, ?, ?, ?)",
                (project, project, "prompt", "logical", "Frozen Prompt", 7),
            )
        connection.commit()
    filters = {
        "workflow_version_id": long_id,
        "profile_version_id": "profile",
        "saved_batch_id": "saved",
        "prompt_id": "logical",
        "prompt_version_id": "prompt",
        "created_from": "2026-09-07T12:00:00.123456Z",
        "created_before": "2026-09-07T12:00:00.123457Z",
    }
    page = query_results(database, "project", HistoryQuery(filters=json.dumps(filters)))
    assert len(page.items) == 3 and {item.run.project_id for item in page.items} == {"project"}
    filters["created_before"] = filters.pop("created_from")
    assert not query_runs(database, "project", HistoryQuery(filters=json.dumps(filters))).items
    workflow = query_choices(database, "project", "workflow_version").items[0]
    assert workflow.value == long_id and len(workflow.label) == len(workflow.detail or "") == 256
    assert query_choices(database, "project", "prompt").items[0].value == "logical"
    assert query_choices(database, "project", "prompt_version").items[0].label == "Frozen Prompt v7"
    assert query_choices(database, "project", "saved_batch").items[0].label == "Saved"


@pytest.mark.parametrize("value", [2**53, 10**20])
def test_whole_float_json_values_match_and_bind_identically(database: Path, value: int) -> None:
    def filters(number: int | float, kind: str = "float") -> str:
        return json.dumps(
            {
                "parameters": [
                    {"key": "large", "value_type": kind, "mode": "equals", "value": number}
                ]
            }
        )

    assert parse_filters(filters(value)) == parse_filters(filters(float(value)))
    assert type(parse_filters(filters(value))["parameters"][0]["value"]) is float
    for invalid in (filters(value, "integer"), json.dumps({"seed": value}), filters(True)):
        with pytest.raises(HistoryQueryError):
            parse_filters(invalid)
    with closing(open_connection(database)) as connection:
        connection.execute(
            "INSERT INTO historical_provenance_state VALUES (?, ?)", ("project", GENERATION)
        )
        _seed_run(connection, "run")
        connection.execute(
            "INSERT INTO historical_parameter_value VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "project",
                "run",
                "run-job-1",
                "large",
                "Large",
                "float",
                0,
                None,
                None,
                float(value),
                None,
            ),
        )
        connection.commit()
    first = query_results(database, "project", HistoryQuery(limit=1, filters=filters(value)))
    assert len(first.items) == 1 and first.next_cursor
    second = query_results(
        database, "project", HistoryQuery(cursor=first.next_cursor, filters=filters(float(value)))
    )
    assert len(second.items) == 1


def test_choice_display_search_and_logical_saved_batch(database: Path) -> None:
    with closing(open_connection(database)) as connection:
        connection.execute(
            "INSERT INTO historical_provenance_state VALUES (?, ?)", ("project", GENERATION)
        )
        for revision in (7, 8):
            run_id = f"run-{revision}"
            _seed_run(connection, run_id)
            connection.execute(
                "INSERT INTO historical_run_provenance VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "project",
                    run_id,
                    f"workflow-{revision}",
                    "Landscape",
                    str(revision),
                    f"profile-{revision}",
                    "Profile",
                    str(revision),
                    "saved",
                    "Saved",
                    str(revision),
                ),
            )
            connection.execute(
                "INSERT INTO historical_prompt_snapshot VALUES (?, ?, ?, ?, ?, ?)",
                (
                    "project",
                    run_id,
                    "prompt",
                    "logical",
                    "Stra\u00dfe_%" + "x" * 260,
                    str(revision),
                ),
            )
        connection.commit()
    for q in ("Landscape v7", "v7"):
        choices = query_choices(database, "project", "workflow_version", q=q)
        assert [(item.value, item.label) for item in choices.items] == [
            ("workflow-7", "Landscape v7")
        ]
    assert (
        query_choices(database, "project", "profile_version", q="Profile v7").items[0].value
        == "profile-7"
    )
    prompt = query_choices(database, "project", "prompt_version", q="v7").items[0]
    assert len(prompt.label) == 256 and "v7" not in prompt.label
    assert query_choices(database, "project", "prompt_version", q="STRASSE_%").items
    assert not query_choices(database, "project", "prompt_version", q="STRASSE__%").items
    saved = query_choices(database, "project", "saved_batch").items
    assert [(item.value, item.label) for item in saved] == [("saved", "Saved")]
    assert not query_choices(database, "project", "saved_batch", q="v7").items
    assert (
        len(
            query_runs(
                database, "project", HistoryQuery(filters='{"saved_batch_id":"saved"}')
            ).items
        )
        == 2
    )
