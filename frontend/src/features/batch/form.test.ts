import { describe, expect, it } from "vitest";

import { buildBatchRequest, initialBatchForm } from "./form";

describe("buildBatchRequest", () => {
  it("converts the editor state to the exact API contract", () => {
    const form = initialBatchForm();
    form.referenceAssetIds = ["asset-1"];
    form.seedMode = "explicit";
    form.seedValues = "9, 3";
    form.workflowJson = '{"7":{"class_type":"KSampler","inputs":{"seed":0}}}';

    expect(buildBatchRequest(form)).toEqual({
      project: { id: "project-1", filesystem_key: "project_1", name: "My Project" },
      batch: { id: "batch-1", filesystem_key: "batch_1", name: "First experiment" },
      prompt_version: { id: "prompt-v1", text: "A studio portrait of {{subject}}." },
      variable_bindings: [
        {
          placeholder: "subject",
          variable_list: { id: "subjects", values: ["cat", "dog"] },
          mode: "all",
          selected_values: ["cat", "dog"],
          fixed_value: null,
        },
      ],
      references: [{ asset_id: "asset-1" }],
      seeds: { mode: "explicit", values: [9, 3] },
      workflow: { "7": { class_type: "KSampler", inputs: { seed: 0 } } },
      workflow_profile: expect.objectContaining({ id: "workflow-profile-1" }),
    });
  });

  it("preserves commas inside newline-separated variable values", () => {
    const form = initialBatchForm();
    form.referenceAssetIds = ["asset-1"];
    form.variableBindings[0].values = "red, white, and blue\nblue";
    form.variableBindings[0].selectedValues = "red, white, and blue";

    const request = buildBatchRequest(form);

    expect(request.variable_bindings[0].variable_list.values).toEqual([
      "red, white, and blue",
      "blue",
    ]);
    expect(request.variable_bindings[0].selected_values).toEqual(["red, white, and blue"]);
  });
});
