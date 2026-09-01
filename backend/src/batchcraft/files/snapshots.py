from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


class SnapshotModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


SnapshotSeed = Annotated[int, Field(strict=True, ge=0, le=2**53 - 1)]


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


class SnapshotReference(SnapshotModel):
    asset_id: str = Field(min_length=1)


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


class BatchSnapshotV2(SnapshotModel):
    snapshot_version: int = Field(strict=True, ge=2, le=2)
    project: SnapshotIdentity
    source_saved_batch: SnapshotSourceSavedBatch | None
    batch: SnapshotBatch
    prompt_versions: list[SnapshotPromptVersion]
    variable_bindings: list[SnapshotVariableBinding]
    references: list[SnapshotReference]
    seed_intent: SnapshotSeedIntent
    workflow_selection: SnapshotWorkflowSelection
