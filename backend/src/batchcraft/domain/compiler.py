import math
import re
from collections import Counter
from collections.abc import Iterator, Mapping
from itertools import product
from typing import cast

from batchcraft.domain.image_slots import validate_image_input_slot_key, validate_stable_key
from batchcraft.domain.models import (
    MAX_SAFE_INTEGER,
    BatchDefinition,
    CompilationPreview,
    CompilationWarning,
    CompilationWarningCode,
    CompiledJob,
    CompiledRunPlan,
    LinkedParameterRow,
    LinkedParameterSet,
    ParameterScalar,
    ResolvedImageInput,
    ResolvedParameter,
    ResolvedParameterSet,
    ResolvedVariable,
    SeedMode,
    VariableBinding,
    parameter_value_key,
    validate_parameter_alternatives,
    validate_parameter_scalar,
)

_MAX_SAFE_INTEGER = 2**53 - 1

_IDENTIFIER_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_PLACEHOLDER_PATTERN = re.compile(r"{{(.*?)}}", re.DOTALL)


class CompilationError(ValueError):
    """The Batch cannot produce a valid execution plan."""


def extract_placeholder_names(template: str) -> tuple[str, ...]:
    names: list[str] = []
    seen: set[str] = set()
    previous_end = 0

    for match in _PLACEHOLDER_PATTERN.finditer(template):
        between = template[previous_end : match.start()]
        if "{{" in between or "}}" in between:
            raise CompilationError("prompt contains malformed placeholder delimiters")

        name = match.group(1)
        if _IDENTIFIER_PATTERN.fullmatch(name) is None:
            raise CompilationError(f"prompt contains malformed placeholder: {match.group(0)!r}")
        if name not in seen:
            names.append(name)
            seen.add(name)
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
    elif batch.seeds.mode is SeedMode.MATERIALIZED_RANDOM:
        if not batch.seeds.values:
            raise CompilationError("materialized Random seeds must contain at least one seed")
        if batch.seeds.random_seed_count is None or batch.seeds.random_seed_count < 1:
            raise CompilationError("materialized Random seed count must be positive")
    else:
        raise CompilationError(f"unsupported seed mode: {batch.seeds.mode!r}")
    if any(
        isinstance(seed, bool) or not isinstance(seed, int) or seed < 0 or seed > MAX_SAFE_INTEGER
        for seed in batch.seeds.values
    ):
        raise CompilationError(f"seed values must be integers from 0 through {MAX_SAFE_INTEGER}")
    return batch.seeds.values


def _resolve_prompt(template: str, assignments: dict[str, str]) -> str:
    return "".join(_prompt_chunks(template, assignments))


def _prompt_chunks(template: str, assignments: Mapping[str, str]) -> Iterator[str]:
    end = 0
    for match in _PLACEHOLDER_PATTERN.finditer(template):
        yield template[end : match.start()]
        yield assignments[match.group(1)]
        end = match.end()
    yield template[end:]


def _utf8_size(text: str) -> int:
    return sum(
        len(text[index : index + 4096].encode("utf-8")) for index in range(0, len(text), 4096)
    )


def _prompt_matches(template: str, assignments: Mapping[str, str], stored: str) -> bool:
    if sum(map(len, _prompt_chunks(template, assignments))) != len(stored):
        return False
    position = 0
    for chunk in _prompt_chunks(template, assignments):
        if not stored.startswith(chunk, position):
            return False
        position += len(chunk)
    return True


def compile_batch(
    batch: BatchDefinition,
    *,
    max_jobs: int | None = None,
    max_prompt_bytes: int | None = None,
    max_resolved_text_bytes: int | None = None,
) -> CompiledRunPlan:
    """Budget raw UTF-8 prompt + variable values + string parameter values per Job.

    Repeated placeholders count at every occurrence in the prompt; variable provenance
    counts once per used name. Every Job counts again, even when strings are shared.
    JSON escaping, keys, labels, snapshots, Base values and object overhead are excluded.
    None disables each independent budget, for pure callers and historical validation.
    """
    return cast(
        CompiledRunPlan,
        _compile_batch(
            batch,
            max_jobs=max_jobs,
            max_prompt_bytes=max_prompt_bytes,
            max_resolved_text_bytes=max_resolved_text_bytes,
        ),
    )


def count_batch(
    batch: BatchDefinition,
    *,
    max_jobs: int | None = None,
    parameter_counts: Mapping[str, int] | None = None,
    max_prompt_bytes: int | None = None,
    max_resolved_text_bytes: int | None = None,
) -> CompilationPreview:
    """Validate structure/count without resolving prompts or constructing Jobs.

    parameter_counts supplies preflight Range cardinalities for Base stand-ins.
    It does not validate the eventual resolved prompt or generated numeric values.
    """
    return cast(
        CompilationPreview,
        _compile_batch(
            batch,
            max_jobs=max_jobs,
            count_only=True,
            parameter_counts=parameter_counts,
            max_prompt_bytes=max_prompt_bytes,
            max_resolved_text_bytes=max_resolved_text_bytes,
        ),
    )


def validate_batch_plan(batch: BatchDefinition, plan: CompiledRunPlan) -> None:
    """Compare against stored truth without expanding strings or retaining another plan."""
    _compile_batch(batch, max_jobs=plan.job_count, expected_plan=plan)


def _compile_batch(
    batch: BatchDefinition,
    *,
    max_jobs: int | None = None,
    max_prompt_bytes: int | None = None,
    max_resolved_text_bytes: int | None = None,
    count_only: bool = False,
    parameter_counts: Mapping[str, int] | None = None,
    expected_plan: CompiledRunPlan | None = None,
) -> CompiledRunPlan | CompilationPreview:
    if expected_plan is not None and (
        batch.prompt_versions != expected_plan.prompt_versions
        or batch.image_input_slots != expected_plan.image_input_slots
        or batch.parameters != expected_plan.parameters
    ):
        raise CompilationError("Batch snapshot metadata does not match the compiled Run plan")
    for limit in (max_prompt_bytes, max_resolved_text_bytes):
        if limit is not None and (type(limit) is not int or limit < 0):
            raise CompilationError("text byte budgets must be nonnegative integers")
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
        prompt_placeholders.append(extract_placeholder_names(prompt_version.text))

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

    parameter_keys: list[str] = []
    for parameter in batch.parameters:
        try:
            validate_stable_key(parameter.key)
        except ValueError as error:
            raise CompilationError(f"workflow parameter {error}") from error
        if parameter.key in parameter_keys:
            raise CompilationError(f"duplicate workflow parameter key: {parameter.key!r}")
        if not parameter.label.strip() or not parameter.node_id or not parameter.input_name:
            raise CompilationError(f"workflow parameter {parameter.key!r} has incomplete metadata")
        parameter_keys.append(parameter.key)

    parameter_values: dict[str, tuple[str | int | float | bool | None, ...]] = {}
    for parameter_binding in batch.parameter_bindings:
        try:
            validate_stable_key(parameter_binding.parameter_key)
        except ValueError as error:
            raise CompilationError(f"workflow parameter {error}") from error
        if parameter_binding.parameter_key in parameter_values:
            raise CompilationError(
                f"duplicate parameter binding for {parameter_binding.parameter_key!r}"
            )
        try:
            validate_parameter_alternatives(parameter_binding.values)
        except ValueError as error:
            raise CompilationError(
                f"parameter binding for {parameter_binding.parameter_key!r} is invalid: {error}"
            ) from error
        parameter_values[parameter_binding.parameter_key] = parameter_binding.values
    linked_sets_by_key: dict[str, LinkedParameterSet] = {}
    linked_set_by_member: dict[str, LinkedParameterSet] = {}
    for linked_set in batch.linked_parameter_sets:
        try:
            validate_stable_key(linked_set.key)
        except ValueError as error:
            raise CompilationError(f"linked parameter set {error}") from error
        if linked_set.key in linked_sets_by_key:
            raise CompilationError(f"duplicate linked parameter set key: {linked_set.key!r}")
        if not linked_set.label.strip():
            raise CompilationError(
                f"linked parameter set {linked_set.key!r} label must be nonblank"
            )
        if len(linked_set.member_keys) < 2 or len(set(linked_set.member_keys)) != len(
            linked_set.member_keys
        ):
            raise CompilationError(
                f"linked parameter set {linked_set.key!r} must contain at least two unique members"
            )
        unknown_members = set(linked_set.member_keys) - set(parameter_keys)
        if unknown_members:
            raise CompilationError(
                f"linked parameter set {linked_set.key!r} contains unknown parameters: "
                f"{', '.join(sorted(unknown_members))}"
            )
        duplicate_members = set(linked_set.member_keys) & set(linked_set_by_member)
        if duplicate_members:
            raise CompilationError(
                "parameters may belong to at most one linked parameter set: "
                f"{', '.join(sorted(duplicate_members))}"
            )
        if not linked_set.rows:
            raise CompilationError(
                f"linked parameter set {linked_set.key!r} must contain at least one row"
            )
        seen_rows: set[tuple[tuple[type, object], ...]] = set()
        definitions = {parameter.key: parameter for parameter in batch.parameters}
        for row_ordinal, row in enumerate(linked_set.rows, 1):
            if row.label is not None and not row.label.strip():
                raise CompilationError(
                    f"linked parameter set {linked_set.key!r} row {row_ordinal} label must be nonblank"
                )
            if len(row.values) != len(linked_set.member_keys):
                raise CompilationError(
                    f"linked parameter set {linked_set.key!r} row {row_ordinal} must define every member"
                )
            for member_key, value in zip(linked_set.member_keys, row.values, strict=True):
                _validate_parameter_value(
                    member_key, definitions[member_key].value_type.value, value
                )
            row_key = tuple(parameter_value_key(value) for value in row.values)
            if row_key in seen_rows:
                raise CompilationError(
                    f"linked parameter set {linked_set.key!r} contains duplicate row tuples"
                )
            seen_rows.add(row_key)
        linked_sets_by_key[linked_set.key] = linked_set
        linked_set_by_member.update({key: linked_set for key in linked_set.member_keys})

    unknown_parameters = set(parameter_values) - set(parameter_keys)
    overlap = set(parameter_values) & set(linked_set_by_member)
    missing_parameters = set(parameter_keys) - set(parameter_values) - set(linked_set_by_member)
    if unknown_parameters:
        raise CompilationError(
            f"parameter bindings contain unknown parameters: {', '.join(sorted(unknown_parameters))}"
        )
    if overlap:
        raise CompilationError(
            f"linked parameters must not have independent bindings: {', '.join(sorted(overlap))}"
        )
    if missing_parameters:
        raise CompilationError(
            f"parameter bindings are missing parameters: {', '.join(sorted(missing_parameters))}"
        )
    for parameter in batch.parameters:
        if parameter.key in parameter_values:
            for value in parameter_values[parameter.key]:
                _validate_parameter_value(parameter.key, parameter.value_type.value, value)
    parameter_axes: list[tuple[object, ...]] = []
    parameter_axis_sets: list[LinkedParameterSet | None] = []
    parameter_axis_keys: list[str | None] = []
    emitted_sets: set[str] = set()
    for parameter in batch.parameters:
        axis_linked_set = linked_set_by_member.get(parameter.key)
        if axis_linked_set is None:
            parameter_axes.append(parameter_values[parameter.key])
            parameter_axis_sets.append(None)
            parameter_axis_keys.append(parameter.key)
        elif axis_linked_set.key not in emitted_sets:
            parameter_axes.append(axis_linked_set.rows)
            parameter_axis_sets.append(axis_linked_set)
            parameter_axis_keys.append(None)
            emitted_sets.add(axis_linked_set.key)

    seeds = _seed_values(batch)
    if parameter_counts is not None and any(
        key not in parameter_values or type(size) is not int or size < 1
        for key, size in parameter_counts.items()
    ):
        raise CompilationError(
            "parameter preflight counts must be positive integers for independent bindings"
        )
    axis_counts = tuple(
        parameter_counts[key]
        if parameter_counts is not None and key is not None and key in parameter_counts
        else len(axis)
        for key, axis in zip(parameter_axis_keys, parameter_axes, strict=True)
    )
    seed_axis_count = (
        batch.seeds.random_seed_count
        if batch.seeds.mode is SeedMode.MATERIALIZED_RANDOM
        else len(seeds)
    )
    assert seed_axis_count is not None
    if max_jobs is not None and max_jobs < 0:
        raise CompilationError("maximum Job count must not be negative")
    expected_jobs = 0
    for placeholder_names in prompt_placeholders:
        prompt_jobs = seed_axis_count
        remaining_jobs = None if max_jobs is None else max_jobs - expected_jobs
        if remaining_jobs is not None and prompt_jobs > remaining_jobs:
            raise CompilationError(f"Batch expands beyond the maximum of {max_jobs} Jobs")
        for name in placeholder_names:
            value_count = len(binding_values[name])
            if remaining_jobs is not None and prompt_jobs > remaining_jobs // value_count:
                raise CompilationError(f"Batch expands beyond the maximum of {max_jobs} Jobs")
            prompt_jobs *= value_count
        for image_axis in image_axes:
            if remaining_jobs is not None and prompt_jobs > remaining_jobs // len(image_axis):
                raise CompilationError(f"Batch expands beyond the maximum of {max_jobs} Jobs")
            prompt_jobs *= len(image_axis)
        for axis_count in axis_counts:
            if remaining_jobs is not None and prompt_jobs > remaining_jobs // axis_count:
                raise CompilationError(f"Batch expands beyond the maximum of {max_jobs} Jobs")
            prompt_jobs *= axis_count
        expected_jobs += prompt_jobs
    if batch.seeds.mode is SeedMode.MATERIALIZED_RANDOM and len(seeds) != expected_jobs:
        raise CompilationError(
            "materialized Random seed assignments must contain exactly one seed per Job"
        )

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

    if expected_plan is not None and (
        expected_jobs != expected_plan.job_count or warnings != expected_plan.warnings
    ):
        raise CompilationError(
            "Batch snapshot count or warnings do not match the compiled Run plan"
        )
    if max_prompt_bytes is not None or max_resolved_text_bytes is not None:
        total_text = 0
        copies = seed_axis_count * math.prod(map(len, image_axes)) * math.prod(axis_counts)
        for prompt, text_names in zip(batch.prompt_versions, prompt_placeholders, strict=True):
            occurrences = Counter(
                match.group(1) for match in _PLACEHOLDER_PATTERN.finditer(prompt.text)
            )
            literal = sum(
                _utf8_size(chunk)
                for chunk in _prompt_chunks(prompt.text, dict.fromkeys(text_names, ""))
            )
            sizes = {
                name: tuple(_utf8_size(value) for value in binding_values[name])
                for name in text_names
            }
            largest = literal + sum(occurrences[name] * max(sizes[name]) for name in text_names)
            if max_prompt_bytes is not None and largest > max_prompt_bytes:
                raise CompilationError(
                    f"resolved prompt exceeds the maximum of {max_prompt_bytes} UTF-8 bytes"
                )
            variants = math.prod(len(binding_values[name]) for name in text_names)
            total_text += copies * (
                literal * variants
                + sum(
                    (occurrences[name] + 1) * sum(sizes[name]) * (variants // len(sizes[name]))
                    for name in text_names
                )
            )
        for axis, linked in zip(parameter_axes, parameter_axis_sets, strict=True):
            text_size = sum(
                _utf8_size(value)
                for item in axis
                for value in (cast(LinkedParameterRow, item).values if linked else (item,))
                if isinstance(value, str)
            )
            total_text += text_size * (expected_jobs // len(axis))
        if max_resolved_text_bytes is not None and total_text > max_resolved_text_bytes:
            raise CompilationError(
                f"resolved text exceeds the maximum of {max_resolved_text_bytes} UTF-8 bytes"
            )

    if count_only:
        return CompilationPreview(job_count=expected_jobs, warnings=warnings)

    jobs: list[CompiledJob] = []
    ordinal = 0
    row_ordinals = {
        (linked_set.key, id(row)): index
        for linked_set in batch.linked_parameter_sets
        for index, row in enumerate(linked_set.rows, 1)
    }
    random_seed_position = 0

    for prompt_version, placeholder_names in zip(
        batch.prompt_versions, prompt_placeholders, strict=True
    ):
        value_axes = tuple(binding_values[name] for name in placeholder_names)
        for variable_values in product(*value_axes):
            assignments = dict(zip(placeholder_names, variable_values, strict=True))
            if expected_plan is None:
                resolved_prompt = _resolve_prompt(prompt_version.text, assignments)
            else:
                resolved_prompt = expected_plan.jobs[ordinal].resolved_prompt
                if not _prompt_matches(prompt_version.text, assignments, resolved_prompt):
                    raise CompilationError(
                        "Batch snapshot prompt does not match the compiled Run plan"
                    )
            unresolved = extract_placeholder_names(resolved_prompt)
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
                for parameter_values_for_job in product(*parameter_axes):
                    selected_values: dict[str, ParameterScalar | None] = {}
                    resolved_parameter_sets: list[ResolvedParameterSet] = []
                    for axis_value, axis_linked_set, parameter_key in zip(
                        parameter_values_for_job,
                        parameter_axis_sets,
                        parameter_axis_keys,
                        strict=True,
                    ):
                        if axis_linked_set is None:
                            assert parameter_key is not None
                            selected_values[parameter_key] = cast(
                                ParameterScalar | None, axis_value
                            )
                            continue
                        row = cast(LinkedParameterRow, axis_value)
                        for member_key, value in zip(
                            axis_linked_set.member_keys, row.values, strict=True
                        ):
                            selected_values[member_key] = value
                        resolved_parameter_sets.append(
                            ResolvedParameterSet(
                                set_key=axis_linked_set.key,
                                set_label=axis_linked_set.label,
                                row_ordinal=row_ordinals[(axis_linked_set.key, id(row))],
                                row_label=row.label,
                            )
                        )
                    resolved_parameters = tuple(
                        ResolvedParameter(parameter_key=key, value=selected_values[key])
                        for key in parameter_keys
                    )
                    seeds_for_configuration = seeds
                    if batch.seeds.mode is SeedMode.MATERIALIZED_RANDOM:
                        seeds_for_configuration = seeds[
                            random_seed_position : random_seed_position + seed_axis_count
                        ]
                        random_seed_position += seed_axis_count
                    for seed in seeds_for_configuration:
                        ordinal += 1
                        job = CompiledJob(
                            ordinal=ordinal,
                            prompt_version_id=prompt_version.id,
                            resolved_prompt=resolved_prompt,
                            resolved_variables=resolved_variables,
                            resolved_image_inputs=resolved_image_inputs,
                            resolved_parameters=resolved_parameters,
                            resolved_parameter_sets=tuple(resolved_parameter_sets),
                            seed=seed,
                        )
                        if expected_plan is None:
                            jobs.append(job)
                        else:
                            stored = expected_plan.jobs[ordinal - 1]
                            if job != stored or any(
                                type(left.value) is not type(right.value)
                                or (
                                    isinstance(left.value, float)
                                    and isinstance(right.value, float)
                                    and left.value.hex() != right.value.hex()
                                )
                                for left, right in zip(
                                    job.resolved_parameters, stored.resolved_parameters, strict=True
                                )
                            ):
                                raise CompilationError(
                                    "Batch snapshot does not reconstruct the compiled Run plan"
                                )

    if expected_plan is not None:
        return expected_plan
    return CompiledRunPlan(
        prompt_versions=batch.prompt_versions,
        image_input_slots=batch.image_input_slots,
        parameters=batch.parameters,
        jobs=tuple(jobs),
        warnings=warnings,
    )


def preview_batch(
    batch: BatchDefinition,
    *,
    max_jobs: int | None = None,
    max_prompt_bytes: int | None = None,
    max_resolved_text_bytes: int | None = None,
) -> CompilationPreview:
    plan = compile_batch(
        batch,
        max_jobs=max_jobs,
        max_prompt_bytes=max_prompt_bytes,
        max_resolved_text_bytes=max_resolved_text_bytes,
    )
    return CompilationPreview(job_count=plan.job_count, warnings=plan.warnings)


def _validate_parameter_value(key: str, value_type: str, value: object) -> None:
    if value is None:
        return
    try:
        validate_parameter_scalar(value)
    except ValueError as error:
        raise CompilationError(f"parameter binding for {key!r} is invalid: {error}") from error
    valid = False
    if value_type == "string":
        valid = isinstance(value, str)
    elif value_type == "integer":
        valid = (
            isinstance(value, int)
            and not isinstance(value, bool)
            and -_MAX_SAFE_INTEGER <= value <= _MAX_SAFE_INTEGER
        )
    elif value_type == "float":
        valid = (
            isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
        )
    elif value_type == "boolean":
        valid = isinstance(value, bool)
    if not valid:
        raise CompilationError(f"parameter binding for {key!r} must be {value_type} or null")
