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

export interface ReferenceForm {
  key: number;
  assetId: string;
}

export interface BatchFormState {
  projectId: string;
  projectFilesystemKey: string;
  projectName: string;
  batchId: string;
  batchFilesystemKey: string;
  batchName: string;
  promptVersionId: string;
  promptText: string;
  variableBindings: VariableBindingForm[];
  references: ReferenceForm[];
  seedMode: "fixed" | "explicit";
  seedValues: string;
  workflowJson: string;
  workflowProfileJson: string;
}

let nextKey = 1;

export function newVariableBinding(): VariableBindingForm {
  return {
    key: nextKey++,
    placeholder: "variable",
    variableListId: "variable-list-1",
    values: "value one\nvalue two",
    mode: "all",
    selectedValues: "value one\nvalue two",
    fixedValue: "value one",
  };
}

export function newReference(): ReferenceForm {
  return { key: nextKey++, assetId: "" };
}

export function initialBatchForm(): BatchFormState {
  const binding = newVariableBinding();
  binding.placeholder = "subject";
  binding.variableListId = "subjects";
  binding.values = "cat\ndog";
  binding.selectedValues = "cat\ndog";
  binding.fixedValue = "cat";

  return {
    projectId: "project-1",
    projectFilesystemKey: "project_1",
    projectName: "My Project",
    batchId: "batch-1",
    batchFilesystemKey: "batch_1",
    batchName: "First experiment",
    promptVersionId: "prompt-v1",
    promptText: "A studio portrait of {{subject}}.",
    variableBindings: [binding],
    references: [newReference()],
    seedMode: "fixed",
    seedValues: "1",
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

export function buildBatchRequest(form: BatchFormState): BatchRequest {
  const references = form.references.map((reference) => reference.assetId.trim()).filter(Boolean);
  if (references.length === 0) {
    throw new FormBuildError("references", "Enter at least one existing Project Asset ID.");
  }

  const seeds = splitSeeds(form.seedValues).map((value) => {
    if (!/^-?\d+$/.test(value)) {
      throw new FormBuildError("seeds", `Seed ${JSON.stringify(value)} is not an integer.`);
    }
    const seed = Number(value);
    if (!Number.isSafeInteger(seed)) {
      throw new FormBuildError("seeds", `Seed ${JSON.stringify(value)} is outside the safe integer range.`);
    }
    return seed;
  });
  if (seeds.length === 0) {
    throw new FormBuildError("seeds", "Enter at least one seed.");
  }

  return {
    project: {
      id: required(form.projectId, "project", "Project ID"),
      filesystem_key: required(form.projectFilesystemKey, "project", "Project filesystem key"),
      name: required(form.projectName, "project", "Project name"),
    },
    batch: {
      id: required(form.batchId, "batch", "Batch ID"),
      filesystem_key: required(form.batchFilesystemKey, "batch", "Batch filesystem key"),
      name: required(form.batchName, "batch", "Batch name"),
    },
    prompt_version: {
      id: required(form.promptVersionId, "prompt", "PromptVersion ID"),
      text: form.promptText,
    },
    variable_bindings: form.variableBindings.map((binding) => ({
      placeholder: required(binding.placeholder, "variables", "Placeholder"),
      variable_list: {
        id: required(binding.variableListId, "variables", "Variable List ID"),
        values: splitListValues(binding.values),
      },
      mode: binding.mode,
      selected_values: binding.mode === "all" ? splitListValues(binding.selectedValues) : [],
      fixed_value: binding.mode === "fixed" ? binding.fixedValue : null,
    })),
    references: references.map((assetId) => ({ asset_id: assetId })),
    seeds: { mode: form.seedMode, values: seeds },
    workflow: parseJsonObject(form.workflowJson, "workflow", "Workflow"),
    workflow_profile: parseJsonObject(
      form.workflowProfileJson,
      "workflow_profile",
      "Workflow Profile",
    ),
  };
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
