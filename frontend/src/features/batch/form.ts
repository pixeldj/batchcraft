import type { BatchRequest, JsonObject } from "../../api/types";

export interface VariableBindingForm {
  key: number;
  placeholder: string;
  variableListId: string;
  values: string;
  mode: "all" | "fixed";
  selectedValues: string;
  fixedValue: string;
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
  referenceAssetIds: string[];
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

let nextVariableBindingKey = 1;
let nextPromptKey = 1;

export function newVariableBinding(): VariableBindingForm {
  return {
    key: nextVariableBindingKey++,
    placeholder: "variable",
    variableListId: "variable-list-1",
    values: "value one\nvalue two",
    mode: "all",
    selectedValues: "value one\nvalue two",
    fixedValue: "value one",
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
  binding.variableListId = "subjects";
  binding.values = "cat\ndog";
  binding.selectedValues = "cat\ndog";
  binding.fixedValue = "cat";

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
    referenceAssetIds: [],
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
          reference_image: { node_id: "", input_name: "", value_type: "image" },
          seed: { node_id: "", input_name: "", value_type: "integer" },
          output_prefix: { node_id: "", input_name: "", value_type: "string" },
        },
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
  const references = form.referenceAssetIds;

  const seedInput = form.seedMode === "random"
    ? { mode: "explicit" as const, values: generateRandomSeeds(parseRandomSeedCount(form.randomSeedCount)) }
    : { mode: form.seedMode, values: parseSeedValues(form.seedValues) };

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
    variable_list: {
      id: required(binding.variableListId, "variables", "Variable List ID"),
      values: splitListValues(binding.values),
    },
    mode: binding.mode,
    selected_values: binding.mode === "all" ? splitListValues(binding.selectedValues) : [],
    fixed_value: binding.mode === "fixed" ? binding.fixedValue : null,
  }));
  const referenceRequests = references.map((assetId) => ({ asset_id: assetId }));
  const workflow = parseJsonObject(form.workflowJson, "workflow", "Workflow");
  const workflowProfile = parseJsonObject(
    form.workflowProfileJson,
    "workflow_profile",
    "Workflow Profile",
  );
  const seedIntent = form.seedMode === "random"
    ? {
      mode: "random" as const,
      values: [],
      random_seed_count: parseRandomSeedCount(form.randomSeedCount),
    }
    : {
      mode: form.seedMode,
      values: seedInput.values,
      random_seed_count: null,
    };

  return {
    project,
    batch,
    prompt_versions: promptVersions,
    variable_bindings: variableBindings,
    references: referenceRequests,
    seeds: seedInput,
    workflow,
    workflow_profile: workflowProfile,
    batch_snapshot: {
      snapshot_version: 1,
      project,
      source_saved_batch: context.sourceSavedBatch,
      batch: { ...batch, description: form.batchDescription.trim() || null },
      prompt_versions: promptVersions.map((prompt, index) => ({
        ...prompt,
        prompt_id: form.prompts[index].promptId,
        version_number: form.prompts[index].versionNumber,
      })),
      variable_bindings: variableBindings,
      references: referenceRequests,
      seed_intent: seedIntent,
      workflow_selection: {
        workflow_id: form.workflowId,
        workflow_version_id: form.workflowVersionId,
        workflow_profile_id: form.workflowProfileId,
        workflow_profile_version_id: form.workflowProfileVersionId,
        workflow,
        workflow_profile: workflowProfile,
      },
    },
  };
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

function splitListValues(value: string): string[] {
  return value
    .split(/\n/)
    .map((item) => item.trim())
    .filter(Boolean);
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
