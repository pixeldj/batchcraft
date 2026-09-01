import re
from itertools import product

from batchcraft.domain.image_slots import validate_image_input_slot_key
from batchcraft.domain.models import (
    BatchDefinition,
    CompilationPreview,
    CompilationWarning,
    CompilationWarningCode,
    CompiledJob,
    CompiledRunPlan,
    ResolvedImageInput,
    ResolvedVariable,
    SeedMode,
    VariableBinding,
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

    if any(not isinstance(value, str) for value in binding.values):
        raise CompilationError(f"binding values for {binding.placeholder!r} must be strings")
    if len(set(binding.values)) != len(binding.values):
        raise CompilationError(
            f"binding values for {binding.placeholder!r} contain exact duplicates"
        )
    return binding.values


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


def compile_batch(batch: BatchDefinition, *, max_jobs: int | None = None) -> CompiledRunPlan:
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
        empty = tuple(name for name in placeholder_names if not binding_values[name])
        if empty:
            names = ", ".join(repr(name) for name in empty)
            raise CompilationError(
                f"PromptVersion {prompt_version.id!r} has bindings with no values: {names}"
            )

    slot_keys: list[str] = []
    for slot in batch.image_input_slots:
        try:
            validate_image_input_slot_key(slot.key)
        except ValueError as error:
            raise CompilationError(str(error)) from error
        if slot.key in slot_keys:
            raise CompilationError(f"duplicate image input slot key: {slot.key!r}")
        if not slot.label.strip() or not slot.node_id or not slot.input_name:
            raise CompilationError(f"image input slot {slot.key!r} has incomplete metadata")
        slot_keys.append(slot.key)

    bindings_by_slot: dict[str, tuple[str | None, ...]] = {}
    for image_binding in batch.image_bindings:
        try:
            validate_image_input_slot_key(image_binding.slot_key)
        except ValueError as error:
            raise CompilationError(str(error)) from error
        if image_binding.slot_key in bindings_by_slot:
            raise CompilationError(f"duplicate image binding for slot {image_binding.slot_key!r}")
        if not image_binding.values:
            raise CompilationError(
                f"image binding for slot {image_binding.slot_key!r} must contain at least one value"
            )
        if any(
            asset_id is not None and (not isinstance(asset_id, str) or not asset_id.strip())
            for asset_id in image_binding.values
        ):
            raise CompilationError(
                f"image binding for slot {image_binding.slot_key!r} has a blank asset ID"
            )
        if len(set(image_binding.values)) != len(image_binding.values):
            raise CompilationError(
                f"image binding for slot {image_binding.slot_key!r} contains exact duplicates"
            )
        if None in image_binding.values and image_binding.values[0] is not None:
            raise CompilationError(
                f"image binding for slot {image_binding.slot_key!r} must place Base workflow first"
            )
        bindings_by_slot[image_binding.slot_key] = image_binding.values
    unknown_slots = set(bindings_by_slot) - set(slot_keys)
    missing_slots = set(slot_keys) - set(bindings_by_slot)
    if unknown_slots:
        raise CompilationError(
            f"image bindings contain unknown slots: {', '.join(sorted(unknown_slots))}"
        )
    if missing_slots:
        raise CompilationError(
            f"image bindings are missing slots: {', '.join(sorted(missing_slots))}"
        )
    image_axes = tuple(bindings_by_slot[key] for key in slot_keys)

    seeds = _seed_values(batch)
    if max_jobs is not None:
        if max_jobs < 0:
            raise CompilationError("maximum Job count must not be negative")
        expected_jobs = 0
        for placeholder_names in prompt_placeholders:
            prompt_jobs = len(seeds)
            remaining_jobs = max_jobs - expected_jobs
            if prompt_jobs > remaining_jobs:
                raise CompilationError(f"Batch expands beyond the maximum of {max_jobs} Jobs")
            for name in placeholder_names:
                value_count = len(binding_values[name])
                if prompt_jobs > remaining_jobs // value_count:
                    raise CompilationError(f"Batch expands beyond the maximum of {max_jobs} Jobs")
                prompt_jobs *= value_count
            for image_axis in image_axes:
                if prompt_jobs > remaining_jobs // len(image_axis):
                    raise CompilationError(f"Batch expands beyond the maximum of {max_jobs} Jobs")
                prompt_jobs *= len(image_axis)
            expected_jobs += prompt_jobs

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
            for image_values in product(*image_axes):
                resolved_image_inputs = tuple(
                    ResolvedImageInput(slot_key=key, asset_id=asset_id)
                    for key, asset_id in zip(slot_keys, image_values, strict=True)
                )
                for seed in seeds:
                    jobs.append(
                        CompiledJob(
                            ordinal=len(jobs) + 1,
                            prompt_version_id=prompt_version.id,
                            resolved_prompt=resolved_prompt,
                            resolved_variables=resolved_variables,
                            resolved_image_inputs=resolved_image_inputs,
                            seed=seed,
                        )
                    )

    return CompiledRunPlan(
        prompt_versions=batch.prompt_versions,
        image_input_slots=batch.image_input_slots,
        jobs=tuple(jobs),
        warnings=warnings,
    )


def preview_batch(batch: BatchDefinition) -> CompilationPreview:
    plan = compile_batch(batch)
    return CompilationPreview(job_count=plan.job_count, warnings=plan.warnings)
