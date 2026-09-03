import {
  initialBatchForm,
  newPrompt,
  newVariableBinding,
  profileParameters,
  reconcileParameterState,
  type BatchFormState,
  type PromptForm,
  type VariableBindingForm,
} from "../batch/form";

export const WORKING_SESSION_RECOVERY_KEY = "batchcraft.working-session-recovery.v4";
const WORKING_SESSION_RECOVERY_VERSION = 4;

type StoredVariableBinding = Omit<VariableBindingForm, "key">;
type StoredPrompt = Omit<
  PromptForm,
  "key" | "placeholders" | "historicalVersionId" | "historicalResourceStatus" | "historicalResourceReason"
>;

interface StoredBatchForm extends Omit<
  BatchFormState,
  "prompts" | "variableBindings" | "workflowJson" | "workflowProfileJson"
  | "historicalWorkflowVersionId" | "historicalWorkflowResourceStatus" | "historicalWorkflowResourceReason"
  | "historicalProfileVersionId" | "historicalProfileResourceStatus" | "historicalProfileResourceReason"
> {
  prompts: StoredPrompt[];
  variableBindings: StoredVariableBinding[];
  workflowJson: string | null;
  workflowProfileJson: string | null;
}

interface WorkingSessionRecoveryV4 {
  format_version: 4;
  updated_at: string;
  draft: StoredBatchForm;
  current_run_id: string | null;
  session_run_ids: string[];
  selected_project_id: string | null;
  selected_saved_batch_id: string | null;
  saved_batch_base_revision: number | null;
  source_run_id: string | null;
}

export interface RestoredWorkingSession {
  form: BatchFormState;
  currentRunId: string | null;
  sessionRunIds: string[];
  selectedProjectId: string | null;
  selectedSavedBatchId: string | null;
  savedBatchBaseRevision: number | null;
  sourceRunId: string | null;
  workflowSnapshotRecoveryRequired: boolean;
  profileSnapshotRecoveryRequired: boolean;
  draftRestored: boolean;
}

export function loadWorkingSessionRecovery(
  storage: Storage | null = browserLocalStorage(),
): RestoredWorkingSession {
  if (!storage) {
    return defaultSession();
  }
  try {
    const raw = storage.getItem(WORKING_SESSION_RECOVERY_KEY);
    if (raw === null) {
      return defaultSession();
    }
    const value: unknown = JSON.parse(raw);
    if (!isWorkingSessionRecoveryV4(value)) {
      return defaultSession();
    }
    return restoredSession(value);
  } catch {
    return defaultSession();
  }
}

export function saveWorkingSessionRecovery(
  form: BatchFormState,
  currentRunId: string | null,
  sessionRunIds: string[] = [],
  selectedProjectId: string | null = null,
  storage: Storage | null = browserLocalStorage(),
  selectedSavedBatchId: string | null = null,
  savedBatchBaseRevision: number | null = null,
  sourceRunId: string | null = null,
): void {
  if (!storage) {
    return;
  }
  const normalizedRunIds = uniqueStrings(sessionRunIds);
  if (currentRunId && !normalizedRunIds.includes(currentRunId)) {
    normalizedRunIds.push(currentRunId);
  }
  const envelope: WorkingSessionRecoveryV4 = {
    format_version: WORKING_SESSION_RECOVERY_VERSION,
    updated_at: new Date().toISOString(),
    draft: dehydrateForm(form),
    current_run_id: currentRunId,
    session_run_ids: normalizedRunIds,
    selected_project_id: selectedProjectId,
    selected_saved_batch_id: selectedSavedBatchId,
    saved_batch_base_revision: savedBatchBaseRevision,
    source_run_id: sourceRunId,
  };
  try {
    storage.setItem(WORKING_SESSION_RECOVERY_KEY, JSON.stringify(envelope));
  } catch {
    // Recovery is best effort; the live editor remains usable without browser storage.
  }
}

function dehydrateForm(form: BatchFormState): StoredBatchForm {
  const resolutions = resolutionsForCurrentSelections(form);
  const storedForm = { ...form, historicalImportCopyResolutions: resolutions };
  delete storedForm.historicalWorkflowVersionId;
  delete storedForm.historicalWorkflowResourceStatus;
  delete storedForm.historicalWorkflowResourceReason;
  delete storedForm.historicalProfileVersionId;
  delete storedForm.historicalProfileResourceStatus;
  delete storedForm.historicalProfileResourceReason;
  return {
    ...storedForm,
    prompts: form.prompts.map(({
      libraryProjectId,
      promptId,
      promptName,
      versionId,
      versionNumber,
      snapshotName,
      text,
      historicalPosition,
    }) => ({
      libraryProjectId,
      promptId,
      promptName,
      versionId,
      versionNumber,
      snapshotName,
      text,
      historicalPosition: historicalPosition ?? null,
    })),
    variableBindings: form.variableBindings.map(({ placeholder, values }) => ({
      placeholder,
      values: [...values],
    })),
    workflowJson: (form.workflowLibraryProjectId && form.workflowVersionId) || resolutions.workflowVersion
      ? null
      : form.workflowJson,
    workflowProfileJson: (form.workflowLibraryProjectId && form.workflowProfileVersionId)
      || resolutions.workflowProfileVersion
      ? null
      : form.workflowProfileJson,
  };
}

function resolutionsForCurrentSelections(
  form: BatchFormState,
): BatchFormState["historicalImportCopyResolutions"] {
  return {
    promptVersions: form.historicalImportCopyResolutions.promptVersions.filter((resolution) => (
      form.prompts.some((prompt) => prompt.versionId === resolution.copiedVersionId)
    )),
    workflowVersion: form.historicalImportCopyResolutions.workflowVersion
      && (
        form.historicalImportCopyResolutions.workflowVersion.copiedVersionId
          === form.workflowVersionId
        || (
          form.historicalImportCopyResolutions.workflowVersion.historicalVersionId
            === form.historicalWorkflowVersionId
          && form.workflowVersionId === form.historicalWorkflowVersionId
        )
      )
      ? form.historicalImportCopyResolutions.workflowVersion
      : null,
    workflowProfileVersion: form.historicalImportCopyResolutions.workflowProfileVersion?.copiedVersionId
      === form.workflowProfileVersionId
      && form.workflowProfileWorkflowVersionId === form.workflowVersionId
      ? form.historicalImportCopyResolutions.workflowProfileVersion
      : null,
  };
}

function hydrateForm(form: StoredBatchForm): BatchFormState {
  const workflowProfileJson = form.workflowProfileJson ?? "{}";
  const parameterState = form.workflowProfileJson === null
    ? { parameterBindings: form.parameterBindings, linkedParameterSets: form.linkedParameterSets }
    : reconcileParameterState(
      form.parameterBindings,
      form.linkedParameterSets,
      profileParameters(workflowProfileJson),
    );
  return {
    ...form,
    workflowJson: form.workflowJson ?? "{}",
    workflowProfileJson,
    prompts: form.prompts.map((prompt) => ({
      ...prompt,
      key: newPrompt().key,
      placeholders: [],
      historicalVersionId: null,
      historicalResourceStatus: null,
      historicalResourceReason: null,
    })),
    variableBindings: form.variableBindings.map((binding) => ({
      ...binding,
      key: newVariableBinding().key,
    })),
    ...parameterState,
    historicalWorkflowVersionId: null,
    historicalWorkflowResourceStatus: null,
    historicalWorkflowResourceReason: null,
    historicalProfileVersionId: null,
    historicalProfileResourceStatus: null,
    historicalProfileResourceReason: null,
  };
}

function defaultSession(): RestoredWorkingSession {
  return {
    form: initialBatchForm(),
    currentRunId: null,
    sessionRunIds: [],
    selectedProjectId: null,
    selectedSavedBatchId: null,
    savedBatchBaseRevision: null,
    sourceRunId: null,
    workflowSnapshotRecoveryRequired: false,
    profileSnapshotRecoveryRequired: false,
    draftRestored: false,
  };
}

function restoredSession(value: WorkingSessionRecoveryV4): RestoredWorkingSession {
  return {
    form: hydrateForm(value.draft),
    currentRunId: value.current_run_id,
    sessionRunIds: uniqueStrings(value.session_run_ids),
    selectedProjectId: value.selected_project_id,
    selectedSavedBatchId: value.selected_saved_batch_id,
    savedBatchBaseRevision: value.saved_batch_base_revision,
    sourceRunId: value.source_run_id,
    workflowSnapshotRecoveryRequired: value.draft.workflowJson === null,
    profileSnapshotRecoveryRequired: value.draft.workflowProfileJson === null,
    draftRestored: true,
  };
}

function browserLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isWorkingSessionRecoveryV4(value: unknown): value is WorkingSessionRecoveryV4 {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "format_version",
      "updated_at",
      "draft",
      "current_run_id",
      "session_run_ids",
      "selected_project_id",
      "selected_saved_batch_id",
      "saved_batch_base_revision",
      "source_run_id",
    ]) &&
    value.format_version === WORKING_SESSION_RECOVERY_VERSION &&
    isIsoTimestamp(value.updated_at) &&
    isStoredBatchForm(value.draft) &&
    (value.current_run_id === null || isNonEmptyString(value.current_run_id)) &&
    isStringArray(value.session_run_ids) &&
    value.session_run_ids.every(isNonEmptyString) &&
    new Set(value.session_run_ids).size === value.session_run_ids.length &&
    (value.current_run_id === null || value.session_run_ids.includes(value.current_run_id)) &&
    (value.selected_project_id === null || isNonEmptyString(value.selected_project_id)) &&
    (value.selected_saved_batch_id === null || isNonEmptyString(value.selected_saved_batch_id)) &&
    (value.saved_batch_base_revision === null ||
      (isInteger(value.saved_batch_base_revision) && value.saved_batch_base_revision >= 1)) &&
    ((value.selected_saved_batch_id === null) === (value.saved_batch_base_revision === null))
    && (value.source_run_id === null || isNonEmptyString(value.source_run_id))
    && (value.source_run_id !== null || !hasHistoricalImportCopyResolutions(value.draft))
  );
}

function isStoredBatchForm(value: unknown): value is StoredBatchForm {
  if (!isRecord(value)) {
    return false;
  }
  const stringFields = [
    "projectId",
    "projectFilesystemKey",
    "projectName",
    "batchId",
    "batchFilesystemKey",
    "batchName",
    "batchDescription",
    "seedValues",
    "randomSeedCount",
    "workflowName",
    "workflowProfileName",
  ] as const;
  return (
    hasExactKeys(value, [
      "projectId",
      "projectFilesystemKey",
      "projectName",
      "batchId",
      "batchFilesystemKey",
      "batchName",
      "batchDescription",
      "prompts",
      "variableBindings",
      "imageBindings",
      "parameterBindings",
      "linkedParameterSets",
      "seedMode",
      "seedValues",
      "randomSeedCount",
      "workflowJson",
      "workflowProfileJson",
      "workflowLibraryProjectId",
      "workflowId",
      "workflowName",
      "workflowVersionId",
      "workflowVersionNumber",
      "workflowContentSha256",
      "workflowProfileId",
      "workflowProfileName",
      "workflowProfileVersionId",
      "workflowProfileVersionNumber",
      "workflowProfileWorkflowVersionId",
      "workflowProfileContentSha256",
      "historicalImportCopyResolutions",
    ]) &&
    stringFields.every((field) => typeof value[field] === "string") &&
    (typeof value.workflowJson === "string" ||
      (value.workflowJson === null && isNonEmptyString(value.workflowVersionId))) &&
    (typeof value.workflowProfileJson === "string" ||
      (value.workflowProfileJson === null && isNonEmptyString(value.workflowProfileVersionId))) &&
    Array.isArray(value.prompts) &&
    value.prompts.every(isStoredPrompt) &&
    Array.isArray(value.variableBindings) &&
    value.variableBindings.every(isStoredVariableBinding) &&
    isImageBindings(value.imageBindings) &&
    isParameterBindings(value.parameterBindings) &&
    isLinkedParameterSets(value.linkedParameterSets) &&
    parameterPartitionIsUnique(value.parameterBindings, value.linkedParameterSets) &&
    (value.seedMode === "fixed" || value.seedMode === "explicit" || value.seedMode === "random") &&
    isNullableString(value.workflowLibraryProjectId) &&
    isNullableString(value.workflowId) &&
    isNullableString(value.workflowVersionId) &&
    isNullableInteger(value.workflowVersionNumber) &&
    isNullableString(value.workflowContentSha256) &&
    isNullableString(value.workflowProfileId) &&
    isNullableString(value.workflowProfileVersionId) &&
    isNullableInteger(value.workflowProfileVersionNumber) &&
    isNullableString(value.workflowProfileWorkflowVersionId) &&
    isNullableString(value.workflowProfileContentSha256) &&
    isHistoricalImportCopyResolutions(value.historicalImportCopyResolutions)
  );
}

function isHistoricalImportCopyResolutions(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    "promptVersions",
    "workflowVersion",
    "workflowProfileVersion",
  ])) return false;
  if (!Array.isArray(value.promptVersions) || !value.promptVersions.every((resolution) => (
    isRecord(resolution)
    && hasExactKeys(resolution, ["position", "historicalVersionId", "copiedVersionId"])
    && isInteger(resolution.position)
    && resolution.position >= 0
    && isNonEmptyString(resolution.historicalVersionId)
    && isNonEmptyString(resolution.copiedVersionId)
    && resolution.historicalVersionId !== resolution.copiedVersionId
  ))) return false;
  const positions = value.promptVersions.map((resolution) => (resolution as { position: number }).position);
  const copiedIds = value.promptVersions.map((resolution) => (resolution as { copiedVersionId: string }).copiedVersionId);
  return new Set(positions).size === positions.length
    && new Set(copiedIds).size === copiedIds.length
    && isNullableVersionCopyResolution(value.workflowVersion)
    && isNullableVersionCopyResolution(value.workflowProfileVersion);
}

function isNullableVersionCopyResolution(value: unknown): boolean {
  return value === null || (
    isRecord(value)
    && hasExactKeys(value, ["historicalVersionId", "copiedVersionId"])
    && isNonEmptyString(value.historicalVersionId)
    && isNonEmptyString(value.copiedVersionId)
    && value.historicalVersionId !== value.copiedVersionId
  );
}

function hasHistoricalImportCopyResolutions(value: StoredBatchForm): boolean {
  const resolutions = value.historicalImportCopyResolutions;
  return resolutions.promptVersions.length > 0
    || resolutions.workflowVersion !== null
    || resolutions.workflowProfileVersion !== null;
}

function isLinkedParameterSets(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every((set) => (
    isRecord(set)
    && hasExactKeys(set, ["setKey", "setLabel", "members", "rows"])
    && isStableKey(set.setKey)
    && typeof set.setLabel === "string"
    && Array.isArray(set.members)
    && set.members.length >= 2
    && set.members.every((member: unknown) => isRecord(member)
      && hasExactKeys(member, ["parameterKey", "valueType"])
      && isStableKey(member.parameterKey)
      && ["string", "integer", "float", "boolean"].includes(String(member.valueType)))
    && new Set(set.members.map((member: unknown) => (member as { parameterKey: string }).parameterKey)).size === set.members.length
    && Array.isArray(set.rows)
    && set.rows.length >= 1
    && set.rows.every((row) => isRecord(row)
      && hasExactKeys(row, ["rowLabel", "values"])
      && typeof row.rowLabel === "string"
      && isRecord(row.values)
      && Object.keys(row.values).length === (set.members as unknown[]).length
      && (set.members as unknown[]).every((member: unknown) => {
        const parameterKey = (member as { parameterKey: string }).parameterKey;
        const cell = (row.values as Record<string, unknown>)[parameterKey];
        return isRecord(cell) && (
          (hasExactKeys(cell, ["kind"]) && cell.kind === "base")
          || (hasExactKeys(cell, ["kind", "value"]) && cell.kind === "override" && typeof cell.value === "string")
        );
      }))
  ))) return false;
  const keys = value.map((set) => (set as { setKey: string }).setKey);
  const allMembers = value.flatMap((set) => (set as { members: Array<{ parameterKey: string }> }).members.map((member) => member.parameterKey));
  return new Set(keys).size === keys.length && new Set(allMembers).size === allMembers.length;
}

function parameterPartitionIsUnique(bindings: unknown, sets: unknown): boolean {
  const independent = (bindings as Array<{ parameterKey: string }>).map((binding) => binding.parameterKey);
  const linked = (sets as Array<{ members: Array<{ parameterKey: string }> }>).flatMap((set) => set.members.map((member) => member.parameterKey));
  return new Set([...independent, ...linked]).size === independent.length + linked.length;
}

function isStableKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value);
}

function isParameterBindings(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every((binding) => (
    isRecord(binding)
    && hasExactKeys(binding, ["parameterKey", "valueType", "mode", "alternatives", "range"])
    && isStableKey(binding.parameterKey)
    && ["string", "integer", "float", "boolean"].includes(String(binding.valueType))
    && (binding.mode === "values" || binding.mode === "range")
    && (binding.mode !== "range" || binding.valueType === "integer" || binding.valueType === "float")
    && Array.isArray(binding.alternatives)
    && binding.alternatives.every((alternative) => (
      isRecord(alternative)
      && (
        (hasExactKeys(alternative, ["kind"]) && alternative.kind === "base")
        || (hasExactKeys(alternative, ["kind", "value"])
          && alternative.kind === "override"
          && typeof alternative.value === "string")
      )
    ))
    && binding.alternatives.filter((alternative) => alternative.kind === "base").length <= 1
    && (!binding.alternatives.some((alternative) => alternative.kind === "base")
      || binding.alternatives[0]?.kind === "base")
    && isRecord(binding.range)
    && hasExactKeys(binding.range, ["start", "end", "step", "includeBase"])
    && typeof binding.range.start === "string"
    && typeof binding.range.end === "string"
    && typeof binding.range.step === "string"
    && typeof binding.range.includeBase === "boolean"
  ))) return false;
  const keys = value.map((binding) => (binding as { parameterKey: string }).parameterKey);
  return new Set(keys).size === keys.length;
}

function isImageBindings(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every((binding) => (
    isRecord(binding)
    && hasExactKeys(binding, ["slot_key", "values"])
    && isNonEmptyString(binding.slot_key)
    && Array.isArray(binding.values)
    && binding.values.length >= 1
    && binding.values.every((item) => item === null || isNonEmptyString(item))
    && new Set(binding.values).size === binding.values.length
    && (!binding.values.includes(null) || binding.values[0] === null)
  ))) return false;
  const keys = value.map((binding) => (binding as { slot_key: string }).slot_key);
  return new Set(keys).size === keys.length;
}

function isStoredPrompt(value: unknown): value is StoredPrompt {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "libraryProjectId",
      "promptId",
      "promptName",
      "versionId",
      "versionNumber",
      "snapshotName",
      "text",
      "historicalPosition",
    ]) &&
    isNullableString(value.libraryProjectId) &&
    isNullableString(value.promptId) &&
    typeof value.promptName === "string" &&
    typeof value.versionId === "string" &&
    isNullableInteger(value.versionNumber) &&
    typeof value.snapshotName === "string" &&
    typeof value.text === "string" &&
    (value.historicalPosition === null
      || (isInteger(value.historicalPosition) && value.historicalPosition >= 0))
  );
}

function isStoredVariableBinding(value: unknown): value is StoredVariableBinding {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["placeholder", "values"]) &&
    typeof value.placeholder === "string" &&
    isStringArray(value.values)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || isInteger(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
