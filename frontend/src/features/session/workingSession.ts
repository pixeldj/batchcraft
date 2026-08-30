import {
  initialBatchForm,
  newPrompt,
  newVariableBinding,
  type BatchFormState,
  type PromptForm,
  type VariableBindingForm,
} from "../batch/form";

export const WORKING_SESSION_KEY = "batchcraft.working-session";
const WORKING_SESSION_VERSION = 6;

type StoredVariableBinding = Omit<VariableBindingForm, "key">;
type StoredPrompt = Omit<PromptForm, "key">;
interface StoredPromptV4 {
  versionId: string;
  name: string;
  text: string;
}

interface StoredBatchForm extends Omit<BatchFormState, "prompts" | "variableBindings"> {
  prompts: StoredPrompt[];
  variableBindings: StoredVariableBinding[];
}

type LegacyStoredBatchForm = Omit<StoredBatchForm, "prompts" | "randomSeedCount" | "seedMode"> & {
  promptVersionId: string;
  promptText: string;
  seedMode: "fixed" | "explicit";
};

type LegacyStoredBatchFormV3 = Omit<StoredBatchForm, "prompts"> & {
  promptVersionId: string;
  promptText: string;
};

interface WorkingSessionEnvelopeV1 {
  version: 1;
  form: LegacyStoredBatchForm;
  current_run_id: string | null;
}

interface WorkingSessionEnvelopeV2 {
  version: 2;
  form: LegacyStoredBatchForm;
  current_run_id: string | null;
  session_run_ids: string[];
}

interface WorkingSessionEnvelopeV3 {
  version: 3;
  form: LegacyStoredBatchFormV3;
  current_run_id: string | null;
  session_run_ids: string[];
}

interface WorkingSessionEnvelopeV4 {
  version: 4;
  form: Omit<StoredBatchForm, "prompts"> & { prompts: StoredPromptV4[] };
  current_run_id: string | null;
  session_run_ids: string[];
}

interface WorkingSessionEnvelopeV5 {
  version: 5;
  form: StoredBatchForm;
  current_run_id: string | null;
  session_run_ids: string[];
}

interface WorkingSessionEnvelopeV6 {
  version: 6;
  form: StoredBatchForm;
  current_run_id: string | null;
  session_run_ids: string[];
  selected_project_id: string | null;
}

export interface RestoredWorkingSession {
  form: BatchFormState;
  currentRunId: string | null;
  sessionRunIds: string[];
  selectedProjectId: string | null;
  draftRestored: boolean;
}

export function loadWorkingSession(
  storage: Storage | null = browserSessionStorage(),
): RestoredWorkingSession {
  if (!storage) {
    return defaultSession();
  }
  try {
    const raw = storage.getItem(WORKING_SESSION_KEY);
    if (raw === null) {
      return defaultSession();
    }
    const value: unknown = JSON.parse(raw);
    if (isWorkingSessionEnvelopeV6(value)) {
      return restoredSession(
        value.form,
        value.current_run_id,
        value.session_run_ids,
        value.selected_project_id,
      );
    }
    if (isWorkingSessionEnvelopeV5(value)) {
      return restoredSession(
        value.form,
        value.current_run_id,
        value.session_run_ids,
        projectCandidate(value.form),
      );
    }
    if (isWorkingSessionEnvelopeV4(value)) {
      return restoredSession(
        migrateV4Form(value.form),
        value.current_run_id,
        value.session_run_ids,
        projectCandidate(value.form),
      );
    }
    if (isWorkingSessionEnvelopeV3(value)) {
      return restoredSession(
        migrateLegacyForm(value.form),
        value.current_run_id,
        value.session_run_ids,
        projectCandidate(value.form),
      );
    }
    if (isWorkingSessionEnvelopeV2(value)) {
      return restoredSession(
        migrateLegacyForm(value.form),
        value.current_run_id,
        value.session_run_ids,
        projectCandidate(value.form),
      );
    }
    if (isWorkingSessionEnvelopeV1(value)) {
      return restoredSession(
        migrateLegacyForm(value.form),
        value.current_run_id,
        value.current_run_id === null ? [] : [value.current_run_id],
        projectCandidate(value.form),
      );
    }
    return defaultSession();
  } catch {
    return defaultSession();
  }
}

export function saveWorkingSession(
  form: BatchFormState,
  currentRunId: string | null,
  sessionRunIds: string[] = [],
  selectedProjectId: string | null = null,
  storage: Storage | null = browserSessionStorage(),
): void {
  if (!storage) {
    return;
  }
  const envelope: WorkingSessionEnvelopeV6 = {
    version: WORKING_SESSION_VERSION,
    form: dehydrateForm(form),
    current_run_id: currentRunId,
    session_run_ids: uniqueStrings(sessionRunIds),
    selected_project_id: selectedProjectId,
  };
  try {
    storage.setItem(WORKING_SESSION_KEY, JSON.stringify(envelope));
  } catch {
    // Browser storage is only a convenience; the live editor remains authoritative.
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
    variableBindings: form.variableBindings.map((binding) => ({
      placeholder: binding.placeholder,
      variableListId: binding.variableListId,
      values: binding.values,
      mode: binding.mode,
      selectedValues: binding.selectedValues,
      fixedValue: binding.fixedValue,
    })),
  };
}

function hydrateForm(form: StoredBatchForm): BatchFormState {
  return {
    ...form,
    prompts: form.prompts.map((prompt) => ({
      ...prompt,
      key: newPrompt().key,
    })),
    variableBindings: form.variableBindings.map((binding) => ({
      ...binding,
      key: newVariableBinding().key,
    })),
  };
}

function migrateLegacyForm(
  form: LegacyStoredBatchForm | LegacyStoredBatchFormV3,
): StoredBatchForm {
  const { promptVersionId, promptText, ...rest } = form;
  return {
    ...rest,
    prompts: [detachedPrompt(promptVersionId, "Prompt 1", promptText)],
    randomSeedCount: "randomSeedCount" in form ? form.randomSeedCount : "1",
  };
}

function migrateV4Form(form: WorkingSessionEnvelopeV4["form"]): StoredBatchForm {
  return {
    ...form,
    prompts: form.prompts.map(({ versionId, name, text }) => detachedPrompt(versionId, name, text)),
  };
}

function detachedPrompt(versionId: string, name: string, text: string): StoredPrompt {
  return {
    libraryProjectId: null,
    promptId: null,
    promptName: name,
    versionId,
    versionNumber: null,
    snapshotName: name,
    text,
  };
}

function defaultSession(): RestoredWorkingSession {
  return {
    form: initialBatchForm(),
    currentRunId: null,
    sessionRunIds: [],
    selectedProjectId: null,
    draftRestored: false,
  };
}

function restoredSession(
  form: StoredBatchForm,
  currentRunId: string | null,
  sessionRunIds: string[],
  selectedProjectId: string | null,
): RestoredWorkingSession {
  return {
    form: hydrateForm(form),
    currentRunId,
    sessionRunIds: uniqueStrings(sessionRunIds),
    selectedProjectId,
    draftRestored: true,
  };
}

function browserSessionStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function isWorkingSessionEnvelopeV1(value: unknown): value is WorkingSessionEnvelopeV1 {
  if (!isRecord(value) || value.version !== 1 || !isLegacyStoredBatchForm(value.form)) {
    return false;
  }
  return value.current_run_id === null || isNonEmptyString(value.current_run_id);
}

function isWorkingSessionEnvelopeV2(value: unknown): value is WorkingSessionEnvelopeV2 {
  return (
    isRecord(value) &&
    value.version === 2 &&
    isLegacyStoredBatchForm(value.form) &&
    (value.current_run_id === null || isNonEmptyString(value.current_run_id)) &&
    isStringArray(value.session_run_ids) &&
    value.session_run_ids.every(isNonEmptyString)
  );
}

function isWorkingSessionEnvelopeV3(value: unknown): value is WorkingSessionEnvelopeV3 {
  return (
    isRecord(value) &&
    value.version === 3 &&
    isLegacyStoredBatchFormV3(value.form) &&
    (value.current_run_id === null || isNonEmptyString(value.current_run_id)) &&
    isStringArray(value.session_run_ids) &&
    value.session_run_ids.every(isNonEmptyString)
  );
}

function isWorkingSessionEnvelopeV4(value: unknown): value is WorkingSessionEnvelopeV4 {
  return (
    isRecord(value) &&
    value.version === 4 &&
    isStoredBatchFormV4(value.form) &&
    (value.current_run_id === null || isNonEmptyString(value.current_run_id)) &&
    isStringArray(value.session_run_ids) &&
    value.session_run_ids.every(isNonEmptyString)
  );
}

function isWorkingSessionEnvelopeV5(value: unknown): value is WorkingSessionEnvelopeV5 {
  return (
    isRecord(value) &&
    value.version === 5 &&
    isStoredBatchForm(value.form) &&
    (value.current_run_id === null || isNonEmptyString(value.current_run_id)) &&
    isStringArray(value.session_run_ids) &&
    value.session_run_ids.every(isNonEmptyString)
  );
}

function isWorkingSessionEnvelopeV6(value: unknown): value is WorkingSessionEnvelopeV6 {
  return (
    isRecord(value) &&
    value.version === WORKING_SESSION_VERSION &&
    isStoredBatchForm(value.form) &&
    (value.current_run_id === null || isNonEmptyString(value.current_run_id)) &&
    isStringArray(value.session_run_ids) &&
    value.session_run_ids.every(isNonEmptyString) &&
    (value.selected_project_id === null || isNonEmptyString(value.selected_project_id))
  );
}

function isStoredBatchForm(value: unknown): value is StoredBatchForm {
  return (
    isStoredBatchFormShape(value) &&
    Array.isArray(value.prompts) &&
    value.prompts.every(isStoredPrompt) &&
    typeof value.randomSeedCount === "string" &&
    (value.seedMode === "fixed" || value.seedMode === "explicit" || value.seedMode === "random")
  );
}

function isStoredBatchFormV4(value: unknown): value is WorkingSessionEnvelopeV4["form"] {
  return (
    isStoredBatchFormShape(value) &&
    Array.isArray(value.prompts) &&
    value.prompts.length > 0 &&
    value.prompts.every(isStoredPromptV4) &&
    typeof value.randomSeedCount === "string" &&
    (value.seedMode === "fixed" || value.seedMode === "explicit" || value.seedMode === "random")
  );
}

function isLegacyStoredBatchForm(value: unknown): value is LegacyStoredBatchForm {
  return isLegacyStoredBatchFormShape(value) &&
    (value.seedMode === "fixed" || value.seedMode === "explicit");
}

function isLegacyStoredBatchFormV3(value: unknown): value is LegacyStoredBatchFormV3 {
  return (
    isLegacyStoredBatchFormShape(value) &&
    typeof value.randomSeedCount === "string" &&
    (value.seedMode === "fixed" || value.seedMode === "explicit" || value.seedMode === "random")
  );
}

function isStoredBatchFormShape(value: unknown): value is Record<string, unknown> {
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
    "seedValues",
    "workflowJson",
    "workflowProfileJson",
  ] as const;
  return (
    stringFields.every((field) => typeof value[field] === "string") &&
    Array.isArray(value.variableBindings) &&
    value.variableBindings.every(isStoredVariableBinding) &&
    isStringArray(value.referenceAssetIds)
  );
}

function isLegacyStoredBatchFormShape(value: unknown): value is Record<string, unknown> {
  return (
    isStoredBatchFormShape(value) &&
    typeof value.promptVersionId === "string" &&
    typeof value.promptText === "string"
  );
}

function isStoredPrompt(value: unknown): value is StoredPrompt {
  return (
    isRecord(value) &&
    (value.libraryProjectId === null || typeof value.libraryProjectId === "string") &&
    (value.promptId === null || typeof value.promptId === "string") &&
    typeof value.promptName === "string" &&
    typeof value.versionId === "string" &&
    (value.versionNumber === null ||
      (typeof value.versionNumber === "number" && Number.isInteger(value.versionNumber))) &&
    typeof value.snapshotName === "string" &&
    typeof value.text === "string"
  );
}

function isStoredPromptV4(value: unknown): value is StoredPromptV4 {
  return (
    isRecord(value) &&
    typeof value.versionId === "string" &&
    typeof value.name === "string" &&
    typeof value.text === "string"
  );
}

function isStoredVariableBinding(value: unknown): value is StoredVariableBinding {
  return (
    isRecord(value) &&
    typeof value.placeholder === "string" &&
    typeof value.variableListId === "string" &&
    typeof value.values === "string" &&
    (value.mode === "all" || value.mode === "fixed") &&
    typeof value.selectedValues === "string" &&
    typeof value.fixedValue === "string"
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function projectCandidate(form: { projectId: string }): string | null {
  return form.projectId.trim() || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
