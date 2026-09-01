import {
  initialBatchForm,
  newPrompt,
  newVariableBinding,
  profileParameters,
  reconcileParameterBindings,
  type BatchFormState,
  type PromptForm,
  type VariableBindingForm,
} from "../batch/form";

export const WORKING_SESSION_RECOVERY_KEY = "batchcraft.working-session-recovery.v1";
const WORKING_SESSION_RECOVERY_VERSION = 1;

type StoredVariableBinding = Omit<VariableBindingForm, "key">;
type StoredPrompt = Omit<PromptForm, "key">;

interface StoredBatchForm extends Omit<
  BatchFormState,
  "prompts" | "variableBindings" | "workflowJson" | "workflowProfileJson"
> {
  prompts: StoredPrompt[];
  variableBindings: StoredVariableBinding[];
  workflowJson: string | null;
  workflowProfileJson: string | null;
}

interface WorkingSessionRecoveryV1 {
  format_version: 1;
  updated_at: string;
  draft: StoredBatchForm;
  current_run_id: string | null;
  session_run_ids: string[];
  selected_project_id: string | null;
  selected_saved_batch_id: string | null;
  saved_batch_base_revision: number | null;
}

export interface RestoredWorkingSession {
  form: BatchFormState;
  currentRunId: string | null;
  sessionRunIds: string[];
  selectedProjectId: string | null;
  selectedSavedBatchId: string | null;
  savedBatchBaseRevision: number | null;
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
    if (!isWorkingSessionRecoveryV1(value)) {
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
): void {
  if (!storage) {
    return;
  }
  const normalizedRunIds = uniqueStrings(sessionRunIds);
  if (currentRunId && !normalizedRunIds.includes(currentRunId)) {
    normalizedRunIds.push(currentRunId);
  }
  const envelope: WorkingSessionRecoveryV1 = {
    format_version: WORKING_SESSION_RECOVERY_VERSION,
    updated_at: new Date().toISOString(),
    draft: dehydrateForm(form),
    current_run_id: currentRunId,
    session_run_ids: normalizedRunIds,
    selected_project_id: selectedProjectId,
    selected_saved_batch_id: selectedSavedBatchId,
    saved_batch_base_revision: savedBatchBaseRevision,
  };
  try {
    storage.setItem(WORKING_SESSION_RECOVERY_KEY, JSON.stringify(envelope));
  } catch {
    // Recovery is best effort; the live editor remains usable without browser storage.
  }
}

function dehydrateForm(form: BatchFormState): StoredBatchForm {
  return {
    ...form,
    prompts: form.prompts.map(({
      libraryProjectId,
      promptId,
      promptName,
      versionId,
      versionNumber,
      snapshotName,
      text,
    }) => ({
      libraryProjectId,
      promptId,
      promptName,
      versionId,
      versionNumber,
      snapshotName,
      text,
    })),
    variableBindings: form.variableBindings.map(({ placeholder, values }) => ({
      placeholder,
      values: [...values],
    })),
    workflowJson: form.workflowVersionId ? null : form.workflowJson,
    workflowProfileJson: form.workflowProfileVersionId ? null : form.workflowProfileJson,
  };
}

function hydrateForm(form: StoredBatchForm): BatchFormState {
  const workflowProfileJson = form.workflowProfileJson ?? "{}";
  return {
    ...form,
    workflowJson: form.workflowJson ?? "{}",
    workflowProfileJson,
    prompts: form.prompts.map((prompt) => ({
      ...prompt,
      key: newPrompt().key,
    })),
    variableBindings: form.variableBindings.map((binding) => ({
      ...binding,
      key: newVariableBinding().key,
    })),
    parameterBindings: form.workflowProfileJson === null
      ? form.parameterBindings
      : reconcileParameterBindings(
        form.parameterBindings,
        profileParameters(workflowProfileJson),
      ),
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
    workflowSnapshotRecoveryRequired: false,
    profileSnapshotRecoveryRequired: false,
    draftRestored: false,
  };
}

function restoredSession(value: WorkingSessionRecoveryV1): RestoredWorkingSession {
  return {
    form: hydrateForm(value.draft),
    currentRunId: value.current_run_id,
    sessionRunIds: uniqueStrings(value.session_run_ids),
    selectedProjectId: value.selected_project_id,
    selectedSavedBatchId: value.selected_saved_batch_id,
    savedBatchBaseRevision: value.saved_batch_base_revision,
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

function isWorkingSessionRecoveryV1(value: unknown): value is WorkingSessionRecoveryV1 {
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
    isNullableString(value.workflowProfileContentSha256)
  );
}

function isParameterBindings(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every((binding) => (
    isRecord(binding)
    && hasExactKeys(binding, ["parameterKey", "valueType", "mode", "alternatives", "range"])
    && isNonEmptyString(binding.parameterKey)
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
    ]) &&
    isNullableString(value.libraryProjectId) &&
    isNullableString(value.promptId) &&
    typeof value.promptName === "string" &&
    typeof value.versionId === "string" &&
    isNullableInteger(value.versionNumber) &&
    typeof value.snapshotName === "string" &&
    typeof value.text === "string"
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
