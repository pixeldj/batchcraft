import math
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum


class SeedMode(StrEnum):
    FIXED = "fixed"
    EXPLICIT = "explicit"
    MATERIALIZED_RANDOM = "materialized_random"


class CompilationWarningCode(StrEnum):
    UNUSED_BINDING = "unused_binding"


@dataclass(frozen=True, slots=True)
class PromptVersion:
    id: str
    name: str
    text: str


@dataclass(frozen=True, slots=True)
class VariableBinding:
    placeholder: str
    values: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ImageInputSlot:
    key: str
    label: str
    node_id: str
    input_name: str


@dataclass(frozen=True, slots=True)
class ImageBinding:
    slot_key: str
    values: tuple[str | None, ...]


class ParameterValueType(StrEnum):
    STRING = "string"
    INTEGER = "integer"
    FLOAT = "float"
    BOOLEAN = "boolean"


ParameterScalar = str | int | float | bool
MAX_SAFE_INTEGER = 2**53 - 1


def validate_parameter_scalar(value: object) -> ParameterScalar:
    if isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        if -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER:
            return value
        raise ValueError(
            f"integer parameter values must be from {-MAX_SAFE_INTEGER} through {MAX_SAFE_INTEGER}"
        )
    if isinstance(value, float) and math.isfinite(value):
        return value
    raise ValueError("parameter values must be finite JSON strings, numbers, or booleans")


def validate_parameter_alternatives(values: Sequence[object]) -> None:
    if not values:
        raise ValueError("parameter binding values must contain at least one effective value")
    for value in values:
        if value is not None:
            validate_parameter_scalar(value)
    seen: set[tuple[type, object]] = set()
    for value in values:
        key = parameter_value_key(value)
        if key in seen:
            raise ValueError("parameter binding values must not contain exact duplicates")
        seen.add(key)
    if None in values and values[0] is not None:
        raise ValueError("parameter binding values must place Base workflow first")


def parameter_value_key(value: object) -> tuple[type, object]:
    """Duplicate identity: numbers compare together; booleans remain distinct."""
    if isinstance(value, bool):
        return bool, value
    if isinstance(value, str):
        return str, value
    return (float if isinstance(value, (int, float)) else type(value)), value


@dataclass(frozen=True, slots=True)
class WorkflowParameter:
    key: str
    label: str
    node_id: str
    input_name: str
    value_type: ParameterValueType


@dataclass(frozen=True, slots=True)
class ParameterBinding:
    parameter_key: str
    values: tuple[ParameterScalar | None, ...]


@dataclass(frozen=True, slots=True)
class LinkedParameterRow:
    values: tuple[ParameterScalar | None, ...]
    label: str | None = None


@dataclass(frozen=True, slots=True)
class LinkedParameterSet:
    key: str
    label: str
    member_keys: tuple[str, ...]
    rows: tuple[LinkedParameterRow, ...]


@dataclass(frozen=True, slots=True)
class SeedInput:
    mode: SeedMode
    values: tuple[int, ...]
    random_seed_count: int | None = None

    @classmethod
    def fixed(cls, seed: int) -> "SeedInput":
        return cls(mode=SeedMode.FIXED, values=(seed,))

    @classmethod
    def explicit(cls, seeds: tuple[int, ...]) -> "SeedInput":
        return cls(mode=SeedMode.EXPLICIT, values=seeds)

    @classmethod
    def materialized_random(cls, seeds: tuple[int, ...], count: int) -> "SeedInput":
        return cls(
            mode=SeedMode.MATERIALIZED_RANDOM,
            values=seeds,
            random_seed_count=count,
        )


@dataclass(frozen=True, slots=True)
class BatchDefinition:
    prompt_versions: tuple[PromptVersion, ...]
    variable_bindings: tuple[VariableBinding, ...]
    image_input_slots: tuple[ImageInputSlot, ...]
    image_bindings: tuple[ImageBinding, ...]
    seeds: SeedInput
    parameters: tuple[WorkflowParameter, ...] = ()
    parameter_bindings: tuple[ParameterBinding, ...] = ()
    linked_parameter_sets: tuple[LinkedParameterSet, ...] = ()


@dataclass(frozen=True, slots=True)
class ResolvedVariable:
    name: str
    value: str


@dataclass(frozen=True, slots=True)
class ResolvedImageInput:
    slot_key: str
    asset_id: str | None


@dataclass(frozen=True, slots=True)
class ResolvedParameter:
    parameter_key: str
    value: ParameterScalar | None


@dataclass(frozen=True, slots=True)
class ResolvedParameterSet:
    set_key: str
    set_label: str
    row_ordinal: int
    row_label: str | None


@dataclass(frozen=True, slots=True)
class CompilationWarning:
    code: CompilationWarningCode
    message: str
    placeholder: str


@dataclass(frozen=True, slots=True)
class CompiledJob:
    ordinal: int
    prompt_version_id: str
    resolved_prompt: str
    resolved_variables: tuple[ResolvedVariable, ...]
    resolved_image_inputs: tuple[ResolvedImageInput, ...]
    seed: int
    resolved_parameters: tuple[ResolvedParameter, ...] = ()
    resolved_parameter_sets: tuple[ResolvedParameterSet, ...] = ()


@dataclass(frozen=True, slots=True)
class CompiledRunPlan:
    prompt_versions: tuple[PromptVersion, ...]
    image_input_slots: tuple[ImageInputSlot, ...]
    jobs: tuple[CompiledJob, ...]
    warnings: tuple[CompilationWarning, ...]
    parameters: tuple[WorkflowParameter, ...] = ()

    @property
    def job_count(self) -> int:
        return len(self.jobs)


@dataclass(frozen=True, slots=True)
class CompilationPreview:
    job_count: int
    warnings: tuple[CompilationWarning, ...]
