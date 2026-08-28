import {
  initialBatchForm,
  newVariableBinding,
  type BatchFormState,
  type VariableBindingForm,
} from "../batch/form";

export const WORKING_SESSION_KEY = "batchcraft.working-session";
const WORKING_SESSION_VERSION = 3;

type StoredVariableBinding = Omit<VariableBindingForm, "key">;

interface StoredBatchForm extends Omit<BatchFormState, "variableBindings"> {
  variableBindings: StoredVariableBinding[];
}

type LegacyStoredBatchForm = Omit<StoredBatchForm, "randomSeedCount" | "seedMode"> & {
  seedMode: "fixed" | "explicit";
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
  form: StoredBatchForm;
  current_run_id: string | null;
  session_run_ids: string[];
}

export interface RestoredWorkingSession {
  form: BatchFormState;
  currentRunId: string | null;
  sessionRunIds: string[];
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
    if (isWorkingSessionEnvelopeV3(value)) {
      return restoredSession(value.form, value.current_run_id, value.session_run_ids);
    }
    if (isWorkingSessionEnvelopeV2(value)) {
      return restoredSession(
        migrateLegacyForm(value.form),
        value.current_run_id,
        value.session_run_ids,
      );
    }
    if (isWorkingSessionEnvelopeV1(value)) {
      return restoredSession(
        migrateLegacyForm(value.form),
        value.current_run_id,
        value.current_run_id === null ? [] : [value.current_run_id],
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
  storage: Storage | null = browserSessionStorage(),
): void {
  if (!storage) {
    return;
  }
  const envelope: WorkingSessionEnvelopeV3 = {
    version: WORKING_SESSION_VERSION,
    form: dehydrateForm(form),
    current_run_id: currentRunId,
    session_run_ids: uniqueStrings(sessionRunIds),
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
    variableBindings: form.variableBindings.map((binding) => ({
      ...binding,
      key: newVariableBinding().key,
    })),
  };
}

function migrateLegacyForm(form: LegacyStoredBatchForm): StoredBatchForm {
  return { ...form, randomSeedCount: "1" };
}

function defaultSession(): RestoredWorkingSession {
  return {
    form: initialBatchForm(),
    currentRunId: null,
    sessionRunIds: [],
    draftRestored: false,
  };
}

function restoredSession(
  form: StoredBatchForm,
  currentRunId: string | null,
  sessionRunIds: string[],
): RestoredWorkingSession {
  return {
    form: hydrateForm(form),
    currentRunId,
    sessionRunIds: uniqueStrings(sessionRunIds),
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
    value.version === WORKING_SESSION_VERSION &&
    isStoredBatchForm(value.form) &&
    (value.current_run_id === null || isNonEmptyString(value.current_run_id)) &&
    isStringArray(value.session_run_ids) &&
    value.session_run_ids.every(isNonEmptyString)
  );
}

function isStoredBatchForm(value: unknown): value is StoredBatchForm {
  return (
    isStoredBatchFormShape(value) &&
    typeof value.randomSeedCount === "string" &&
    (value.seedMode === "fixed" || value.seedMode === "explicit" || value.seedMode === "random")
  );
}

function isLegacyStoredBatchForm(value: unknown): value is LegacyStoredBatchForm {
  return isStoredBatchFormShape(value) &&
    (value.seedMode === "fixed" || value.seedMode === "explicit");
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
    "promptVersionId",
    "promptText",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
