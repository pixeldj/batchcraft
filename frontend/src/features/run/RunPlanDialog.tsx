import type { EditableBatchSnapshot, RunPlanJobResponse, RunResponse } from "../../api/types";

interface Props {
  run: RunResponse;
  onClose(): void;
}

export function RunPlanDialog({ run, onClose }: Props) {
  const snapshot = run.batch_snapshot;

  return (
    <dialog className="run-plan-dialog" open aria-labelledby="run-plan-title" onCancel={onClose}>
      <div className="run-plan-heading">
        <div>
          <p className="run-plan-kicker">Frozen experiment specification</p>
          <h2 id="run-plan-title">Run {run.run_number} Plan</h2>
        </div>
        <button className="button-link" type="button" onClick={onClose}>Close</button>
      </div>

      <section className="run-plan-overview" aria-labelledby="run-plan-overview-title">
        <h3 id="run-plan-overview-title">{snapshot?.batch.name ?? run.batch_name}</h3>
        {snapshot?.batch.description ? <p>{snapshot.batch.description}</p> : null}
        <dl>
          <div><dt>Total Jobs</dt><dd>{run.plan.job_count}</dd></div>
          <div><dt>References</dt><dd>{referenceSummary(run)}</dd></div>
          <div><dt>Seed intent</dt><dd>{seedIntentSummary(snapshot)}</dd></div>
          <div><dt>Materialized seeds</dt><dd>{materializedSeeds(run)}</dd></div>
          <div><dt>Workflow</dt><dd>{workflowSummary(snapshot)}</dd></div>
          <div><dt>Profile</dt><dd>{profileSummary(snapshot)}</dd></div>
        </dl>
        {!snapshot ? (
          <p className="run-plan-compatibility">
            Editable Batch intent is unavailable for this older Run. Its concrete frozen Jobs remain inspectable.
          </p>
        ) : null}
      </section>

      <section className="run-plan-section" aria-labelledby="run-plan-prompts-title">
        <h3 id="run-plan-prompts-title">PromptVersions</h3>
        <ol className="run-plan-prompts">
          {run.prompt_versions.map((prompt, index) => {
            const intent = snapshot?.prompt_versions[index];
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
        {snapshot?.variable_bindings.length ? (
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

      {run.plan.warnings.length ? (
        <div className="warning-box" role="status">
          <strong>Compiler warnings</strong>
          <ul>{run.plan.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul>
        </div>
      ) : null}

      <section className="run-plan-section" aria-labelledby="run-plan-jobs-title">
        <h3 id="run-plan-jobs-title">Concrete Jobs</h3>
        <div className="run-plan-jobs">
          {run.plan.jobs.map((job) => <RunPlanJob key={job.ordinal} job={job} />)}
        </div>
      </section>
    </dialog>
  );
}

function RunPlanJob({ job }: { job: RunPlanJobResponse }) {
  const variables = job.resolved_variables.map((variable) => variable.value).join(" · ");
  const reference = job.reference_filename ?? (job.reference_asset_id ? "Selected reference" : "Base workflow");
  return (
    <details className="run-plan-job">
      <summary>
        <span className="ordinal">{String(job.ordinal).padStart(3, "0")}</span>
        <strong>{job.prompt_version_name}</strong>
        {variables ? <span>{variables}</span> : null}
        <span>{reference}</span>
        <code>seed {job.seed}</code>
      </summary>
      <div>
        <p className="resolved-prompt">{job.resolved_prompt}</p>
        <dl>
          {job.resolved_variables.map((variable) => (
            <div key={variable.name}><dt>{variable.name}</dt><dd>{variable.value}</dd></div>
          ))}
          <div><dt>Reference</dt><dd>{reference}</dd></div>
          <div><dt>Seed</dt><dd><code>{job.seed}</code></dd></div>
        </dl>
      </div>
    </details>
  );
}

function seedIntentSummary(snapshot: EditableBatchSnapshot | null): string {
  const intent = snapshot?.seed_intent;
  if (!intent) return "Unavailable";
  if (intent.mode === "random") return `Random · ${intent.random_seed_count} requested`;
  if (intent.mode === "fixed") return `Fixed · ${intent.values[0]}`;
  return `Explicit · ${intent.values.join(", ")}`;
}

function materializedSeeds(run: RunResponse): string {
  return [...new Set(run.plan.jobs.map((job) => job.seed))].join(", ");
}

function referenceSummary(run: RunResponse): string {
  const references = new Map<string, string>();
  for (const job of run.plan.jobs) {
    if (job.reference_asset_id) {
      references.set(job.reference_asset_id, job.reference_filename ?? "Selected reference");
    }
  }
  return references.size ? [...references.values()].join(", ") : "Base workflow";
}

function workflowSummary(snapshot: EditableBatchSnapshot | null): string {
  const selection = snapshot?.workflow_selection;
  if (!selection?.workflow_name) return "Frozen Workflow snapshot · version unavailable";
  return `${selection.workflow_name}${selection.workflow_version_number ? ` · v${selection.workflow_version_number}` : ""}`;
}

function profileSummary(snapshot: EditableBatchSnapshot | null): string {
  const selection = snapshot?.workflow_selection;
  if (!selection?.workflow_profile_name) return "Frozen Profile snapshot · version unavailable";
  return `${selection.workflow_profile_name}${selection.workflow_profile_version_number ? ` · v${selection.workflow_profile_version_number}` : ""}`;
}

function bindingValues(binding: EditableBatchSnapshot["variable_bindings"][number]): string {
  if (binding.mode === "fixed") return `Fixed · ${binding.fixed_value ?? "Unavailable"}`;
  return `All values · ${binding.selected_values.join(", ")}`;
}
