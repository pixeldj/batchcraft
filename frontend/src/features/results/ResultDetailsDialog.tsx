import { useEffect, useRef, useState } from "react";

import type {
  ExecutionResponse,
  HistoryImageInputFilter,
  HistoryParameterFilter,
  ResultResponse,
  RunPlanJobResponse,
  RunResponse,
} from "../../api/types";
import { OverlayPortal } from "../../components/OverlayPortal";
import { useModalDialog } from "../../components/useModalDialog";
import { errorMessage } from "../../utils/errors";
import { formatBaseWorkflowValue } from "../batch/baseWorkflowValue";
import { profileImageInputs, profileParameters } from "../batch/form";
import { runDisplayLabel } from "../run/runDisplay";
import { validateHistoryFilters } from "../project/HistoryFilters";

export type ResultDetailsFilter =
  | { parameters: [HistoryParameterFilter & { mode: "base" | "equals" }] }
  | { image_inputs: [HistoryImageInputFilter] }
  | { seed: number }
  | { prompt_version_id: string }
  | { workflow_version_id: string }
  | { profile_version_id: string }
  | { asset_id: string };

interface Props {
  runId: string;
  result: ResultResponse;
  execution: ExecutionResponse | null;
  restoreTarget: HTMLElement | null;
  getCachedRun(runId: string): RunResponse | null;
  loadRun(runId: string): Promise<RunResponse>;
  onClose(): void;
  onFilter?(filter: ResultDetailsFilter): void;
}

export function ResultDetailsDialog({
  runId,
  result,
  execution,
  restoreTarget,
  getCachedRun,
  loadRun,
  onClose,
  onFilter,
}: Props) {
  const cachedRun = getCachedRun(runId);
  const [run, setRun] = useState<RunResponse | null>(cachedRun);
  const [loading, setLoading] = useState(cachedRun === null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [filterError, setFilterError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const modal = useModalDialog(dialogRef, onClose, restoreTarget, closeRef);

  useEffect(() => {
    if (run) {
      return;
    }
    let current = true;
    void loadRun(runId).then(
      (loadedRun) => {
        if (!current) return;
        setRun(loadedRun);
        setLoading(false);
      },
      (caught: unknown) => {
        if (!current) return;
        setError(errorMessage(caught));
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [attempt, loadRun, run, runId]);

  const job = run?.plan.jobs.find((candidate) => candidate.ordinal === result.job_ordinal) ?? null;

  return (
    <OverlayPortal level="details" onBackdropClick={onClose}>
      <dialog
        className="result-details-dialog"
        ref={dialogRef}
        style={{ position: "fixed", inset: 0, margin: "auto" }}
        aria-modal="true"
        aria-labelledby="result-details-title"
        {...modal}
      >
        <div className="result-details-heading">
          <div>
            <p className="result-details-kicker">
              Result details{run ? ` · ${runDisplayLabel(run)}` : ""}
            </p>
            <h2 id="result-details-title">
              Job {String(result.job_ordinal).padStart(3, "0")} · Artifact {result.artifact_ordinal}
            </h2>
          </div>
          <button className="button-link" type="button" onClick={onClose} ref={closeRef}>
            Close
          </button>
        </div>

        {loading ? <p className="result-details-loading" role="status">Loading frozen Run provenance...</p> : null}
        {error ? (
          <div className="operation-error result-details-error" role="alert">
            <p>Frozen Run provenance could not be loaded. {error}</p>
            <button
              className="button-secondary compact"
              type="button"
              onClick={() => {
                setError(null);
                setLoading(true);
                setAttempt((current) => current + 1);
              }}
            >
              Retry
            </button>
          </div>
        ) : null}

        {filterError ? <p className="operation-error" role="alert">{filterError}</p> : null}
        {run && job ? <GenerationDetails run={run} job={job} onFilter={onFilter ? (filter) => {
          try {
            onFilter(filter);
          } catch (caught) {
            setFilterError(errorMessage(caught));
          }
        } : undefined} /> : null}
        {run && !job ? (
          <p className="operation-error" role="alert">
            Frozen Job {result.job_ordinal} is unavailable for this Run.
          </p>
        ) : null}
        {run ? <TechnicalDetails run={run} result={result} execution={execution} /> : null}
      </dialog>
    </OverlayPortal>
  );
}

function GenerationDetails({ run, job, onFilter }: {
  run: RunResponse;
  job: RunPlanJobResponse;
  onFilter?: Props["onFilter"];
}) {
  const snapshotPrompt = run.batch_snapshot.prompt_versions.find(
    (prompt) => prompt.id === job.prompt_version_id,
  );
  const selection = run.batch_snapshot.workflow_selection;
  function action(label: string, filter: ResultDetailsFilter, text = "Filter Gallery..."): DetailAction[] {
    return onFilter && !validateHistoryFilters(filter)
      ? [{ label, text, onClick: () => onFilter(filter) }]
      : [];
  }

  return (
    <section className="result-generation-details" aria-label="Generation provenance">
      <dl>
        <Detail label="Prompt" value={formatVersioned(
          snapshotPrompt?.name ?? job.prompt_version_name,
          snapshotPrompt?.version_number ?? null,
        )} actions={action("Prompt revision", { prompt_version_id: job.prompt_version_id })} />
        <div className="result-details-wide">
          <dt>Resolved prompt</dt>
          <dd className="result-resolved-prompt">“{job.resolved_prompt}”</dd>
        </div>
        <div className="result-details-wide">
          <dt>Variables</dt>
          <dd>
            {job.resolved_variables.length ? (
              <dl className="result-details-variables">
                {job.resolved_variables.map((variable) => (
                  <div key={variable.name}>
                    <dt>{variable.name}</dt>
                    <dd>{variable.value}</dd>
                  </div>
                ))}
              </dl>
            ) : "None"}
          </dd>
        </div>
        <Detail label="Seed" value={String(job.seed)} actions={action("Seed", { seed: job.seed })} />
        {job.resolved_image_inputs.map((input) => {
          const baseValue = imageBaseValue(run, input.slot_key);
          return <Detail
            key={input.slot_key}
            label={input.label}
            value={input.filename ?? (input.asset_id ? "Project Asset" : baseValue.text)}
            title={input.asset_id === null ? baseValue.title : undefined}
            code={input.asset_id ?? undefined}
            actions={[
              ...action(`${input.label} slot`, { image_inputs: [input.asset_id === null
                ? { slot_key: input.slot_key, mode: "base" }
                : { slot_key: input.slot_key, mode: "asset", asset_id: input.asset_id }] }, "Filter Gallery: this slot"),
              ...(input.asset_id ? action(`${input.label} Asset in any slot`, { asset_id: input.asset_id }, "Filter Gallery: Asset in any slot") : []),
            ]}
          />;
        })}
        {job.resolved_parameters.map((parameter) => {
          const baseValue = parameterBaseValue(run, parameter.parameter_key);
          const definition = profileParameters(selection.workflow_profile).find((candidate) => candidate.key === parameter.parameter_key);
          return <Detail
            key={parameter.parameter_key}
            label={parameter.label}
            value={parameter.value === null ? baseValue.text : formatParameterValue(parameter.value)}
            title={parameter.value === null ? baseValue.title : undefined}
            actions={definition ? action(`${parameter.label} (${definition.value_type})`, { parameters: [parameter.value === null
              ? { key: parameter.parameter_key, value_type: definition.value_type, mode: "base" }
              : { key: parameter.parameter_key, value_type: definition.value_type, mode: "equals", value: parameter.value }] }) : []}
          />;
        })}
        {job.resolved_parameter_sets.map((set) => (
          <Detail key={set.set_key} label={`${set.set_label} preset`} value={set.row_label ?? `Row ${set.row_ordinal}`} />
        ))}
        <Detail
          label="Workflow"
          actions={selection.workflow_version_id ? action("Workflow revision", { workflow_version_id: selection.workflow_version_id }) : []}
          value={formatVersioned(
            selection.workflow_name ?? "Frozen Workflow snapshot",
            selection.workflow_version_number,
          )}
        />
        <Detail
          label="Profile"
          actions={selection.workflow_profile_version_id ? action("Profile revision", { profile_version_id: selection.workflow_profile_version_id }) : []}
          value={formatVersioned(
            selection.workflow_profile_name ?? "Frozen Profile snapshot",
            selection.workflow_profile_version_number,
          )}
        />
        <Detail label="Editable seed intent" value={seedIntent(run)} />
      </dl>
    </section>
  );
}

function TechnicalDetails({
  run,
  result,
  execution,
}: {
  run: RunResponse;
  result: ResultResponse;
  execution: ExecutionResponse | null;
}) {
  const executionJob = (execution ?? run.execution).jobs.find(
    (job) => job.ordinal === result.job_ordinal,
  );
  return (
    <details className="technical-details result-technical-details">
      <summary>Technical details</summary>
      <dl>
        <Detail label="Run" value={runDisplayLabel(run)} code={run.run_id} />
        <Detail label="Run folder" value={run.filesystem_key} code={run.filesystem_key} />
        <Detail label="Job ordinal" value={String(result.job_ordinal)} />
        <Detail label="Artifact ordinal" value={String(result.artifact_ordinal)} />
        <Detail label="ComfyUI prompt ID" value={executionJob?.prompt_id ?? "Unavailable"} code={executionJob?.prompt_id ?? undefined} />
        <Detail label="Filename" value={result.remote_filename} />
        <Detail label="Producing node" value={result.producing_node_id} code={result.producing_node_id} />
        <Detail label="Output" value={result.output_name} />
        <Detail label="Content type" value={result.content_type ?? "Unknown"} />
        <Detail label="Byte size" value={formatBytes(result.byte_size)} />
        <Detail label="SHA-256" value={result.sha256} code={result.sha256} />
        <Detail label="Integrity" value={result.integrity_status} />
      </dl>
    </details>
  );
}

interface DetailAction { label: string; text: string; onClick(): void }

function Detail({ label, value, title, code, actions = [] }: {
  label: string; value: string; title?: string; code?: string; actions?: DetailAction[];
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={code ? "detail-value-code" : undefined} title={title}>
        {code ? (
          <>
            {value === code ? null : <span className="detail-value">{value}</span>}
            <code>{code}</code>
          </>
        ) : value}
        {actions.map((action) => <button
          key={action.label}
          type="button"
          className="button-link compact result-detail-filter"
          aria-label={`Filter Gallery by ${action.label}`}
          onClick={action.onClick}
        >{action.text}</button>)}
      </dd>
    </div>
  );
}

function formatVersioned(name: string, version: number | null): string {
  return `${name}${version === null ? " · version unavailable" : ` · v${version}`}`;
}

function seedIntent(run: RunResponse): string {
  const intent = run.batch_snapshot.seed_intent;
  if (intent.mode === "random") return `Random · ${intent.random_seed_count} requested`;
  if (intent.mode === "fixed") return `Fixed · ${intent.values[0]}`;
  return `Explicit · ${intent.values.join(", ")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatParameterValue(value: string | number | boolean | null): string {
  if (value === null) return "Base workflow · Unavailable";
  if (typeof value === "string") return value === "" ? '"" (empty string)' : value;
  return String(value);
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

function unavailableBaseValue(): ReturnType<typeof formatBaseWorkflowValue> {
  return { text: "Base workflow · Unavailable", available: false };
}
