import type {
  BatchRequest,
  EditableBatchSnapshot,
  ImageBindingRequest,
  JsonObject,
  ParameterBindingRequest,
  ParameterScalar,
  ParameterValueType,
  WorkflowProfileImageInput,
  WorkflowProfileParameter,
} from "../../api/types";

export interface VariableBindingForm {
  key: number;
  placeholder: string;
  values: string[];
}

export interface PromptForm {
  key: number;
  libraryProjectId: string | null;
  promptId: string | null;
  promptName: string;
  versionId: string;
  versionNumber: number | null;
  snapshotName: string;
  text: string;
}

export interface ParameterBindingForm {
  parameterKey: string;
  valueType: ParameterValueType;
  mode: "values" | "range";
  alternatives: ParameterAlternativeForm[];
  range: ParameterRangeDraft;
}

export interface ParameterRangeDraft {
  start: string;
  end: string;
  step: string;
  includeBase: boolean;
}

export type ParameterAlternativeForm =
  | { kind: "base" }
  | { kind: "override"; value: string };

export interface BatchFormState {
  projectId: string;
  projectFilesystemKey: string;
  projectName: string;
  batchId: string;
  batchFilesystemKey: string;
  batchName: string;
  batchDescription: string;
  prompts: PromptForm[];
  variableBindings: VariableBindingForm[];
  imageBindings: ImageBindingRequest[];
  parameterBindings: ParameterBindingForm[];
  seedMode: "fixed" | "explicit" | "random";
  seedValues: string;
  randomSeedCount: string;
  workflowJson: string;
  workflowProfileJson: string;
  workflowLibraryProjectId: string | null;
  workflowId: string | null;
  workflowName: string;
  workflowVersionId: string | null;
  workflowVersionNumber: number | null;
  workflowContentSha256: string | null;
  workflowProfileId: string | null;
  workflowProfileName: string;
  workflowProfileVersionId: string | null;
  workflowProfileVersionNumber: number | null;
  workflowProfileWorkflowVersionId: string | null;
  workflowProfileContentSha256: string | null;
}

export interface BatchRequestContext {
  sourceSavedBatch: { id: string; revision: number } | null;
}

export const MAX_RANDOM_SEED_COUNT = 100;
export const MAX_PARAMETER_ALTERNATIVES = 10_000;
const MAX_DECIMAL_LENGTH = 100;
const SIMPLE_DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

let nextVariableBindingKey = 1;
let nextPromptKey = 1;

export function newVariableBinding(): VariableBindingForm {
  return {
    key: nextVariableBindingKey++,
    placeholder: "variable",
    values: ["value one", "value two"],
  };
}

export function newPrompt(promptNumber = 1): PromptForm {
  const key = nextPromptKey++;
  return {
    key,
    libraryProjectId: null,
    promptId: null,
    promptName: `Prompt ${promptNumber}`,
    versionId: `prompt-v${promptNumber}`,
    versionNumber: null,
    snapshotName: `Prompt ${promptNumber}`,
    text: "",
  };
}

export function initialBatchForm(): BatchFormState {
  const binding = newVariableBinding();
  binding.placeholder = "subject";
  binding.values = ["cat", "dog"];

  return {
    projectId: "",
    projectFilesystemKey: "",
    projectName: "",
    batchId: "batch-1",
    batchFilesystemKey: "batch_1",
    batchName: "First experiment",
    batchDescription: "",
    prompts: [],
    variableBindings: [binding],
    imageBindings: [],
    parameterBindings: [],
    seedMode: "fixed",
    seedValues: "1",
    randomSeedCount: "1",
    workflowJson: "{}",
    workflowProfileJson: JSON.stringify(
      {
        id: "workflow-profile-1",
        name: "Workflow Profile",
        mappings: {
          prompt: { node_id: "", input_name: "", value_type: "string" },
          seed: { node_id: "", input_name: "", value_type: "integer" },
          output_prefix: { node_id: "", input_name: "", value_type: "string" },
        },
        image_inputs: [],
        parameters: [],
      },
      null,
      2,
    ),
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
  };
}

export class FormBuildError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "FormBuildError";
  }
}

export function buildBatchRequest(
  form: BatchFormState,
  context: BatchRequestContext = { sourceSavedBatch: null },
): BatchRequest {
  const batchSnapshot = buildEditableBatchSnapshot(form, context);
  const seedInput = form.seedMode === "random"
    ? { mode: "explicit" as const, values: generateRandomSeeds(parseRandomSeedCount(form.randomSeedCount)) }
    : { mode: form.seedMode, values: parseSeedValues(form.seedValues) };

  return {
    project: batchSnapshot.project,
    batch: {
      id: batchSnapshot.batch.id,
      filesystem_key: batchSnapshot.batch.filesystem_key,
      name: batchSnapshot.batch.name,
    },
    prompt_versions: batchSnapshot.prompt_versions.map(({ id, name, text }) => ({ id, name, text })),
    variable_bindings: batchSnapshot.variable_bindings,
    image_bindings: batchSnapshot.image_bindings,
    parameter_bindings: batchSnapshot.parameter_bindings,
    seeds: seedInput,
    workflow: batchSnapshot.workflow_selection.workflow,
    workflow_profile: batchSnapshot.workflow_selection.workflow_profile,
    batch_snapshot: batchSnapshot,
  };
}

export function buildEditableBatchSnapshot(
  form: BatchFormState,
  context: BatchRequestContext = { sourceSavedBatch: null },
): EditableBatchSnapshot {
  if (form.prompts.length === 0) {
    throw new FormBuildError("prompts", "Add at least one PromptVersion.");
  }
  const crossProjectPrompt = form.prompts.find(
    (prompt) => prompt.libraryProjectId !== null && prompt.libraryProjectId !== form.projectId.trim(),
  );
  if (crossProjectPrompt) {
    throw new FormBuildError(
      "prompts",
      `${crossProjectPrompt.promptName || crossProjectPrompt.snapshotName} belongs to another Project. Replace or remove it before Preview.`,
    );
  }
  if (form.workflowLibraryProjectId !== null) {
    if (form.workflowLibraryProjectId !== form.projectId.trim()) {
      throw new FormBuildError(
        "workflow",
        "The selected Workflow belongs to another Project. Replace it before Preview.",
      );
    }
    if (
      !form.workflowId ||
      !form.workflowVersionId ||
      !form.workflowProfileId ||
      !form.workflowProfileVersionId ||
      form.workflowProfileWorkflowVersionId !== form.workflowVersionId
    ) {
      throw new FormBuildError(
        "workflow_profile",
        "Choose a compatible ProfileVersion for the selected WorkflowVersion before Preview.",
      );
    }
  }
  const project = {
    id: required(form.projectId, "project", "Project ID"),
    filesystem_key: required(form.projectFilesystemKey, "project", "Project filesystem key"),
    name: required(form.projectName, "project", "Project name"),
  };
  const batch = {
    id: required(form.batchId, "batch", "Batch ID"),
    filesystem_key: required(form.batchFilesystemKey, "batch", "Batch filesystem key"),
    name: required(form.batchName, "batch", "Batch name"),
  };
  const promptVersions = form.prompts.map((prompt, index) => ({
    id: required(prompt.versionId, "prompts", `Prompt ${index + 1} ID`),
    name: required(prompt.snapshotName, "prompts", `Prompt ${index + 1} name`),
    text: prompt.text,
  }));
  const variableBindings = form.variableBindings.map((binding) => ({
    placeholder: required(binding.placeholder, "variables", "Placeholder"),
    values: normalizedBindingValues(binding.values),
  }));
  const workflow = parseJsonObject(form.workflowJson, "workflow", "Workflow");
  const workflowProfile = parseJsonObject(
    form.workflowProfileJson,
    "workflow_profile",
    "Workflow Profile",
  );
  if (!Array.isArray(workflowProfile.image_inputs) || !Array.isArray(workflowProfile.parameters)) {
    throw new FormBuildError(
      "workflow_profile",
      "Workflow Profile JSON must define image_inputs and parameters arrays.",
    );
  }
  const imageBindings = reconcileImageBindings(form.imageBindings, profileImageInputs(workflowProfile));
  validateImageBindings(imageBindings);
  const parameterBindings = buildParameterBindings(
    reconcileParameterBindings(form.parameterBindings, profileParameters(workflowProfile)),
  );
  const seedIntent = form.seedMode === "random"
    ? {
      mode: "random" as const,
      values: [],
      random_seed_count: parseRandomSeedCount(form.randomSeedCount),
    }
    : {
      mode: form.seedMode,
      values: parseSeedValues(form.seedValues),
      random_seed_count: null,
    };

  return {
    snapshot_version: 5,
    project,
    source_saved_batch: context.sourceSavedBatch,
    batch: { ...batch, description: form.batchDescription.trim() || null },
    prompt_versions: promptVersions.map((prompt, index) => ({
      ...prompt,
      prompt_id: form.prompts[index].promptId,
      version_number: form.prompts[index].versionNumber,
    })),
    variable_bindings: variableBindings,
    image_bindings: imageBindings,
    parameter_bindings: parameterBindings,
    seed_intent: seedIntent,
    workflow_selection: {
      workflow_id: form.workflowId,
      workflow_version_id: form.workflowVersionId,
      workflow_name: form.workflowName.trim() || null,
      workflow_version_number: form.workflowVersionNumber,
      workflow_profile_id: form.workflowProfileId,
      workflow_profile_version_id: form.workflowProfileVersionId,
      workflow_profile_name: form.workflowProfileName.trim() || null,
      workflow_profile_version_number: form.workflowProfileVersionNumber,
      workflow,
      workflow_profile: workflowProfile,
    },
  };
}

export function profileImageInputs(profile: JsonObject | string): WorkflowProfileImageInput[] {
  const parsed = typeof profile === "string" ? parseJsonObject(profile, "workflow_profile", "Workflow Profile") : profile;
  if (!Array.isArray(parsed.image_inputs)) return [];
  return parsed.image_inputs.flatMap((value) => {
    if (!isJsonObject(value)) return [];
    if (
      typeof value.key !== "string"
      || typeof value.label !== "string"
      || typeof value.node_id !== "string"
      || typeof value.input_name !== "string"
    ) return [];
    return [{ key: value.key, label: value.label, node_id: value.node_id, input_name: value.input_name }];
  });
}

export function profileParameters(profile: JsonObject | string): WorkflowProfileParameter[] {
  const parsed = typeof profile === "string" ? parseJsonObject(profile, "workflow_profile", "Workflow Profile") : profile;
  if (!Array.isArray(parsed.parameters)) return [];
  return parsed.parameters.flatMap((value) => {
    if (!isJsonObject(value)) return [];
    if (
      typeof value.key !== "string"
      || typeof value.label !== "string"
      || typeof value.node_id !== "string"
      || typeof value.input_name !== "string"
      || !isParameterValueType(value.value_type)
    ) return [];
    return [{
      key: value.key,
      label: value.label,
      node_id: value.node_id,
      input_name: value.input_name,
      value_type: value.value_type,
    }];
  });
}

export function reconcileImageBindings(
  current: ImageBindingRequest[],
  slots: WorkflowProfileImageInput[],
): ImageBindingRequest[] {
  const byKey = new Map(current.map((binding) => [binding.slot_key, binding.values]));
  return slots.map((slot) => ({
    slot_key: slot.key,
    values: normalizeImageBindingValues(byKey.get(slot.key)),
  }));
}

export function reconcileFormImageBindings(form: BatchFormState, profileJson: string): BatchFormState {
  return {
    ...form,
    imageBindings: reconcileImageBindings(form.imageBindings, profileImageInputs(profileJson)),
  };
}

export function reconcileParameterBindings(
  current: ParameterBindingForm[],
  parameters: WorkflowProfileParameter[],
): ParameterBindingForm[] {
  const byKey = new Map(current.map((binding) => [binding.parameterKey, binding]));
  return parameters.map((parameter) => {
    const existing = byKey.get(parameter.key);
    if (!existing) return {
      parameterKey: parameter.key,
      valueType: parameter.value_type,
      mode: "values",
      alternatives: [{ kind: "base" }],
      range: defaultParameterRange(parameter.value_type),
    };
    if (existing.valueType === parameter.value_type) return existing;
    return {
      parameterKey: parameter.key,
      valueType: parameter.value_type,
      mode: "values",
      alternatives: [{ kind: "base" }],
      range: defaultParameterRange(parameter.value_type),
    };
  });
}

export function reconcileFormBindings(form: BatchFormState, profileJson: string): BatchFormState {
  return {
    ...form,
    imageBindings: reconcileImageBindings(form.imageBindings, profileImageInputs(profileJson)),
    parameterBindings: reconcileParameterBindings(form.parameterBindings, profileParameters(profileJson)),
  };
}

export function buildParameterBindings(bindings: ParameterBindingForm[]): ParameterBindingRequest[] {
  return bindings.map((binding) => {
    if (binding.mode === "range") {
      parameterRangeCount(binding.range, binding.valueType, binding.parameterKey);
      return {
        parameter_key: binding.parameterKey,
        mode: "range",
        include_base: binding.range.includeBase,
        range: {
          start: binding.range.start,
          end: binding.range.end,
          step: binding.range.step,
        },
      };
    }
    if (binding.alternatives.length === 0) {
      throw new FormBuildError(
        "parameters",
        `${binding.parameterKey} must have at least one alternative.`,
      );
    }
    const values = binding.alternatives.map((alternative) => alternative.kind === "base"
      ? null
      : parseParameterValue(alternative.value, binding.valueType, binding.parameterKey));
    if (new Set(values).size !== values.length) {
      throw new FormBuildError(
        "parameters",
        `${binding.parameterKey} contains duplicate alternatives.`,
      );
    }
    if (values.includes(null) && values[0] !== null) {
      throw new FormBuildError(
        "parameters",
        `${binding.parameterKey} must place Base workflow first.`,
      );
    }
    return { parameter_key: binding.parameterKey, mode: "values", values };
  });
}

export function defaultParameterRange(valueType: ParameterValueType): ParameterRangeDraft {
  return valueType === "integer"
    ? { start: "0", end: "10", step: "1", includeBase: false }
    : { start: "0", end: "1", step: "0.1", includeBase: false };
}

export function parameterRangeCount(
  range: ParameterRangeDraft,
  valueType: ParameterValueType,
  label: string,
): number {
  if (valueType !== "integer" && valueType !== "float") {
    throw new FormBuildError("parameters", `${label} does not support Range mode.`);
  }
  const parsed = [range.start, range.end, range.step].map((raw, index) => (
    parseRangeDecimal(raw, valueType, label, ["start", "end", "step"][index])
  ));
  const scale = Math.max(...parsed.map((value) => value.scale));
  const [start, end, step] = parsed.map((value) => value.integer * 10n ** BigInt(scale - value.scale));
  if (step === 0n) throw new FormBuildError("parameters", `${label} step must not be zero.`);
  if (start < end && step < 0n) {
    throw new FormBuildError("parameters", `${label} step must be positive for an ascending range.`);
  }
  if (start > end && step > 0n) {
    throw new FormBuildError("parameters", `${label} step must be negative for a descending range.`);
  }
  const distance = start > end ? start - end : end - start;
  const magnitude = step < 0n ? -step : step;
  const generated = distance / magnitude + 1n;
  if (generated > BigInt(MAX_PARAMETER_ALTERNATIVES)) {
    throw new FormBuildError(
      "parameters",
      `This range produces ${generated.toLocaleString()} values. Reduce the range or increase the step.`,
    );
  }
  if (valueType === "integer") {
    const scaleFactor = 10n ** BigInt(scale);
    const last = start + (generated - 1n) * step;
    const minimum = BigInt(Number.MIN_SAFE_INTEGER) * scaleFactor;
    const maximum = BigInt(Number.MAX_SAFE_INTEGER) * scaleFactor;
    if (start < minimum || start > maximum || last < minimum || last > maximum) {
      throw new FormBuildError("parameters", `${label} integer range values must be JavaScript-safe integers.`);
    }
  }
  return Number(generated) + (range.includeBase ? 1 : 0);
}

function parseRangeDecimal(
  raw: string,
  valueType: ParameterValueType,
  label: string,
  field: string,
): { integer: bigint; scale: number } {
  if (raw.length > MAX_DECIMAL_LENGTH || !SIMPLE_DECIMAL.test(raw)) {
    throw new FormBuildError("parameters", `${label} ${field} must use simple decimal notation.`);
  }
  const unsigned = raw[0] === "+" || raw[0] === "-" ? raw.slice(1) : raw;
  const [whole, fraction = ""] = unsigned.split(".");
  const digits = `${whole || "0"}${fraction}`;
  const integer = BigInt(`${raw.startsWith("-") ? "-" : ""}${digits}`);
  if (valueType === "integer" && integer % 10n ** BigInt(fraction.length) !== 0n) {
    throw new FormBuildError("parameters", `${label} integer ranges require integral start, end, and step.`);
  }
  return { integer, scale: fraction.length };
}

export function parseParameterValue(
  raw: string,
  valueType: ParameterValueType,
  label: string,
): ParameterScalar {
  if (valueType === "string") return raw;
  if (valueType === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new FormBuildError("parameters", `${label} must be true or false.`);
  }
  const trimmed = raw.trim();
  if (valueType === "integer") {
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new FormBuildError("parameters", `${label} must be an exact signed integer.`);
    }
    const value = Number(trimmed);
    if (!Number.isSafeInteger(value)) {
      throw new FormBuildError("parameters", `${label} must be a JavaScript-safe integer.`);
    }
    return value;
  }
  if (!trimmed) throw new FormBuildError("parameters", `${label} must be a finite number.`);
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new FormBuildError("parameters", `${label} must be a finite number.`);
  }
  return value;
}

function isParameterValueType(value: unknown): value is ParameterValueType {
  return value === "string" || value === "integer" || value === "float" || value === "boolean";
}

function normalizeImageBindingValues(values: (string | null)[] | undefined): Array<string | null> {
  if (values === undefined) return [null];
  return [...values];
}

export function validateImageBindings(bindings: ImageBindingRequest[]): void {
  for (const binding of bindings) {
    if (binding.values.length === 0) {
      throw new FormBuildError(
        "image_inputs",
        `Image Input ${JSON.stringify(binding.slot_key)} must have at least one alternative.`,
      );
    }
    if (binding.values.some((value) => typeof value === "string" && !value.trim())) {
      throw new FormBuildError(
        "image_inputs",
        `Image Input ${JSON.stringify(binding.slot_key)} contains a blank Project Asset ID.`,
      );
    }
    if (new Set(binding.values).size !== binding.values.length) {
      throw new FormBuildError(
        "image_inputs",
        `Image Input ${JSON.stringify(binding.slot_key)} contains duplicate alternatives.`,
      );
    }
    if (binding.values.includes(null) && binding.values[0] !== null) {
      throw new FormBuildError(
        "image_inputs",
        `Image Input ${JSON.stringify(binding.slot_key)} must place Base workflow first.`,
      );
    }
  }
}

export function editableBatchSnapshotIdentity(snapshot: EditableBatchSnapshot): string {
  return JSON.stringify(canonicalize(snapshot));
}

export function generateRandomSeeds(
  count: number,
  cryptoSource: Pick<Crypto, "getRandomValues"> = globalThis.crypto,
): number[] {
  const seeds = new Set<number>();
  const value = new Uint32Array(1);
  while (seeds.size < count) {
    cryptoSource.getRandomValues(value);
    seeds.add(value[0]);
  }
  return [...seeds];
}

function parseRandomSeedCount(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new FormBuildError("seeds", "Random seed count must be a whole number.");
  }
  const count = Number(trimmed);
  if (count < 1 || count > MAX_RANDOM_SEED_COUNT) {
    throw new FormBuildError(
      "seeds",
      `Random seed count must be between 1 and ${MAX_RANDOM_SEED_COUNT}.`,
    );
  }
  return count;
}

function parseSeedValues(value: string): number[] {
  const seeds = splitSeeds(value).map((item) => {
    if (!/^-?\d+$/.test(item)) {
      throw new FormBuildError("seeds", `Seed ${JSON.stringify(item)} is not an integer.`);
    }
    const seed = Number(item);
    if (!Number.isSafeInteger(seed) || seed < 0) {
      throw new FormBuildError("seeds", `Seed ${JSON.stringify(item)} must be a nonnegative safe integer.`);
    }
    return seed;
  });
  if (seeds.length === 0) {
    throw new FormBuildError("seeds", "Enter at least one seed.");
  }
  return seeds;
}

export function normalizedBindingValues(values: string[]): string[] {
  return values.flatMap((item) => {
    if (item === "") return [""];
    const trimmed = item.trim();
    return trimmed ? [trimmed] : [];
  });
}

function splitSeeds(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function required(value: string, field: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new FormBuildError(field, `${label} is required.`);
  }
  return trimmed;
}

function parseJsonObject(value: string, field: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new FormBuildError(field, `${label} JSON is invalid: ${detail}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new FormBuildError(field, `${label} JSON must have an object at its root.`);
  }
  return parsed as JsonObject;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}
