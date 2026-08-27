from dataclasses import dataclass
from enum import StrEnum


class VariableBindingMode(StrEnum):
    ALL = "all"
    FIXED = "fixed"


class SeedMode(StrEnum):
    FIXED = "fixed"
    EXPLICIT = "explicit"


class CompilationWarningCode(StrEnum):
    UNUSED_BINDING = "unused_binding"


@dataclass(frozen=True, slots=True)
class PromptVersion:
    id: str
    text: str


@dataclass(frozen=True, slots=True)
class VariableList:
    id: str
    values: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class VariableBinding:
    placeholder: str
    variable_list: VariableList
    mode: VariableBindingMode
    selected_values: tuple[str, ...] = ()
    fixed_value: str | None = None


@dataclass(frozen=True, slots=True)
class ReferenceSelection:
    asset_id: str


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
    prompt_version: PromptVersion
    variable_bindings: tuple[VariableBinding, ...]
    references: tuple[ReferenceSelection, ...]
    seeds: SeedInput


@dataclass(frozen=True, slots=True)
class ResolvedVariable:
    name: str
    value: str


@dataclass(frozen=True, slots=True)
class CompilationWarning:
    code: CompilationWarningCode
    message: str
    placeholder: str


@dataclass(frozen=True, slots=True)
class CompiledJob:
    ordinal: int
    resolved_prompt: str
    resolved_variables: tuple[ResolvedVariable, ...]
    reference_asset_id: str
    seed: int


@dataclass(frozen=True, slots=True)
class CompiledRunPlan:
    prompt_version_id: str
    prompt_template: str
    jobs: tuple[CompiledJob, ...]
    warnings: tuple[CompilationWarning, ...]

    @property
    def job_count(self) -> int:
        return len(self.jobs)


@dataclass(frozen=True, slots=True)
class CompilationPreview:
    job_count: int
    warnings: tuple[CompilationWarning, ...]
