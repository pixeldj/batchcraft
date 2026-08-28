import type { ExecutionResponse, RunCreatedResponse } from "../../api/types";

interface Props {
  run: RunCreatedResponse | null;
  execution: ExecutionResponse | null;
  starting: boolean;
  polling: boolean;
  error: string | null;
  onStart(): void;
}

export function RunPanel({ run, execution, starting, polling, error, onStart }: Props) {
  if (!run) {
    return (
      <section className="section-card quiet-card" aria-labelledby="run-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">03 / Execute</p>
            <h2 id="run-heading">Run</h2>
          </div>
        </div>
        <p>Create a Run to freeze the plan and make it eligible for execution.</p>
      </section>
    );
  }

  const status = execution?.status ?? run.durable_status;
  const completedJobs = execution?.jobs.filter((job) => job.status === "succeeded").length ?? 0;
  const progress = run.job_count ? Math.round((completedJobs / run.job_count) * 100) : 0;
  const current = execution?.current_job_ordinal;
  const statusText =
    status === "running" && current
      ? `Running · Job ${current} of ${run.job_count}`
      : status === "created"
        ? "Created · Ready to start"
        : status.charAt(0).toUpperCase() + status.slice(1);

  return (
    <section className={`section-card run-card status-${status}`} aria-labelledby="run-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">03 / Execute</p>
          <h2 id="run-heading">Run {run.run_number}</h2>
        </div>
        <span className={`status-pill ${status}`} role="status" aria-live="polite">
          {statusText}
        </span>
      </div>

      <dl className="run-metadata">
        <div><dt>Run ID</dt><dd><code>{run.run_id}</code></dd></div>
        <div><dt>Project</dt><dd>{run.project_name}</dd></div>
        <div><dt>Batch</dt><dd>{run.batch_name}</dd></div>
        <div><dt>Jobs</dt><dd>{run.job_count}</dd></div>
      </dl>

      {execution && status !== "created" ? (
        <>
          <div className="progress-heading">
            <span>{completedJobs} of {run.job_count} Jobs succeeded</span>
            <span>{progress}%</span>
          </div>
          <progress max={run.job_count} value={completedJobs}>{progress}%</progress>
          <div className="timestamp-row">
            {execution.started_at ? <span>Started {formatTimestamp(execution.started_at)}</span> : null}
            {execution.completed_at ? (
              <span>Completed {formatTimestamp(execution.completed_at)}</span>
            ) : null}
          </div>

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
                  {job.prompt_id ? <code>{job.prompt_id}</code> : null}
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
        <div className="action-row">
          <p>Execution submits one Job at a time to the configured ComfyUI server.</p>
          <button className="button-primary" type="button" disabled={starting || polling} onClick={onStart}>
            {starting ? "Starting..." : "Start Run"}
          </button>
        </div>
      ) : null}
      {polling ? <p className="polling-note" aria-live="polite">Watching execution state...</p> : null}
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
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
