import { describe, expect, it } from "vitest";

import {
  buildBatchRequest,
  buildEditableBatchSnapshot,
  editableBatchSnapshotIdentity,
  generateRandomSeeds,
  initialBatchForm,
  MAX_RANDOM_SEED_COUNT,
  newPrompt,
  reconcileParameterBindings,
  reconcileImageBindings,
} from "./form";

describe("buildBatchRequest", () => {
  it("starts without a Project or selected PromptVersions", () => {
    expect(initialBatchForm()).toMatchObject({
      projectId: "",
      projectFilesystemKey: "",
      projectName: "",
      prompts: [],
    });
  });

  it("creates a prompt with safe identity defaults", () => {
    expect(newPrompt(3)).toMatchObject({
      libraryProjectId: null,
      promptId: null,
      promptName: "Prompt 3",
      versionId: "prompt-v3",
      versionNumber: null,
      snapshotName: "Prompt 3",
      text: "",
    });
  });

  it("converts the editor state to the exact API contract", () => {
    const form = populatedBatchForm();
    form.workflowProfileJson = JSON.stringify({ mappings: {}, image_inputs: [{ key: "source", label: "Source", node_id: "1", input_name: "image" }], parameters: [] });
    form.imageBindings = [{ slot_key: "source", values: [null, "asset-1", "asset-2"] }];
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
          values: ["cat", "dog"],
        },
      ],
      image_bindings: [{ slot_key: "source", values: [null, "asset-1", "asset-2"] }],
      parameter_bindings: [],
      seeds: { mode: "explicit", values: [9, 3] },
      workflow: { "7": { class_type: "KSampler", inputs: { seed: 0 } } },
      workflow_profile: {
        mappings: {},
        image_inputs: [{ key: "source", label: "Source", node_id: "1", input_name: "image" }],
        parameters: [],
      },
      batch_snapshot: expect.objectContaining({
        snapshot_version: 4,
        source_saved_batch: null,
      }),
    });
  });

  it("serializes exact effective snapshots and never sends library IDs", () => {
    const form = populatedBatchForm();
    form.workflowJson = '{ "node": { "inputs": [1, 2] } }';
    form.workflowProfileJson = '{ "mappings": { "prompt": "7.text" }, "image_inputs": [], "parameters": [] }';
    form.workflowLibraryProjectId = "project-1";
    form.workflowId = "workflow-1";
    form.workflowVersionId = "workflow-v3";
    form.workflowProfileId = "profile-1";
    form.workflowProfileVersionId = "profile-v5";
    form.workflowProfileWorkflowVersionId = "workflow-v3";

    const request = buildBatchRequest(form);

    expect(request.workflow).toEqual({ node: { inputs: [1, 2] } });
    expect(request.workflow_profile).toEqual({ mappings: { prompt: "7.text" }, image_inputs: [], parameters: [] });
    expect(request).not.toHaveProperty("workflow_id");
    expect(request).not.toHaveProperty("workflow_version_id");
    expect(request).not.toHaveProperty("workflow_profile_version_id");
  });

  it("requires an exact compatible ProfileVersion for a library WorkflowVersion", () => {
    const form = populatedBatchForm();
    form.workflowLibraryProjectId = "project-1";
    form.workflowId = "workflow-1";
    form.workflowVersionId = "workflow-v2";
    form.workflowProfileJson = "{}";

    expect(() => buildBatchRequest(form)).toThrow(
      "Choose a compatible ProfileVersion for the selected WorkflowVersion before Preview.",
    );
  });

  it("serializes zero Image Input slots", () => {
    const form = populatedBatchForm();

    expect(buildBatchRequest(form).image_bindings).toEqual([]);
  });

  it("constructs Base and exact typed fixed Parameter bindings without coercion", () => {
    const form = populatedBatchForm();
    form.workflowProfileJson = JSON.stringify({ mappings: {}, image_inputs: [], parameters: [
      { key: "caption", label: "Caption", node_id: "1", input_name: "caption", value_type: "string" },
      { key: "steps", label: "Steps", node_id: "1", input_name: "steps", value_type: "integer" },
      { key: "cfg", label: "CFG", node_id: "1", input_name: "cfg", value_type: "float" },
      { key: "enabled", label: "Enabled", node_id: "1", input_name: "enabled", value_type: "boolean" },
    ] });
    form.parameterBindings = [
      { parameterKey: "caption", valueType: "string", mode: "override", value: "" },
      { parameterKey: "steps", valueType: "integer", mode: "override", value: "-30" },
      { parameterKey: "cfg", valueType: "float", mode: "override", value: "7" },
      { parameterKey: "enabled", valueType: "boolean", mode: "base", value: "false" },
    ];

    const request = buildBatchRequest(form);
    expect(request.parameter_bindings).toEqual([
      { parameter_key: "caption", values: [""] },
      { parameter_key: "steps", values: [-30] },
      { parameter_key: "cfg", values: [7] },
      { parameter_key: "enabled", values: [null] },
    ]);
    expect(request.batch_snapshot.parameter_bindings).toEqual(request.parameter_bindings);
    form.parameterBindings[3] = { ...form.parameterBindings[3], mode: "override", value: "false" };
    expect(buildBatchRequest(form).parameter_bindings[3]).toEqual({ parameter_key: "enabled", values: [false] });
  });

  it.each([
    ["integer", "1.0", /exact signed integer/],
    ["integer", String(Number.MAX_SAFE_INTEGER + 1), /safe integer/],
    ["float", "Infinity", /finite number/],
    ["boolean", "yes", /true or false/],
  ] as const)("rejects an invalid %s Parameter override", (valueType, value, message) => {
    const form = populatedBatchForm();
    form.workflowProfileJson = JSON.stringify({ mappings: {}, image_inputs: [], parameters: [
      { key: "value", label: "Value", node_id: "1", input_name: "value", value_type: valueType },
    ] });
    form.parameterBindings = [{ parameterKey: "value", valueType, mode: "override", value }];
    expect(() => buildBatchRequest(form)).toThrow(message);
  });

  it("reconciles Parameters by stable key and compatible declared type only", () => {
    expect(reconcileParameterBindings([
      { parameterKey: "steps", valueType: "integer", mode: "override", value: "30" },
      { parameterKey: "enabled", valueType: "boolean", mode: "override", value: "false" },
      { parameterKey: "removed", valueType: "string", mode: "override", value: "old" },
    ], [
      { key: "enabled", label: "Renamed", node_id: "1", input_name: "enabled", value_type: "boolean" },
      { key: "steps", label: "Steps", node_id: "1", input_name: "steps", value_type: "float" },
      { key: "added", label: "Added", node_id: "1", input_name: "added", value_type: "string" },
    ])).toEqual([
      { parameterKey: "enabled", valueType: "boolean", mode: "override", value: "false" },
      { parameterKey: "steps", valueType: "float", mode: "override", value: "30" },
      { parameterKey: "added", valueType: "string", mode: "base", value: "" },
    ]);
  });

  it("clears an incompatible hidden Base draft when the declared type changes", () => {
    expect(reconcileParameterBindings([
      { parameterKey: "enabled", valueType: "boolean", mode: "base", value: "false" },
      { parameterKey: "steps", valueType: "integer", mode: "base", value: "30" },
    ], [
      { key: "enabled", label: "Enabled", node_id: "1", input_name: "enabled", value_type: "integer" },
      { key: "steps", label: "Steps", node_id: "1", input_name: "steps", value_type: "float" },
    ])).toEqual([
      { parameterKey: "enabled", valueType: "integer", mode: "base", value: "" },
      { parameterKey: "steps", valueType: "float", mode: "base", value: "30" },
    ]);
  });

  it("reconciles complete ordered alternatives by stable slot key", () => {
    expect(reconcileImageBindings(
      [
        { slot_key: "removed", values: ["old"] },
        { slot_key: "retained", values: [null, "asset-b", "asset-a"] },
      ],
      [
        { key: "retained", label: "Renamed", node_id: "1", input_name: "image" },
        { key: "added", label: "Added", node_id: "2", input_name: "image" },
      ],
    )).toEqual([
      { slot_key: "retained", values: [null, "asset-b", "asset-a"] },
      { slot_key: "added", values: [null] },
    ]);
  });

  it.each([
    [[], /at least one alternative/],
    [["asset", "asset"], /duplicate alternatives/],
    [[null, null], /duplicate alternatives/],
    [["asset", null], /Base workflow first/],
  ] as Array<[Array<string | null>, RegExp]>)(
    "rejects invalid Image Input alternatives %j",
    (values, message) => {
      const form = populatedBatchForm();
      form.workflowProfileJson = JSON.stringify({
        mappings: {},
        image_inputs: [{ key: "source", label: "Source", node_id: "1", input_name: "image" }],
        parameters: [],
      });
      form.imageBindings = [{ slot_key: "source", values }];

      expect(() => buildBatchRequest(form)).toThrow(message);
    },
  );

  it("preserves PromptVersion order and permits duplicate IDs for backend validation", () => {
    const form = populatedBatchForm();
    form.prompts = [
      {
        key: 10,
        libraryProjectId: "project-1",
        promptId: "prompt-second",
        promptName: "Editable second",
        versionId: "shared",
        versionNumber: 4,
        snapshotName: "Second",
        text: "Second prompt",
      },
      {
        key: 11,
        libraryProjectId: null,
        promptId: null,
        promptName: "Detached first",
        versionId: "shared",
        versionNumber: null,
        snapshotName: "First",
        text: "First prompt",
      },
    ];

    expect(buildBatchRequest(form).prompt_versions).toEqual([
      { id: "shared", name: "Second", text: "Second prompt" },
      { id: "shared", name: "First", text: "First prompt" },
    ]);
  });

  it("rejects a known Prompt selection from another Project", () => {
    const form = populatedBatchForm();
    form.prompts = [{
      ...newPrompt(),
      libraryProjectId: "other-project",
      promptId: "prompt-other",
      promptName: "Other Prompt",
      versionNumber: 1,
    }];

    expect(() => buildBatchRequest(form)).toThrow(/belongs to another Project/);
  });

  it.each([
    { prompts: [], message: /at least one PromptVersion/ },
    {
      prompts: [{ ...newPrompt(), versionId: "", snapshotName: "Name", text: "Text" }],
      message: /Prompt 1 ID/,
    },
    {
      prompts: [{ ...newPrompt(), versionId: "id", snapshotName: "", text: "Text" }],
      message: /Prompt 1 name/,
    },
  ])("rejects an invalid prompt list", ({ prompts, message }) => {
    const form = populatedBatchForm();
    form.prompts = prompts;

    expect(() => buildBatchRequest(form)).toThrow(message);
  });

  it("preserves an empty PromptVersion template", () => {
    const form = populatedBatchForm();
    form.prompts[0].text = "";

    expect(buildBatchRequest(form).prompt_versions[0].text).toBe("");
  });

  it("trims binding values while preserving order, duplicates, and commas", () => {
    const form = populatedBatchForm();
    form.variableBindings[0].values = [
      " red, white, and blue ",
      "blue",
      "red, white, and blue",
      "  ",
    ];

    const request = buildBatchRequest(form);

    expect(request.variable_bindings[0].values).toEqual([
      "red, white, and blue",
      "blue",
      "red, white, and blue",
    ]);
    expect(request.batch_snapshot.variable_bindings).toEqual(request.variable_bindings);
  });

  it("preserves an explicit empty value but filters whitespace-only entries", () => {
    const form = populatedBatchForm();
    form.variableBindings[0].values = ["", "  "];

    expect(buildBatchRequest(form).variable_bindings).toEqual([
      { placeholder: "subject", values: [""] },
    ]);
  });

  it("sends a zero-value binding for backend compiler validation", () => {
    const form = populatedBatchForm();
    form.variableBindings[0].values = [];

    expect(buildBatchRequest(form).variable_bindings).toEqual([
      { placeholder: "subject", values: [] },
    ]);
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

  it("builds Random snapshot identity without materializing execution seeds", () => {
    const form = populatedBatchForm();
    form.seedMode = "random";
    form.randomSeedCount = "3";
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { getRandomValues: () => { throw new Error("must not materialize"); } },
    });

    try {
      const snapshot = buildEditableBatchSnapshot(form);
      expect(snapshot.seed_intent).toEqual({ mode: "random", values: [], random_seed_count: 3 });
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
    }
  });

  it("canonicalizes nested object keys while preserving ordered snapshot arrays", () => {
    const left = buildEditableBatchSnapshot(populatedBatchForm());
    const right = structuredClone(left);
    left.workflow_selection.workflow = { outer: { b: 2, a: 1 } };
    right.workflow_selection.workflow = { outer: { a: 1, b: 2 } };

    expect(editableBatchSnapshotIdentity(left)).toBe(editableBatchSnapshotIdentity(right));
    right.variable_bindings[0].values.reverse();
    expect(editableBatchSnapshotIdentity(left)).not.toBe(editableBatchSnapshotIdentity(right));
  });

  it.each(["", "0", "-1", "1.5", "two", String(MAX_RANDOM_SEED_COUNT + 1)])(
    "rejects invalid Random seed count %j",
    (randomSeedCount) => {
      const form = populatedBatchForm();
      form.seedMode = "random";
      form.randomSeedCount = randomSeedCount;

      expect(() => buildBatchRequest(form)).toThrow(/Random seed count/);
    },
  );

  it("sends Random seeds through the concrete explicit API contract", () => {
    const form = populatedBatchForm();
    form.seedMode = "random";
    form.randomSeedCount = "3";

    const request = buildBatchRequest(form);

    expect(request.seeds.mode).toBe("explicit");
    expect(request.seeds.values).toHaveLength(3);
    expect(request.seeds.values.every((seed) => seed >= 0 && seed <= 4_294_967_295)).toBe(true);
  });
});

function populatedBatchForm() {
  const form = initialBatchForm();
  const prompt = newPrompt(1);
  form.projectId = "project-1";
  form.projectFilesystemKey = "project_1";
  form.projectName = "My Project";
  prompt.promptName = "Portrait";
  prompt.snapshotName = "Portrait";
  prompt.text = "A studio portrait of {{subject}}.";
  form.prompts = [prompt];
  return form;
}
