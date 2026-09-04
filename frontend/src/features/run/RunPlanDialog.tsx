import { useEffect, useRef, type KeyboardEvent } from "react";

import type { EditableBatchSnapshot, RunPlanJobResponse, RunResponse } from "../../api/types";
import { OverlayPortal } from "../../components/OverlayPortal";
import { formatBaseWorkflowValue } from "../batch/baseWorkflowValue";
import { parameterRangeCount, profileImageInputs, profileParameters } from "../batch/form";
import { runDisplayLabel, runDisplayName, runNumberLabel } from "./runDisplay";

interface Props {
  run: RunResponse;
  restoreTarget: HTMLElement | null;
  onClose(): void;
}

export function RunPlanDialog({ run, restoreTarget, onClose }: Props) {
  const snapshot = run.batch_snapshot;
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreTargetRef = useRef<HTMLElement | null>(restoreTarget);

  useEffect(() => {
    closeRef.current?.focus();
    const restoreTarget = restoreTargetRef.current;
    return () => restoreTarget?.focus();
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <OverlayPortal level="run-plan">
      <dialog
        className="run-plan-dialog"
        open
        aria-modal="true"
        aria-labelledby="run-plan-title"
        onCancel={onClose}
        onKeyDown={handleKeyDown}
      >
      <div className="run-plan-heading">
        <div>
          <p className="run-plan-kicker">Frozen experiment specification · {runNumberLabel(run)}</p>
          <h2 id="run-plan-title">{runDisplayName(run)} Plan</h2>
        </div>
        <button className="button-link" type="button" onClick={onClose} ref={closeRef}>Close</button>
      </div>

      <div className="run-plan-content">
      <section className="run-plan-overview" aria-labelledby="run-plan-overview-title">
        <h3 id="run-plan-overview-title">{snapshot.batch.name}</h3>
        <p className="run-plan-run-label">{runDisplayLabel(run)}</p>
        {run.run_description ? <p className="run-plan-description">{run.run_description}</p> : null}
        {snapshot.batch.description ? <p>{snapshot.batch.description}</p> : null}
        <dl>
          <div><dt>Run folder</dt><dd><code>{run.filesystem_key}</code></dd></div>
          <div><dt>Total Jobs</dt><dd>{run.plan.job_count}</dd></div>
          <div><dt>Image Inputs</dt><dd>{imageInputSummary(run)}</dd></div>
          <div><dt>Parameters</dt><dd>{parameterSummary(run)}</dd></div>
          <div><dt>Seed intent</dt><dd>{seedIntentSummary(snapshot)}</dd></div>
          <div><dt>Materialized seeds</dt><dd>{materializedSeeds(run)}</dd></div>
          <div><dt>Workflow</dt><dd>{workflowSummary(snapshot)}</dd></div>
          <div><dt>Profile</dt><dd>{profileSummary(snapshot)}</dd></div>
        </dl>
      </section>

      <section className="run-plan-section" aria-labelledby="run-plan-parameters-title">
        <h3 id="run-plan-parameters-title">Parameters</h3>
        {snapshot.parameter_bindings.length ? (
          <dl className="run-plan-bindings">
            {snapshot.parameter_bindings.map((binding) => {
              const resolved = run.plan.jobs[0]?.resolved_parameters.find((item) => item.parameter_key === binding.parameter_key);
              return (
                <div key={binding.parameter_key}>
                  <dt>{resolved?.label ?? binding.parameter_key}</dt>
                  <dd className="run-plan-parameter-alternatives">
                    {binding.mode === "values" ? binding.values.map((value, index) => (
                      <span key={`${typeof value}-${String(value)}-${index}`}>
                        <span className="alternative-number">{index + 1}</span>
                        {value === null
                          ? <BaseValue display={parameterBaseValue(run, binding.parameter_key)} />
                          : formatParameterValue(value)}
                      </span>
                    )) : (
                      <span className="run-plan-range-intent">
                        <strong>{binding.range.start} → {binding.range.end} by {binding.range.step}</strong>
                        <span>{rangeBindingCount(snapshot, binding)} alternatives</span>
                        <span>{binding.include_base
                          ? <BaseValue display={parameterBaseValue(run, binding.parameter_key)} />
                          : "Base workflow not included"}</span>
                      </span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : <p className="empty-note">{snapshot.linked_parameter_sets.length ? "Linked parameters are shown as Presets below." : "This Profile has no parameters."}</p>}
      </section>

      {snapshot.linked_parameter_sets.length ? (
        <section className="run-plan-section" aria-labelledby="run-plan-presets-title">
          <h3 id="run-plan-presets-title">Presets</h3>
          <div className="run-plan-presets">
            {snapshot.linked_parameter_sets.map((set) => (
              <div className="run-plan-preset" key={set.set_key}>
                <strong>{set.set_label}</strong>
                <span>{set.members.map((member) => parameterLabel(run, member)).join(" + ")}</span>
                <ol>{set.rows.map((row, index) => {
                  const display = linkedRowDisplay(run, set.members, row.values);
                  return <li key={index}><strong>{row.row_label ?? `Row ${index + 1}`}</strong><span title={display.title}>{display.text}</span></li>;
                })}</ol>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="run-plan-section" aria-labelledby="run-plan-prompts-title">
        <h3 id="run-plan-prompts-title">PromptVersions</h3>
        <ol className="run-plan-prompts">
          {run.prompt_versions.map((prompt, index) => {
            const intent = snapshot.prompt_versions[index];
            return (
              <li key={prompt.id}>
                <strong>{prompt.name}</strong>{intent?.version_number ? ` · v${intent.version_number}` : ""}
                <details>
                  <summary>Prompt Template</summary>
                  <pre>{prompt.text}</pre>
                </details>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="run-plan-section" aria-labelledby="run-plan-variables-title">
        <h3 id="run-plan-variables-title">Variable bindings</h3>
        {snapshot.variable_bindings.length ? (
          <dl className="run-plan-bindings">
            {snapshot.variable_bindings.map((binding) => (
              <div key={binding.placeholder}>
                <dt>{binding.placeholder}</dt>
                <dd>{bindingValues(binding)}</dd>
              </div>
            ))}
          </dl>
        ) : <p className="empty-note">No variable bindings were preserved.</p>}
      </section>

      <section className="run-plan-section" aria-labelledby="run-plan-images-title">
        <h3 id="run-plan-images-title">Image Inputs</h3>
        {snapshot.image_bindings.length ? (
          <dl className="run-plan-bindings">
            {imageInputAlternatives(run).map((input) => (
              <div key={input.slotKey}>
                <dt>{input.label}</dt>
                <dd className="run-plan-image-alternatives">
                  {input.values.map((value, index) => (
                    <span key={`${value.assetId ?? "base"}-${index}`}>
                      <span title={value.title}>{value.name}</span>
                      {value.assetId ? <code>{value.assetId}</code> : null}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        ) : <p className="empty-note">This Profile has no Image Input slots.</p>}
      </section>

      {run.plan.warnings.length ? (
        <div className="warning-box" role="status">
          <strong>Compiler warnings</strong>
          <ul>{run.plan.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul>
        </div>
      ) : null}

      <section className="run-plan-section" aria-labelledby="run-plan-jobs-title">
        <h3 id="run-plan-jobs-title">Concrete Jobs</h3>
        <div className="run-plan-jobs">
          {run.plan.jobs.map((job) => <RunPlanJob key={job.ordinal} run={run} job={job} />)}
        </div>
      </section>
      </div>
      </dialog>
    </OverlayPortal>
  );
}

function RunPlanJob({ run, job }: { run: RunResponse; job: RunPlanJobResponse }) {
  const variables = job.resolved_variables.map((variable) => variable.value).join(" · ");
  const imageInputDisplays = job.resolved_image_inputs.map((input) => {
    const baseValue = imageBaseValue(run, input.slot_key);
    return {
      text: `${input.label}: ${input.filename ?? (input.asset_id ? "Project Asset" : baseValue.text)}`,
      title: input.asset_id === null && baseValue.title ? `${input.label}: ${baseValue.title}` : undefined,
    };
  });
  const parameterDisplays = job.resolved_parameters.map((parameter) => {
    const baseValue = parameterBaseValue(run, parameter.parameter_key);
    return {
      text: `${parameter.label}: ${parameter.value === null ? baseValue.text : formatParameterValue(parameter.value)}`,
      title: parameter.value === null && baseValue.title ? `${parameter.label}: ${baseValue.title}` : undefined,
    };
  });
  const imageInputs = imageInputDisplays.map((display) => display.text).join(" · ");
  const imageInputsTitle = summaryTitle(imageInputDisplays);
  const parameters = parameterDisplays.map((display) => display.text).join(" · ");
  const parametersTitle = summaryTitle(parameterDisplays);
  const presets = job.resolved_parameter_sets.map((set) => `${set.set_label}: ${set.row_label ?? `Row ${set.row_ordinal}`}`).join(" · ");
  return (
    <details className="run-plan-job">
      <summary>
        <span className="ordinal">{String(job.ordinal).padStart(3, "0")}</span>
        <strong>{job.prompt_version_name}</strong>
        {variables ? <span>{variables}</span> : null}
        {imageInputs ? <span title={imageInputsTitle}>{imageInputs}</span> : null}
        {parameters ? <span title={parametersTitle}>{parameters}</span> : null}
        {presets ? <span>{presets}</span> : null}
        <code>seed {job.seed}</code>
      </summary>
      <div>
        <p className="resolved-prompt">{job.resolved_prompt}</p>
        <dl>
          {job.resolved_variables.map((variable) => (
            <div key={variable.name}><dt>{variable.name}</dt><dd>{variable.value}</dd></div>
          ))}
          {job.resolved_image_inputs.map((input) => (
            <div key={input.slot_key}>
              <dt>{input.label}</dt>
              <dd>
                {input.filename ?? (input.asset_id
                  ? "Project Asset"
                  : <BaseValue display={imageBaseValue(run, input.slot_key)} />)}
                {input.asset_id ? <code>{input.asset_id}</code> : null}
              </dd>
            </div>
          ))}
          {job.resolved_parameters.map((parameter) => (
            <div key={parameter.parameter_key}>
              <dt>{parameter.label}</dt>
              <dd>{parameter.value === null
                ? <BaseValue display={parameterBaseValue(run, parameter.parameter_key)} />
                : formatParameterValue(parameter.value)}</dd>
            </div>
          ))}
          {job.resolved_parameter_sets.map((set) => (
            <div key={set.set_key}><dt>{set.set_label} preset</dt><dd>{set.row_label ?? `Row ${set.row_ordinal}`}</dd></div>
          ))}
          <div><dt>Seed</dt><dd><code>{job.seed}</code></dd></div>
        </dl>
      </div>
    </details>
  );
}

function seedIntentSummary(snapshot: EditableBatchSnapshot): string {
  const intent = snapshot.seed_intent;
  if (intent.mode === "random") return `Random · ${intent.random_seed_count} requested`;
  if (intent.mode === "fixed") return `Fixed · ${intent.values[0]}`;
  return `Explicit · ${intent.values.join(", ")}`;
}

function materializedSeeds(run: RunResponse): string {
  return [...new Set(run.plan.jobs.map((job) => job.seed))].join(", ");
}

function imageInputSummary(run: RunResponse): string {
  const inputs = imageInputAlternatives(run);
  if (inputs.length === 0) return "No slots";
  return inputs
    .map((input) => `${input.label}: ${input.values.length} ${input.values.length === 1 ? "alternative" : "alternatives"}`)
    .join(" · ");
}

function parameterSummary(run: RunResponse): string {
  const parameters = run.plan.jobs[0]?.resolved_parameters ?? [];
  if (parameters.length === 0) return "No parameters";
  const bindings = new Map(run.batch_snapshot.parameter_bindings.map((binding) => [binding.parameter_key, binding]));
  const independent = parameters.flatMap((parameter) => {
    const binding = bindings.get(parameter.parameter_key);
    const count = binding?.mode === "values"
      ? binding.values.length
      : binding?.mode === "range" ? rangeBindingCount(run.batch_snapshot, binding) : 0;
    return binding ? [`${parameter.label}: ${count} ${count === 1 ? "alternative" : "alternatives"}`] : [];
  });
  const presets = run.batch_snapshot.linked_parameter_sets.map((set) => `${set.set_label}: ${set.rows.length} ${set.rows.length === 1 ? "row" : "rows"}`);
  return [...independent, ...presets].join(" · ");
}

function parameterLabel(run: RunResponse, parameterKey: string): string {
  return run.plan.jobs[0]?.resolved_parameters.find((parameter) => parameter.parameter_key === parameterKey)?.label ?? parameterKey;
}

function linkedRowDisplay(
  run: RunResponse,
  members: string[],
  values: Record<string, string | number | boolean | null>,
): { text: string; title?: string } {
  const displays = members.map((member) => {
    const label = parameterLabel(run, member);
    const value = values[member];
    const baseValue = parameterBaseValue(run, member);
    return {
      text: `${label}: ${value === null ? baseValue.text : formatParameterValue(value)}`,
      title: value === null && baseValue.title ? `${label}: ${baseValue.title}` : undefined,
    };
  });
  const title = summaryTitle(displays);
  return { text: displays.map((display) => display.text).join(" · "), ...(title ? { title } : {}) };
}

function summaryTitle(displays: Array<{ text: string; title?: string }>): string | undefined {
  return displays.some((display) => display.title)
    ? displays.map((display) => display.title ?? display.text).join(" · ")
    : undefined;
}

function rangeBindingCount(
  snapshot: EditableBatchSnapshot,
  binding: Extract<EditableBatchSnapshot["parameter_bindings"][number], { mode: "range" }>,
): number {
  const parameter = profileParameters(snapshot.workflow_selection.workflow_profile)
    .find((candidate) => candidate.key === binding.parameter_key);
  if (!parameter) return 0;
  try {
    return parameterRangeCount({
      ...binding.range,
      includeBase: binding.include_base,
    }, parameter.value_type, binding.parameter_key);
  } catch {
    return 0;
  }
}

function formatParameterValue(value: string | number | boolean | null): string {
  if (value === null) return "Base workflow · Unavailable";
  if (typeof value === "string") return value === "" ? '"" (empty string)' : value;
  return String(value);
}

function imageInputAlternatives(run: RunResponse): Array<{
  slotKey: string;
  label: string;
  values: Array<{ name: string; title?: string; assetId: string | null }>;
}> {
  const labels = new Map(
    (run.plan.jobs[0]?.resolved_image_inputs ?? []).map((input) => [input.slot_key, input.label]),
  );
  const filenames = new Map<string, string>();
  for (const job of run.plan.jobs) {
    for (const input of job.resolved_image_inputs) {
      if (input.asset_id && input.filename) filenames.set(input.asset_id, input.filename);
    }
  }
  const bindings = new Map(
    run.batch_snapshot.image_bindings.map((binding) => [binding.slot_key, binding.values]),
  );
  return (run.plan.jobs[0]?.resolved_image_inputs ?? []).map((input) => ({
    slotKey: input.slot_key,
    label: labels.get(input.slot_key) ?? input.slot_key,
    values: (bindings.get(input.slot_key) ?? []).map((value) => {
      const baseValue = imageBaseValue(run, input.slot_key);
      return {
        name: value === null ? baseValue.text : filenames.get(value) ?? "Project Asset",
        ...(value === null && baseValue.title ? { title: baseValue.title } : {}),
        assetId: value,
      };
    }),
  }));
}

function parameterBaseValue(run: RunResponse, parameterKey: string): ReturnType<typeof formatBaseWorkflowValue> {
  const selection = run.batch_snapshot.workflow_selection;
  const parameter = profileParameters(selection.workflow_profile).find((candidate) => candidate.key === parameterKey);
  return parameter
    ? formatBaseWorkflowValue(selection.workflow, parameter, parameter.value_type)
    : unavailableBaseValue();
}

function imageBaseValue(run: RunResponse, slotKey: string): ReturnType<typeof formatBaseWorkflowValue> {
  const selection = run.batch_snapshot.workflow_selection;
  const slot = profileImageInputs(selection.workflow_profile).find((candidate) => candidate.key === slotKey);
  return slot
    ? formatBaseWorkflowValue(selection.workflow, slot, "string")
    : unavailableBaseValue();
}

function BaseValue({ display }: { display: ReturnType<typeof formatBaseWorkflowValue> }) {
  return <span title={display.title}>{display.text}</span>;
}

function unavailableBaseValue(): ReturnType<typeof formatBaseWorkflowValue> {
  return { text: "Base workflow · Unavailable", available: false };
}

function workflowSummary(snapshot: EditableBatchSnapshot): string {
  const selection = snapshot.workflow_selection;
  if (!selection.workflow_name) return "Frozen Workflow snapshot · version unavailable";
  return `${selection.workflow_name}${selection.workflow_version_number ? ` · v${selection.workflow_version_number}` : ""}`;
}

function profileSummary(snapshot: EditableBatchSnapshot): string {
  const selection = snapshot.workflow_selection;
  if (!selection.workflow_profile_name) return "Frozen Profile snapshot · version unavailable";
  return `${selection.workflow_profile_name}${selection.workflow_profile_version_number ? ` · v${selection.workflow_profile_version_number}` : ""}`;
}

function bindingValues(binding: EditableBatchSnapshot["variable_bindings"][number]): string {
  const count = binding.values.length;
  const values = binding.values.map((value) => value === "" ? "(empty)" : value);
  return `${count} ${count === 1 ? "value" : "values"} · ${values.join(", ")}`;
}
