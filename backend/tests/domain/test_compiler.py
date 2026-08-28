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
    VariableBindingMode,
    VariableList,
    compile_batch,
    preview_batch,
)


def variable_list(list_id: str, *values: str) -> VariableList:
    return VariableList(id=list_id, values=values)


def all_binding(placeholder: str, source: VariableList, *selected_values: str) -> VariableBinding:
    return VariableBinding(
        placeholder=placeholder,
        variable_list=source,
        mode=VariableBindingMode.ALL,
        selected_values=selected_values,
    )


def fixed_binding(placeholder: str, source: VariableList, value: str) -> VariableBinding:
    return VariableBinding(
        placeholder=placeholder,
        variable_list=source,
        mode=VariableBindingMode.FIXED,
        fixed_value=value,
    )


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
    animals = variable_list("animals", "cat")
    batch = batch_definition(
        "A {{animal}} in a park.",
        bindings=(fixed_binding("animal", animals, "cat"),),
    )

    plan = compile_batch(batch)

    assert plan.jobs[0].resolved_prompt == "A cat in a park."
    assert [(item.name, item.value) for item in plan.jobs[0].resolved_variables] == [
        ("animal", "cat")
    ]


def test_multiple_variables_form_cartesian_product_in_first_occurrence_order() -> None:
    animals = variable_list("animals", "cat", "dog")
    locations = variable_list("locations", "park", "forest")
    batch = batch_definition(
        "A {{animal}} in a {{location}}.",
        bindings=(
            all_binding("location", locations, "park", "forest"),
            all_binding("animal", animals, "cat", "dog"),
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
    animals = variable_list("animals", "cat", "dog")
    batch = batch_definition(
        "A {{animal}} looking at another {{animal}}.",
        bindings=(all_binding("animal", animals, "cat", "dog"),),
    )

    prompts = [job.resolved_prompt for job in compile_batch(batch).jobs]

    assert prompts == [
        "A cat looking at another cat.",
        "A dog looking at another dog.",
    ]


def test_fixed_binding_produces_one_prompt_dimension_value() -> None:
    lenses = variable_list("lenses", "35mm", "50mm")
    batch = batch_definition(
        "Shot with {{lens}}.",
        bindings=(fixed_binding("lens", lenses, "50mm"),),
        references=("ref-a", "ref-b"),
    )

    plan = compile_batch(batch)

    assert plan.job_count == 2
    assert {job.resolved_prompt for job in plan.jobs} == {"Shot with 50mm."}


def test_all_binding_preserves_user_selection_order() -> None:
    animals = variable_list("animals", "cat", "dog", "bird")
    batch = batch_definition(
        "A {{animal}}.",
        bindings=(all_binding("animal", animals, "bird", "cat"),),
    )

    prompts = [job.resolved_prompt for job in compile_batch(batch).jobs]

    assert prompts == ["A bird.", "A cat."]


def test_undefined_placeholder_fails() -> None:
    with pytest.raises(CompilationError, match="undefined.*'location'"):
        compile_batch(batch_definition("A {{location}}."))


def test_empty_all_selection_fails() -> None:
    animals = variable_list("animals", "cat")
    batch = batch_definition("A {{animal}}.", bindings=(all_binding("animal", animals),))

    with pytest.raises(CompilationError, match="no selected values"):
        compile_batch(batch)


def test_selected_value_must_exist_in_variable_list() -> None:
    animals = variable_list("animals", "cat")
    batch = batch_definition(
        "A {{animal}}.",
        bindings=(all_binding("animal", animals, "dog"),),
    )

    with pytest.raises(CompilationError, match="'dog'.*not in Variable List 'animals'"):
        compile_batch(batch)


def test_unused_binding_produces_warning() -> None:
    animals = variable_list("animals", "cat")
    batch = batch_definition("A fixed prompt.", bindings=(fixed_binding("animal", animals, "cat"),))

    plan = compile_batch(batch)

    assert plan.warnings[0].code is CompilationWarningCode.UNUSED_BINDING
    assert plan.warnings[0].placeholder == "animal"


def test_placeholder_names_are_case_sensitive() -> None:
    animals = variable_list("animals", "cat")
    batch = batch_definition("A {{Animal}}.", bindings=(fixed_binding("animal", animals, "cat"),))

    with pytest.raises(CompilationError, match="undefined.*'Animal'"):
        compile_batch(batch)


def test_documented_dimension_order_and_rightmost_seed_variation() -> None:
    animals = variable_list("animals", "cat", "dog")
    locations = variable_list("locations", "park", "forest")
    batch = batch_definition(
        "{{animal}} {{location}}",
        bindings=(
            all_binding("animal", animals, "cat", "dog"),
            all_binding("location", locations, "park", "forest"),
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
    animals = variable_list("animals", "cat", "dog")
    styles = variable_list("styles", "ink", "oil")
    batch = batch_definition(
        "unused",
        prompt_versions=(
            PromptVersion(id="animals", name="Animals", text="A {{animal}}"),
            PromptVersion(id="styles", name="Styles", text="In {{style}}"),
        ),
        bindings=(
            all_binding("animal", animals, "dog", "cat"),
            all_binding("style", styles, "oil", "ink"),
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
    animals = variable_list("animals", "cat")
    batch = batch_definition(
        "unused",
        prompt_versions=(
            PromptVersion(id="fixed", name="Fixed", text="Fixed"),
            PromptVersion(id="animal", name="Animal", text="{{animal}}"),
        ),
        bindings=(fixed_binding("animal", animals, "cat"),),
    )

    assert compile_batch(batch).warnings == ()


def test_binding_unused_by_all_prompts_warns_once() -> None:
    unused = variable_list("unused", "value")
    batch = batch_definition(
        "unused",
        prompt_versions=(
            PromptVersion(id="one", name="One", text="One"),
            PromptVersion(id="two", name="Two", text="Two"),
        ),
        bindings=(fixed_binding("unused", unused, "value"),),
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


def test_batch_requires_a_reference_selection() -> None:
    with pytest.raises(CompilationError, match="at least one reference"):
        compile_batch(batch_definition("Prompt", references=()))


def test_explicit_seed_order_is_preserved() -> None:
    batch = batch_definition("Prompt", seeds=SeedInput.explicit((9, 2, 7)))

    assert [job.seed for job in compile_batch(batch).jobs] == [9, 2, 7]


def test_job_ordinals_are_one_based_and_contiguous() -> None:
    animals = variable_list("animals", "cat", "dog")
    batch = batch_definition(
        "{{animal}}",
        bindings=(all_binding("animal", animals, "cat", "dog"),),
        references=("ref-1", "ref-2"),
        seeds=SeedInput.explicit((1, 2)),
    )

    plan = compile_batch(batch)

    assert [job.ordinal for job in plan.jobs] == list(range(1, 9))


def test_preview_count_and_warnings_match_compilation() -> None:
    animals = variable_list("animals", "cat", "dog")
    unused = variable_list("unused", "value")
    batch = batch_definition(
        "{{animal}}",
        bindings=(
            all_binding("animal", animals, "cat", "dog"),
            fixed_binding("unused", unused, "value"),
        ),
        references=("ref-1", "ref-2"),
        seeds=SeedInput.explicit((1, 2, 3)),
    )

    plan = compile_batch(batch)
    preview = preview_batch(batch)

    assert preview.job_count == plan.job_count == 12
    assert preview.warnings == plan.warnings


def test_compilation_does_not_mutate_input_objects() -> None:
    animals = variable_list("animals", "cat", "dog")
    batch = batch_definition(
        "{{animal}}",
        bindings=(all_binding("animal", animals, "dog", "cat"),),
        references=("ref-2", "ref-1"),
        seeds=SeedInput.explicit((8, 3)),
    )
    original = copy.deepcopy(batch)

    compile_batch(batch)

    assert batch == original


def test_compiled_jobs_have_no_unresolved_placeholders() -> None:
    animals = variable_list("animals", "cat", "dog")
    batch = batch_definition(
        "A {{animal}}.",
        bindings=(all_binding("animal", animals, "cat", "dog"),),
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
    animals = variable_list("animals", "{{other}}")
    batch = batch_definition(
        "A {{animal}}.",
        bindings=(fixed_binding("animal", animals, "{{other}}"),),
    )

    with pytest.raises(CompilationError, match="still contains placeholders.*'other'"):
        compile_batch(batch)


def test_duplicate_bindings_fail() -> None:
    animals = variable_list("animals", "cat")
    binding = fixed_binding("animal", animals, "cat")
    batch = batch_definition("{{animal}}", bindings=(binding, binding))

    with pytest.raises(CompilationError, match="duplicate binding"):
        compile_batch(batch)


def test_fixed_seed_requires_exactly_one_value() -> None:
    batch = batch_definition("Prompt", seeds=SeedInput(mode=SeedMode.FIXED, values=(1, 2)))

    with pytest.raises(CompilationError, match="exactly one"):
        compile_batch(batch)


def test_explicit_seed_list_cannot_be_empty() -> None:
    batch = batch_definition("Prompt", seeds=SeedInput.explicit(()))

    with pytest.raises(CompilationError, match="at least one seed"):
        compile_batch(batch)
