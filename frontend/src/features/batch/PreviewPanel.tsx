import type { PreviewResponse, RunCreatedResponse, RunStatus } from "../../api/types";
import { Field, TextAreaField } from "../../components/Field";
import { runDisplayLabel } from "../run/runDisplay";

interface Props {
  preview: PreviewResponse | null;
  creating: boolean;
  currentRun: RunCreatedResponse | null;
  currentRunStatus: RunStatus | null;
  canCreateRun: boolean;
  creationBlockedMessage: string | null;
  association: { runId: string; runNumber: number; consistent: boolean } | null;
  error: string | null;
  runName: string;
  runDescription: string;
  onRunNameChange(value: string): void;
  onRunDescriptionChange(value: string): void;
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
  runName,
  runDescription,
  onRunNameChange,
  onRunDescriptionChange,
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
              <th scope="col">Image Inputs</th>
              <th scope="col">Parameters</th>
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
                  {job.resolved_image_inputs.length === 0 ? "None" : (
                    <dl className="named-image-inputs">
                      {job.resolved_image_inputs.map((input) => (
                        <div key={input.slot_key}>
                          <dt>{input.label}</dt>
                          <dd>{input.asset_id === null ? "Base workflow" : input.filename ?? "Project Asset"}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </td>
                <td>
                  {job.resolved_parameters.length === 0 ? "None" : (
                    <dl className="named-image-inputs">
                      {job.resolved_parameters.map((parameter) => (
                        <div key={parameter.parameter_key}>
                          <dt>{parameter.label}</dt>
                          <dd>{formatParameterValue(parameter.value)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </td>
                <td><code>{job.seed}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error ? <p className="operation-error" role="alert">{error}</p> : null}
      {association && currentRun && association.runId === currentRun.run_id ? (
        <p className={association.consistent ? "preview-run-note" : "operation-error"}>
          {association.consistent
            ? `Created as ${runDisplayLabel(currentRun)}.`
            : `Run ${association.runNumber} was created but does not match this Preview.`}
        </p>
      ) : null}
      <div className="run-creation-panel">
        <div className="run-creation-fields">
          <Field
            id="run-name"
            label="Run Name"
            hint="Optional. Used for this Run's permanent folder name."
            maxLength={200}
            placeholder="Baseline"
            value={runName}
            disabled={creating}
            onChange={(event) => onRunNameChange(event.target.value)}
          />
          <TextAreaField
            id="run-description"
            label="Notes"
            hint="Optional notes frozen with this Run."
            maxLength={4000}
            rows={3}
            value={runDescription}
            disabled={creating}
            onChange={(event) => onRunDescriptionChange(event.target.value)}
          />
        </div>
        <div className="action-row">
          <p>
            {creationBlockedMessage ??
              (currentRun && currentRunStatus && ["succeeded", "failed", "blocked", "cancelled"].includes(currentRunStatus)
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
      </div>
    </section>
  );
}

function formatParameterValue(value: string | number | boolean | null): string {
  if (value === null) return "Base workflow";
  if (typeof value === "string") return value === "" ? '"" (empty string)' : value;
  return String(value);
}
