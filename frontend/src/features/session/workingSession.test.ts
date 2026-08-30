import { describe, expect, it } from "vitest";

import { initialBatchForm, newPrompt, newVariableBinding, type BatchFormState } from "../batch/form";
import {
  loadWorkingSession,
  saveWorkingSession,
  WORKING_SESSION_KEY,
} from "./workingSession";

describe("browser working session", () => {
  it("round-trips a v6 draft with no selected PromptVersions", () => {
    const storage = new MemoryStorage();
    const form = populatedForm();
    form.prompts = [];

    saveWorkingSession(form, null, [], "restored-project", storage);

    const restored = loadWorkingSession(storage);
    expect(restored.form.prompts).toEqual([]);
    expect(restored.selectedProjectId).toBe("restored-project");
  });

  it("round-trips v7 Project and Workflow library metadata without UI keys", () => {
    const storage = new MemoryStorage();
    const form = populatedForm();
    form.seedMode = "random";
    form.workflowLibraryProjectId = "library-project";
    form.workflowId = "workflow-1";
    form.workflowName = "Portrait workflow";
    form.workflowVersionId = "workflow-v2";
    form.workflowVersionNumber = 2;
    form.workflowProfileId = "profile-1";
    form.workflowProfileName = "Default mapping";
    form.workflowProfileVersionId = "profile-v3";
    form.workflowProfileVersionNumber = 3;
    form.workflowProfileWorkflowVersionId = "workflow-v2";
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
    );
    const stored = JSON.parse(storage.getItem(WORKING_SESSION_KEY) ?? "{}") as Record<string, unknown>;
    const restored = loadWorkingSession(storage);

    expect(stored.version).toBe(8);
    expect(stored.selected_project_id).toBe("selected-project");
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
    expect(stored).not.toHaveProperty("preview");
    expect(withoutKeys(restored.form)).toEqual(withoutKeys(form));
    expect(restored.currentRunId).toBe("run-42");
    expect(restored.sessionRunIds).toEqual(["run-40", "run-42"]);
    expect(restored.selectedProjectId).toBe("selected-project");
    expect(restored.form).toMatchObject({
      workflowLibraryProjectId: "library-project",
      workflowId: "workflow-1",
      workflowVersionId: "workflow-v2",
      workflowProfileId: "profile-1",
      workflowProfileVersionId: "profile-v3",
      workflowJson: '{"workflow":true}',
      workflowProfileJson: '{"profile":true}',
    });
    expect(restored.draftRestored).toBe(true);
  });

  it("round-trips a null Project selection", () => {
    const storage = new MemoryStorage();

    saveWorkingSession(populatedForm(), null, [], null, storage);

    expect(loadWorkingSession(storage).selectedProjectId).toBeNull();
  });

  it("migrates version 5 with a trimmed form Project candidate", () => {
    const storage = new MemoryStorage();
    const form = populatedForm();
    form.projectId = "  restored-project  ";
    saveWorkingSession(form, "run-42", ["run-42"], null, storage);
    const versionFive = JSON.parse(storage.getItem(WORKING_SESSION_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    versionFive.version = 5;
    delete versionFive.selected_project_id;
    storage.setItem(WORKING_SESSION_KEY, JSON.stringify(versionFive));

    const restored = loadWorkingSession(storage);

    expect(restored.selectedProjectId).toBe("restored-project");
    expect(restored.form.projectId).toBe("  restored-project  ");
    expect(restored.currentRunId).toBe("run-42");
    expect(restored.form.prompts[0]).toMatchObject({
      libraryProjectId: "library-project",
      promptId: "prompt-logical",
      versionId: "prompt-restored",
      text: "Restored {{subject}}",
    });
  });

  it("migrates version 6 Workflow snapshots as detached without rewriting raw JSON", () => {
    const storage = new MemoryStorage();
    saveWorkingSession(populatedForm(), null, [], "restored-project", storage);
    const envelope = JSON.parse(storage.getItem(WORKING_SESSION_KEY) ?? "{}") as {
      version: number;
      form: Record<string, unknown>;
    };
    envelope.version = 6;
    for (const field of workflowLinkFields) delete envelope.form[field];
    storage.setItem(WORKING_SESSION_KEY, JSON.stringify(envelope));

    const restored = loadWorkingSession(storage).form;

    expect(restored.workflowJson).toBe('{"workflow":true}');
    expect(restored.workflowProfileJson).toBe('{"profile":true}');
    expect(restored).toMatchObject({
      workflowLibraryProjectId: null,
      workflowId: null,
      workflowVersionId: null,
      workflowProfileId: null,
      workflowProfileVersionId: null,
    });
  });

  it("rejects malformed v5 prompt metadata", () => {
    const storage = new MemoryStorage();
    saveWorkingSession(populatedForm(), "run-42", ["run-42"], null, storage);
    const envelope = JSON.parse(storage.getItem(WORKING_SESSION_KEY) ?? "{}") as Record<
      string,
      unknown
    > & { form: { prompts: Array<Record<string, unknown>> } };
    envelope.version = 5;
    delete envelope.selected_project_id;
    envelope.form.prompts[0].versionNumber = "7";
    storage.setItem(WORKING_SESSION_KEY, JSON.stringify(envelope));

    const restored = loadWorkingSession(storage);

    expect(restored.draftRestored).toBe(false);
  });

  it("migrates version 4 prompts to detached library metadata", () => {
    const storage = new MemoryStorage();
    saveWorkingSession(populatedForm(), "run-42", ["run-42"], null, storage);
    const versionFour = version4Envelope(storage);
    storage.setItem(WORKING_SESSION_KEY, JSON.stringify(versionFour));

    const restored = loadWorkingSession(storage);

    expect(restored.form.prompts[0]).toMatchObject({
      libraryProjectId: null,
      promptId: null,
      promptName: "Restored Prompt",
      versionId: "prompt-restored",
      versionNumber: null,
      snapshotName: "Restored Prompt",
      text: "Restored {{subject}}",
    });
    expect(restored.selectedProjectId).toBe("restored-project");
    expect(restored.form.referenceAssetIds).toEqual(["asset-b", "asset-a"]);
    expect(restored.form.seedValues).toBe("9, 3");
    expect(restored.form.workflowJson).toBe('{"workflow":true}');
    expect(restored.form.batchId).toBe("restored-batch");
  });

  it("migrates version 1 by retaining its current Run as the first session Run", () => {
    const storage = new MemoryStorage();
    saveWorkingSession(populatedForm(), "run-42", [], null, storage);
    const versionOne = legacyEnvelope(storage, 1);
    delete versionOne.session_run_ids;
    delete (versionOne.form as Record<string, unknown>).randomSeedCount;
    storage.setItem(WORKING_SESSION_KEY, JSON.stringify(versionOne));

    const restored = loadWorkingSession(storage);

    expect(restored.currentRunId).toBe("run-42");
    expect(restored.sessionRunIds).toEqual(["run-42"]);
    expect(restored.draftRestored).toBe(true);
    expect(restored.form.randomSeedCount).toBe("1");
    expect(restored.form.prompts[0]).toMatchObject({
      libraryProjectId: null,
      promptId: null,
      promptName: "Prompt 1",
      versionId: "prompt-restored",
      versionNumber: null,
      snapshotName: "Prompt 1",
      text: "Restored {{subject}}",
    });
    expect(restored.selectedProjectId).toBe("restored-project");
    expect(restored.form.referenceAssetIds).toEqual(["asset-b", "asset-a"]);
    expect(restored.form.seedValues).toBe("9, 3");
    expect(restored.form.workflowProfileJson).toBe('{"profile":true}');
    expect(restored.form.batchId).toBe("restored-batch");
  });

  it("migrates version 2 with its ordered session Runs and a default Random count", () => {
    const storage = new MemoryStorage();
    saveWorkingSession(populatedForm(), "run-42", ["run-40", "run-42"], null, storage);
    const versionTwo = legacyEnvelope(storage, 2);
    delete (versionTwo.form as Record<string, unknown>).randomSeedCount;
    storage.setItem(WORKING_SESSION_KEY, JSON.stringify(versionTwo));

    const restored = loadWorkingSession(storage);

    expect(restored.currentRunId).toBe("run-42");
    expect(restored.sessionRunIds).toEqual(["run-40", "run-42"]);
    expect(restored.form.randomSeedCount).toBe("1");
  });

  it("migrates a version 3 singular prompt and preserves Run IDs", () => {
    const storage = new MemoryStorage();
    saveWorkingSession(populatedForm(), "run-42", ["run-40", "run-42"], null, storage);
    const versionThree = legacyEnvelope(storage, 3);
    storage.setItem(WORKING_SESSION_KEY, JSON.stringify(versionThree));

    const restored = loadWorkingSession(storage);

    expect(restored.form.prompts).toHaveLength(1);
    expect(restored.form.prompts[0]).toMatchObject({
      libraryProjectId: null,
      promptId: null,
      promptName: "Prompt 1",
      versionId: "prompt-restored",
      versionNumber: null,
      snapshotName: "Prompt 1",
      text: "Restored {{subject}}",
    });
    expect(restored.currentRunId).toBe("run-42");
    expect(restored.sessionRunIds).toEqual(["run-40", "run-42"]);
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
    const restoredKeys = restored.variableBindings.map((binding) => binding.key);
    const addedPrompt = newPrompt();
    const added = newVariableBinding();

    expect(new Set(restoredPromptKeys).size).toBe(restoredPromptKeys.length);
    expect(restoredPromptKeys).not.toEqual(storedPromptKeys);
    expect(restoredPromptKeys).not.toContain(addedPrompt.key);
    expect(new Set(restoredKeys).size).toBe(restoredKeys.length);
    expect(restoredKeys).not.toEqual(storedBindingKeys);
    expect(restoredKeys).not.toContain(added.key);
  });

  it("falls back for a malformed v6 selected Project ID", () => {
    const storage = new MemoryStorage();
    saveWorkingSession(populatedForm(), "run-42", ["run-42"], "selected-project", storage);
    const envelope = JSON.parse(storage.getItem(WORKING_SESSION_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    envelope.selected_project_id = "";
    storage.setItem(WORKING_SESSION_KEY, JSON.stringify(envelope));

    const restored = loadWorkingSession(storage);

    expect(restored.draftRestored).toBe(false);
    expect(restored.selectedProjectId).toBeNull();
  });

  it.each([
    "not json",
    JSON.stringify({ version: 99, form: {}, current_run_id: null }),
    JSON.stringify({ version: 1, form: { promptText: "incomplete" }, current_run_id: null }),
  ])("falls back safely for malformed or incompatible data", (stored) => {
    const storage = new MemoryStorage();
    storage.setItem(WORKING_SESSION_KEY, stored);

    const restored = loadWorkingSession(storage);

    expect(restored.draftRestored).toBe(false);
    expect(restored.currentRunId).toBeNull();
    expect(restored.sessionRunIds).toEqual([]);
    expect(restored.selectedProjectId).toBeNull();
    expect(restored.form.prompts).toEqual([]);
  });

  it("ignores storage read and write exceptions", () => {
    const unavailable = new ThrowingStorage();

    expect(() =>
      saveWorkingSession(populatedForm(), "run-42", ["run-42"], null, unavailable),
    ).not.toThrow();
    expect(loadWorkingSession(unavailable).draftRestored).toBe(false);
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
  form.variableBindings[0].values = "fox\nwolf";
  form.variableBindings[0].selectedValues = "wolf\nfox";
  form.referenceAssetIds = ["asset-b", "asset-a"];
  form.seedMode = "explicit";
  form.seedValues = "9, 3";
  form.randomSeedCount = "7";
  form.workflowJson = '{"workflow":true}';
  form.workflowProfileJson = '{"profile":true}';
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
      variableListId: binding.variableListId,
      values: binding.values,
      mode: binding.mode,
      selectedValues: binding.selectedValues,
      fixedValue: binding.fixedValue,
    })),
  };
}

function legacyEnvelope(storage: Storage, version: 1 | 2 | 3): Record<string, unknown> {
  const envelope = JSON.parse(storage.getItem(WORKING_SESSION_KEY) ?? "{}") as Record<string, unknown>;
  envelope.version = version;
  const form = envelope.form as Record<string, unknown>;
  const prompts = form.prompts as Array<{ versionId: string; text: string }>;
  form.promptVersionId = prompts[0].versionId;
  form.promptText = prompts[0].text;
  delete form.prompts;
  return envelope;
}

function version4Envelope(storage: Storage): Record<string, unknown> {
  const envelope = JSON.parse(storage.getItem(WORKING_SESSION_KEY) ?? "{}") as Record<string, unknown>;
  envelope.version = 4;
  const form = envelope.form as Record<string, unknown>;
  const prompts = form.prompts as Array<{ versionId: string; snapshotName: string; text: string }>;
  form.prompts = prompts.map(({ versionId, snapshotName, text }) => ({
    versionId,
    name: snapshotName,
    text,
  }));
  return envelope;
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

const workflowLinkFields = [
  "workflowLibraryProjectId",
  "workflowId",
  "workflowName",
  "workflowVersionId",
  "workflowVersionNumber",
  "workflowProfileId",
  "workflowProfileName",
  "workflowProfileVersionId",
  "workflowProfileVersionNumber",
  "workflowProfileWorkflowVersionId",
] as const;
