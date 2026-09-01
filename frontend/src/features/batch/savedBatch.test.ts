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
    reference_selections: [],
    selected_workflow_version: null,
    selected_workflow_profile_version: null,
  };
}
