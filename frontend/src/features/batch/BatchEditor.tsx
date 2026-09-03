import { useState } from "react";

import type { BatchcraftApi } from "../../api/client";
import type { ProjectResponse } from "../../api/types";
import { Field, TextAreaField } from "../../components/Field";
import { ProjectSelector } from "../project/ProjectSelector";
import { ConfigurationSection } from "./ConfigurationSection";
import { ImageInputBindingsEditor } from "./ImageInputBindingsEditor";
import { ParameterBindingsEditor } from "./ParameterBindingsEditor";
import {
  MAX_RANDOM_SEED_COUNT,
  buildParameterBindings,
  buildLinkedParameterSets,
  missingPromptPlaceholders,
  parameterRangeCount,
  newVariableBinding,
  normalizedBindingValues,
  profileParameters,
  type BatchFormState,
  type VariableBindingForm,
} from "./form";
import { PromptLibraryEditor } from "./PromptLibraryEditor";
import { SavedBatchSelector, type SavedBatchCreateInput } from "./SavedBatchSelector";
import { WorkflowLibraryEditor } from "./WorkflowLibraryEditor";

interface Props {
  form: BatchFormState;
  historicalSourceRunId: string | null;
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
  onHistoricalResourceChange(form: BatchFormState): void;
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
  historicalSourceRunId,
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
  onHistoricalResourceChange,
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
  const [parametersExpanded, setParametersExpanded] = useState(false);
  const parameters = safeProfileParameters(form.workflowProfileJson);
  const missingPlaceholders = missingPromptPlaceholders(form.prompts, form.variableBindings);
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
      && normalizedBindingValues(binding.values).length > 0,
    ),
  );
  const seedsComplete = form.seedMode === "random"
    ? /^\d+$/.test(form.randomSeedCount.trim())
    : form.seedValues.trim().length > 0;
  const parametersComplete = parameterBindingsComplete(form.parameterBindings, form.linkedParameterSets, parameters);
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

  function createMissingBindings() {
    if (missingPlaceholders.length === 0) return;
    setVariablesExpanded(true);
    update("variableBindings", [
      ...form.variableBindings,
      ...missingPlaceholders.map((placeholder) => newVariableBinding(placeholder, [])),
    ]);
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
          form.imageBindings.some((binding) => binding.values.some((value) => value !== null)) ||
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

      <WorkflowLibraryEditor
        api={api}
        projectId={projectVerified && selectedProjectId === form.projectId ? form.projectId : ""}
        form={form}
        sourceRunId={historicalSourceRunId}
        onChange={onChange}
        onHistoricalImport={onHistoricalResourceChange}
        onMetadataChange={onWorkflowMetadataChange}
      />

      <PromptLibraryEditor
        api={api}
        projectId={projectVerified && selectedProjectId === form.projectId ? form.projectId : ""}
        prompts={form.prompts}
        historicalImportCopyResolutions={form.historicalImportCopyResolutions}
        sourceRunId={historicalSourceRunId}
        onChange={(prompts) => onChange({
          ...form,
          prompts,
          historicalImportCopyResolutions: {
            ...form.historicalImportCopyResolutions,
            promptVersions: form.historicalImportCopyResolutions.promptVersions.filter(
              (resolution) => prompts.some(
                (prompt) => prompt.versionId === resolution.copiedVersionId,
              ),
            ),
          },
        })}
        onHistoricalImport={(prompts, historicalImportCopyResolutions) => onHistoricalResourceChange({
          ...form,
          prompts,
          historicalImportCopyResolutions,
        })}
        onMetadataChange={onPromptMetadataChange}
      />

      <ConfigurationSection
        title="Variable bindings"
        summary={variableSummary(form.variableBindings, missingPlaceholders.length)}
        expanded={variablesExpanded}
        collapsible={variablesComplete}
        controlsId="variable-binding-controls"
        summaryAction={missingPlaceholders.length ? (
          <button className="button-primary compact" type="button" onClick={createMissingBindings}>
            Create missing bindings
          </button>
        ) : null}
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
        {missingPlaceholders.length ? (
          <div className="missing-bindings-assistance">
            <p><strong>Missing from selected prompts:</strong> {missingPlaceholders.join(", ")}</p>
            <button className="button-primary compact" type="button" onClick={createMissingBindings}>
              Create missing bindings
            </button>
          </div>
        ) : null}
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
                  aria-label={`Remove Binding ${index + 1}`}
                  onClick={() =>
                    update(
                      "variableBindings",
                      form.variableBindings.filter((item) => item.key !== binding.key),
                    )
                  }
                >
                  Remove binding
                </button>
              </div>
              <div className="variable-binding-fields">
                <Field
                  id={`placeholder-${binding.key}`}
                  label="Placeholder"
                  value={binding.placeholder}
                  onChange={(event) => updateBinding(binding.key, { placeholder: event.target.value })}
                />
                <BindingValuesEditor
                  binding={binding}
                  onChange={(values) => updateBinding(binding.key, { values })}
                />
              </div>
            </div>
          ))}
        </div>
      </ConfigurationSection>

      {parameters.length ? (
        <ConfigurationSection
          title="Parameters"
          summary={parameterSummary(form.parameterBindings, form.linkedParameterSets, parameters.length)}
          expanded={parametersExpanded}
          collapsible={parametersComplete}
          controlsId="parameter-binding-controls"
          onExpandedChange={setParametersExpanded}
        >
          <ParameterBindingsEditor
            parameters={parameters}
            parameterBindings={form.parameterBindings}
            linkedParameterSets={form.linkedParameterSets}
            onChange={(state) => onChange({ ...form, ...state })}
          />
        </ConfigurationSection>
      ) : null}

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

      <ImageInputBindingsEditor
        api={api}
        projectKey={projectVerified && selectedProjectId === form.projectId ? form.projectFilesystemKey : ""}
        profileJson={form.workflowProfileJson}
        imageBindings={form.imageBindings}
        onChange={(imageBindings) => update("imageBindings", imageBindings)}
      />

      {error ? <p className="operation-error" role="alert">{error}</p> : null}
      <div className="action-row">
        <button
          className={`button-primary ${previewing ? "busy" : ""}`.trim()}
          type="button"
          disabled={previewUnavailable}
          aria-busy={previewing}
          onClick={onPreview}
        >
          {previewing ? "Previewing..." : "Preview Batch"}
        </button>
      </div>
    </section>
  );
}

function safeProfileParameters(profileJson: string) {
  try {
    return profileParameters(profileJson);
  } catch {
    return [];
  }
}

function variableSummary(bindings: VariableBindingForm[], missingCount: number) {
  if (missingCount > 0) {
    return <span>{bindings.length} configured · {missingCount} missing</span>;
  }
  if (bindings.length === 0) return <span>No bindings</span>;
  return (
    <div className="configuration-summary-list">
      {bindings.map((binding) => {
        const values = normalizedBindingValues(binding.values);
        const complete = Boolean(binding.placeholder.trim()) && values.length > 0;
        return (
          <span key={binding.key}>
            <strong>{complete ? binding.placeholder.trim() : "Incomplete binding"}</strong>
            {values.length
              ? `: ${values.length} ${values.length === 1 ? "value" : "values"} · ${values.map(displayBindingValue).join(", ")}`
              : ": no values"}
          </span>
        );
      })}
    </div>
  );
}

function BindingValuesEditor({
  binding,
  onChange,
}: {
  binding: VariableBindingForm;
  onChange(values: string[]): void;
}) {
  const [draft, setDraft] = useState(() => binding.values
    .filter((value) => value.trim().length > 0)
    .join("\n"));
  const [emptyPosition, setEmptyPosition] = useState(() => {
    const index = binding.values.indexOf("");
    return index < 0
      ? 0
      : binding.values.slice(0, index).filter((value) => value.trim().length > 0).length;
  });

  const includesEmpty = binding.values.includes("");

  function changeValues(text: string) {
    const previousValues = draftBindingValues(draft);
    const visibleValues = draftBindingValues(text);
    const nextEmptyPosition = remapGap(previousValues, visibleValues, emptyPosition);
    const values = [...visibleValues];
    if (includesEmpty) {
      values.splice(nextEmptyPosition, 0, "");
    }
    setDraft(text);
    setEmptyPosition(nextEmptyPosition);
    onChange(values);
  }

  function changeIncludeEmpty(checked: boolean) {
    const values = draftBindingValues(draft);
    if (checked) {
      values.splice(Math.min(emptyPosition, values.length), 0, "");
    }
    onChange(values);
  }

  return (
    <div className="variable-values">
      <TextAreaField
        id={`values-${binding.key}`}
        className="short-list"
        aria-label="Values"
        label="Values"
        hint="One value per non-empty line"
        value={draft}
        onChange={(event) => changeValues(event.target.value)}
      />
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={includesEmpty}
          onChange={(event) => changeIncludeEmpty(event.target.checked)}
        />
        <span>Include empty value</span>
      </label>
    </div>
  );
}

function draftBindingValues(draft: string): string[] {
  return draft.split(/\r?\n/).filter((value) => value.trim().length > 0);
}

function remapGap(previous: string[], next: string[], gap: number): number {
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) {
    prefix += 1;
  }
  if (gap <= prefix) return gap;

  let suffix = 0;
  while (
    suffix < previous.length - prefix
    && suffix < next.length - prefix
    && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
  ) {
    suffix += 1;
  }
  const previousSuffixStart = previous.length - suffix;
  if (gap >= previousSuffixStart) {
    return Math.max(0, Math.min(next.length, gap + next.length - previous.length));
  }
  const changedLength = next.length - prefix - suffix;
  return prefix + Math.min(gap - prefix, changedLength);
}

function displayBindingValue(value: string): string {
  return value === "" ? "(empty)" : value;
}

function seedSummary(form: BatchFormState): string {
  if (form.seedMode === "random") return `Random × ${form.randomSeedCount.trim() || "?"}`;
  if (form.seedMode === "fixed") return `Fixed · ${form.seedValues.trim() || "not set"}`;
  const seeds = form.seedValues.split(/[\n,]/).map((seed) => seed.trim()).filter(Boolean);
  return `Explicit · ${seeds.length} ${seeds.length === 1 ? "seed" : "seeds"}`;
}

function parameterBindingsComplete(
  bindings: BatchFormState["parameterBindings"],
  linkedSets: BatchFormState["linkedParameterSets"],
  parameters: ReturnType<typeof safeProfileParameters>,
): boolean {
  const linkedMembers = linkedSets.flatMap((set) => set.members);
  if (bindings.length + linkedMembers.length !== parameters.length || !parameters.every((parameter) => (
    bindings.some((binding) => binding.parameterKey === parameter.key && binding.valueType === parameter.value_type)
    || linkedMembers.some((member) => member.parameterKey === parameter.key && member.valueType === parameter.value_type)
  ))) return false;
  try {
    buildParameterBindings(bindings);
    buildLinkedParameterSets(linkedSets);
    return true;
  } catch {
    return false;
  }
}

function parameterSummary(bindings: BatchFormState["parameterBindings"], linkedSets: BatchFormState["linkedParameterSets"], parameterCount: number): string {
  const sweeping = bindings.filter((binding) => {
    if (binding.mode === "range") {
      try {
        return parameterRangeCount(binding.range, binding.valueType, binding.parameterKey) > 1;
      } catch {
        return false;
      }
    }
    return binding.alternatives.length > 1;
  }).length;
  const presetRows = linkedSets.reduce((count, set) => count + set.rows.length, 0);
  const presets = linkedSets.length ? ` · ${linkedSets.length} ${linkedSets.length === 1 ? "preset" : "presets"} / ${presetRows} rows` : "";
  return `${parameterCount} ${parameterCount === 1 ? "parameter" : "parameters"} · ${sweeping} independent sweeping${presets}`;
}
