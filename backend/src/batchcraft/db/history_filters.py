"""Strict, canonical query intent, independent of SQL and mutable libraries."""

import json
import math
from typing import Any

from batchcraft.db.connection import _history_timestamp_us
from batchcraft.domain.image_slots import validate_stable_key


class HistoryQueryError(ValueError):
    """A history query or continuation cursor is invalid."""


class HistoryReindexRequiredError(HistoryQueryError):
    """Advanced history requires a completed enriched projection."""


def parse_filters(raw: str | None) -> dict[str, Any]:
    if raw is None:
        return {}
    try:
        if not isinstance(raw, str) or len(raw) > 16384:
            raise ValueError
        raw.encode("utf-8")
        data = json.loads(raw, object_pairs_hook=_unique_object)
        ids = {
            "prompt_id",
            "prompt_version_id",
            "workflow_version_id",
            "profile_version_id",
            "saved_batch_id",
            "asset_id",
        }
        if not isinstance(data, dict) or set(data) - ids - {
            "seed",
            "created_from",
            "created_before",
            "parameters",
            "image_inputs",
        }:
            raise ValueError
        for key in ids & data.keys():
            if not isinstance(data[key], str) or not data[key]:
                raise ValueError
        if "seed" in data and (type(data["seed"]) is not int or not 0 <= data["seed"] <= 2**53 - 1):
            raise ValueError
        for key in ("created_from", "created_before"):
            if key in data:
                timestamp = _history_timestamp_us(data[key])
                if timestamp is None:
                    raise ValueError
                data[key] = timestamp
        if (
            "created_from" in data
            and "created_before" in data
            and data["created_from"] >= data["created_before"]
        ):
            raise ValueError
        for key, maximum in (("parameters", 8), ("image_inputs", 4)):
            if key not in data:
                continue
            if not isinstance(data[key], list) or len(data[key]) > maximum:
                raise ValueError
            for item in data[key]:
                if not isinstance(item, dict):
                    raise ValueError
                if key == "parameters":
                    if set(item) not in (
                        {"key", "value_type", "mode"},
                        {"key", "value_type", "mode", "value"},
                    ):
                        raise ValueError
                    validate_stable_key(item["key"])
                    kind, mode = item["value_type"], item["mode"]
                    if kind not in ("string", "integer", "float", "boolean") or mode not in (
                        "equals",
                        "base",
                        "override",
                    ):
                        raise ValueError
                    if (mode == "equals") != ("value" in item):
                        raise ValueError
                    if mode == "equals":
                        value = item["value"]
                        if kind == "float":
                            if type(value) not in (int, float):
                                raise ValueError
                            value = float(value)
                            if not math.isfinite(value):
                                raise ValueError
                            item["value"] = value
                            continue
                        valid = {
                            "string": isinstance(value, str),
                            "integer": type(value) is int and abs(value) <= 2**53 - 1,
                            "boolean": type(value) is bool,
                        }[kind]
                        if not valid:
                            raise ValueError
                else:
                    if set(item) not in ({"slot_key", "mode"}, {"slot_key", "mode", "asset_id"}):
                        raise ValueError
                    validate_stable_key(item["slot_key"])
                    if item["mode"] not in ("base", "asset") or (item["mode"] == "asset") != (
                        "asset_id" in item
                    ):
                        raise ValueError
                    if "asset_id" in item and (
                        not isinstance(item["asset_id"], str) or not item["asset_id"].strip()
                    ):
                        raise ValueError
            if not data[key]:
                del data[key]
            else:
                data[key] = sorted(data[key], key=lambda item: json.dumps(item, sort_keys=True))
        # Also reject escaped lone surrogates in JSON values.
        json.dumps(data, ensure_ascii=False).encode("utf-8")
        return dict(sorted(data.items()))
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError) as error:
        raise HistoryQueryError("Invalid history filters") from error


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def filter_sql(filters: dict[str, Any], *, results: bool) -> tuple[list[str], list[object]]:
    predicates: list[str] = []
    values: list[object] = []
    for key, operator in (("created_from", ">="), ("created_before", "<")):
        if key in filters:
            predicates.append(f"history_timestamp_us(r.created_at) {operator} ?")
            values.append(filters[key])
    run = []
    for key in ("workflow_version_id", "profile_version_id", "saved_batch_id"):
        if key in filters:
            run.append(f"p.{key} = ?")
            values.append(filters[key])
    if run:
        predicates.append(
            "EXISTS (SELECT 1 FROM historical_run_provenance p WHERE p.project_id = r.project_id AND p.run_id = r.run_id AND "
            + " AND ".join(run)
            + ")"
        )
    job = []
    for key in ("seed", "prompt_version_id"):
        if key in filters:
            job.append(f"j.{key} = ?")
            values.append(filters[key])
    if "prompt_id" in filters:
        job.append(
            "EXISTS (SELECT 1 FROM historical_prompt_snapshot p WHERE p.project_id = j.project_id AND p.run_id = j.run_id AND p.prompt_version_id = j.prompt_version_id AND p.prompt_id = ?)"
        )
        values.append(filters["prompt_id"])
    for item in filters.get("parameters", []):
        condition = "p.parameter_key = ? AND p.value_type = ? AND p.is_base = ?"
        values.extend((item["key"], item["value_type"], int(item["mode"] == "base")))
        if item["mode"] == "equals":
            column = {
                "string": "string_value",
                "integer": "integer_value",
                "float": "real_value",
                "boolean": "boolean_value",
            }[item["value_type"]]
            condition += f" AND p.{column} = ?"
            values.append(item["value"])
        job.append(
            "EXISTS (SELECT 1 FROM historical_parameter_value p WHERE p.project_id = j.project_id AND p.run_id = j.run_id AND p.job_id = j.job_id AND "
            + condition
            + ")"
        )
    for item in filters.get("image_inputs", []):
        condition = "i.slot_key = ? AND i.asset_id " + (
            "IS NULL" if item["mode"] == "base" else "= ?"
        )
        values.append(item["slot_key"])
        if item["mode"] == "asset":
            values.append(item["asset_id"])
        job.append(
            "EXISTS (SELECT 1 FROM historical_image_input i WHERE i.project_id = j.project_id AND i.run_id = j.run_id AND i.job_id = j.job_id AND "
            + condition
            + ")"
        )
    if "asset_id" in filters:
        job.append(
            "EXISTS (SELECT 1 FROM historical_asset_use u WHERE u.project_id = j.project_id AND u.run_id = j.run_id AND u.job_id = j.job_id AND u.asset_id = ?)"
        )
        values.append(filters["asset_id"])
    if job:
        if results:
            job.append("j.job_id = a.job_id")
        predicates.append(
            "EXISTS (SELECT 1 FROM historical_job j WHERE j.project_id = r.project_id AND j.run_id = r.run_id AND "
            + " AND ".join(job)
            + ")"
        )
    return predicates, values
