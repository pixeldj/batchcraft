import { describe, expect, it } from "vitest";

import { initialBatchForm, newVariableBinding, type BatchFormState } from "../batch/form";
import {
  loadWorkingSession,
  saveWorkingSession,
  WORKING_SESSION_KEY,
} from "./workingSession";

describe("browser working session", () => {
  it("round-trips form values and ordered unique session Run IDs", () => {
    const storage = new MemoryStorage();
    const form = populatedForm();

    saveWorkingSession(form, "run-42", ["run-40", "run-42", "run-40"], storage);
    const restored = loadWorkingSession(storage);

    expect(withoutKeys(restored.form)).toEqual(withoutKeys(form));
    expect(restored.currentRunId).toBe("run-42");
    expect(restored.sessionRunIds).toEqual(["run-40", "run-42"]);
    expect(restored.draftRestored).toBe(true);
  });

  it("migrates version 1 by retaining its current Run as the first session Run", () => {
    const storage = new MemoryStorage();
    saveWorkingSession(populatedForm(), "run-42", [], storage);
    const versionTwo = JSON.parse(storage.getItem(WORKING_SESSION_KEY) ?? "{}") as Record<string, unknown>;
    versionTwo.version = 1;
    delete versionTwo.session_run_ids;
    storage.setItem(WORKING_SESSION_KEY, JSON.stringify(versionTwo));

    const restored = loadWorkingSession(storage);

    expect(restored.currentRunId).toBe("run-42");
    expect(restored.sessionRunIds).toEqual(["run-42"]);
    expect(restored.draftRestored).toBe(true);
  });

  it("allocates fresh binding keys and advances the allocator after restore", () => {
    const storage = new MemoryStorage();
    const form = populatedForm();
    form.variableBindings.push({ ...newVariableBinding(), placeholder: "style" });
    saveWorkingSession(form, null, [], storage);

    const restored = loadWorkingSession(storage).form;
    const restoredKeys = restored.variableBindings.map((binding) => binding.key);
    const added = newVariableBinding();

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
    expect(restored.form.promptText).toBe(initialBatchForm().promptText);
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
  form.promptVersionId = "prompt-restored";
  form.promptText = "Restored {{subject}}";
  form.variableBindings[0].values = "fox\nwolf";
  form.variableBindings[0].selectedValues = "wolf\nfox";
  form.referenceAssetIds = ["asset-b", "asset-a"];
  form.seedMode = "explicit";
  form.seedValues = "9, 3";
  form.workflowJson = '{"workflow":true}';
  form.workflowProfileJson = '{"profile":true}';
  return form;
}

function withoutKeys(form: BatchFormState) {
  return {
    ...form,
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
