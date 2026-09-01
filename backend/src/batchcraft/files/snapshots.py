from typing import Annotated, Literal, Self

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictBool,
    StrictStr,
    model_validator,
)

from batchcraft.domain import validate_parameter_alternatives, validate_parameter_scalar
from batchcraft.domain.image_slots import validate_image_input_slot_key


class SnapshotModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


SnapshotSeed = Annotated[int, Field(strict=True, ge=0, le=2**53 - 1)]
SnapshotInteger = Annotated[int, Field(strict=True, ge=-(2**53 - 1), le=2**53 - 1)]
SnapshotFloat = Annotated[float, Field(strict=True, allow_inf_nan=False)]
SnapshotParameterScalar = Annotated[
    StrictStr | SnapshotInteger | SnapshotFloat | StrictBool,
    BeforeValidator(validate_parameter_scalar),
]


class SnapshotIdentity(SnapshotModel):
    id: str = Field(min_length=1)
    filesystem_key: str = Field(min_length=1)
    name: str = Field(min_length=1)


class SnapshotSourceSavedBatch(SnapshotModel):
    id: str = Field(min_length=1)
    revision: int = Field(strict=True, ge=1)


class SnapshotBatch(SnapshotModel):
    id: str = Field(min_length=1)
    filesystem_key: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str | None = None


class SnapshotPromptVersion(SnapshotModel):
    id: str = Field(min_length=1)
    prompt_id: str | None = Field(default=None, min_length=1)
    version_number: int | None = Field(default=None, strict=True, ge=1)
    name: str = Field(min_length=1)
    text: str


class SnapshotVariableBinding(SnapshotModel):
    placeholder: str = Field(min_length=1)
    values: list[str]

    @model_validator(mode="after")
    def validate_values(self) -> Self:
        if len(set(self.values)) != len(self.values):
            raise ValueError("variable binding values must not contain exact duplicates")
        return self


class SnapshotImageBinding(SnapshotModel):
    slot_key: str
    values: list[str | None] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_binding(self) -> Self:
        validate_image_input_slot_key(self.slot_key)
        if any(value is not None and not value.strip() for value in self.values):
            raise ValueError("image binding values must be nonblank asset IDs or null")
        if len(set(self.values)) != len(self.values):
            raise ValueError("image binding values must not contain exact duplicates")
        if None in self.values and self.values[0] is not None:
            raise ValueError("image binding values must place Base workflow first")
        return self


class SnapshotParameterValuesBinding(SnapshotModel):
    parameter_key: str
    mode: Literal["values"]
    values: list[SnapshotParameterScalar | None] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_values(self) -> Self:
        validate_parameter_alternatives(self.values)
        return self


class SnapshotParameterRange(SnapshotModel):
    start: str = Field(min_length=1, max_length=100)
    end: str = Field(min_length=1, max_length=100)
    step: str = Field(min_length=1, max_length=100)


class SnapshotParameterRangeBinding(SnapshotModel):
    parameter_key: str
    mode: Literal["range"]
    include_base: StrictBool
    range: SnapshotParameterRange


SnapshotParameterBinding = Annotated[
    SnapshotParameterValuesBinding | SnapshotParameterRangeBinding,
    Field(discriminator="mode"),
]


class SnapshotSeedIntent(SnapshotModel):
    mode: Literal["fixed", "explicit", "random"]
    values: list[SnapshotSeed]
    random_seed_count: int | None = Field(default=None, strict=True, ge=1, le=100)

    @model_validator(mode="after")
    def validate_shape(self) -> Self:
        if self.mode == "fixed" and (len(self.values) != 1 or self.random_seed_count is not None):
            raise ValueError("fixed seed intent requires one value and no random count")
        if self.mode == "explicit" and (not self.values or self.random_seed_count is not None):
            raise ValueError("explicit seed intent requires values and no random count")
        if self.mode == "random" and (self.values or self.random_seed_count is None):
            raise ValueError("random seed intent requires a count and no values")
        return self


class SnapshotWorkflowSelection(SnapshotModel):
    workflow_id: str | None = Field(default=None, min_length=1)
    workflow_version_id: str | None = Field(default=None, min_length=1)
    workflow_name: str | None = Field(default=None, min_length=1)
    workflow_version_number: int | None = Field(default=None, strict=True, ge=1)
    workflow_profile_id: str | None = Field(default=None, min_length=1)
    workflow_profile_version_id: str | None = Field(default=None, min_length=1)
    workflow_profile_name: str | None = Field(default=None, min_length=1)
    workflow_profile_version_number: int | None = Field(default=None, strict=True, ge=1)
    workflow: dict[str, object]
    workflow_profile: dict[str, object]


class BatchSnapshotV5(SnapshotModel):
    snapshot_version: int = Field(strict=True, ge=5, le=5)
    project: SnapshotIdentity
    source_saved_batch: SnapshotSourceSavedBatch | None
    batch: SnapshotBatch
    prompt_versions: list[SnapshotPromptVersion]
    variable_bindings: list[SnapshotVariableBinding]
    image_bindings: list[SnapshotImageBinding]
    parameter_bindings: list[SnapshotParameterBinding]
    seed_intent: SnapshotSeedIntent
    workflow_selection: SnapshotWorkflowSelection

    @model_validator(mode="after")
    def validate_binding_keys(self) -> Self:
        keys = [binding.slot_key for binding in self.image_bindings]
        if len(set(keys)) != len(keys):
            raise ValueError("image bindings must have unique slot keys")
        parameter_keys = [binding.parameter_key for binding in self.parameter_bindings]
        if len(set(parameter_keys)) != len(parameter_keys):
            raise ValueError("parameter bindings must have unique parameter keys")
        return self
