import { useState } from "react";

import type { BatchcraftApi } from "../../api/client";
import type { ProjectResponse } from "../../api/types";
import { Field, TextAreaField } from "../../components/Field";
import { ProjectSelector } from "../project/ProjectSelector";
import { ConfigurationSection } from "./ConfigurationSection";
import {
  MAX_RANDOM_SEED_COUNT,
  newVariableBinding,
  type BatchFormState,
  type VariableBindingForm,
} from "./form";
import { PromptLibraryEditor } from "./PromptLibraryEditor";
import { ReferenceAssetPicker } from "./ReferenceAssetPicker";
import { SavedBatchSelector, type SavedBatchCreateInput } from "./SavedBatchSelector";
import { WorkflowLibraryEditor } from "./WorkflowLibraryEditor";

interface Props {
  form: BatchFormState;
  api: BatchcraftApi;
  selectedProjectId: string | null;
  projectVerified: boolean;
  projectSwitchingBlocked: boolean;
  hasUnsavedChanges: boolean;
  savedBatchDirty: boolean;
  savedBatchId: string | null;
  savedBatchRevision: number | null;
  savedBatchListRefresh: number;
  savingBatch: boolean;
  saveAsRequest: boolean;
  error: string | null;
  previewing: boolean;
  onChange(form: BatchFormState): void;
  onPromptMetadataChange(prompts: BatchFormState["prompts"]): void;
  onWorkflowMetadataChange(form: BatchFormState): void;
  onProjectReconnect(project: ProjectResponse): void;
  onProjectUnresolved(): void;
  onProjectSelect(project: ProjectResponse): void;
  onPreview(): void;
  onSavedBatchSelect(batchId: string): Promise<void>;
  onSavedBatchCreateEmpty(input: SavedBatchCreateInput): Promise<void>;
  onSavedBatchCreateFromCurrent(input: SavedBatchCreateInput): Promise<void>;
  onSavedBatchSave(): Promise<void>;
  onSavedBatchArchive(): Promise<void>;
  onSaveAsRequestHandled(): void;
}

export function BatchEditor({
  api,
  form,
  selectedProjectId,
  projectVerified,
  projectSwitchingBlocked,
  hasUnsavedChanges,
  savedBatchDirty,
  savedBatchId,
  savedBatchRevision,
  savedBatchListRefresh,
  savingBatch,
  saveAsRequest,
  error,
  previewing,
  onChange,
  onPromptMetadataChange,
  onWorkflowMetadataChange,
  onProjectReconnect,
  onProjectUnresolved,
  onProjectSelect,
  onPreview,
  onSavedBatchSelect,
  onSavedBatchCreateEmpty,
  onSavedBatchCreateFromCurrent,
  onSavedBatchSave,
  onSavedBatchArchive,
  onSaveAsRequestHandled,
}: Props) {
  const [variablesExpanded, setVariablesExpanded] = useState(false);
  const [seedsExpanded, setSeedsExpanded] = useState(false);
  const workflowSelectionIncomplete = Boolean(form.workflowLibraryProjectId) && (
    !form.workflowId ||
    !form.workflowVersionId ||
    !form.workflowProfileId ||
    !form.workflowProfileVersionId ||
    form.workflowProfileWorkflowVersionId !== form.workflowVersionId
  );
  const variablesComplete = form.variableBindings.length > 0 && form.variableBindings.every(
    (binding) => Boolean(
      binding.placeholder.trim()
      && binding.variableListId.trim()
      && binding.values.trim()
      && (binding.mode === "fixed" ? binding.fixedValue.trim() : binding.selectedValues.trim()),
    ),
  );
  const seedsComplete = form.seedMode === "random"
    ? /^\d+$/.test(form.randomSeedCount.trim())
    : form.seedValues.trim().length > 0;
  const previewUnavailable = previewing || !projectVerified || selectedProjectId !== form.projectId || workflowSelectionIncomplete;
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

  return (
    <section className="section-card batch-editor" aria-labelledby="batch-heading">
      <div className="section-heading">
        <h2 id="batch-heading">Batch configuration</h2>
      </div>

      <ProjectSelector
        api={api}
        selectedProjectId={selectedProjectId}
        projectVerified={projectVerified}
        draftIdentity={{
          id: form.projectId,
          filesystemKey: form.projectFilesystemKey,
          name: form.projectName,
        }}
        hasProjectScopedSelections={
          hasUnsavedChanges ||
          form.prompts.length > 0 ||
          form.referenceAssetIds.length > 0 ||
          Boolean(form.workflowId) ||
          form.workflowJson.trim() !== "{}"
        }
        unsavedChangesNote={
          hasUnsavedChanges ? "The current Batch draft has unsaved changes." : null
        }
        switchingBlocked={projectSwitchingBlocked}
        onReconnect={onProjectReconnect}
        onUnresolved={onProjectUnresolved}
        onSelect={onProjectSelect}
      />

      <fieldset>
        <legend>Batch</legend>
        <SavedBatchSelector
          api={api}
          projectId={projectVerified && selectedProjectId === form.projectId ? form.projectId : ""}
          refreshToken={savedBatchListRefresh}
          selectedBatchId={savedBatchId}
          revision={savedBatchRevision}
          filesystemKey={form.batchFilesystemKey}
          currentName={form.batchName}
          currentDescription={form.batchDescription}
          dirty={savedBatchDirty}
          hasUnsavedChanges={hasUnsavedChanges}
          disabled={projectSwitchingBlocked}
          saving={savingBatch}
          dialogRequest={saveAsRequest ? "save-as" : null}
          onDialogRequestHandled={onSaveAsRequestHandled}
          onSelectBatch={onSavedBatchSelect}
          onCreateEmpty={onSavedBatchCreateEmpty}
          onCreateFromCurrent={onSavedBatchCreateFromCurrent}
          onSave={onSavedBatchSave}
          onArchive={onSavedBatchArchive}
        />
        <div className="field-grid two-columns">
          <Field
            id="batch-name"
            label="Batch name"
            value={form.batchName}
            onChange={(event) => update("batchName", event.target.value)}
          />
          <Field
            id="batch-description"
            label="Description (optional)"
            value={form.batchDescription}
            onChange={(event) => update("batchDescription", event.target.value)}
          />
        </div>
      </fieldset>

      <PromptLibraryEditor
        api={api}
        projectId={projectVerified && selectedProjectId === form.projectId ? form.projectId : ""}
        prompts={form.prompts}
        onChange={(prompts) => update("prompts", prompts)}
        onMetadataChange={onPromptMetadataChange}
      />

      <ConfigurationSection
        title="Variable bindings"
        summary={variableSummary(form.variableBindings)}
        expanded={variablesExpanded}
        collapsible={variablesComplete}
        controlsId="variable-binding-controls"
        action={(
          <button
            className="button-secondary compact"
            type="button"
            onClick={() => update("variableBindings", [...form.variableBindings, newVariableBinding()])}
          >
            Add Binding
          </button>
        )}
        onExpandedChange={setVariablesExpanded}
      >
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
      </ConfigurationSection>

      <ConfigurationSection
        title="Seeds"
        summary={seedSummary(form)}
        expanded={seedsExpanded}
        collapsible={seedsComplete}
        controlsId="seed-controls"
        className="seed-fieldset"
        onExpandedChange={setSeedsExpanded}
      >
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
          ) : form.seedMode === "fixed" ? (
            <Field
              id="seed-values"
              type="number"
              min="0"
              step="1"
              label="Seed"
              hint="Nonnegative integer"
              value={form.seedValues}
              onChange={(event) => update("seedValues", event.target.value)}
            />
          ) : (
            <TextAreaField
              id="seed-values"
              className="short-list"
              label="Explicit seeds"
              hint="Integers, one per line or comma-separated"
              value={form.seedValues}
              onChange={(event) => update("seedValues", event.target.value)}
            />
          )}
        </div>
      </ConfigurationSection>

      <fieldset>
        <legend>Reference Assets</legend>
        <ReferenceAssetPicker
          api={api}
          projectKey={
            projectVerified && selectedProjectId === form.projectId
              ? form.projectFilesystemKey
              : ""
          }
          selectedAssetIds={form.referenceAssetIds}
          onSelectedAssetIdsChange={(referenceAssetIds) =>
            update("referenceAssetIds", referenceAssetIds)
          }
        />
      </fieldset>

      <WorkflowLibraryEditor
        api={api}
        projectId={projectVerified && selectedProjectId === form.projectId ? form.projectId : ""}
        form={form}
        onChange={onChange}
        onMetadataChange={onWorkflowMetadataChange}
      />

      {error ? <p className="operation-error" role="alert">{error}</p> : null}
      <div className="action-row">
        <button className="button-primary" type="button" disabled={previewUnavailable} onClick={onPreview}>
          {previewing ? "Previewing..." : "Preview Batch"}
        </button>
      </div>
    </section>
  );
}

function variableSummary(bindings: VariableBindingForm[]) {
  if (bindings.length === 0) return <span>No bindings</span>;
  return (
    <div className="configuration-summary-list">
      {bindings.map((binding) => {
        const values = binding.mode === "fixed"
          ? binding.fixedValue.trim()
          : splitLines(binding.selectedValues).join(", ");
        return (
          <span key={binding.key}>
            <strong>{binding.placeholder.trim() || "Incomplete binding"}</strong>
            {values ? `: ${values}` : ""}
          </span>
        );
      })}
    </div>
  );
}

function seedSummary(form: BatchFormState): string {
  if (form.seedMode === "random") return `Random × ${form.randomSeedCount.trim() || "?"}`;
  if (form.seedMode === "fixed") return `Fixed · ${form.seedValues.trim() || "not set"}`;
  const seeds = form.seedValues.split(/[\n,]/).map((seed) => seed.trim()).filter(Boolean);
  return `Explicit · ${seeds.length} ${seeds.length === 1 ? "seed" : "seeds"}`;
}

function splitLines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}
