import { useState } from "react";

import type { ExecutionResponse, RunCreatedResponse, RunResponse } from "../../api/types";
import { RunPlanDialog } from "./RunPlanDialog";
import { runDisplayName, runNumberLabel } from "./runDisplay";

interface Props {
  run: RunCreatedResponse | RunResponse | null;
  execution: ExecutionResponse | null;
  starting: boolean;
  discarding: boolean;
  requestingStop: boolean;
  reconcilingStop: boolean;
  requestingDetach: boolean;
  reconcilingDetach: boolean;
  polling: boolean;
  error: string | null;
  createdUnavailable: boolean;
  batchDiverged: boolean;
  onStart(): void;
  onDiscard(): void;
  onStopAfterCurrentJob(): void;
  onDetachFromCurrentJob(): void;
}

export function RunPanel({
  run,
  execution,
  starting,
  discarding,
  requestingStop,
  reconcilingStop,
  requestingDetach,
  reconcilingDetach,
  polling,
  error,
  createdUnavailable,
  batchDiverged,
  onStart,
  onDiscard,
  onStopAfterCurrentJob,
  onDetachFromCurrentJob,
}: Props) {
  const [planOpen, setPlanOpen] = useState(false);
  const [planRestoreTarget, setPlanRestoreTarget] = useState<HTMLElement | null>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [confirmingDetach, setConfirmingDetach] = useState(false);

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
  const stopping = status === "running" && (
    execution?.cancellation?.state === "stop_requested" ||
    execution?.cancellation?.state === "stopping_after_current_job"
  );
  const detaching = status === "running" && execution?.cancellation?.mode === "detach";
  const detached = status === "blocked" && execution?.cancellation?.state === "detached";
  const currentJob = execution?.jobs.find((job) => job.ordinal === current);
  const detachEligible = status === "running" && currentJob !== undefined && [
    "preparing",
    "submitting",
    "submission_unknown",
    "submitted",
  ].includes(currentJob.status);
  const statusText =
    detaching
      ? "Stopping local wait"
      : stopping
      ? current
        ? `Stopping after current Job · Job ${current} of ${run.job_count}`
        : "Stopping after current Job"
      : status === "running" && current
      ? `Running · Job ${current} of ${run.job_count}`
      : status === "created"
        ? createdUnavailable ? "Created · Not executable" : "Created · Ready to start"
        : detached
          ? "Blocked: Remote outcome unknown"
          : status.charAt(0).toUpperCase() + status.slice(1);

  return (
    <section className={`section-card run-card status-${status}`} aria-labelledby="run-heading">
      <div className="section-heading">
        <div className="run-heading-title">
          <h2 id="run-heading">{runDisplayName(run)}</h2>
          {run.run_name ? <span>{runNumberLabel(run)}</span> : null}
        </div>
        <span className={`status-pill ${status}`} role="status" aria-live="polite">
          {statusText}
        </span>
      </div>

      <div className="run-summary">
        <strong>{completedJobs} / {run.job_count} Jobs</strong>
        {run.run_description ? <p className="run-description">{run.run_description}</p> : null}
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
          <button
            className="button-secondary compact"
            type="button"
            onClick={(event) => {
              setPlanRestoreTarget(event.currentTarget);
              setPlanOpen(true);
            }}
          >
            View Run Plan
          </button>
        ) : null}
      </div>
      <details className="technical-details">
        <summary>Run details</summary>
        <p>Run ID: <code>{run.run_id}</code></p>
        <p>Filesystem key: <code>{run.filesystem_key}</code></p>
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
              {detached
                ? "Detached while the remote Job outcome was unconfirmed. The remote ComfyUI Job may still be running. No later Job will start."
                : "Automatic execution stopped. This Run requires explicit reconciliation; no retry is available in this version."}
            </p>
          ) : null}
          {stopping ? (
            <p className="stopping-note" role="status" aria-live="polite">
              {execution.cancellation?.state === "stop_requested"
                ? "Stop requested. No further Job will start."
                : "The current Job will finish normally and keep its Results. No later Job will start."}
            </p>
          ) : null}
          {detaching ? (
            <p className="stopping-note" role="status" aria-live="polite">
              Stopping batchcraft's local wait. The remote ComfyUI Job may continue running.
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
      {status === "running" && !execution?.cancellation ? (
        <div className="action-row run-stop-action">
          {confirmingStop ? (
            <div className="stop-confirmation" role="group" aria-label="Confirm stop after current Job">
              <p>
                <strong>Stop this Run after the current Job finishes?</strong><br />
                Remaining Jobs will not start.
              </p>
              <div className="run-action-buttons">
                <button
                  className="button-secondary"
                  type="button"
                  disabled={requestingStop || reconcilingStop || requestingDetach || reconcilingDetach}
                  onClick={() => setConfirmingStop(false)}
                >
                  Keep Running
                </button>
                <button
                  className="button-primary"
                  type="button"
                  disabled={requestingStop || reconcilingStop || requestingDetach || reconcilingDetach}
                  onClick={() => {
                    setConfirmingStop(false);
                    onStopAfterCurrentJob();
                  }}
                >
                  Stop Run
                </button>
              </div>
            </div>
          ) : (
            <>
              <p>The current Job will finish normally. Remaining Jobs will not start.</p>
              <button
                className="button-secondary"
                type="button"
                disabled={requestingStop || reconcilingStop || requestingDetach || reconcilingDetach}
                onClick={() => setConfirmingStop(true)}
              >
                {requestingStop
                  ? "Requesting stop..."
                  : reconcilingStop
                    ? "Checking stop request..."
                    : "Stop after current Job"}
              </button>
            </>
          )}
        </div>
      ) : null}
      {detachEligible && execution?.cancellation?.mode !== "detach" ? (
        <div className="action-row run-detach-action">
          {confirmingDetach ? (
            <div className="stop-confirmation" role="group" aria-label="Confirm Stop waiting">
              <p>
                <strong>Stop waiting for this Job?</strong><br />
                batchcraft will submit no later Jobs. The remote ComfyUI Job may continue running and
                its final outcome may remain unknown.
              </p>
              <div className="run-action-buttons">
                <button
                  className="button-secondary"
                  type="button"
                  disabled={requestingDetach || reconcilingDetach}
                  onClick={() => setConfirmingDetach(false)}
                >
                  Keep Waiting
                </button>
                <button
                  className="button-primary"
                  type="button"
                  disabled={requestingDetach || reconcilingDetach}
                  onClick={() => {
                    setConfirmingDetach(false);
                    onDetachFromCurrentJob();
                  }}
                >
                  Stop waiting
                </button>
              </div>
            </div>
          ) : (
            <>
              <p>
                Use this if ComfyUI is stuck or unavailable. The current remote Job may continue
                running and its outcome may remain unknown.
              </p>
              <button
                className="button-secondary"
                type="button"
                disabled={requestingStop || reconcilingStop || requestingDetach || reconcilingDetach}
                onClick={() => setConfirmingDetach(true)}
              >
                {requestingDetach
                  ? "Stopping local wait..."
                  : reconcilingDetach
                    ? "Checking Stop waiting request..."
                    : "Stop waiting"}
              </button>
            </>
          )}
        </div>
      ) : null}
      {polling ? <p className="polling-note" aria-live="polite">Watching execution state...</p> : null}
      {frozenRun && planOpen ? (
        <RunPlanDialog
          run={frozenRun}
          restoreTarget={planRestoreTarget}
          onClose={() => setPlanOpen(false)}
        />
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
