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


@dataclass(frozen=True, slots=True)
class ResolvedVariable:
    name: str
    value: str


@dataclass(frozen=True, slots=True)
class ResolvedImageInput:
    slot_key: str
    asset_id: str | None


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


@dataclass(frozen=True, slots=True)
class CompiledRunPlan:
    prompt_versions: tuple[PromptVersion, ...]
    image_input_slots: tuple[ImageInputSlot, ...]
    jobs: tuple[CompiledJob, ...]
    warnings: tuple[CompilationWarning, ...]

    @property
    def job_count(self) -> int:
        return len(self.jobs)


@dataclass(frozen=True, slots=True)
class CompilationPreview:
    job_count: int
    warnings: tuple[CompilationWarning, ...]
