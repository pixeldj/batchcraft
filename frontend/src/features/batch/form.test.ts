import { describe, expect, it } from "vitest";

import { canonicalBatchIntent } from "./savedBatch";
import {
  buildBatchRequest,
  buildEditableBatchSnapshot,
  editableBatchSnapshotToForm,
  editableBatchSnapshotIdentity,
  generateRandomSeeds,
  initialBatchForm,
  MAX_RANDOM_SEED_COUNT,
  missingPromptPlaceholders,
  newPrompt,
  newVariableBinding,
  reconcileParameterBindings,
  reconcileParameterState,
  reconcileImageBindings,
  parameterRangeCount,
  requiredPromptPlaceholders,
  restoreHistoricalResourceState,
} from "./form";

describe("Prompt placeholder requirements", () => {
  const prompts = [
    { ...newPrompt(1), placeholders: ["subject", "outfit"] },
    { ...newPrompt(2), placeholders: ["lighting", "subject", "Subject"] },
  ];

  it("preserves selected PromptVersion order and globally de-duplicates exact names", () => {
    expect(requiredPromptPlaceholders(prompts)).toEqual([
      "subject",
      "outfit",
      "lighting",
      "Subject",
    ]);
  });

  it("finds all, some, and no missing bindings without treating unused bindings specially", () => {
    expect(missingPromptPlaceholders(prompts, [])).toEqual([
      "subject",
      "outfit",
      "lighting",
      "Subject",
    ]);
    expect(missingPromptPlaceholders(prompts, [
      newVariableBinding("subject", []),
      newVariableBinding("unused", ["kept"]),
    ])).toEqual(["outfit", "lighting", "Subject"]);
    expect(missingPromptPlaceholders(prompts, [
      newVariableBinding("subject", []),
      newVariableBinding("outfit", [""]),
      newVariableBinding("lighting", ["studio"]),
      newVariableBinding("Subject", ["person"]),
    ])).toEqual([]);
  });

  it("uses exact case-sensitive binding names", () => {
    expect(missingPromptPlaceholders(
      [{ ...newPrompt(), placeholders: ["subject"] }],
      [newVariableBinding("Subject", ["person"])],
    )).toEqual(["subject"]);
  });
});

describe("buildBatchRequest", () => {
  it("starts without a Project or selected PromptVersions", () => {
    expect(initialBatchForm()).toMatchObject({
      projectId: "",
      projectFilesystemKey: "",
      projectName: "",
      prompts: [],
      historicalImportCopyResolutions: {
        promptVersions: [],
        workflowVersion: null,
        workflowProfileVersion: null,
      },
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
      linked_parameter_sets: [],
      seeds: { mode: "explicit", values: [9, 3] },
      workflow: { "7": { class_type: "KSampler", inputs: { seed: 0 } } },
      workflow_profile: {
        mappings: {},
        image_inputs: [{ key: "source", label: "Source", node_id: "1", input_name: "image" }],
        parameters: [],
      },
      batch_snapshot: expect.objectContaining({
        format: "batchcraft.batch-snapshot",
        format_version: 1,
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

  it("constructs ordered Base and exact typed Parameter alternatives without coercion", () => {
    const form = populatedBatchForm();
    form.workflowProfileJson = JSON.stringify({ mappings: {}, image_inputs: [], parameters: [
      { key: "caption", label: "Caption", node_id: "1", input_name: "caption", value_type: "string" },
      { key: "steps", label: "Steps", node_id: "1", input_name: "steps", value_type: "integer" },
      { key: "cfg", label: "CFG", node_id: "1", input_name: "cfg", value_type: "float" },
      { key: "enabled", label: "Enabled", node_id: "1", input_name: "enabled", value_type: "boolean" },
    ] });
    form.parameterBindings = [
      parameterBinding("caption", "string", [{ kind: "base" }, { kind: "override", value: "" }, { kind: "override", value: "text" }]),
      parameterBinding("steps", "integer", [{ kind: "override", value: "-30" }, { kind: "override", value: "0" }]),
      parameterBinding("cfg", "float", [{ kind: "override", value: "7" }]),
      parameterBinding("enabled", "boolean", [{ kind: "base" }, { kind: "override", value: "false" }]),
    ];

    const request = buildBatchRequest(form);
    expect(request.parameter_bindings).toEqual([
      { parameter_key: "caption", mode: "values", values: [null, "", "text"] },
      { parameter_key: "steps", mode: "values", values: [-30, 0] },
      { parameter_key: "cfg", mode: "values", values: [7] },
      { parameter_key: "enabled", mode: "values", values: [null, false] },
    ]);
    expect(request.batch_snapshot.parameter_bindings).toEqual(request.parameter_bindings);
    form.parameterBindings[3] = { ...form.parameterBindings[3], alternatives: [{ kind: "override", value: "false" }] };
    expect(buildBatchRequest(form).parameter_bindings[3]).toEqual({ parameter_key: "enabled", mode: "values", values: [false] });
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
    form.parameterBindings = [parameterBinding("value", valueType, [{ kind: "override", value }])];
    expect(() => buildBatchRequest(form)).toThrow(message);
  });

  it("serializes exact ascending and descending range intent without materializing values", () => {
    const form = populatedBatchForm();
    form.workflowProfileJson = JSON.stringify({ mappings: {}, image_inputs: [], parameters: [
      { key: "cfg", label: "CFG", node_id: "1", input_name: "cfg", value_type: "float" },
      { key: "steps", label: "Steps", node_id: "1", input_name: "steps", value_type: "integer" },
    ] });
    form.parameterBindings = [
      { ...parameterBinding("cfg", "float", [{ kind: "override", value: "retained" }]), mode: "range", range: { start: "0.10", end: "0.30", step: "0.10", includeBase: true } },
      { ...parameterBinding("steps", "integer", [{ kind: "base" }]), mode: "range", range: { start: "10", end: "0", step: "-3", includeBase: false } },
    ];

    expect(buildBatchRequest(form).parameter_bindings).toEqual([
      { parameter_key: "cfg", mode: "range", include_base: true, range: { start: "0.10", end: "0.30", step: "0.10" } },
      { parameter_key: "steps", mode: "range", include_base: false, range: { start: "10", end: "0", step: "-3" } },
    ]);
    expect(parameterRangeCount(form.parameterBindings[0].range, "float", "CFG")).toBe(4);
    expect(parameterRangeCount(form.parameterBindings[1].range, "integer", "Steps")).toBe(4);
  });

  it("counts exact scaled decimals, start=end, and Base without Number addition", () => {
    expect(parameterRangeCount({ start: "0", end: "1", step: "0.1", includeBase: false }, "float", "CFG")).toBe(11);
    expect(parameterRangeCount({ start: "7", end: "7", step: "-2", includeBase: true }, "integer", "Steps")).toBe(2);
    expect(parameterRangeCount({ start: ".5", end: "1.", step: "+.25", includeBase: false }, "float", "CFG")).toBe(3);
    expect(parameterRangeCount({ start: "1.0", end: "3.0", step: "1.0", includeBase: false }, "integer", "Steps")).toBe(3);
    expect(parameterRangeCount({ start: "1", end: "10000", step: "1", includeBase: true }, "integer", "Steps")).toBe(10_001);
  });

  it.each([
    [{ start: "0", end: "1", step: "0", includeBase: false }, "float", /must not be zero/],
    [{ start: "0", end: "1", step: "-0.1", includeBase: false }, "float", /positive.*ascending/],
    [{ start: "1", end: "0", step: "0.1", includeBase: false }, "float", /negative.*descending/],
    [{ start: "0", end: "1", step: "0.00001", includeBase: false }, "float", /produces 100,001 values/],
    [{ start: "0.5", end: "1", step: "1", includeBase: false }, "integer", /require integral/],
    [{ start: "1e2", end: "200", step: "1", includeBase: false }, "float", /simple decimal/],
  ] as const)("rejects invalid range draft %#", (range, valueType, message) => {
    expect(() => parameterRangeCount(range, valueType, "Value")).toThrow(message);
  });

  it("keeps high-precision float validation at the backend boundary", () => {
    expect(parameterRangeCount({
      start: "0.10000000000000001",
      end: "0.2",
      step: "0.1",
      includeBase: false,
    }, "float", "Value")).toBe(1);
  });

  it("reconciles complete Parameter order by stable key and exact declared type", () => {
    expect(reconcileParameterBindings([
      parameterBinding("steps", "integer", [{ kind: "override", value: "30" }]),
      parameterBinding("enabled", "boolean", [{ kind: "base" }, { kind: "override", value: "false" }, { kind: "override", value: "true" }]),
      parameterBinding("removed", "string", [{ kind: "override", value: "old" }]),
    ], [
      { key: "enabled", label: "Renamed", node_id: "1", input_name: "enabled", value_type: "boolean" },
      { key: "steps", label: "Steps", node_id: "1", input_name: "steps", value_type: "float" },
      { key: "added", label: "Added", node_id: "1", input_name: "added", value_type: "string" },
    ])).toEqual([
      parameterBinding("enabled", "boolean", [{ kind: "base" }, { kind: "override", value: "false" }, { kind: "override", value: "true" }]),
      parameterBinding("steps", "float", [{ kind: "base" }]),
      parameterBinding("added", "string", [{ kind: "base" }]),
    ]);
  });

  it("resets incompatible Parameter alternatives when the declared type changes", () => {
    expect(reconcileParameterBindings([
      parameterBinding("enabled", "boolean", [{ kind: "override", value: "false" }]),
      parameterBinding("steps", "integer", [{ kind: "base" }, { kind: "override", value: "30" }]),
    ], [
      { key: "enabled", label: "Enabled", node_id: "1", input_name: "enabled", value_type: "integer" },
      { key: "steps", label: "Steps", node_id: "1", input_name: "steps", value_type: "float" },
    ])).toEqual([
      parameterBinding("enabled", "integer", [{ kind: "base" }]),
      parameterBinding("steps", "float", [{ kind: "base" }]),
    ]);
  });

  it("preserves compatible Presets and dissolves an incompatible set to Base independent bindings", () => {
    const preset = {
      setKey: "resolution", setLabel: "Resolution",
      members: [{ parameterKey: "width", valueType: "integer" as const }, { parameterKey: "height", valueType: "integer" as const }],
      rows: [{ rowLabel: "Landscape", values: { width: { kind: "override" as const, value: "1024" }, height: { kind: "override" as const, value: "768" } } }],
    };
    const profile = [
      { key: "width", label: "Width", node_id: "1", input_name: "width", value_type: "integer" as const },
      { key: "height", label: "Height", node_id: "1", input_name: "height", value_type: "integer" as const },
    ];
    expect(reconcileParameterState([], [preset], profile)).toEqual({ parameterBindings: [], linkedParameterSets: [preset] });
    expect(reconcileParameterState([], [preset], [{ ...profile[0], value_type: "float" }, profile[1]])).toEqual({
      linkedParameterSets: [],
      parameterBindings: [parameterBinding("width", "float", [{ kind: "base" }]), parameterBinding("height", "integer", [{ kind: "base" }])],
    });
  });

  it("builds linked rows as typed API values and excludes members from independent bindings", () => {
    const form = populatedBatchForm();
    form.workflowProfileJson = JSON.stringify({ mappings: {}, image_inputs: [], parameters: [
      { key: "width", label: "Width", node_id: "1", input_name: "width", value_type: "integer" },
      { key: "height", label: "Height", node_id: "1", input_name: "height", value_type: "integer" },
      { key: "enabled", label: "Enabled", node_id: "1", input_name: "enabled", value_type: "boolean" },
    ] });
    form.parameterBindings = [parameterBinding("enabled", "boolean", [{ kind: "override", value: "false" }])];
    form.linkedParameterSets = [{
      setKey: "resolution", setLabel: " Resolution ",
      members: [{ parameterKey: "width", valueType: "integer" }, { parameterKey: "height", valueType: "integer" }],
      rows: [
        { rowLabel: " Landscape ", values: { width: { kind: "override", value: "1024" }, height: { kind: "override", value: "768" } } },
        { rowLabel: "", values: { width: { kind: "base" }, height: { kind: "override", value: "512" } } },
      ],
    }];
    const request = buildBatchRequest(form);
    expect(request.parameter_bindings).toEqual([{ parameter_key: "enabled", mode: "values", values: [false] }]);
    expect(request.linked_parameter_sets).toEqual([{ set_key: "resolution", set_label: "Resolution", members: ["width", "height"], rows: [
      { row_label: "Landscape", values: { width: 1024, height: 768 } },
      { row_label: null, values: { width: null, height: 512 } },
    ] }]);
    expect(request.batch_snapshot.linked_parameter_sets).toEqual(request.linked_parameter_sets);
  });

  it.each([
    [[], /at least one alternative/],
    [[{ kind: "override", value: "1" }, { kind: "override", value: "01" }], /duplicate alternatives/],
    [[{ kind: "override", value: "1" }, { kind: "base" }], /Base workflow first/],
  ] as const)("rejects invalid Parameter alternatives", (alternatives, message) => {
    const form = populatedBatchForm();
    form.workflowProfileJson = JSON.stringify({ mappings: {}, image_inputs: [], parameters: [
      { key: "steps", label: "Steps", node_id: "1", input_name: "steps", value_type: "integer" },
    ] });
    form.parameterBindings = [parameterBinding("steps", "integer", [...alternatives])];
    expect(() => buildBatchRequest(form)).toThrow(message);
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
        placeholders: [],
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
        placeholders: [],
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

  it("uses supplied historical Random seeds while retaining Random snapshot intent", () => {
    const form = populatedBatchForm();
    form.seedMode = "random";
    form.randomSeedCount = "3";

    const request = buildBatchRequest(form, undefined, [91, 17, 42]);

    expect(request.seeds).toEqual({ mode: "explicit", values: [91, 17, 42] });
    expect(request.batch_snapshot.seed_intent).toEqual({
      mode: "random",
      values: [],
      random_seed_count: 3,
    });
  });

  it("reconstructs exact ordered editable intent and applies resource linkage statuses", () => {
    const snapshot = buildEditableBatchSnapshot(populatedBatchForm());
    snapshot.prompt_versions = [
      { id: "historical-prompt-1", prompt_id: "prompt-1", version_number: 3, name: "First", text: "First" },
      { id: "historical-prompt-2", prompt_id: "prompt-2", version_number: 5, name: "Second", text: "Second" },
    ];
    snapshot.image_bindings = [{ slot_key: "source", values: [null, "asset-b", "asset-a"] }];
    snapshot.workflow_selection = {
      workflow_id: "workflow-1",
      workflow_version_id: "historical-workflow",
      workflow_name: "Frozen workflow",
      workflow_version_number: 4,
      workflow_profile_id: "profile-1",
      workflow_profile_version_id: "historical-profile",
      workflow_profile_name: "Frozen profile",
      workflow_profile_version_number: 6,
      workflow: { node: { inputs: { cfg: 7 } } },
      workflow_profile: {
        mappings: {},
        image_inputs: [{ key: "source", label: "Source", node_id: "1", input_name: "image" }],
        parameters: [
          { key: "cfg", label: "CFG", node_id: "1", input_name: "cfg", value_type: "float" },
          { key: "width", label: "Width", node_id: "2", input_name: "width", value_type: "integer" },
          { key: "height", label: "Height", node_id: "2", input_name: "height", value_type: "integer" },
        ],
      },
    };
    snapshot.parameter_bindings = [{
      parameter_key: "cfg",
      mode: "range",
      include_base: true,
      range: { start: "0.10", end: "0.30", step: "0.05" },
    }];
    snapshot.linked_parameter_sets = [{
      set_key: "resolution",
      set_label: "Resolution",
      members: ["width", "height"],
      rows: [
        { row_label: "Landscape", values: { width: 1024, height: 768 } },
        { row_label: "Base width", values: { width: null, height: 512 } },
      ],
    }];
    snapshot.seed_intent = { mode: "random", values: [], random_seed_count: 2 };
    snapshot.prompt_versions[0].prompt_id = null;
    snapshot.workflow_selection.workflow_id = null;
    snapshot.workflow_selection.workflow_profile_id = null;

    const form = editableBatchSnapshotToForm({
      run_id: "run-1",
      batch_snapshot: snapshot,
      resources: {
        prompt_versions: [
          { position: 0, historical_version_id: "current-prompt-1", status: "linked", reason: null, linked_version_id: "current-prompt-1", linked_resource_id: "prompt-1" },
          { position: 1, historical_version_id: "historical-prompt-2", status: "conflict", reason: "content mismatch", linked_version_id: null, linked_resource_id: null },
        ],
        workflow_version: { historical_version_id: "historical-workflow", status: "detached", reason: "missing", linked_version_id: null, linked_resource_id: "recovered-workflow" },
        workflow_profile_version: { historical_version_id: "historical-profile", status: "conflict", reason: "content mismatch", linked_version_id: null, linked_resource_id: "recovered-profile" },
      },
    });

    expect(form.prompts.map(({ libraryProjectId, versionId, text }) => ({ libraryProjectId, versionId, text }))).toEqual([
      { libraryProjectId: "project-1", versionId: "current-prompt-1", text: "First" },
      { libraryProjectId: null, versionId: "historical-prompt-2", text: "Second" },
    ]);
    expect(form.imageBindings).toEqual(snapshot.image_bindings);
    expect(form.parameterBindings[0]).toMatchObject({
      parameterKey: "cfg",
      valueType: "float",
      mode: "range",
      range: { start: "0.10", end: "0.30", step: "0.05", includeBase: true },
    });
    expect(form.linkedParameterSets[0]).toEqual({
      setKey: "resolution",
      setLabel: "Resolution",
      members: [
        { parameterKey: "width", valueType: "integer" },
        { parameterKey: "height", valueType: "integer" },
      ],
      rows: [
        { rowLabel: "Landscape", values: { width: { kind: "override", value: "1024" }, height: { kind: "override", value: "768" } } },
        { rowLabel: "Base width", values: { width: { kind: "base" }, height: { kind: "override", value: "512" } } },
      ],
    });
    expect(form).toMatchObject({
      seedMode: "random",
      randomSeedCount: "2",
      workflowLibraryProjectId: null,
      workflowVersionId: "historical-workflow",
      workflowProfileVersionId: "historical-profile",
      workflowContentSha256: null,
      workflowProfileContentSha256: null,
      workflowId: "recovered-workflow",
      workflowProfileId: "recovered-profile",
    });
    expect(form.prompts[0].promptId).toBe("prompt-1");
    expect(form.historicalImportCopyResolutions).toEqual({
      promptVersions: [],
      workflowVersion: null,
      workflowProfileVersion: null,
    });
    expect(JSON.parse(form.workflowJson)).toEqual(snapshot.workflow_selection.workflow);
    expect(JSON.parse(form.workflowProfileJson)).toEqual(snapshot.workflow_selection.workflow_profile);
  });

  it("restores validated import-copy selections by frozen Prompt position after reordering", () => {
    const snapshot = buildEditableBatchSnapshot(populatedBatchForm());
    snapshot.prompt_versions = [
      { id: "historical-first", prompt_id: null, version_number: 1, name: "First", text: "First text" },
      { id: "historical-second", prompt_id: null, version_number: 1, name: "Second", text: "Second text" },
    ];
    snapshot.workflow_selection.workflow_version_id = "historical-workflow";
    snapshot.workflow_selection.workflow_profile_version_id = "historical-profile";
    const reconstruction = {
      run_id: "run-1",
      batch_snapshot: snapshot,
      resources: {
        prompt_versions: [
          { position: 0, historical_version_id: "historical-first", status: "detached" as const, reason: "missing", linked_version_id: null, linked_resource_id: null },
          { position: 1, historical_version_id: "historical-second", status: "detached" as const, reason: "missing", linked_version_id: null, linked_resource_id: null },
        ],
        workflow_version: { historical_version_id: "historical-workflow", status: "detached" as const, reason: "missing", linked_version_id: null, linked_resource_id: null },
        workflow_profile_version: { historical_version_id: "historical-profile", status: "detached" as const, reason: "missing", linked_version_id: null, linked_resource_id: null },
      },
    };
    const current = editableBatchSnapshotToForm(reconstruction);
    current.prompts = [
      { ...current.prompts[1], libraryProjectId: "project-1", promptId: "copied-prompt", versionId: "copied-second", snapshotName: "Second copy" },
      current.prompts[0],
    ];
    current.workflowLibraryProjectId = "project-1";
    current.workflowId = "copied-workflow";
    current.workflowVersionId = "copied-workflow-version";
    current.workflowProfileId = "copied-profile";
    current.workflowProfileVersionId = "copied-profile-version";
    current.workflowProfileWorkflowVersionId = "copied-workflow-version";
    current.workflowProfileJson = JSON.stringify({
      ...JSON.parse(current.workflowProfileJson),
      id: "copied-profile",
      name: "Copied profile",
    });
    current.historicalImportCopyResolutions = {
      promptVersions: [{ position: 1, historicalVersionId: "historical-second", copiedVersionId: "copied-second" }],
      workflowVersion: { historicalVersionId: "historical-workflow", copiedVersionId: "copied-workflow-version" },
      workflowProfileVersion: { historicalVersionId: "historical-profile", copiedVersionId: "copied-profile-version" },
    };

    const restored = restoreHistoricalResourceState(current, reconstruction);

    expect(restored.prompts.map((prompt) => prompt.versionId)).toEqual(["copied-second", "historical-first"]);
    expect(restored.prompts[0]).toMatchObject({
      libraryProjectId: "project-1",
      promptId: "copied-prompt",
      historicalResourceStatus: "detached",
    });
    expect(restored).toMatchObject({
      workflowId: "copied-workflow",
      workflowVersionId: "copied-workflow-version",
      workflowProfileId: "copied-profile",
      workflowProfileVersionId: "copied-profile-version",
      historicalImportCopyResolutions: current.historicalImportCopyResolutions,
    });
    expect(buildEditableBatchSnapshot(restored)).not.toHaveProperty("historicalImportCopyResolutions");
    const withoutResolutions = structuredClone(restored);
    withoutResolutions.historicalImportCopyResolutions = {
      promptVersions: [],
      workflowVersion: null,
      workflowProfileVersion: null,
    };
    expect(canonicalBatchIntent(restored)).toBe(canonicalBatchIntent(withoutResolutions));

    restored.historicalImportCopyResolutions.promptVersions[0].historicalVersionId = "wrong-source";
    restored.historicalImportCopyResolutions.workflowProfileVersion = {
      historicalVersionId: "wrong-profile",
      copiedVersionId: "copied-profile-version",
    };
    const invalidated = restoreHistoricalResourceState(restored, reconstruction);
    expect(invalidated.historicalImportCopyResolutions.promptVersions).toEqual([]);
    expect(invalidated.historicalImportCopyResolutions.workflowVersion).toEqual(
      current.historicalImportCopyResolutions.workflowVersion,
    );
    expect(invalidated.historicalImportCopyResolutions.workflowProfileVersion).toBeNull();

    const partial = editableBatchSnapshotToForm(reconstruction);
    partial.workflowJson = "{}";
    partial.historicalImportCopyResolutions.workflowVersion = {
      historicalVersionId: "historical-workflow",
      copiedVersionId: "copied-workflow-version",
    };
    const restoredPartial = restoreHistoricalResourceState(partial, reconstruction);
    expect(restoredPartial.workflowVersionId).toBe("historical-workflow");
    expect(restoredPartial.historicalWorkflowResourceStatus).toBe("detached");
    expect(restoredPartial.historicalImportCopyResolutions.workflowVersion).toEqual(
      partial.historicalImportCopyResolutions.workflowVersion,
    );
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

function parameterBinding(
  parameterKey: string,
  valueType: "string" | "integer" | "float" | "boolean",
  alternatives: Array<{ kind: "base" } | { kind: "override"; value: string }>,
) {
  return {
    parameterKey,
    valueType,
    mode: "values" as const,
    alternatives,
    range: valueType === "integer"
      ? { start: "0", end: "10", step: "1", includeBase: false }
      : { start: "0", end: "1", step: "0.1", includeBase: false },
  };
}
