import pytest

from batchcraft.domain import (
    MAX_SAFE_INTEGER,
    BatchDefinition,
    ImageBinding,
    ImageInputSlot,
    ParameterDecimalRange,
    ParameterRangeIntent,
    ParameterValuesIntent,
    ParameterValueType,
    PromptVersion,
    SeedInput,
    VariableBinding,
    WorkflowParameter,
    compile_batch,
    materialize_parameter_bindings,
)


def _parameter(value_type: ParameterValueType) -> WorkflowParameter:
    return WorkflowParameter("value", "Value", "7", "value", value_type)


def _range(start: str, end: str, step: str, *, include_base: bool = False) -> ParameterRangeIntent:
    return ParameterRangeIntent("value", include_base, ParameterDecimalRange(start, end, step))


@pytest.mark.parametrize(
    ("start", "end", "step", "expected"),
    (
        ("1", "5", "2", (1, 3, 5)),
        ("1", "6", "2", (1, 3, 5)),
        ("5", "1", "-2", (5, 3, 1)),
        ("3", "3", "1", (3,)),
        ("3", "3", "-1", (3,)),
    ),
)
def test_integer_ranges_have_exact_inclusive_step_semantics(
    start: str, end: str, step: str, expected: tuple[int, ...]
) -> None:
    binding = materialize_parameter_bindings(
        (_parameter(ParameterValueType.INTEGER),), (_range(start, end, step),)
    )[0]

    assert binding.values == expected


@pytest.mark.parametrize(
    ("start", "end", "step", "expected"),
    (
        ("0", "1", "0.1", (0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0)),
        ("0", "1", "0.25", (0.0, 0.25, 0.5, 0.75, 1.0)),
        ("0", "1", "0.3", (0.0, 0.3, 0.6, 0.9)),
        ("1", "0", "-0.1", (1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0)),
        ("0.6", "1.2", "0.2", (0.6, 0.8, 1.0, 1.2)),
    ),
)
def test_float_ranges_use_exact_decimal_progression_without_float_addition_artifacts(
    start: str, end: str, step: str, expected: tuple[float, ...]
) -> None:
    binding = materialize_parameter_bindings(
        (_parameter(ParameterValueType.FLOAT),), (_range(start, end, step),)
    )[0]

    assert binding.values == expected
    assert all("00000000000000004" not in str(value) for value in binding.values)


def test_integer_range_example_materializes_20_through_50_by_10() -> None:
    binding = materialize_parameter_bindings(
        (_parameter(ParameterValueType.INTEGER),), (_range("20", "50", "10"),)
    )[0]

    assert binding.values == (20, 30, 40, 50)


def test_range_include_base_prepends_one_null_and_compiles_as_existing_axis() -> None:
    parameter = _parameter(ParameterValueType.INTEGER)
    binding = materialize_parameter_bindings(
        (parameter,), (_range("4", "8", "2", include_base=True),)
    )[0]
    plan = compile_batch(
        BatchDefinition(
            prompt_versions=(PromptVersion("prompt", "Prompt", "text"),),
            variable_bindings=(),
            image_input_slots=(),
            image_bindings=(),
            seeds=SeedInput.fixed(1),
            parameters=(parameter,),
            parameter_bindings=(binding,),
        )
    )

    assert binding.values == (None, 4, 6, 8)
    assert [job.resolved_parameters[0].value for job in plan.jobs] == [None, 4, 6, 8]


@pytest.mark.parametrize(
    ("value_type", "intent", "message"),
    (
        (ParameterValueType.INTEGER, _range("0", "1", "0"), "step must not be zero"),
        (ParameterValueType.INTEGER, _range("0", "2", "-1"), "toward end"),
        (ParameterValueType.INTEGER, _range("2", "0", "1"), "toward end"),
        (ParameterValueType.INTEGER, _range("0", "2", "0.5"), "require integral"),
        (
            ParameterValueType.INTEGER,
            _range(str(MAX_SAFE_INTEGER + 1), str(MAX_SAFE_INTEGER + 1), "1"),
            "integer parameter range values",
        ),
        (ParameterValueType.STRING, _range("0", "1", "1"), "cannot use a range"),
        (ParameterValueType.BOOLEAN, _range("0", "1", "1"), "cannot use a range"),
        (ParameterValueType.FLOAT, _range("1e0", "2", "1"), "simple finite decimal"),
        (
            ParameterValueType.FLOAT,
            _range("0.123456789012345678", "0.123456789012345678", "1"),
            "round-trip",
        ),
    ),
)
def test_invalid_ranges_are_rejected(
    value_type: ParameterValueType, intent: ParameterRangeIntent, message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        materialize_parameter_bindings((_parameter(value_type),), (intent,))


def test_range_limit_is_computed_before_materialization_without_truncation() -> None:
    parameter = _parameter(ParameterValueType.INTEGER)

    accepted = materialize_parameter_bindings((parameter,), (_range("1", "10000", "1"),))[0]
    assert len(accepted.values) == 10_000

    with pytest.raises(
        ValueError,
        match=r"This range produces 10,001 values\. Reduce the range or increase the step\.",
    ):
        materialize_parameter_bindings((parameter,), (_range("0", "10000", "1"),))


@pytest.mark.parametrize("boundary", (-MAX_SAFE_INTEGER, MAX_SAFE_INTEGER))
def test_integer_range_accepts_each_javascript_safe_boundary(boundary: int) -> None:
    binding = materialize_parameter_bindings(
        (_parameter(ParameterValueType.INTEGER),),
        (_range(str(boundary), str(boundary), "1"),),
    )[0]

    assert binding.values == (boundary,)


def test_explicit_values_remain_materialized_unchanged() -> None:
    intent = ParameterValuesIntent("value", (None, 1.5, 2))

    binding = materialize_parameter_bindings((_parameter(ParameterValueType.FLOAT),), (intent,))[0]

    assert binding.values is intent.values


def test_materialized_ranges_use_existing_full_compiler_dimension_order() -> None:
    parameters = (
        WorkflowParameter("cfg", "CFG", "7", "cfg", ParameterValueType.INTEGER),
        WorkflowParameter("steps", "Steps", "7", "steps", ParameterValueType.INTEGER),
        WorkflowParameter("denoise", "Denoise", "7", "denoise", ParameterValueType.FLOAT),
    )
    bindings = materialize_parameter_bindings(
        parameters,
        (
            ParameterRangeIntent("cfg", False, ParameterDecimalRange("4", "6", "2")),
            ParameterValuesIntent("steps", (20, 30)),
            ParameterRangeIntent("denoise", False, ParameterDecimalRange("0.6", "0.8", "0.2")),
        ),
    )
    plan = compile_batch(
        BatchDefinition(
            prompt_versions=(
                PromptVersion("animals", "Animals", "{{animal}}"),
                PromptVersion("fixed", "Fixed", "fixed"),
            ),
            variable_bindings=(VariableBinding("animal", ("cat", "dog")),),
            image_input_slots=(ImageInputSlot("source", "Source", "1", "image"),),
            image_bindings=(ImageBinding("source", (None, "asset")),),
            parameters=parameters,
            parameter_bindings=bindings,
            seeds=SeedInput.explicit((1, 2)),
        )
    )

    expected = [
        (prompt, animal, image, cfg, steps, denoise, seed)
        for prompt, animals in (("animals", ("cat", "dog")), ("fixed", (None,)))
        for animal in animals
        for image in (None, "asset")
        for cfg in (4, 6)
        for steps in (20, 30)
        for denoise in (0.6, 0.8)
        for seed in (1, 2)
    ]
    assert [
        (
            job.prompt_version_id,
            job.resolved_variables[0].value if job.resolved_variables else None,
            job.resolved_image_inputs[0].asset_id,
            job.resolved_parameters[0].value,
            job.resolved_parameters[1].value,
            job.resolved_parameters[2].value,
            job.seed,
        )
        for job in plan.jobs
    ] == expected
