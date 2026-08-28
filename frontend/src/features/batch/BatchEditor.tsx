import type { BatchcraftApi } from "../../api/client";
import { Field, TextAreaField } from "../../components/Field";
import {
  MAX_RANDOM_SEED_COUNT,
  newPrompt,
  newVariableBinding,
  type BatchFormState,
  type PromptForm,
  type VariableBindingForm,
} from "./form";
import { ReferenceAssetPicker } from "./ReferenceAssetPicker";

interface Props {
  form: BatchFormState;
  api: BatchcraftApi;
  error: string | null;
  previewing: boolean;
  onChange(form: BatchFormState): void;
  onPreview(): void;
}

export function BatchEditor({ api, form, error, previewing, onChange, onPreview }: Props) {
  function update<K extends keyof BatchFormState>(key: K, value: BatchFormState[K]) {
    onChange({ ...form, [key]: value });
  }

  function updateBinding(key: number, patch: Partial<VariableBindingForm>) {
    update(
      "variableBindings",
      form.variableBindings.map((binding) =>
        binding.key === key ? { ...binding, ...patch } : binding,
      ),
    );
  }

  function updatePrompt(key: number, patch: Partial<PromptForm>) {
    update(
      "prompts",
      form.prompts.map((prompt) => prompt.key === key ? { ...prompt, ...patch } : prompt),
    );
  }

  function movePrompt(index: number, offset: -1 | 1) {
    const prompts = [...form.prompts];
    const [prompt] = prompts.splice(index, 1);
    prompts.splice(index + offset, 0, prompt);
    update("prompts", prompts);
  }

  return (
    <section className="section-card batch-editor" aria-labelledby="batch-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">01 / Define</p>
          <h2 id="batch-heading">Batch configuration</h2>
        </div>
        <p className="section-note">Working draft · this browser session only</p>
      </div>

      <fieldset>
        <legend>Project identity</legend>
        <div className="field-grid three-columns">
          <Field
            id="project-id"
            label="Project ID"
            value={form.projectId}
            onChange={(event) => update("projectId", event.target.value)}
          />
          <Field
            id="project-key"
            label="Filesystem key"
            value={form.projectFilesystemKey}
            onChange={(event) =>
              onChange({
                ...form,
                projectFilesystemKey: event.target.value,
                referenceAssetIds: [],
              })
            }
          />
          <Field
            id="project-name"
            label="Project name"
            value={form.projectName}
            onChange={(event) => update("projectName", event.target.value)}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>Batch identity</legend>
        <div className="field-grid three-columns">
          <Field
            id="batch-id"
            label="Batch ID"
            value={form.batchId}
            onChange={(event) => update("batchId", event.target.value)}
          />
          <Field
            id="batch-key"
            label="Filesystem key"
            value={form.batchFilesystemKey}
            onChange={(event) => update("batchFilesystemKey", event.target.value)}
          />
          <Field
            id="batch-name"
            label="Batch name"
            value={form.batchName}
            onChange={(event) => update("batchName", event.target.value)}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>PromptVersions</legend>
        <div className="fieldset-action">
          <button
            className="button-secondary compact"
            type="button"
            onClick={() => update("prompts", [...form.prompts, newPrompt(nextPromptNumber(form.prompts))])}
          >
            Add Prompt
          </button>
        </div>
        <div className="repeater-stack">
          {form.prompts.map((prompt, index) => (
            <div className="repeater-card prompt-card" key={prompt.key}>
              <div className="repeater-title">
                <strong>Prompt {index + 1}</strong>
                <div className="repeater-actions">
                  <button
                    className="button-link"
                    type="button"
                    disabled={index === 0}
                    onClick={() => movePrompt(index, -1)}
                  >
                    Move up
                  </button>
                  <button
                    className="button-link"
                    type="button"
                    disabled={index === form.prompts.length - 1}
                    onClick={() => movePrompt(index, 1)}
                  >
                    Move down
                  </button>
                  <button
                    className="button-link danger"
                    type="button"
                    disabled={form.prompts.length === 1}
                    onClick={() => update("prompts", form.prompts.filter((item) => item.key !== prompt.key))}
                  >
                    Remove
                  </button>
                </div>
              </div>
              <div className="field-grid two-columns">
                <Field
                  id={`prompt-version-id-${prompt.key}`}
                  label="PromptVersion ID"
                  value={prompt.versionId}
                  onChange={(event) => updatePrompt(prompt.key, { versionId: event.target.value })}
                />
                <Field
                  id={`prompt-name-${prompt.key}`}
                  label="Prompt name"
                  value={prompt.name}
                  onChange={(event) => updatePrompt(prompt.key, { name: event.target.value })}
                />
              </div>
              <TextAreaField
                id={`prompt-text-${prompt.key}`}
                className="prompt-editor"
                label="Prompt template"
                hint="Use named placeholders such as {{subject}}. The backend validates and resolves them."
                value={prompt.text}
                onChange={(event) => updatePrompt(prompt.key, { text: event.target.value })}
              />
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Variable bindings</legend>
        <div className="fieldset-action">
          <button
            className="button-secondary compact"
            type="button"
            onClick={() => update("variableBindings", [...form.variableBindings, newVariableBinding()])}
          >
            Add binding
          </button>
        </div>
        {form.variableBindings.length === 0 ? (
          <p className="empty-note">No bindings. Prompts without placeholders need none.</p>
        ) : null}
        <div className="repeater-stack">
          {form.variableBindings.map((binding, index) => (
            <div className="repeater-card" key={binding.key}>
              <div className="repeater-title">
                <strong>Binding {index + 1}</strong>
                <button
                  className="button-link danger"
                  type="button"
                  onClick={() =>
                    update(
                      "variableBindings",
                      form.variableBindings.filter((item) => item.key !== binding.key),
                    )
                  }
                >
                  Remove
                </button>
              </div>
              <div className="field-grid three-columns">
                <Field
                  id={`placeholder-${binding.key}`}
                  label="Placeholder"
                  value={binding.placeholder}
                  onChange={(event) => updateBinding(binding.key, { placeholder: event.target.value })}
                />
                <Field
                  id={`list-id-${binding.key}`}
                  label="Variable List ID"
                  value={binding.variableListId}
                  onChange={(event) =>
                    updateBinding(binding.key, { variableListId: event.target.value })
                  }
                />
                <label className="field" htmlFor={`mode-${binding.key}`}>
                  <span className="field-label">Binding mode</span>
                  <select
                    id={`mode-${binding.key}`}
                    value={binding.mode}
                    onChange={(event) =>
                      updateBinding(binding.key, { mode: event.target.value as "all" | "fixed" })
                    }
                  >
                    <option value="all">All selected values</option>
                    <option value="fixed">Fixed value</option>
                  </select>
                </label>
              </div>
              <div className="field-grid two-columns">
                <TextAreaField
                  id={`values-${binding.key}`}
                  className="short-list"
                  label="Variable List values"
                  hint="One per line; commas inside a value are preserved"
                  value={binding.values}
                  onChange={(event) => updateBinding(binding.key, { values: event.target.value })}
                />
                {binding.mode === "all" ? (
                  <TextAreaField
                    id={`selected-${binding.key}`}
                    className="short-list"
                    label="Selected values"
                    hint="Order controls deterministic expansion"
                    value={binding.selectedValues}
                    onChange={(event) =>
                      updateBinding(binding.key, { selectedValues: event.target.value })
                    }
                  />
                ) : (
                  <Field
                    id={`fixed-${binding.key}`}
                    label="Fixed value"
                    value={binding.fixedValue}
                    onChange={(event) =>
                      updateBinding(binding.key, { fixedValue: event.target.value })
                    }
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className="seed-fieldset">
        <legend>Seeds</legend>
        <div className="field-grid two-columns align-start">
          <label className="field" htmlFor="seed-mode">
            <span className="field-label">Seed mode</span>
            <select
              id="seed-mode"
              value={form.seedMode}
              onChange={(event) =>
                update("seedMode", event.target.value as BatchFormState["seedMode"])
              }
            >
              <option value="fixed">Fixed</option>
              <option value="explicit">Explicit list</option>
              <option value="random">Random</option>
            </select>
          </label>
          {form.seedMode === "random" ? (
            <Field
              id="random-seed-count"
              type="number"
              min="1"
              max={MAX_RANDOM_SEED_COUNT}
              step="1"
              label="Random seed count"
              hint={`Generate 1 to ${MAX_RANDOM_SEED_COUNT} concrete seeds when Preview runs`}
              value={form.randomSeedCount}
              onChange={(event) => update("randomSeedCount", event.target.value)}
            />
          ) : (
            <TextAreaField
              id="seed-values"
              className="short-list"
              label={form.seedMode === "fixed" ? "Seed" : "Explicit seeds"}
              hint="Integers, one per line or comma-separated"
              value={form.seedValues}
              onChange={(event) => update("seedValues", event.target.value)}
            />
          )}
        </div>
      </fieldset>

      <fieldset>
        <legend>Reference Assets</legend>
        <ReferenceAssetPicker
          api={api}
          projectKey={form.projectFilesystemKey}
          selectedAssetIds={form.referenceAssetIds}
          onSelectedAssetIdsChange={(referenceAssetIds) =>
            update("referenceAssetIds", referenceAssetIds)
          }
        />
      </fieldset>

      <fieldset>
        <legend>ComfyUI workflow</legend>
        <p className="limitation-note">
          Paste the complete API-format workflow exported from ComfyUI. This is not the UI-format
          workflow.
        </p>
        <div className="field-grid two-columns align-start">
          <TextAreaField
            id="workflow-json"
            className="json-editor"
            label="Workflow JSON"
            spellCheck={false}
            value={form.workflowJson}
            onChange={(event) => update("workflowJson", event.target.value)}
          />
          <TextAreaField
            id="workflow-profile-json"
            className="json-editor"
            label="Workflow Profile JSON"
            spellCheck={false}
            value={form.workflowProfileJson}
            onChange={(event) => update("workflowProfileJson", event.target.value)}
          />
        </div>
      </fieldset>

      {error ? <p className="operation-error" role="alert">{error}</p> : null}
      <div className="action-row">
        <button className="button-primary" type="button" disabled={previewing} onClick={onPreview}>
          {previewing ? "Previewing..." : "Preview Batch"}
        </button>
      </div>
    </section>
  );
}

function nextPromptNumber(prompts: PromptForm[]): number {
  let number = 1;
  while (
    prompts.some(
      (prompt) => prompt.versionId === `prompt-v${number}` || prompt.name === `Prompt ${number}`,
    )
  ) {
    number += 1;
  }
  return number;
}
