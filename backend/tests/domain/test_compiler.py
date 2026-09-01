import copy

import pytest

from batchcraft.domain import (
    BatchDefinition,
    CompilationError,
    CompilationWarningCode,
    PromptVersion,
    ReferenceSelection,
    SeedInput,
    SeedMode,
    VariableBinding,
    compile_batch,
    preview_batch,
)


def binding(placeholder: str, *values: str) -> VariableBinding:
    return VariableBinding(placeholder=placeholder, values=values)


def batch_definition(
    template: str,
    *,
    prompt_versions: tuple[PromptVersion, ...] | None = None,
    bindings: tuple[VariableBinding, ...] = (),
    references: tuple[str, ...] = ("ref-1",),
    seeds: SeedInput | None = None,
) -> BatchDefinition:
    return BatchDefinition(
        prompt_versions=prompt_versions
        or (PromptVersion(id="prompt-v1", name="Prompt one", text=template),),
        variable_bindings=bindings,
        references=tuple(ReferenceSelection(asset_id=value) for value in references),
        seeds=seeds or SeedInput.fixed(123),
    )


def test_simple_substitution() -> None:
    batch = batch_definition(
        "A {{animal}} in a park.",
        bindings=(binding("animal", "cat"),),
    )

    plan = compile_batch(batch)

    assert plan.jobs[0].resolved_prompt == "A cat in a park."
    assert [(item.name, item.value) for item in plan.jobs[0].resolved_variables] == [
        ("animal", "cat")
    ]


def test_multiple_variables_form_cartesian_product_in_first_occurrence_order() -> None:
    batch = batch_definition(
        "A {{animal}} in a {{location}}.",
        bindings=(
            binding("location", "park", "forest"),
            binding("animal", "cat", "dog"),
        ),
    )

    prompts = [job.resolved_prompt for job in compile_batch(batch).jobs]

    assert prompts == [
        "A cat in a park.",
        "A cat in a forest.",
        "A dog in a park.",
        "A dog in a forest.",
    ]


def test_repeated_variable_uses_one_value_per_variant() -> None:
    batch = batch_definition(
        "A {{animal}} looking at another {{animal}}.",
        bindings=(binding("animal", "cat", "dog"),),
    )

    prompts = [job.resolved_prompt for job in compile_batch(batch).jobs]

    assert prompts == [
        "A cat looking at another cat.",
        "A dog looking at another dog.",
    ]


def test_one_binding_value_produces_one_prompt_dimension_value() -> None:
    batch = batch_definition(
        "Shot with {{lens}}.",
        bindings=(binding("lens", "50mm"),),
        references=("ref-a", "ref-b"),
    )

    plan = compile_batch(batch)

    assert plan.job_count == 2
    assert {job.resolved_prompt for job in plan.jobs} == {"Shot with 50mm."}


def test_binding_preserves_value_order() -> None:
    batch = batch_definition(
        "A {{animal}}.",
        bindings=(binding("animal", "bird", "cat"),),
    )

    prompts = [job.resolved_prompt for job in compile_batch(batch).jobs]

    assert prompts == ["A bird.", "A cat."]


@pytest.mark.parametrize(
    ("values", "expected_prompts"),
    (
        (("",), ("A  portrait.",)),
        (("", "foo"), ("A  portrait.", "A foo portrait.")),
    ),
)
def test_empty_string_is_a_first_class_ordered_value(
    values: tuple[str, ...], expected_prompts: tuple[str, ...]
) -> None:
    batch = batch_definition(
        "A {{style}} portrait.",
        bindings=(VariableBinding("style", values),),
    )

    assert tuple(job.resolved_prompt for job in compile_batch(batch).jobs) == expected_prompts


def test_undefined_placeholder_fails() -> None:
    with pytest.raises(CompilationError, match="undefined.*'location'"):
        compile_batch(batch_definition("A {{location}}."))


def test_required_binding_with_zero_values_fails() -> None:
    batch = batch_definition("A {{animal}}.", bindings=(binding("animal"),))

    with pytest.raises(CompilationError, match="bindings with no values: 'animal'"):
        compile_batch(batch)


def test_unused_binding_with_zero_values_is_a_warning_not_an_error() -> None:
    plan = compile_batch(batch_definition("A fixed prompt.", bindings=(binding("animal"),)))

    assert plan.job_count == 1
    assert plan.warnings[0].placeholder == "animal"


def test_unused_binding_produces_warning() -> None:
    batch = batch_definition("A fixed prompt.", bindings=(binding("animal", "cat"),))

    plan = compile_batch(batch)

    assert plan.warnings[0].code is CompilationWarningCode.UNUSED_BINDING
    assert plan.warnings[0].placeholder == "animal"


def test_placeholder_names_are_case_sensitive() -> None:
    batch = batch_definition("A {{Animal}}.", bindings=(binding("animal", "cat"),))

    with pytest.raises(CompilationError, match="undefined.*'Animal'"):
        compile_batch(batch)


def test_documented_dimension_order_and_rightmost_seed_variation() -> None:
    batch = batch_definition(
        "{{animal}} {{location}}",
        bindings=(
            binding("animal", "cat", "dog"),
            binding("location", "park", "forest"),
        ),
        references=("ref-b", "ref-a"),
        seeds=SeedInput.explicit((20, 10)),
    )

    actual = [
        (job.resolved_prompt, job.reference_asset_id, job.seed) for job in compile_batch(batch).jobs
    ]

    assert actual == [
        (prompt, reference, seed)
        for prompt in ("cat park", "cat forest", "dog park", "dog forest")
        for reference in ("ref-b", "ref-a")
        for seed in (20, 10)
    ]


def test_prompt_versions_are_outermost_with_prompt_specific_placeholder_axes() -> None:
    batch = batch_definition(
        "unused",
        prompt_versions=(
            PromptVersion(id="animals", name="Animals", text="A {{animal}}"),
            PromptVersion(id="styles", name="Styles", text="In {{style}}"),
        ),
        bindings=(
            binding("animal", "dog", "cat"),
            binding("style", "oil", "ink"),
        ),
        references=("ref-b", "ref-a"),
        seeds=SeedInput.explicit((20, 10)),
    )

    actual = [
        (
            job.ordinal,
            job.prompt_version_id,
            job.resolved_prompt,
            tuple((value.name, value.value) for value in job.resolved_variables),
            job.reference_asset_id,
            job.seed,
        )
        for job in compile_batch(batch).jobs
    ]

    assert actual == [
        (ordinal, prompt_id, prompt, variables, reference, seed)
        for ordinal, (prompt_id, prompt, variables, reference, seed) in enumerate(
            (
                (prompt_id, prompt, variables, reference, seed)
                for prompt_id, prompts in (
                    ("animals", (("A dog", (("animal", "dog"),)), ("A cat", (("animal", "cat"),)))),
                    ("styles", (("In oil", (("style", "oil"),)), ("In ink", (("style", "ink"),)))),
                )
                for prompt, variables in prompts
                for reference in ("ref-b", "ref-a")
                for seed in (20, 10)
            ),
            start=1,
        )
    ]


def test_binding_used_by_any_prompt_does_not_warn() -> None:
    batch = batch_definition(
        "unused",
        prompt_versions=(
            PromptVersion(id="fixed", name="Fixed", text="Fixed"),
            PromptVersion(id="animal", name="Animal", text="{{animal}}"),
        ),
        bindings=(binding("animal", "cat"),),
    )

    assert compile_batch(batch).warnings == ()


def test_binding_unused_by_all_prompts_warns_once() -> None:
    batch = batch_definition(
        "unused",
        prompt_versions=(
            PromptVersion(id="one", name="One", text="One"),
            PromptVersion(id="two", name="Two", text="Two"),
        ),
        bindings=(binding("unused", "value"),),
    )

    assert [warning.placeholder for warning in compile_batch(batch).warnings] == ["unused"]


def test_prompt_versions_cannot_be_empty() -> None:
    batch = batch_definition("unused")

    with pytest.raises(CompilationError, match="at least one PromptVersion"):
        compile_batch(
            BatchDefinition(
                prompt_versions=(),
                variable_bindings=(),
                references=batch.references,
                seeds=batch.seeds,
            )
        )


@pytest.mark.parametrize("prompt_id", ("", "duplicate"))
def test_prompt_version_ids_must_be_nonempty_and_unique(prompt_id: str) -> None:
    versions = (
        PromptVersion(id="duplicate", name="One", text="One"),
        PromptVersion(id=prompt_id, name="Two", text="Two"),
    )

    with pytest.raises(CompilationError, match="empty|duplicate PromptVersion ID"):
        compile_batch(batch_definition("unused", prompt_versions=versions))


def test_reference_order_is_preserved() -> None:
    batch = batch_definition("Prompt", references=("ref-3", "ref-1", "ref-2"))

    assert [job.reference_asset_id for job in compile_batch(batch).jobs] == [
        "ref-3",
        "ref-1",
        "ref-2",
    ]


def test_empty_reference_axis_produces_jobs_without_a_reference_asset() -> None:
    plan = compile_batch(
        batch_definition(
            "Prompt",
            references=(),
            seeds=SeedInput.explicit((9, 2, 7)),
        )
    )

    assert plan.job_count == 3
    assert [job.reference_asset_id for job in plan.jobs] == [None, None, None]
    assert [job.seed for job in plan.jobs] == [9, 2, 7]


def test_reference_selection_asset_id_must_not_be_empty() -> None:
    with pytest.raises(CompilationError, match="empty asset ID"):
        compile_batch(batch_definition("Prompt", references=("",)))


def test_explicit_seed_order_is_preserved() -> None:
    batch = batch_definition("Prompt", seeds=SeedInput.explicit((9, 2, 7)))

    assert [job.seed for job in compile_batch(batch).jobs] == [9, 2, 7]


def test_job_ordinals_are_one_based_and_contiguous() -> None:
    batch = batch_definition(
        "{{animal}}",
        bindings=(binding("animal", "cat", "dog"),),
        references=("ref-1", "ref-2"),
        seeds=SeedInput.explicit((1, 2)),
    )

    plan = compile_batch(batch)

    assert [job.ordinal for job in plan.jobs] == list(range(1, 9))


def test_preview_count_and_warnings_match_compilation() -> None:
    batch = batch_definition(
        "{{animal}}",
        bindings=(
            binding("animal", "cat", "dog"),
            binding("unused", "value"),
        ),
        references=("ref-1", "ref-2"),
        seeds=SeedInput.explicit((1, 2, 3)),
    )

    plan = compile_batch(batch)
    preview = preview_batch(batch)

    assert preview.job_count == plan.job_count == 12
    assert preview.warnings == plan.warnings


def test_compilation_rejects_expansion_above_job_limit() -> None:
    batch = batch_definition(
        "{{animal}} in {{place}}",
        bindings=(
            binding("animal", "cat", "dog", "fox"),
            binding("place", "woods", "city", "studio"),
        ),
    )

    with pytest.raises(CompilationError, match="beyond the maximum of 8 Jobs"):
        compile_batch(batch, max_jobs=8)


def test_compilation_does_not_mutate_input_objects() -> None:
    batch = batch_definition(
        "{{animal}}",
        bindings=(binding("animal", "dog", "cat"),),
        references=("ref-2", "ref-1"),
        seeds=SeedInput.explicit((8, 3)),
    )
    original = copy.deepcopy(batch)

    compile_batch(batch)

    assert batch == original


def test_compiled_jobs_have_no_unresolved_placeholders() -> None:
    batch = batch_definition(
        "A {{animal}}.",
        bindings=(binding("animal", "cat", "dog"),),
    )

    plan = compile_batch(batch)

    assert all("{{" not in job.resolved_prompt for job in plan.jobs)
    assert all("}}" not in job.resolved_prompt for job in plan.jobs)


@pytest.mark.parametrize(
    "template",
    ["A {{ animal }}.", "A {{animal}.", "A animal}}.", "A {{animal:random}}."],
)
def test_malformed_placeholders_fail(template: str) -> None:
    with pytest.raises(CompilationError, match="malformed placeholder"):
        compile_batch(batch_definition(template))


def test_variable_value_cannot_introduce_unresolved_placeholder() -> None:
    batch = batch_definition(
        "A {{animal}}.",
        bindings=(binding("animal", "{{other}}"),),
    )

    with pytest.raises(CompilationError, match="still contains placeholders.*'other'"):
        compile_batch(batch)


def test_duplicate_bindings_fail() -> None:
    duplicate = binding("animal", "cat")
    batch = batch_definition("{{animal}}", bindings=(duplicate, duplicate))

    with pytest.raises(CompilationError, match="duplicate binding"):
        compile_batch(batch)


@pytest.mark.parametrize("values", (("cat", "cat"), ("", "")))
def test_duplicate_binding_values_fail_even_when_binding_is_unused(
    values: tuple[str, ...],
) -> None:
    batch = batch_definition(
        "No placeholders",
        bindings=(VariableBinding("animal", values),),
    )

    with pytest.raises(CompilationError, match="contain exact duplicates"):
        compile_batch(batch)


def test_fixed_seed_requires_exactly_one_value() -> None:
    batch = batch_definition("Prompt", seeds=SeedInput(mode=SeedMode.FIXED, values=(1, 2)))

    with pytest.raises(CompilationError, match="exactly one"):
        compile_batch(batch)


def test_explicit_seed_list_cannot_be_empty() -> None:
    batch = batch_definition("Prompt", seeds=SeedInput.explicit(()))

    with pytest.raises(CompilationError, match="at least one seed"):
        compile_batch(batch)
