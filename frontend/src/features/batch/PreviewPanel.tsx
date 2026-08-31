import type { PreviewResponse, RunCreatedResponse, RunStatus } from "../../api/types";

interface Props {
  preview: PreviewResponse | null;
  creating: boolean;
  currentRun: RunCreatedResponse | null;
  currentRunStatus: RunStatus | null;
  canCreateRun: boolean;
  creationBlockedMessage: string | null;
  association: { runId: string; runNumber: number; consistent: boolean } | null;
  error: string | null;
  onCreateRun(): void;
}

export function PreviewPanel({
  preview,
  creating,
  currentRun,
  currentRunStatus,
  canCreateRun,
  creationBlockedMessage,
  association,
  error,
  onCreateRun,
}: Props) {
  if (!preview) {
    return (
      <section className={`section-card quiet-card ${error ? "" : "inactive-card"}`.trim()} aria-labelledby="preview-heading">
        <div className="section-heading">
          <h2 id="preview-heading">Preview</h2>
        </div>
        {!error ? <p>Preview required</p> : null}
        {error ? <p className="operation-error" role="alert">{error}</p> : null}
      </section>
    );
  }

  return (
    <section className="section-card" aria-labelledby="preview-heading">
      <div className="section-heading">
        <h2 id="preview-heading">Preview</h2>
        <div className="count-block">
          <strong>{preview.job_count}</strong>
          <span>{preview.job_count === 1 ? "Job" : "Jobs"}</span>
        </div>
      </div>

      {preview.warnings.length ? (
        <div className="warning-box" role="status">
          <strong>Compiler warnings</strong>
          <ul>
            {preview.warnings.map((warning, index) => (
              <li key={`${warning.code}-${warning.placeholder}-${index}`}>{warning.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">Prompt</th>
              <th scope="col">Resolved prompt</th>
              <th scope="col">Variables</th>
              <th scope="col">Reference</th>
              <th scope="col">Seed</th>
            </tr>
          </thead>
          <tbody>
            {preview.jobs.map((job) => (
              <tr key={job.ordinal}>
                <td className="ordinal">{job.ordinal}</td>
                <td className="prompt-identity">
                  <strong>{job.prompt_version_name}</strong>
                </td>
                <td className="prompt-cell">{job.resolved_prompt}</td>
                <td>
                  {job.resolved_variables.length
                    ? job.resolved_variables
                        .map((variable) => `${variable.name} = ${variable.value}`)
                        .join(", ")
                    : "None"}
                </td>
                <td>
                  {job.reference_asset_id === null ? "Base workflow" : (
                    <details className="inline-details">
                      <summary>Reference selected</summary>
                      <code>{job.reference_asset_id}</code>
                    </details>
                  )}
                </td>
                <td><code>{job.seed}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error ? <p className="operation-error" role="alert">{error}</p> : null}
      {association && association.runId === currentRun?.run_id ? (
        <p className={association.consistent ? "preview-run-note" : "operation-error"}>
          {association.consistent
            ? `Created as Run ${association.runNumber}.`
            : `Run ${association.runNumber} was created but does not match this Preview.`}
        </p>
      ) : null}
      <div className="action-row">
        <p>
          {creationBlockedMessage ??
            (currentRun && currentRunStatus && ["succeeded", "failed", "blocked"].includes(currentRunStatus)
              ? "Create a new immutable Run from this inspected Preview. The previous Run is unchanged."
              : "Run creation submits the exact Batch specification used for this Preview.")}
        </p>
        <button
          className="button-primary"
          type="button"
          disabled={creating || !canCreateRun}
          onClick={onCreateRun}
        >
          {creating ? "Creating Run..." : currentRun ? "Create Another Run" : "Create Run"}
        </button>
      </div>
    </section>
  );
}
