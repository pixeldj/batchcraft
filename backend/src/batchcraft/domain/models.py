import math
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum


class SeedMode(StrEnum):
    FIXED = "fixed"
    EXPLICIT = "explicit"


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
    for position, value in enumerate(values):
        if any(_parameter_values_equal(value, prior) for prior in values[:position]):
            raise ValueError("parameter binding values must not contain exact duplicates")
    if None in values and values[0] is not None:
        raise ValueError("parameter binding values must place Base workflow first")


def _parameter_values_equal(left: object, right: object) -> bool:
    if left is None or right is None:
        return left is right
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, str) or isinstance(right, str):
        return isinstance(left, str) and isinstance(right, str) and left == right
    return isinstance(left, (int, float)) and isinstance(right, (int, float)) and left == right


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
class SeedInput:
    mode: SeedMode
    values: tuple[int, ...]

    @classmethod
    def fixed(cls, seed: int) -> "SeedInput":
        return cls(mode=SeedMode.FIXED, values=(seed,))

    @classmethod
    def explicit(cls, seeds: tuple[int, ...]) -> "SeedInput":
        return cls(mode=SeedMode.EXPLICIT, values=seeds)


@dataclass(frozen=True, slots=True)
class BatchDefinition:
    prompt_versions: tuple[PromptVersion, ...]
    variable_bindings: tuple[VariableBinding, ...]
    image_input_slots: tuple[ImageInputSlot, ...]
    image_bindings: tuple[ImageBinding, ...]
    seeds: SeedInput
    parameters: tuple[WorkflowParameter, ...] = ()
    parameter_bindings: tuple[ParameterBinding, ...] = ()


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
