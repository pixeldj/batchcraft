import { describe, expect, it } from "vitest";

import { initialBatchForm, newPrompt, newVariableBinding, type BatchFormState } from "../batch/form";
import {
  loadWorkingSession,
  saveWorkingSession,
  WORKING_SESSION_KEY,
} from "./workingSession";

describe("browser working session", () => {
  it("round-trips a v11 draft and recovery metadata without UI keys", () => {
    const storage = new MemoryStorage();
    const form = populatedForm();
    form.seedMode = "random";
    form.prompts.push({
      key: 999,
      libraryProjectId: null,
      promptId: null,
      promptName: "Second Prompt",
      versionId: "prompt-second",
      versionNumber: null,
      snapshotName: "Second Prompt",
      text: "Second {{subject}}",
    });

    saveWorkingSession(
      form,
      "run-42",
      ["run-40", "run-42", "run-40"],
      "selected-project",
      storage,
      "saved-batch-1",
      7,
    );
    const stored = JSON.parse(storage.getItem(WORKING_SESSION_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    const restored = loadWorkingSession(storage);

    expect(stored.version).toBe(11);
    expect(stored).toMatchObject({
      current_run_id: "run-42",
      session_run_ids: ["run-40", "run-42"],
      selected_project_id: "selected-project",
      selected_saved_batch_id: "saved-batch-1",
      saved_batch_base_revision: 7,
    });
    expect((stored.form as { prompts: unknown[] }).prompts).toEqual([
      {
        libraryProjectId: "library-project",
        promptId: "prompt-logical",
        promptName: "Current Prompt Name",
        versionId: "prompt-restored",
        versionNumber: 7,
        snapshotName: "Restored Prompt",
        text: "Restored {{subject}}",
      },
      {
        libraryProjectId: null,
        promptId: null,
        promptName: "Second Prompt",
        versionId: "prompt-second",
        versionNumber: null,
        snapshotName: "Second Prompt",
        text: "Second {{subject}}",
      },
    ]);
    expect((stored.form as { variableBindings: unknown[] }).variableBindings).toEqual([
      { placeholder: "subject", values: ["wolf", "fox"] },
    ]);
    expect(withoutKeys(restored.form)).toEqual(withoutKeys(form));
    expect(restored).toMatchObject({
      currentRunId: "run-42",
      sessionRunIds: ["run-40", "run-42"],
      selectedProjectId: "selected-project",
      selectedSavedBatchId: "saved-batch-1",
      savedBatchBaseRevision: 7,
      draftRestored: true,
    });
  });

  it("round-trips an incomplete v11 draft", () => {
    const storage = new MemoryStorage();
    const form = populatedForm();
    form.prompts = [];
    form.variableBindings = [];

    saveWorkingSession(form, null, [], null, storage);

    const restored = loadWorkingSession(storage);
    expect(restored.form.prompts).toEqual([]);
    expect(restored.form.variableBindings).toEqual([]);
    expect(restored.selectedProjectId).toBeNull();
    expect(restored.draftRestored).toBe(true);
  });

  it("reconciles restored Parameter bindings to stored Profile order and exact keys", () => {
    const storage = new MemoryStorage();
    const form = populatedForm();
    form.workflowProfileJson = JSON.stringify({ mappings: {}, image_inputs: [], parameters: [
      { key: "steps", label: "Steps", node_id: "1", input_name: "steps", value_type: "integer" },
      { key: "enabled", label: "Enabled", node_id: "1", input_name: "enabled", value_type: "boolean" },
    ] });
    form.parameterBindings = [
      { parameterKey: "unknown", valueType: "string", mode: "override", value: "remove me" },
      { parameterKey: "steps", valueType: "integer", mode: "override", value: "30" },
    ];

    saveWorkingSession(form, null, [], null, storage);

    expect(loadWorkingSession(storage).form.parameterBindings).toEqual([
      { parameterKey: "steps", valueType: "integer", mode: "override", value: "30" },
      { parameterKey: "enabled", valueType: "boolean", mode: "base", value: "" },
    ]);
  });

  it("round-trips zero values and one exact empty value distinctly", () => {
    const storage = new MemoryStorage();
    const form = populatedForm();
    form.variableBindings = [
      { ...form.variableBindings[0], values: [] },
      { ...newVariableBinding(), placeholder: "style", values: [""] },
    ];

    saveWorkingSession(form, null, [], null, storage);

    expect(loadWorkingSession(storage).form.variableBindings.map((binding) => binding.values))
      .toEqual([[], [""]]);
  });

  it("preserves duplicate and raw Variable Binding editor state", () => {
    const storage = new MemoryStorage();
    const form = populatedForm();
    form.variableBindings[0].placeholder = " subject ";
    form.variableBindings[0].values = [" first ", "first", "   "];

    saveWorkingSession(form, null, [], null, storage);

    expect(loadWorkingSession(storage).form.variableBindings[0]).toMatchObject({
      placeholder: " subject ",
      values: [" first ", "first", "   "],
    });
  });

  it("allocates fresh prompt and binding keys and advances both allocators after restore", () => {
    const storage = new MemoryStorage();
    const form = populatedForm();
    form.prompts.push({ ...form.prompts[0], key: 999, versionId: "prompt-2" });
    form.variableBindings.push({ ...newVariableBinding(), placeholder: "style" });
    const storedPromptKeys = form.prompts.map((prompt) => prompt.key);
    const storedBindingKeys = form.variableBindings.map((binding) => binding.key);
    saveWorkingSession(form, null, [], null, storage);

    const restored = loadWorkingSession(storage).form;
    const restoredPromptKeys = restored.prompts.map((prompt) => prompt.key);
    const restoredBindingKeys = restored.variableBindings.map((binding) => binding.key);
    const addedPrompt = newPrompt();
    const addedBinding = newVariableBinding();

    expect(new Set(restoredPromptKeys).size).toBe(restoredPromptKeys.length);
    expect(restoredPromptKeys).not.toEqual(storedPromptKeys);
    expect(restoredPromptKeys).not.toContain(addedPrompt.key);
    expect(new Set(restoredBindingKeys).size).toBe(restoredBindingKeys.length);
    expect(restoredBindingKeys).not.toEqual(storedBindingKeys);
    expect(restoredBindingKeys).not.toContain(addedBinding.key);
  });

  it.each([
    ["prompt metadata", (envelope: Record<string, unknown>) => {
      const form = envelope.form as { prompts: Array<Record<string, unknown>> };
      form.prompts[0].versionNumber = "7";
    }],
    ["Variable Binding values", (envelope: Record<string, unknown>) => {
      const form = envelope.form as { variableBindings: Array<Record<string, unknown>> };
      form.variableBindings[0].values = ["wolf", 42];
    }],
    ["empty Image Input alternatives", (envelope: Record<string, unknown>) => {
      const form = envelope.form as { imageBindings: Array<Record<string, unknown>> };
      form.imageBindings[0].values = [];
    }],
    ["duplicate Image Input alternatives", (envelope: Record<string, unknown>) => {
      const form = envelope.form as { imageBindings: Array<Record<string, unknown>> };
      form.imageBindings[0].values = [null, null];
    }],
    ["selected Project ID", (envelope: Record<string, unknown>) => {
      envelope.selected_project_id = "";
    }],
    ["Saved Batch revision", (envelope: Record<string, unknown>) => {
      envelope.saved_batch_base_revision = 0;
    }],
    ["removed Variable Binding field", (envelope: Record<string, unknown>) => {
      const form = envelope.form as { variableBindings: Array<Record<string, unknown>> };
      form.variableBindings[0].mode = "all";
    }],
    ["duplicate session Run IDs", (envelope: Record<string, unknown>) => {
      envelope.session_run_ids = ["run-42", "run-42"];
    }],
    ["unknown envelope field", (envelope: Record<string, unknown>) => {
      envelope.legacy = true;
    }],
    ["Parameter binding value", (envelope: Record<string, unknown>) => {
      const form = envelope.form as { parameterBindings: Array<Record<string, unknown>> };
      form.parameterBindings[0].value = 30;
    }],
  ] as const)("falls back for malformed v11 %s", (_name, mutate) => {
    const storage = new MemoryStorage();
    saveWorkingSession(
      populatedForm(),
      "run-42",
      ["run-42"],
      "selected-project",
      storage,
      "saved-batch-1",
      1,
    );
    const envelope = JSON.parse(storage.getItem(WORKING_SESSION_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    mutate(envelope);
    storage.setItem(WORKING_SESSION_KEY, JSON.stringify(envelope));

    expectFreshSession(loadWorkingSession(storage));
  });

  it.each([1, 8, 9, 10, 12, 99])("resets an old or unknown version %i", (version) => {
    const storage = new MemoryStorage();
    saveWorkingSession(populatedForm(), "run-42", ["run-42"], "selected-project", storage);
    const envelope = JSON.parse(storage.getItem(WORKING_SESSION_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    envelope.version = version;
    storage.setItem(WORKING_SESSION_KEY, JSON.stringify(envelope));

    expectFreshSession(loadWorkingSession(storage));
  });

  it.each([
    "not json",
    JSON.stringify({ version: 11, form: { prompts: [] }, current_run_id: null }),
  ])("falls back safely for malformed current data", (stored) => {
    const storage = new MemoryStorage();
    storage.setItem(WORKING_SESSION_KEY, stored);

    expectFreshSession(loadWorkingSession(storage));
  });

  it("ignores storage read and write exceptions", () => {
    const unavailable = new ThrowingStorage();

    expect(() =>
      saveWorkingSession(populatedForm(), "run-42", ["run-42"], null, unavailable),
    ).not.toThrow();
    expectFreshSession(loadWorkingSession(unavailable));
  });
});

function populatedForm(): BatchFormState {
  const form = initialBatchForm();
  form.projectId = "restored-project";
  form.projectFilesystemKey = "restored_project";
  form.projectName = "Restored Project";
  form.batchId = "restored-batch";
  form.batchFilesystemKey = "restored_batch";
  form.batchName = "Restored Batch";
  form.batchDescription = "Restored description";
  form.prompts = [{
    key: newPrompt().key,
    libraryProjectId: "library-project",
    promptId: "prompt-logical",
    promptName: "Current Prompt Name",
    versionId: "prompt-restored",
    versionNumber: 7,
    snapshotName: "Restored Prompt",
    text: "Restored {{subject}}",
  }];
  form.variableBindings[0].values = ["wolf", "fox"];
  form.imageBindings = [
    { slot_key: "style", values: [null, "asset-b", "asset-a"] },
    { slot_key: "composition", values: ["asset-c", "asset-d"] },
  ];
  form.parameterBindings = [{ parameterKey: "steps", valueType: "integer", mode: "override", value: "30" }];
  form.seedMode = "explicit";
  form.seedValues = "9, 3";
  form.randomSeedCount = "7";
  form.workflowJson = '{"workflow":true}';
  form.workflowProfileJson = '{"mappings":{},"image_inputs":[{"key":"style","label":"Style","node_id":"1","input_name":"image"},{"key":"composition","label":"Composition","node_id":"2","input_name":"image"}],"parameters":[{"key":"steps","label":"Steps","node_id":"3","input_name":"steps","value_type":"integer"}]}';
  form.workflowLibraryProjectId = "library-project";
  form.workflowId = "workflow-1";
  form.workflowName = "Portrait workflow";
  form.workflowVersionId = "workflow-v2";
  form.workflowVersionNumber = 2;
  form.workflowContentSha256 = "workflow-sha";
  form.workflowProfileId = "profile-1";
  form.workflowProfileName = "Default mapping";
  form.workflowProfileVersionId = "profile-v3";
  form.workflowProfileVersionNumber = 3;
  form.workflowProfileWorkflowVersionId = "workflow-v2";
  form.workflowProfileContentSha256 = "profile-sha";
  return form;
}

function withoutKeys(form: BatchFormState) {
  return {
    ...form,
    prompts: form.prompts.map((prompt) => ({
      libraryProjectId: prompt.libraryProjectId,
      promptId: prompt.promptId,
      promptName: prompt.promptName,
      versionId: prompt.versionId,
      versionNumber: prompt.versionNumber,
      snapshotName: prompt.snapshotName,
      text: prompt.text,
    })),
    variableBindings: form.variableBindings.map((binding) => ({
      placeholder: binding.placeholder,
      values: binding.values,
    })),
  };
}

function expectFreshSession(restored: ReturnType<typeof loadWorkingSession>): void {
  expect(restored.draftRestored).toBe(false);
  expect(restored.currentRunId).toBeNull();
  expect(restored.sessionRunIds).toEqual([]);
  expect(restored.selectedProjectId).toBeNull();
  expect(restored.selectedSavedBatchId).toBeNull();
  expect(restored.savedBatchBaseRevision).toBeNull();
  expect(restored.form.prompts).toEqual([]);
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

class ThrowingStorage implements Storage {
  get length(): number {
    throw new DOMException("Storage unavailable");
  }

  clear(): void {
    throw new DOMException("Storage unavailable");
  }

  getItem(key: string): string | null {
    void key;
    throw new DOMException("Storage unavailable");
  }

  key(index: number): string | null {
    void index;
    throw new DOMException("Storage unavailable");
  }

  removeItem(key: string): void {
    void key;
    throw new DOMException("Storage unavailable");
  }

  setItem(key: string, value: string): void {
    void key;
    void value;
    throw new DOMException("Quota exceeded");
  }
}
