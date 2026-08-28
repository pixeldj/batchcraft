import re
from itertools import product

from batchcraft.domain.models import (
    BatchDefinition,
    CompilationPreview,
    CompilationWarning,
    CompilationWarningCode,
    CompiledJob,
    CompiledRunPlan,
    ResolvedVariable,
    SeedMode,
    VariableBinding,
    VariableBindingMode,
)

_IDENTIFIER_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_PLACEHOLDER_PATTERN = re.compile(r"{{(.*?)}}", re.DOTALL)


class CompilationError(ValueError):
    """The Batch cannot produce a valid execution plan."""


def _placeholder_names(template: str) -> tuple[str, ...]:
    names: list[str] = []
    previous_end = 0

    for match in _PLACEHOLDER_PATTERN.finditer(template):
        between = template[previous_end : match.start()]
        if "{{" in between or "}}" in between:
            raise CompilationError("prompt contains malformed placeholder delimiters")

        name = match.group(1)
        if _IDENTIFIER_PATTERN.fullmatch(name) is None:
            raise CompilationError(f"prompt contains malformed placeholder: {match.group(0)!r}")
        if name not in names:
            names.append(name)
        previous_end = match.end()

    remaining = template[previous_end:]
    if "{{" in remaining or "}}" in remaining:
        raise CompilationError("prompt contains malformed placeholder delimiters")

    return tuple(names)


def _binding_values(binding: VariableBinding) -> tuple[str, ...]:
    if _IDENTIFIER_PATTERN.fullmatch(binding.placeholder) is None:
        raise CompilationError(f"binding has invalid placeholder name: {binding.placeholder!r}")

    source_values = binding.variable_list.values
    if binding.mode is VariableBindingMode.ALL:
        if binding.fixed_value is not None:
            raise CompilationError(
                f"all binding for {binding.placeholder!r} cannot define fixed_value"
            )
        if not binding.selected_values:
            raise CompilationError(
                f"all binding for {binding.placeholder!r} has no selected values"
            )
        values = binding.selected_values
    elif binding.mode is VariableBindingMode.FIXED:
        if binding.selected_values:
            raise CompilationError(
                f"fixed binding for {binding.placeholder!r} cannot define selected_values"
            )
        if binding.fixed_value is None:
            raise CompilationError(f"fixed binding for {binding.placeholder!r} has no value")
        values = (binding.fixed_value,)
    else:
        raise CompilationError(
            f"binding for {binding.placeholder!r} has unsupported mode: {binding.mode!r}"
        )

    for value in values:
        if value not in source_values:
            raise CompilationError(
                f"value {value!r} for {binding.placeholder!r} is not in Variable List "
                f"{binding.variable_list.id!r}"
            )
    return values


def _seed_values(batch: BatchDefinition) -> tuple[int, ...]:
    if batch.seeds.mode is SeedMode.FIXED:
        if len(batch.seeds.values) != 1:
            raise CompilationError("fixed seed input must contain exactly one seed")
    elif batch.seeds.mode is SeedMode.EXPLICIT:
        if not batch.seeds.values:
            raise CompilationError("explicit seed input must contain at least one seed")
    else:
        raise CompilationError(f"unsupported seed mode: {batch.seeds.mode!r}")
    return batch.seeds.values


def _resolve_prompt(template: str, assignments: dict[str, str]) -> str:
    return _PLACEHOLDER_PATTERN.sub(
        lambda match: assignments[match.group(1)],
        template,
    )


def compile_batch(batch: BatchDefinition) -> CompiledRunPlan:
    if not batch.prompt_versions:
        raise CompilationError("Batch must contain at least one PromptVersion")
    prompt_ids: set[str] = set()
    prompt_placeholders: list[tuple[str, ...]] = []
    for prompt_version in batch.prompt_versions:
        if not prompt_version.id:
            raise CompilationError("PromptVersion ID must not be empty")
        if not prompt_version.name:
            raise CompilationError(f"PromptVersion {prompt_version.id!r} name must not be empty")
        if prompt_version.id in prompt_ids:
            raise CompilationError(f"duplicate PromptVersion ID: {prompt_version.id!r}")
        prompt_ids.add(prompt_version.id)
        prompt_placeholders.append(_placeholder_names(prompt_version.text))

    bindings_by_name: dict[str, VariableBinding] = {}
    binding_values: dict[str, tuple[str, ...]] = {}

    for binding in batch.variable_bindings:
        if binding.placeholder in bindings_by_name:
            raise CompilationError(f"duplicate binding for {binding.placeholder!r}")
        bindings_by_name[binding.placeholder] = binding
        binding_values[binding.placeholder] = _binding_values(binding)

    for prompt_version, placeholder_names in zip(
        batch.prompt_versions, prompt_placeholders, strict=True
    ):
        missing = tuple(name for name in placeholder_names if name not in bindings_by_name)
        if missing:
            names = ", ".join(repr(name) for name in missing)
            raise CompilationError(
                f"PromptVersion {prompt_version.id!r} has undefined placeholder bindings: {names}"
            )

    if not batch.references:
        raise CompilationError("Batch requires at least one reference selection")
    for reference in batch.references:
        if not reference.asset_id:
            raise CompilationError("reference selection has an empty asset ID")

    seeds = _seed_values(batch)
    globally_used_placeholders = {
        name for placeholder_names in prompt_placeholders for name in placeholder_names
    }
    warnings = tuple(
        CompilationWarning(
            code=CompilationWarningCode.UNUSED_BINDING,
            placeholder=binding.placeholder,
            message=f"binding for {binding.placeholder!r} is not used by any PromptVersion",
        )
        for binding in batch.variable_bindings
        if binding.placeholder not in globally_used_placeholders
    )

    jobs: list[CompiledJob] = []

    for prompt_version, placeholder_names in zip(
        batch.prompt_versions, prompt_placeholders, strict=True
    ):
        value_axes = tuple(binding_values[name] for name in placeholder_names)
        for variable_values in product(*value_axes):
            assignments = dict(zip(placeholder_names, variable_values, strict=True))
            resolved_prompt = _resolve_prompt(prompt_version.text, assignments)
            unresolved = _placeholder_names(resolved_prompt)
            if unresolved:
                names = ", ".join(repr(name) for name in unresolved)
                raise CompilationError(f"resolved prompt still contains placeholders: {names}")

            resolved_variables = tuple(
                ResolvedVariable(name=name, value=assignments[name]) for name in placeholder_names
            )
            for reference in batch.references:
                for seed in seeds:
                    jobs.append(
                        CompiledJob(
                            ordinal=len(jobs) + 1,
                            prompt_version_id=prompt_version.id,
                            resolved_prompt=resolved_prompt,
                            resolved_variables=resolved_variables,
                            reference_asset_id=reference.asset_id,
                            seed=seed,
                        )
                    )

    return CompiledRunPlan(
        prompt_versions=batch.prompt_versions,
        jobs=tuple(jobs),
        warnings=warnings,
    )


def preview_batch(batch: BatchDefinition) -> CompilationPreview:
    plan = compile_batch(batch)
    return CompilationPreview(job_count=plan.job_count, warnings=plan.warnings)
