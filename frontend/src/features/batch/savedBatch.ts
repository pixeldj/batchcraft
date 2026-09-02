import type {
  JsonObject,
  ProjectResponse,
  SavedBatchCreateRequest,
  SavedBatchDefinitionRequest,
  SavedBatchDetail,
  SavedBatchUpdateRequest,
} from "../../api/types";
import {
  FormBuildError,
  initialBatchForm,
  newPrompt,
  newVariableBinding,
  normalizedBindingValues,
  buildParameterBindings,
  buildLinkedParameterSets,
  reconcileImageBindings,
  reconcileParameterState,
  profileImageInputs,
  profileParameters,
  defaultParameterRange,
  validateImageBindings,
  type BatchFormState,
} from "./form";

const EMPTY_OBJECT = "{}";

export function buildSavedBatchDefinition(form: BatchFormState): SavedBatchDefinitionRequest {
  const workflow = parseObject(form.workflowJson, "Workflow");
  const emptyWorkflow = Object.keys(workflow).length === 0;
  const profile = emptyWorkflow && !form.workflowVersionId
    ? {}
    : parseObject(form.workflowProfileJson, "Workflow Profile");
  if (!form.workflowProfileVersionId && form.imageBindings.length > 0) {
    throw new FormBuildError(
      "workflow_profile",
      "Complete the Workflow Profile version before saving its Image Input bindings.",
    );
  }
  if (!form.workflowProfileVersionId && (form.parameterBindings.length > 0 || form.linkedParameterSets.length > 0)) {
    throw new FormBuildError(
      "workflow_profile",
      "Complete the Workflow Profile version before saving its Parameter bindings.",
    );
  }

  const detachedPrompt = form.prompts.find((prompt) =>
    prompt.libraryProjectId !== form.projectId || !prompt.promptId || prompt.versionNumber === null
  );
  if (detachedPrompt) {
    throw new FormBuildError(
      "prompts",
      "This Batch contains a detached Prompt. Save it to the Prompt library before saving the Batch.",
    );
  }
  if (!emptyWorkflow && (
    form.workflowLibraryProjectId !== form.projectId ||
    !form.workflowId ||
    !form.workflowVersionId ||
    !form.workflowContentSha256
  )) {
    throw new FormBuildError(
      "workflow",
      "This Batch contains a detached Workflow/Profile. Save it to the Workflow library before saving the Batch.",
    );
  }
  if (form.workflowProfileVersionId && (
    !form.workflowProfileId ||
    !form.workflowProfileContentSha256 ||
    form.workflowProfileWorkflowVersionId !== form.workflowVersionId
  )) {
    throw new FormBuildError(
      "workflow_profile",
      "This Batch contains a detached Workflow/Profile. Save it to the Workflow library before saving the Batch.",
    );
  }

  const imageBindings = reconcileImageBindings(form.imageBindings, profileImageInputs(profile));
  validateImageBindings(imageBindings);
  const parameterState = reconcileParameterState(
    form.parameterBindings,
    form.linkedParameterSets,
    profileParameters(profile),
  );
  const parameterBindings = buildParameterBindings(parameterState.parameterBindings);
  const linkedParameterSets = buildLinkedParameterSets(parameterState.linkedParameterSets);
  return {
    name: required(form.batchName, "Batch name"),
    description: form.batchDescription.trim() || null,
    prompt_selections: form.prompts.map((prompt) => ({
      prompt_version_id: required(prompt.versionId, "PromptVersion ID"),
      name_snapshot: required(prompt.snapshotName, "PromptVersion name"),
      text: prompt.text,
      prompt_id: prompt.promptId,
      prompt_name: prompt.promptName.trim() || null,
      version_number: prompt.versionNumber,
      prompt_archived_at: null,
      version_archived_at: null,
    })),
    variable_bindings: form.variableBindings.map((binding) => ({
      placeholder: binding.placeholder.trim(),
      values: normalizedBindingValues(binding.values),
    })),
    image_bindings: imageBindings,
    parameter_bindings: parameterBindings,
    linked_parameter_sets: linkedParameterSets,
    seed_intent: savedSeedIntent(form),
    selected_workflow_version: emptyWorkflow ? null : {
      id: form.workflowVersionId as string,
      content_sha256: form.workflowContentSha256 as string,
      workflow,
      workflow_id: form.workflowId,
      workflow_name: form.workflowName.trim() || null,
      version_number: form.workflowVersionNumber,
      name_snapshot: form.workflowName.trim() || null,
      workflow_archived_at: null,
      version_archived_at: null,
    },
    selected_workflow_profile_id: emptyWorkflow ? null : form.workflowProfileId,
    selected_workflow_profile_version: !form.workflowProfileVersionId ? null : {
      id: form.workflowProfileVersionId,
      workflow_profile_id: form.workflowProfileId as string,
      workflow_version_id: form.workflowProfileWorkflowVersionId as string,
      content_sha256: form.workflowProfileContentSha256 as string,
      profile,
      workflow_profile_name: form.workflowProfileName.trim() || null,
      version_number: form.workflowProfileVersionNumber,
      name_snapshot: form.workflowProfileName.trim() || null,
      workflow_profile_archived_at: null,
      version_archived_at: null,
    },
  };
}

export function buildSavedBatchCreate(
  form: BatchFormState,
  filesystemKey: string,
): SavedBatchCreateRequest {
  return { ...buildSavedBatchDefinition(form), filesystem_key: required(filesystemKey, "Filesystem key") };
}

export function buildSavedBatchUpdate(
  form: BatchFormState,
  expectedRevision: number,
): SavedBatchUpdateRequest {
  return { ...buildSavedBatchDefinition(form), expected_revision: expectedRevision };
}

export function savedBatchToForm(
  detail: SavedBatchDetail,
  project: ProjectResponse,
): BatchFormState {
  const form = initialBatchForm();
  const workflow = detail.selected_workflow_version;
  const profile = detail.selected_workflow_profile_version;
  return {
    ...form,
    projectId: project.id,
    projectFilesystemKey: project.filesystem_key,
    projectName: project.name,
    batchId: detail.id,
    batchFilesystemKey: detail.filesystem_key,
    batchName: detail.name,
    batchDescription: detail.description ?? "",
    prompts: detail.prompt_selections.map((selection) => ({
      key: newPrompt().key,
      libraryProjectId: selection.prompt_id && !selection.prompt_archived_at && !selection.version_archived_at
        ? project.id
        : null,
      promptId: selection.prompt_id,
      promptName: selection.prompt_name ?? selection.name_snapshot,
      versionId: selection.prompt_version_id,
      versionNumber: selection.version_number,
      snapshotName: selection.name_snapshot,
      text: selection.text,
    })),
    variableBindings: detail.variable_bindings.map((binding) => ({
      key: newVariableBinding().key,
      placeholder: binding.placeholder,
      values: [...binding.values],
    })),
    imageBindings: reconcileImageBindings(detail.image_bindings, profile ? profileImageInputs(profile.profile) : []),
    ...savedParameterStateToForm(
      detail.parameter_bindings,
      detail.linked_parameter_sets,
      profile ? profileParameters(profile.profile) : [],
    ),
    seedMode: detail.seed_mode,
    seedValues: detail.seed_values.join("\n"),
    randomSeedCount: String(detail.random_seed_count ?? 1),
    workflowJson: workflow ? pretty(workflow.workflow) : EMPTY_OBJECT,
    workflowProfileJson: profile ? pretty(profile.profile) : EMPTY_OBJECT,
    workflowLibraryProjectId: workflow ? project.id : null,
    workflowId: workflow?.workflow_id ?? null,
    workflowName: workflow?.workflow_name ?? workflow?.name_snapshot ?? "",
    workflowVersionId: workflow?.id ?? null,
    workflowVersionNumber: workflow?.version_number ?? null,
    workflowContentSha256: workflow?.content_sha256 ?? null,
    workflowProfileId: detail.selected_workflow_profile_id,
    workflowProfileName: detail.selected_workflow_profile_name ?? profile?.workflow_profile_name ?? "",
    workflowProfileVersionId: profile?.id ?? null,
    workflowProfileVersionNumber: profile?.version_number ?? null,
    workflowProfileWorkflowVersionId: profile?.workflow_version_id ?? null,
    workflowProfileContentSha256: profile?.content_sha256 ?? null,
  };
}

export function canonicalBatchIntent(form: BatchFormState): string {
  return canonical({
    name: form.batchName.trim(),
    description: form.batchDescription.trim() || null,
    prompts: form.prompts.map((prompt) => ({
      libraryProjectId: prompt.libraryProjectId,
      promptId: prompt.promptId,
      versionId: prompt.versionId,
      versionNumber: prompt.versionNumber,
      snapshotName: prompt.snapshotName,
      text: prompt.text,
    })),
    variableBindings: form.variableBindings.map((binding) => ({
      placeholder: binding.placeholder.trim(),
      values: normalizedBindingValues(binding.values),
    })),
    imageBindings: form.imageBindings,
    parameterBindings: form.parameterBindings.map((binding) => binding.mode === "range"
      ? {
        parameterKey: binding.parameterKey,
        valueType: binding.valueType,
        mode: binding.mode,
        range: binding.range,
      }
      : {
        parameterKey: binding.parameterKey,
        valueType: binding.valueType,
        mode: binding.mode,
        alternatives: binding.alternatives,
      }),
    linkedParameterSets: form.linkedParameterSets,
    seed: form.seedMode === "random"
      ? { mode: "random", randomSeedCount: form.randomSeedCount.trim() }
      : { mode: form.seedMode, values: splitSeeds(form.seedValues) },
    workflow: {
      projectId: form.workflowLibraryProjectId,
      workflowId: form.workflowId,
      versionId: form.workflowVersionId,
      versionNumber: form.workflowVersionNumber,
      contentSha256: form.workflowContentSha256,
      snapshot: objectOrText(form.workflowJson),
      profileId: form.workflowProfileId,
      profileVersionId: form.workflowProfileVersionId,
      profileVersionNumber: form.workflowProfileVersionNumber,
      profileWorkflowVersionId: form.workflowProfileWorkflowVersionId,
      profileContentSha256: form.workflowProfileContentSha256,
      profileSnapshot: objectOrText(form.workflowProfileJson),
    },
  });
}

function savedParameterStateToForm(
  bindings: SavedBatchDetail["parameter_bindings"],
  linkedSets: SavedBatchDetail["linked_parameter_sets"],
  parameters: ReturnType<typeof profileParameters>,
): Pick<BatchFormState, "parameterBindings" | "linkedParameterSets"> {
  const byKey = new Map(bindings.map((binding) => [binding.parameter_key, binding]));
  const parameterBindings = parameters.flatMap((parameter) => {
    const binding = byKey.get(parameter.key);
    if (!binding) return [];
    const values = binding?.mode === "values" ? binding.values : undefined;
    return [{
      parameterKey: parameter.key,
      valueType: parameter.value_type,
      mode: binding?.mode ?? "values",
      alternatives: values?.map((value) => value === null
        ? { kind: "base" as const }
        : { kind: "override" as const, value: String(value) }) ?? [{ kind: "base" as const }],
      range: binding?.mode === "range"
        ? {
          start: binding.range.start,
          end: binding.range.end,
          step: binding.range.step,
          includeBase: binding.include_base,
        }
        : defaultParameterRange(parameter.value_type),
    }];
  });
  const parameterByKey = new Map(parameters.map((parameter) => [parameter.key, parameter]));
  const linkedParameterSets = linkedSets.flatMap((set) => {
    const members = set.members.flatMap((parameterKey) => {
      const parameter = parameterByKey.get(parameterKey);
      return parameter ? [{ parameterKey, valueType: parameter.value_type }] : [];
    });
    if (members.length !== set.members.length) return [];
    return [{
      setKey: set.set_key,
      setLabel: set.set_label,
      members,
      rows: set.rows.map((row) => ({
        rowLabel: row.row_label ?? "",
        values: Object.fromEntries(members.map((member) => {
          const value = row.values[member.parameterKey];
          return [member.parameterKey, value === null
            ? { kind: "base" as const }
            : { kind: "override" as const, value: String(value) }];
        })),
      })),
    }];
  });
  return reconcileParameterState(parameterBindings, linkedParameterSets, parameters);
}

function savedSeedIntent(form: BatchFormState) {
  if (form.seedMode === "random") {
    const count = Number(form.randomSeedCount.trim());
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      throw new FormBuildError("seeds", "Random seed count must be between 1 and 100.");
    }
    return { mode: "random" as const, values: [], random_seed_count: count };
  }
  const values = parseSeeds(form.seedValues);
  if (form.seedMode === "fixed" && values.length !== 1) {
    throw new FormBuildError("seeds", "Fixed seed intent requires exactly one seed.");
  }
  if (form.seedMode === "explicit" && values.length === 0) {
    throw new FormBuildError("seeds", "Explicit seed intent requires at least one seed.");
  }
  return { mode: form.seedMode, values, random_seed_count: null };
}

function parseSeeds(value: string): number[] {
  return splitSeeds(value).map((item) => {
    if (!/^\d+$/.test(item)) throw new FormBuildError("seeds", `Seed ${JSON.stringify(item)} is not a nonnegative integer.`);
    const seed = Number(item);
    if (!Number.isSafeInteger(seed)) throw new FormBuildError("seeds", `Seed ${JSON.stringify(item)} is outside the safe integer range.`);
    return seed;
  });
}

function splitSeeds(value: string): string[] {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function parseObject(value: string, label: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as JsonObject;
  } catch {
    // Use the same actionable message for syntax and root-shape failures.
  }
  throw new FormBuildError("workflow", `${label} JSON must contain an object.`);
}

function objectOrText(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new FormBuildError("batch", `${label} is required.`);
  return trimmed;
}

function pretty(value: JsonObject): string {
  return JSON.stringify(value, null, 2);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
