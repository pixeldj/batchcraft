import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type {
  ExecutionResponse,
  ResultResponse,
  RunPlanJobResponse,
  RunResponse,
} from "../../api/types";
import { errorMessage } from "../../utils/errors";

interface Props {
  runId: string;
  result: ResultResponse;
  execution: ExecutionResponse | null;
  restoreTarget: HTMLElement | null;
  getCachedRun(runId: string): RunResponse | null;
  loadRun(runId: string): Promise<RunResponse>;
  onClose(): void;
}

export function ResultDetailsDialog({
  runId,
  result,
  execution,
  restoreTarget,
  getCachedRun,
  loadRun,
  onClose,
}: Props) {
  const cachedRun = getCachedRun(runId);
  const [run, setRun] = useState<RunResponse | null>(cachedRun);
  const [loading, setLoading] = useState(cachedRun === null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreTargetRef = useRef(restoreTarget);

  useEffect(() => {
    closeRef.current?.focus();
    const target = restoreTargetRef.current;
    return () => target?.focus();
  }, []);

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

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div className="result-details-backdrop" onClick={onClose}>
      <dialog
        className="result-details-dialog"
        open
        aria-labelledby="result-details-title"
        onCancel={onClose}
        onKeyDown={handleKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="result-details-heading">
          <div>
            <p className="result-details-kicker">Result details</p>
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

        {run && job ? <GenerationDetails run={run} job={job} /> : null}
        {run && !job ? (
          <p className="operation-error" role="alert">
            Frozen Job {result.job_ordinal} is unavailable for this Run.
          </p>
        ) : null}
        {run ? <TechnicalDetails run={run} result={result} execution={execution} /> : null}
      </dialog>
    </div>
  );
}

function GenerationDetails({ run, job }: { run: RunResponse; job: RunPlanJobResponse }) {
  const snapshotPrompt = run.batch_snapshot.prompt_versions.find(
    (prompt) => prompt.id === job.prompt_version_id,
  );
  const selection = run.batch_snapshot.workflow_selection;

  return (
    <section className="result-generation-details" aria-label="Generation provenance">
      <dl>
        <Detail label="Prompt" value={formatVersioned(
          snapshotPrompt?.name ?? job.prompt_version_name,
          snapshotPrompt?.version_number ?? null,
        )} />
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
        <Detail label="Seed" value={String(job.seed)} />
         {job.resolved_image_inputs.map((input) => (
           <Detail
              key={input.slot_key}
              label={input.label}
              value={input.filename ?? (input.asset_id ? "Project Asset" : "Base workflow")}
              code={input.asset_id ?? undefined}
            />
         ))}
        {job.resolved_parameters.map((parameter) => (
          <Detail
            key={parameter.parameter_key}
            label={parameter.label}
            value={formatParameterValue(parameter.value)}
          />
        ))}
        <Detail
          label="Workflow"
          value={formatVersioned(
            selection.workflow_name ?? "Frozen Workflow snapshot",
            selection.workflow_version_number,
          )}
        />
        <Detail
          label="Profile"
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
        <Detail label="Run" value={`Run ${run.run_number}`} code={run.run_id} />
        <Detail label="Job ordinal" value={String(result.job_ordinal)} />
        <Detail label="Artifact ordinal" value={String(result.artifact_ordinal)} />
        <Detail label="ComfyUI prompt ID" value={executionJob?.prompt_id ?? "Unavailable"} code={executionJob?.prompt_id ?? undefined} />
        <Detail label="Filename" value={result.remote_filename} />
        <Detail label="Producing node" value={result.producing_node_id} code={result.producing_node_id} />
        <Detail label="Output" value={result.output_name} />
        <Detail label="Content type" value={result.content_type ?? "Unknown"} />
        <Detail label="Byte size" value={formatBytes(result.byte_size)} />
        <Detail label="SHA-256" value={result.sha256} code={result.sha256} />
      </dl>
    </details>
  );
}

function Detail({ label, value, code }: { label: string; value: string; code?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={code ? "detail-value-code" : undefined}>
        {code ? (
          <>
            {value === code ? null : <span className="detail-value">{value}</span>}
            <code>{code}</code>
          </>
        ) : value}
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
  if (value === null) return "Base workflow";
  if (typeof value === "string") return value === "" ? '"" (empty string)' : value;
  return String(value);
}
