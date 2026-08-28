import { describe, expect, it } from "vitest";

import { initialBatchForm, newVariableBinding, type BatchFormState } from "../batch/form";
import {
  loadWorkingSession,
  saveWorkingSession,
  WORKING_SESSION_KEY,
} from "./workingSession";

describe("browser working session", () => {
  it("round-trips ordered prompts without UI keys and ordered unique session Run IDs", () => {
    const storage = new MemoryStorage();
    const form = populatedForm();
    form.seedMode = "random";
    form.prompts.push({
      key: 999,
      versionId: "prompt-second",
      name: "Second Prompt",
      text: "Second {{subject}}",
    });

    saveWorkingSession(form, "run-42", ["run-40", "run-42", "run-40"], storage);
    const stored = JSON.parse(storage.getItem(WORKING_SESSION_KEY) ?? "{}") as Record<string, unknown>;
    const restored = loadWorkingSession(storage);

    expect(stored.version).toBe(4);
    expect((stored.form as { prompts: unknown[] }).prompts).toEqual([
      { versionId: "prompt-restored", name: "Restored Prompt", text: "Restored {{subject}}" },
      { versionId: "prompt-second", name: "Second Prompt", text: "Second {{subject}}" },
    ]);
    expect(stored).not.toHaveProperty("preview");
    expect(withoutKeys(restored.form)).toEqual(withoutKeys(form));
    expect(restored.currentRunId).toBe("run-42");
    expect(restored.sessionRunIds).toEqual(["run-40", "run-42"]);
    expect(restored.draftRestored).toBe(true);
  });

  it("migrates version 1 by retaining its current Run as the first session Run", () => {
    const storage = new MemoryStorage();
    saveWorkingSession(populatedForm(), "run-42", [], storage);
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
      versionId: "prompt-restored",
      name: "Prompt 1",
      text: "Restored {{subject}}",
    });
  });

  it("migrates version 2 with its ordered session Runs and a default Random count", () => {
    const storage = new MemoryStorage();
    saveWorkingSession(populatedForm(), "run-42", ["run-40", "run-42"], storage);
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
    saveWorkingSession(populatedForm(), "run-42", ["run-40", "run-42"], storage);
    const versionThree = legacyEnvelope(storage, 3);
    storage.setItem(WORKING_SESSION_KEY, JSON.stringify(versionThree));

    const restored = loadWorkingSession(storage);

    expect(restored.form.prompts).toHaveLength(1);
    expect(restored.form.prompts[0]).toMatchObject({
      versionId: "prompt-restored",
      name: "Prompt 1",
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
    saveWorkingSession(form, null, [], storage);

    const restored = loadWorkingSession(storage).form;
    const restoredPromptKeys = restored.prompts.map((prompt) => prompt.key);
    const restoredKeys = restored.variableBindings.map((binding) => binding.key);
    const addedPrompt = initialBatchForm().prompts[0];
    const added = newVariableBinding();

    expect(new Set(restoredPromptKeys).size).toBe(restoredPromptKeys.length);
    expect(restoredPromptKeys).not.toContain(addedPrompt.key);
    expect(new Set(restoredKeys).size).toBe(restoredKeys.length);
    expect(restoredKeys).not.toContain(added.key);
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
    expect(restored.form.prompts[0].text).toBe(initialBatchForm().prompts[0].text);
  });

  it("ignores storage read and write exceptions", () => {
    const unavailable = new ThrowingStorage();

    expect(() => saveWorkingSession(populatedForm(), "run-42", ["run-42"], unavailable)).not.toThrow();
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
  form.prompts[0].versionId = "prompt-restored";
  form.prompts[0].name = "Restored Prompt";
  form.prompts[0].text = "Restored {{subject}}";
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
    prompts: form.prompts.map(({ versionId, name, text }) => ({ versionId, name, text })),
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
