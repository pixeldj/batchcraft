import { describe, expect, it } from "vitest";

import type { ProjectResponse, SavedBatchDetail } from "../../api/types";
import { initialBatchForm } from "./form";
import {
  buildSavedBatchDefinition,
  canonicalBatchIntent,
  savedBatchToForm,
} from "./savedBatch";

describe("Saved Batch Variable Bindings", () => {
  it("saves ordered values and one exact empty value while normalizing the payload boundary", () => {
    const form = initialBatchForm();
    form.variableBindings[0] = {
      ...form.variableBindings[0],
      placeholder: " subject ",
      values: [" first ", "", "second", "   "],
    };

    expect(buildSavedBatchDefinition(form).variable_bindings).toEqual([
      { placeholder: "subject", values: ["first", "", "second"] },
    ]);

    form.variableBindings[0].values = [];
    expect(buildSavedBatchDefinition(form).variable_bindings).toEqual([
      { placeholder: "subject", values: [] },
    ]);
  });

  it("uses canonical values for dirty comparison while preserving emptiness and order", () => {
    const left = initialBatchForm();
    const equivalent = { ...left, variableBindings: left.variableBindings.map((binding) => ({
      ...binding,
      placeholder: ` ${binding.placeholder} `,
      values: [" cat ", "dog", "   "],
    })) };
    const reordered = { ...equivalent, variableBindings: equivalent.variableBindings.map((binding) => ({
      ...binding,
      values: ["dog", "cat"],
    })) };
    const withEmpty = { ...equivalent, variableBindings: equivalent.variableBindings.map((binding) => ({
      ...binding,
      values: ["", "cat", "dog"],
    })) };

    expect(canonicalBatchIntent(equivalent)).toBe(canonicalBatchIntent(left));
    expect(canonicalBatchIntent(reordered)).not.toBe(canonicalBatchIntent(left));
    expect(canonicalBatchIntent(withEmpty)).not.toBe(canonicalBatchIntent(left));
  });

  it("loads canonical ordered arrays without collapsing an empty value", () => {
    const detail = savedBatchDetail();
    detail.variable_bindings = [
      { placeholder: "empty", values: [] },
      { placeholder: "subject", values: ["", "wolf", "fox"] },
    ];
    const form = savedBatchToForm(detail, project());

    expect(form.variableBindings).toHaveLength(2);
    expect(form.variableBindings[0]).toMatchObject({ placeholder: "empty", values: [] });
    expect(form.variableBindings[1]).toMatchObject({
      placeholder: "subject",
      values: ["", "wolf", "fox"],
    });
  });
});

describe("Saved Batch Image Inputs", () => {
  it("round-trips ordered slot bindings against the exact Profile snapshot", () => {
    const detail = savedBatchDetail();
    detail.selected_workflow_version_id = "workflow-v1";
    detail.selected_workflow_profile_id = "profile-1";
    detail.selected_workflow_profile_version_id = "profile-v1";
    detail.selected_workflow_version = {
      id: "workflow-v1",
      content_sha256: "workflow-sha",
      workflow: { node: {} },
      workflow_id: "workflow-1",
      workflow_name: "Workflow",
      version_number: 1,
      name_snapshot: "Workflow",
      workflow_archived_at: null,
      version_archived_at: null,
    };
    detail.selected_workflow_profile_version = {
      id: "profile-v1",
      workflow_profile_id: "profile-1",
      workflow_version_id: "workflow-v1",
      content_sha256: "profile-sha",
      profile: { mappings: {}, image_inputs: [
        { key: "style", label: "Style", node_id: "1", input_name: "image" },
        { key: "pose", label: "Pose", node_id: "2", input_name: "image" },
      ], parameters: [] },
      workflow_profile_name: "Profile",
      version_number: 1,
      name_snapshot: "Profile",
      workflow_profile_archived_at: null,
      version_archived_at: null,
    };
    detail.image_bindings = [
      { slot_key: "pose", values: ["asset-pose-b", "asset-pose-a"] },
      { slot_key: "removed", values: ["asset-old"] },
      { slot_key: "style", values: [null, "asset-style"] },
    ];

    const form = savedBatchToForm(detail, project());

    expect(form.imageBindings).toEqual([
      { slot_key: "style", values: [null, "asset-style"] },
      { slot_key: "pose", values: ["asset-pose-b", "asset-pose-a"] },
    ]);
    expect(buildSavedBatchDefinition(form).image_bindings).toEqual(form.imageBindings);
  });
});

describe("Saved Batch Parameters", () => {
  it("round-trips Profile-ordered typed alternatives and dirty identity", () => {
    const detail = savedBatchDetail();
    detail.selected_workflow_version_id = "workflow-v1";
    detail.selected_workflow_profile_id = "profile-1";
    detail.selected_workflow_profile_version_id = "profile-v1";
    detail.selected_workflow_version = {
      id: "workflow-v1", content_sha256: "workflow-sha", workflow: { node: {} },
      workflow_id: "workflow-1", workflow_name: "Workflow", version_number: 1,
      name_snapshot: "Workflow", workflow_archived_at: null, version_archived_at: null,
    };
    detail.selected_workflow_profile_version = {
      id: "profile-v1", workflow_profile_id: "profile-1", workflow_version_id: "workflow-v1",
      content_sha256: "profile-sha", workflow_profile_name: "Profile", version_number: 1,
      name_snapshot: "Profile", workflow_profile_archived_at: null, version_archived_at: null,
      profile: { mappings: {}, image_inputs: [], parameters: [
        { key: "caption", label: "Caption", node_id: "1", input_name: "caption", value_type: "string" },
        { key: "enabled", label: "Enabled", node_id: "1", input_name: "enabled", value_type: "boolean" },
      ] },
    };
    detail.parameter_bindings = [
      { parameter_key: "enabled", mode: "values", values: [false, true] },
      { parameter_key: "caption", mode: "values", values: [null, "", "caption"] },
    ];

    const form = savedBatchToForm(detail, project());
    expect(form.parameterBindings).toEqual([
      { parameterKey: "caption", valueType: "string", mode: "values", alternatives: [{ kind: "base" }, { kind: "override", value: "" }, { kind: "override", value: "caption" }], range: { start: "0", end: "1", step: "0.1", includeBase: false } },
      { parameterKey: "enabled", valueType: "boolean", mode: "values", alternatives: [{ kind: "override", value: "false" }, { kind: "override", value: "true" }], range: { start: "0", end: "1", step: "0.1", includeBase: false } },
    ]);
    expect(buildSavedBatchDefinition(form).parameter_bindings).toEqual([
      { parameter_key: "caption", mode: "values", values: [null, "", "caption"] },
      { parameter_key: "enabled", mode: "values", values: [false, true] },
    ]);
    const changed = { ...form, parameterBindings: form.parameterBindings.map((binding) => binding.parameterKey === "caption" ? { ...binding, alternatives: [...binding.alternatives].reverse() } : binding) };
    expect(canonicalBatchIntent(changed)).not.toBe(canonicalBatchIntent(form));
  });

  it("reopens and resaves exact Range intent while retaining a Values draft", () => {
    const detail = savedBatchDetail();
    detail.selected_workflow_version_id = "workflow-v1";
    detail.selected_workflow_profile_version_id = "profile-v1";
    detail.selected_workflow_version = {
      id: "workflow-v1", content_sha256: "workflow-sha", workflow: { node: {} },
      workflow_id: "workflow-1", workflow_name: "Workflow", version_number: 1,
      name_snapshot: "Workflow", workflow_archived_at: null, version_archived_at: null,
    };
    detail.selected_workflow_profile_id = "profile-1";
    detail.selected_workflow_profile_version = {
      id: "profile-v1", workflow_profile_id: "profile-1", workflow_version_id: "workflow-v1",
      content_sha256: "profile-sha", workflow_profile_name: "Profile", version_number: 1,
      name_snapshot: "Profile", workflow_profile_archived_at: null, version_archived_at: null,
      profile: { mappings: {}, image_inputs: [], parameters: [
        { key: "cfg", label: "CFG", node_id: "1", input_name: "cfg", value_type: "float" },
      ] },
    };
    detail.parameter_bindings = [{
      parameter_key: "cfg", mode: "range", include_base: true,
      range: { start: "0.10", end: "1.00", step: "0.05" },
    }];

    const form = savedBatchToForm(detail, project());
    expect(form.parameterBindings).toEqual([{
      parameterKey: "cfg", valueType: "float", mode: "range",
      alternatives: [{ kind: "base" }],
      range: { start: "0.10", end: "1.00", step: "0.05", includeBase: true },
    }]);
    expect(buildSavedBatchDefinition(form).parameter_bindings).toEqual(detail.parameter_bindings);
  });

  it("excludes inactive drafts from Saved Batch dirty identity", () => {
    const valuesForm = initialBatchForm();
    valuesForm.parameterBindings = [{
      parameterKey: "cfg",
      valueType: "float",
      mode: "values",
      alternatives: [{ kind: "override", value: "7" }],
      range: { start: "0", end: "1", step: "0.1", includeBase: false },
    }];
    const changedInactiveRange = {
      ...valuesForm,
      parameterBindings: valuesForm.parameterBindings.map((binding) => ({
        ...binding,
        range: { start: "3.0", end: "7.0", step: "0.5", includeBase: true },
      })),
    };

    expect(canonicalBatchIntent(changedInactiveRange)).toBe(canonicalBatchIntent(valuesForm));
    changedInactiveRange.parameterBindings[0].mode = "range";
    expect(canonicalBatchIntent(changedInactiveRange)).not.toBe(canonicalBatchIntent(valuesForm));
  });
});

function project(): ProjectResponse {
  return {
    id: "project-1",
    name: "Project",
    filesystem_key: "project_1",
    description: null,
    created_at: "2026-08-30T00:00:00Z",
    updated_at: "2026-08-30T00:00:00Z",
    archived_at: null,
  };
}

function savedBatchDetail(): SavedBatchDetail {
  return {
    id: "batch-1",
    project_id: "project-1",
    filesystem_key: "batch_1",
    name: "Batch",
    description: null,
    revision: 1,
    seed_mode: "fixed",
    seed_values: [1],
    random_seed_count: null,
    selected_workflow_version_id: null,
    selected_workflow_profile_id: null,
    selected_workflow_profile_version_id: null,
    selected_workflow_profile_name: null,
    selected_workflow_profile_archived_at: null,
    created_at: "2026-08-30T00:00:00Z",
    updated_at: "2026-08-30T00:00:00Z",
    archived_at: null,
    prompt_selections: [],
    variable_bindings: [{ placeholder: "subject", values: ["wolf", "fox"] }],
    image_bindings: [],
    parameter_bindings: [],
    selected_workflow_version: null,
    selected_workflow_profile_version: null,
  };
}
