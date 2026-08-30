import {
  initialBatchForm,
  newPrompt,
  newVariableBinding,
  type BatchFormState,
  type PromptForm,
  type VariableBindingForm,
} from "../batch/form";

export const WORKING_SESSION_KEY = "batchcraft.working-session";
const WORKING_SESSION_VERSION = 8;

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

type StoredBatchFormV7 = Omit<StoredBatchForm,
  "batchDescription" | "workflowContentSha256" | "workflowProfileContentSha256"
>;

type StoredBatchFormV6 = Omit<StoredBatchFormV7,
  | "workflowLibraryProjectId"
  | "workflowId"
  | "workflowName"
  | "workflowVersionId"
  | "workflowVersionNumber"
  | "workflowProfileId"
  | "workflowProfileName"
  | "workflowProfileVersionId"
  | "workflowProfileVersionNumber"
  | "workflowProfileWorkflowVersionId"
>;

type LegacyStoredBatchForm = Omit<StoredBatchFormV6, "prompts" | "randomSeedCount" | "seedMode"> & {
  promptVersionId: string;
  promptText: string;
  seedMode: "fixed" | "explicit";
};

type LegacyStoredBatchFormV3 = Omit<StoredBatchFormV6, "prompts"> & {
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
  form: Omit<StoredBatchFormV6, "prompts"> & { prompts: StoredPromptV4[] };
  current_run_id: string | null;
  session_run_ids: string[];
}

interface WorkingSessionEnvelopeV5 {
  version: 5;
  form: StoredBatchFormV6;
  current_run_id: string | null;
  session_run_ids: string[];
}

interface WorkingSessionEnvelopeV6 {
  version: 6;
  form: StoredBatchFormV6;
  current_run_id: string | null;
  session_run_ids: string[];
  selected_project_id: string | null;
}

interface WorkingSessionEnvelopeV7 {
  version: 7;
  form: StoredBatchFormV7;
  current_run_id: string | null;
  session_run_ids: string[];
  selected_project_id: string | null;
}

interface WorkingSessionEnvelopeV8 {
  version: 8;
  form: StoredBatchForm;
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
    if (isWorkingSessionEnvelopeV8(value)) {
      return restoredSession(
        value.form,
        value.current_run_id,
        value.session_run_ids,
        value.selected_project_id,
        value.selected_saved_batch_id,
        value.saved_batch_base_revision,
      );
    }
    if (isWorkingSessionEnvelopeV7(value)) {
      return restoredSession(
        migrateV7Form(value.form),
        value.current_run_id,
        value.session_run_ids,
        value.selected_project_id,
      );
    }
    if (isWorkingSessionEnvelopeV6(value)) {
      return restoredSession(
        migrateV6Form(value.form),
        value.current_run_id,
        value.session_run_ids,
        value.selected_project_id,
      );
    }
    if (isWorkingSessionEnvelopeV5(value)) {
      return restoredSession(
        migrateV6Form(value.form),
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
  selectedSavedBatchId: string | null = null,
  savedBatchBaseRevision: number | null = null,
): void {
  if (!storage) {
    return;
  }
  const envelope: WorkingSessionEnvelopeV8 = {
    version: WORKING_SESSION_VERSION,
    form: dehydrateForm(form),
    current_run_id: currentRunId,
    session_run_ids: uniqueStrings(sessionRunIds),
    selected_project_id: selectedProjectId,
    selected_saved_batch_id: selectedSavedBatchId,
    saved_batch_base_revision: savedBatchBaseRevision,
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
  return migrateV6Form({
    ...rest,
    prompts: [detachedPrompt(promptVersionId, "Prompt 1", promptText)],
    randomSeedCount: "randomSeedCount" in form ? form.randomSeedCount : "1",
  });
}

function migrateV4Form(form: WorkingSessionEnvelopeV4["form"]): StoredBatchForm {
  return migrateV6Form({
    ...form,
    prompts: form.prompts.map(({ versionId, name, text }) => detachedPrompt(versionId, name, text)),
  });
}

function migrateV6Form(form: StoredBatchFormV6): StoredBatchForm {
  return {
    ...form,
    workflowLibraryProjectId: null,
    workflowId: null,
    workflowName: "",
    workflowVersionId: null,
    workflowVersionNumber: null,
    workflowContentSha256: null,
    workflowProfileId: null,
    workflowProfileName: "",
    workflowProfileVersionId: null,
    workflowProfileVersionNumber: null,
    workflowProfileWorkflowVersionId: null,
    workflowProfileContentSha256: null,
    batchDescription: "",
  };
}

function migrateV7Form(form: StoredBatchFormV7): StoredBatchForm {
  return {
    ...form,
    batchDescription: "",
    workflowContentSha256: null,
    workflowProfileContentSha256: null,
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
    selectedSavedBatchId: null,
    savedBatchBaseRevision: null,
    draftRestored: false,
  };
}

function restoredSession(
  form: StoredBatchForm,
  currentRunId: string | null,
  sessionRunIds: string[],
  selectedProjectId: string | null,
  selectedSavedBatchId: string | null = null,
  savedBatchBaseRevision: number | null = null,
): RestoredWorkingSession {
  return {
    form: hydrateForm(form),
    currentRunId,
    sessionRunIds: uniqueStrings(sessionRunIds),
    selectedProjectId,
    selectedSavedBatchId,
    savedBatchBaseRevision,
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
    isStoredBatchFormV6(value.form) &&
    (value.current_run_id === null || isNonEmptyString(value.current_run_id)) &&
    isStringArray(value.session_run_ids) &&
    value.session_run_ids.every(isNonEmptyString)
  );
}

function isWorkingSessionEnvelopeV6(value: unknown): value is WorkingSessionEnvelopeV6 {
  return (
    isRecord(value) &&
    value.version === 6 &&
    isStoredBatchFormV6(value.form) &&
    (value.current_run_id === null || isNonEmptyString(value.current_run_id)) &&
    isStringArray(value.session_run_ids) &&
    value.session_run_ids.every(isNonEmptyString) &&
    (value.selected_project_id === null || isNonEmptyString(value.selected_project_id))
  );
}

function isWorkingSessionEnvelopeV7(value: unknown): value is WorkingSessionEnvelopeV7 {
  return (
    isRecord(value) &&
    value.version === 7 &&
    isStoredBatchFormV7(value.form) &&
    (value.current_run_id === null || isNonEmptyString(value.current_run_id)) &&
    isStringArray(value.session_run_ids) &&
    value.session_run_ids.every(isNonEmptyString) &&
    (value.selected_project_id === null || isNonEmptyString(value.selected_project_id))
  );
}

function isWorkingSessionEnvelopeV8(value: unknown): value is WorkingSessionEnvelopeV8 {
  return (
    isRecord(value) &&
    value.version === WORKING_SESSION_VERSION &&
    isStoredBatchForm(value.form) &&
    (value.current_run_id === null || isNonEmptyString(value.current_run_id)) &&
    isStringArray(value.session_run_ids) &&
    value.session_run_ids.every(isNonEmptyString) &&
    (value.selected_project_id === null || isNonEmptyString(value.selected_project_id)) &&
    (value.selected_saved_batch_id === null || isNonEmptyString(value.selected_saved_batch_id)) &&
    (value.saved_batch_base_revision === null || (isInteger(value.saved_batch_base_revision) && value.saved_batch_base_revision >= 1))
  );
}

function isStoredBatchForm(value: unknown): value is StoredBatchForm {
  const links = value as Record<string, unknown>;
  return (
    isStoredBatchFormV7(value) &&
    typeof links.batchDescription === "string" &&
    (links.workflowContentSha256 === null || typeof links.workflowContentSha256 === "string") &&
    (links.workflowProfileContentSha256 === null || typeof links.workflowProfileContentSha256 === "string")
  );
}

function isStoredBatchFormV7(value: unknown): value is StoredBatchFormV7 {
  const links = value as Record<string, unknown>;
  return (
    isStoredBatchFormV6(value) &&
    (links.workflowLibraryProjectId === null || typeof links.workflowLibraryProjectId === "string") &&
    (links.workflowId === null || typeof links.workflowId === "string") &&
    typeof links.workflowName === "string" &&
    (links.workflowVersionId === null || typeof links.workflowVersionId === "string") &&
    (links.workflowVersionNumber === null || isInteger(links.workflowVersionNumber)) &&
    (links.workflowProfileId === null || typeof links.workflowProfileId === "string") &&
    typeof links.workflowProfileName === "string" &&
    (links.workflowProfileVersionId === null || typeof links.workflowProfileVersionId === "string") &&
    (links.workflowProfileVersionNumber === null || isInteger(links.workflowProfileVersionNumber)) &&
    (links.workflowProfileWorkflowVersionId === null || typeof links.workflowProfileWorkflowVersionId === "string")
  );
}

function isStoredBatchFormV6(value: unknown): value is StoredBatchFormV6 {
  return (
    isStoredBatchFormShape(value) &&
    Array.isArray(value.prompts) &&
    value.prompts.every(isStoredPrompt) &&
    typeof value.randomSeedCount === "string" &&
    (value.seedMode === "fixed" || value.seedMode === "explicit" || value.seedMode === "random")
  );
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
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
