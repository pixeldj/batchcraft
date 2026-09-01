import { useState } from "react";

import type { ExecutionResponse, RunCreatedResponse, RunResponse } from "../../api/types";
import { RunPlanDialog } from "./RunPlanDialog";

interface Props {
  run: RunCreatedResponse | RunResponse | null;
  execution: ExecutionResponse | null;
  starting: boolean;
  discarding: boolean;
  polling: boolean;
  error: string | null;
  createdUnavailable: boolean;
  batchDiverged: boolean;
  onStart(): void;
  onDiscard(): void;
}

export function RunPanel({
  run,
  execution,
  starting,
  discarding,
  polling,
  error,
  createdUnavailable,
  batchDiverged,
  onStart,
  onDiscard,
}: Props) {
  const [planOpen, setPlanOpen] = useState(false);

  if (!run) {
    return (
      <section className="section-card quiet-card inactive-card" aria-labelledby="run-heading">
        <div className="section-heading">
          <h2 id="run-heading">Run</h2>
        </div>
        <p>Create a Run to continue</p>
      </section>
    );
  }

  const status = execution?.status ?? run.durable_status;
  const completedJobs = execution?.jobs.filter((job) => job.status === "succeeded").length ?? 0;
  const progress = run.job_count ? Math.round((completedJobs / run.job_count) * 100) : 0;
  const current = execution?.current_job_ordinal;
  const frozenRun = "plan" in run ? run : null;
  const dimensions = frozenRun ? summarizeDimensions(frozenRun) : null;
  const workflow = frozenRun?.batch_snapshot.workflow_selection;
  const statusText =
    status === "running" && current
      ? `Running · Job ${current} of ${run.job_count}`
      : status === "created"
        ? createdUnavailable ? "Created · Not executable" : "Created · Ready to start"
        : status.charAt(0).toUpperCase() + status.slice(1);

  return (
    <section className={`section-card run-card status-${status}`} aria-labelledby="run-heading">
      <div className="section-heading">
        <h2 id="run-heading">Run {run.run_number}</h2>
        <span className={`status-pill ${status}`} role="status" aria-live="polite">
          {statusText}
        </span>
      </div>

      <div className="run-summary">
        <strong>{completedJobs} / {run.job_count} Jobs</strong>
        {dimensions ? <p>{dimensions}</p> : <p>Loading frozen Run Plan...</p>}
        {workflow?.workflow_name ? (
          <p>Workflow: <strong>{workflow.workflow_name}</strong>{formatVersion(workflow.workflow_version_number)}</p>
        ) : null}
        {workflow?.workflow_profile_name ? (
          <p>Profile: <strong>{workflow.workflow_profile_name}</strong>{formatVersion(workflow.workflow_profile_version_number)}</p>
        ) : null}
        {execution?.started_at || execution?.completed_at ? (
          <p className="run-summary-times">
            {execution.started_at ? `Started ${formatTimestamp(execution.started_at)}` : null}
            {execution.started_at && execution.completed_at ? " · " : null}
            {execution.completed_at ? `Completed ${formatTimestamp(execution.completed_at)}` : null}
          </p>
        ) : null}
        {frozenRun ? (
          <button className="button-secondary compact" type="button" onClick={() => setPlanOpen(true)}>
            View Run Plan
          </button>
        ) : null}
      </div>
      <details className="technical-details">
        <summary>Run details</summary>
        <p>Run ID: <code>{run.run_id}</code></p>
      </details>

      {execution && status !== "created" ? (
        <>
          <div className="progress-heading">
            <span>{completedJobs} of {run.job_count} Jobs succeeded</span>
            <span>{progress}%</span>
          </div>
          <progress max={run.job_count} value={completedJobs}>{progress}%</progress>
          {execution.error ? <p className="run-error" role="alert">{execution.error}</p> : null}
          {status === "blocked" ? (
            <p className="blocked-note" role="alert">
              Automatic execution stopped. This Run requires explicit reconciliation; no retry is
              available in this version.
            </p>
          ) : null}
          <Diagnostics diagnostics={execution.diagnostics} label="Run diagnostics" />

          <div className="job-list">
            {execution.jobs.map((job) => (
              <article className={`job-row job-${job.status}`} key={job.ordinal}>
                <div className="job-number">{String(job.ordinal).padStart(3, "0")}</div>
                <div>
                  <strong>{job.status.replaceAll("_", " ")}</strong>
                  {job.prompt_id ? (
                    <span className="job-secondary-metadata">
                      ComfyUI prompt <code>{job.prompt_id}</code>
                    </span>
                  ) : null}
                </div>
                <div className="job-result-count">
                  {job.result_count} {job.result_count === 1 ? "Result" : "Results"}
                </div>
                {job.error ? <p className="job-error">{job.error}</p> : null}
                <Diagnostics diagnostics={job.diagnostics} label={`Job ${job.ordinal} diagnostics`} />
              </article>
            ))}
          </div>
        </>
      ) : null}

      {error ? <p className="operation-error" role="alert">{error}</p> : null}
      {status === "created" ? (
        <>
          <div className="frozen-run-note">
            <p>{createdUnavailable
              ? `Run ${run.run_number} is frozen, but its persisted execution state cannot be started or discarded.`
              : `Run ${run.run_number} is frozen and ready to start.`}</p>
            {batchDiverged ? <p>The current Batch has changed since this Run was created.</p> : null}
          </div>
          {!createdUnavailable ? (
            <div className="action-row">
              <p>Execution submits one Job at a time to the configured ComfyUI server.</p>
              <div className="run-action-buttons">
                <button className="button-primary" type="button" disabled={starting || polling || discarding} onClick={onStart}>
                  {starting ? "Starting..." : "Start Run"}
                </button>
                <button className="button-secondary" type="button" disabled={starting || polling || discarding} onClick={onDiscard}>
                  {discarding ? "Discarding..." : "Discard Run"}
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {polling ? <p className="polling-note" aria-live="polite">Watching execution state...</p> : null}
      {frozenRun && planOpen ? (
        <RunPlanDialog run={frozenRun} onClose={() => setPlanOpen(false)} />
      ) : null}
    </section>
  );
}

function Diagnostics({ diagnostics, label }: { diagnostics: string[]; label: string }) {
  if (!diagnostics.length) {
    return null;
  }
  return (
    <details className="diagnostics">
      <summary>{label}</summary>
      <ul>
        {diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic}</li>)}
      </ul>
    </details>
  );
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatVersion(version: number | null): string {
  return version === null ? "" : ` · v${version}`;
}

function summarizeDimensions(run: RunResponse): string {
  const variableCombinations = new Set(
    run.plan.jobs
      .filter((job) => job.resolved_variables.length > 0)
      .map((job) => JSON.stringify(
        [...job.resolved_variables]
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((variable) => [variable.name, variable.value]),
      )),
  );
  const imageDimensions = run.batch_snapshot.image_bindings.map((binding) => binding.values.length);
  const imageSummary = imageDimensions.length === 0
    ? "No image inputs"
    : imageDimensions.length === 1
      ? `${countLabel(1, "image slot")} · ${countLabel(imageDimensions[0], "alternative")}`
      : `${countLabel(imageDimensions.length, "image slot")} · ${imageDimensions.join(" × ")} alternatives`;
  const seeds = new Set(run.plan.jobs.map((job) => job.seed));
  return [
    countLabel(run.prompt_versions.length, "prompt"),
    variableCombinations.size
      ? countLabel(variableCombinations.size, "variable combination")
      : "No variables",
    imageSummary,
    countLabel(seeds.size, "seed"),
  ].join(" · ");
}

function countLabel(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}
