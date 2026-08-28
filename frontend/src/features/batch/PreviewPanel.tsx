import type { PreviewResponse } from "../../api/types";

interface Props {
  preview: PreviewResponse | null;
  creating: boolean;
  runCreated: boolean;
  error: string | null;
  onCreateRun(): void;
}

export function PreviewPanel({ preview, creating, runCreated, error, onCreateRun }: Props) {
  if (!preview) {
    return (
      <section className="section-card quiet-card" aria-labelledby="preview-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">02 / Inspect</p>
            <h2 id="preview-heading">Preview</h2>
          </div>
        </div>
        <p>Preview the Batch to inspect the backend-compiled Job plan before creating a Run.</p>
        {error ? <p className="operation-error" role="alert">{error}</p> : null}
      </section>
    );
  }

  return (
    <section className="section-card" aria-labelledby="preview-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">02 / Inspect</p>
          <h2 id="preview-heading">Preview</h2>
        </div>
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
              <th scope="col">Resolved prompt</th>
              <th scope="col">Variables</th>
              <th scope="col">Asset ID</th>
              <th scope="col">Seed</th>
            </tr>
          </thead>
          <tbody>
            {preview.jobs.map((job) => (
              <tr key={job.ordinal}>
                <td className="ordinal">{job.ordinal}</td>
                <td className="prompt-cell">{job.resolved_prompt}</td>
                <td>
                  {job.resolved_variables.length
                    ? job.resolved_variables
                        .map((variable) => `${variable.name} = ${variable.value}`)
                        .join(", ")
                    : "None"}
                </td>
                <td><code>{job.reference_asset_id}</code></td>
                <td><code>{job.seed}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error ? <p className="operation-error" role="alert">{error}</p> : null}
      <div className="action-row">
        <p>
          {runCreated
            ? "This browser session already owns a Run. Refresh to begin another session."
            : "The backend recompiles the current form when it creates the frozen Run."}
        </p>
        <button
          className="button-primary"
          type="button"
          disabled={creating || runCreated}
          onClick={onCreateRun}
        >
          {creating ? "Creating Run..." : runCreated ? "Run Created" : "Create Run"}
        </button>
      </div>
    </section>
  );
}
