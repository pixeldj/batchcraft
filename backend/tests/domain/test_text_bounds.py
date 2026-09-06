from dataclasses import replace
from unittest.mock import Mock

import pytest
from test_compiler import batch_definition, binding

from batchcraft.domain import (
    CompilationError,
    LinkedParameterRow,
    LinkedParameterSet,
    ParameterBinding,
    ParameterDecimalRange,
    ParameterRangeIntent,
    ParameterValueType,
    PromptVersion,
    SeedInput,
    WorkflowParameter,
    compile_batch,
    count_batch,
    materialize_parameter_bindings,
    parameter_binding_counts,
    preview_batch,
    validate_batch_plan,
    validate_parameter_alternatives,
)


def test_repeated_placeholder_amplification_stops_before_string_or_job_allocation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    batch = batch_definition("{{x}}" * 4096, bindings=(binding("x", "a" * 1024),))
    allocation = Mock(side_effect=AssertionError("must reject before allocation"))
    monkeypatch.setattr("batchcraft.domain.compiler._resolve_prompt", allocation)
    monkeypatch.setattr("batchcraft.domain.compiler.product", allocation)
    monkeypatch.setattr("batchcraft.domain.compiler.CompiledJob", allocation)
    with pytest.raises(CompilationError, match="prompt.*1048576 UTF-8 bytes"):
        compile_batch(batch, max_prompt_bytes=1024 * 1024)
    allocation.assert_not_called()


@pytest.mark.parametrize("value", ["\u00e9", "\U0001f600", '\\n"\t\n', ""])
def test_raw_utf8_accounting_counts_repetitions_and_provenance_not_json_escapes(value: str) -> None:
    batch = batch_definition("[{{x}}{{x}}]", bindings=(binding("x", value),))
    prompt_bytes = len(("[" + value * 2 + "]").encode("utf-8"))
    total_bytes = prompt_bytes + len(value.encode("utf-8"))
    plan = compile_batch(batch, max_prompt_bytes=prompt_bytes, max_resolved_text_bytes=total_bytes)
    assert plan == compile_batch(batch)
    assert preview_batch(batch, max_resolved_text_bytes=total_bytes).job_count == 1
    with pytest.raises(CompilationError, match="resolved prompt"):
        compile_batch(batch, max_prompt_bytes=prompt_bytes - 1)
    with pytest.raises(CompilationError, match="resolved text"):
        compile_batch(batch, max_resolved_text_bytes=total_bytes - 1)


def test_sum_over_jobs_and_prompt_versions_including_independent_and_linked_string_parameters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parameters = tuple(
        WorkflowParameter(key, key, "1", key, ParameterValueType.STRING)
        for key in ("independent", "left", "right")
    )
    batch = batch_definition(
        "",
        prompt_versions=(
            PromptVersion("one", "One", "{{x}}{{x}}"),
            PromptVersion("two", "Two", "literal"),
        ),
        bindings=(binding("x", "", "\u00e9"), binding("unused", "does not count")),
        parameters=parameters,
        parameter_bindings=(ParameterBinding("independent", (None, '\\"')),),
        linked_parameter_sets=(
            LinkedParameterSet(
                "pair",
                "Pair",
                ("left", "right"),
                (
                    LinkedParameterRow(("\U0001f600", "")),
                    LinkedParameterRow(("", "abc")),
                ),
            ),
        ),
        seeds=SeedInput.explicit((8, 3)),
    )
    plan = compile_batch(batch)
    total = sum(
        len(job.resolved_prompt.encode("utf-8"))
        + sum(len(item.value.encode("utf-8")) for item in job.resolved_variables)
        + sum(
            len(item.value.encode("utf-8"))
            for item in job.resolved_parameters
            if isinstance(item.value, str)
        )
        for job in plan.jobs
    )
    assert compile_batch(batch, max_resolved_text_bytes=total) == plan
    assert count_batch(batch).warnings == plan.warnings
    validate_batch_plan(batch, plan)
    allocation = Mock(side_effect=AssertionError("must preflight the complete sum"))
    monkeypatch.setattr("batchcraft.domain.compiler.product", allocation)
    with pytest.raises(CompilationError, match="resolved text"):
        compile_batch(batch, max_resolved_text_bytes=total - 1)
    allocation.assert_not_called()


def test_string_parameters_cannot_bypass_aggregate_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    batch = batch_definition(
        "",
        parameters=(WorkflowParameter("text", "Text", "1", "text", ParameterValueType.STRING),),
        parameter_bindings=(ParameterBinding("text", ("x" * 4096,)),),
        seeds=SeedInput.explicit(tuple(range(10_000))),
    )
    allocation = Mock(side_effect=AssertionError("must reject before Jobs"))
    monkeypatch.setattr("batchcraft.domain.compiler.CompiledJob", allocation)
    with pytest.raises(CompilationError, match="resolved text.*33554432"):
        compile_batch(batch, max_resolved_text_bytes=32 * 1024 * 1024)
    allocation.assert_not_called()


def test_historical_comparison_checks_metadata_and_prompt_length_before_expansion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    batch = batch_definition("{{x}}" * 4096, bindings=(binding("x", "a" * 1024),))
    small = compile_batch(batch_definition("stored prompt"))
    allocation = Mock(side_effect=AssertionError("historical validation must not resolve strings"))
    monkeypatch.setattr("batchcraft.domain.compiler._resolve_prompt", allocation)
    monkeypatch.setattr("batchcraft.domain.compiler.CompiledJob", allocation)
    with monkeypatch.context() as patch:
        patch.setattr("batchcraft.domain.compiler.product", allocation)
        with pytest.raises(CompilationError, match="metadata"):
            validate_batch_plan(batch, small)
    same_metadata = replace(small, prompt_versions=batch.prompt_versions)
    with pytest.raises(CompilationError, match="snapshot prompt"):
        validate_batch_plan(batch, same_metadata)
    allocation.assert_not_called()


def test_historical_chunk_comparison_rejects_equal_length_wrong_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    batch = batch_definition("{{x}}/{{x}}", bindings=(binding("x", "abc"),))
    plan = compile_batch(batch)
    wrong = replace(plan, jobs=(replace(plan.jobs[0], resolved_prompt="abc/abd"),))
    allocation = Mock(side_effect=AssertionError("no resolved string allocation"))
    monkeypatch.setattr("batchcraft.domain.compiler._resolve_prompt", allocation)
    with pytest.raises(CompilationError, match="snapshot prompt"):
        validate_batch_plan(batch, wrong)
    allocation.assert_not_called()


@pytest.mark.parametrize(("value", "different"), [(1, 1.0), (-0.0, 0.0)])
def test_historical_comparison_preserves_exact_numeric_representation(
    value: float, different: float
) -> None:
    batch = batch_definition(
        "",
        parameters=(WorkflowParameter("cfg", "CFG", "1", "cfg", ParameterValueType.FLOAT),),
        parameter_bindings=(ParameterBinding("cfg", (value,)),),
    )
    plan = compile_batch(batch)
    altered = replace(
        plan,
        jobs=(
            replace(
                plan.jobs[0],
                resolved_parameters=(
                    replace(plan.jobs[0].resolved_parameters[0], value=different),
                ),
            ),
        ),
    )
    with pytest.raises(CompilationError, match="does not reconstruct"):
        validate_batch_plan(batch, altered)


def test_count_only_does_not_expand_huge_parameter_cartesian_product(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parameters = tuple(
        WorkflowParameter(f"p{i}", "P", "1", f"p{i}", ParameterValueType.INTEGER) for i in range(8)
    )
    batch = batch_definition(
        "",
        parameters=parameters,
        parameter_bindings=tuple(ParameterBinding(p.key, tuple(range(100))) for p in parameters),
    )
    allocation = Mock(side_effect=AssertionError("counting must not construct Jobs"))
    monkeypatch.setattr("batchcraft.domain.compiler.product", allocation)
    assert count_batch(batch).job_count == 100**8
    allocation.assert_not_called()


def test_all_range_cardinalities_preflight_before_any_numeric_allocation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parameters = tuple(
        WorkflowParameter(key, key, "1", key, ParameterValueType.FLOAT) for key in ("a", "b")
    )
    intents = tuple(
        ParameterRangeIntent(key, False, ParameterDecimalRange("0", "9999", "1"))
        for key in ("a", "b")
    )
    allocation = Mock(side_effect=AssertionError("no generated range values"))
    monkeypatch.setattr("batchcraft.domain.parameter_intents._materialize_range", allocation)
    assert parameter_binding_counts(parameters, intents) == {"a": 10000, "b": 10000}
    with pytest.raises(ValueError, match="maximum of 10000 Jobs"):
        materialize_parameter_bindings(parameters, intents, max_combinations=10_000)
    allocation.assert_not_called()


@pytest.mark.parametrize("values", [(None, False, 0, True, 1, "1", ""), (False, 0.0), (True, 1.0)])
def test_duplicate_membership_keeps_boolean_string_and_numeric_types_distinct(
    values: tuple[object, ...],
) -> None:
    validate_parameter_alternatives(values)


@pytest.mark.parametrize(
    "values", [(1, 1.0), (-0.0, 0), (0.0, -0.0), (False, False), (None, None), ("", "")]
)
def test_duplicate_membership_retains_existing_numeric_and_base_equality(
    values: tuple[object, ...],
) -> None:
    with pytest.raises(ValueError, match="duplicates"):
        validate_parameter_alternatives(values)


def test_duplicate_validation_is_linear() -> None:
    class Number(int):
        comparisons = 0
        __hash__ = int.__hash__

        def __eq__(self, other: object) -> bool:
            Number.comparisons += 1
            return super().__eq__(other)

    validate_parameter_alternatives(tuple(Number(i) for i in range(10_000)))
    assert Number.comparisons < 30_000
    with pytest.raises(ValueError, match="duplicates"):
        validate_parameter_alternatives((Number(1), 1.0))


def test_valid_historical_plan_above_both_default_text_budgets_needs_no_duplicate_strings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    batch = batch_definition(
        "{{x}}" * 1025,
        bindings=(binding("x", "x" * 1024),),
        seeds=SeedInput.explicit(tuple(range(33))),
    )
    plan = compile_batch(batch)
    assert sum(len(job.resolved_prompt) for job in plan.jobs) > 32 * 1024 * 1024
    allocation = Mock(side_effect=AssertionError("no duplicate historical prompt allocation"))
    monkeypatch.setattr("batchcraft.domain.compiler._resolve_prompt", allocation)
    validate_batch_plan(batch, plan)
    allocation.assert_not_called()
