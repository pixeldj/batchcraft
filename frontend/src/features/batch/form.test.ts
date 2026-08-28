import { describe, expect, it } from "vitest";

import {
  buildBatchRequest,
  generateRandomSeeds,
  initialBatchForm,
  MAX_RANDOM_SEED_COUNT,
  newPrompt,
} from "./form";

describe("buildBatchRequest", () => {
  it("creates a prompt with safe identity defaults", () => {
    expect(newPrompt(3)).toMatchObject({
      versionId: "prompt-v3",
      name: "Prompt 3",
      text: "",
    });
  });

  it("converts the editor state to the exact API contract", () => {
    const form = initialBatchForm();
    form.referenceAssetIds = ["asset-1"];
    form.seedMode = "explicit";
    form.seedValues = "9, 3";
    form.workflowJson = '{"7":{"class_type":"KSampler","inputs":{"seed":0}}}';

    expect(buildBatchRequest(form)).toEqual({
      project: { id: "project-1", filesystem_key: "project_1", name: "My Project" },
      batch: { id: "batch-1", filesystem_key: "batch_1", name: "First experiment" },
      prompt_versions: [
        { id: "prompt-v1", name: "Portrait", text: "A studio portrait of {{subject}}." },
      ],
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

  it("preserves PromptVersion order and permits duplicate IDs for backend validation", () => {
    const form = initialBatchForm();
    form.referenceAssetIds = ["asset-1"];
    form.prompts = [
      { key: 10, versionId: "shared", name: "Second", text: "Second prompt" },
      { key: 11, versionId: "shared", name: "First", text: "First prompt" },
    ];

    expect(buildBatchRequest(form).prompt_versions).toEqual([
      { id: "shared", name: "Second", text: "Second prompt" },
      { id: "shared", name: "First", text: "First prompt" },
    ]);
  });

  it.each([
    { prompts: [], message: /at least one PromptVersion/ },
    { prompts: [{ key: 1, versionId: "", name: "Name", text: "Text" }], message: /Prompt 1 ID/ },
    { prompts: [{ key: 1, versionId: "id", name: "", text: "Text" }], message: /Prompt 1 name/ },
  ])("rejects an invalid prompt list", ({ prompts, message }) => {
    const form = initialBatchForm();
    form.referenceAssetIds = ["asset-1"];
    form.prompts = prompts;

    expect(() => buildBatchRequest(form)).toThrow(message);
  });

  it("preserves an empty PromptVersion template", () => {
    const form = initialBatchForm();
    form.referenceAssetIds = ["asset-1"];
    form.prompts[0].text = "";

    expect(buildBatchRequest(form).prompt_versions[0].text).toBe("");
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

  it("materializes the requested number of distinct unsigned 32-bit Random seeds", () => {
    const values = [0, 0, 4_294_967_295];
    let index = 0;
    const cryptoSource = {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        if (!(array instanceof Uint32Array)) throw new Error("Expected Uint32Array");
        array[0] = values[index++];
        return array;
      },
    };

    expect(generateRandomSeeds(2, cryptoSource)).toEqual([0, 4_294_967_295]);
  });

  it.each(["", "0", "-1", "1.5", "two", String(MAX_RANDOM_SEED_COUNT + 1)])(
    "rejects invalid Random seed count %j",
    (randomSeedCount) => {
      const form = initialBatchForm();
      form.referenceAssetIds = ["asset-1"];
      form.seedMode = "random";
      form.randomSeedCount = randomSeedCount;

      expect(() => buildBatchRequest(form)).toThrow(/Random seed count/);
    },
  );

  it("sends Random seeds through the concrete explicit API contract", () => {
    const form = initialBatchForm();
    form.referenceAssetIds = ["asset-1"];
    form.seedMode = "random";
    form.randomSeedCount = "3";

    const request = buildBatchRequest(form);

    expect(request.seeds.mode).toBe("explicit");
    expect(request.seeds.values).toHaveLength(3);
    expect(request.seeds.values.every((seed) => seed >= 0 && seed <= 4_294_967_295)).toBe(true);
  });
});
