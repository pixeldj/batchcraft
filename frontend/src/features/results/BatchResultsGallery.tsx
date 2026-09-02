import { useState } from "react";

import type { BatchcraftApi } from "../../api/client";
import type { ExecutionResponse, ResultResponse, RunResponse } from "../../api/types";
import { ResultGallery } from "./ResultGallery";

export interface BatchGalleryRun {
  runId: string;
  runNumber: number | null;
  runName: string | null;
  results: ResultResponse[];
  execution: ExecutionResponse | null;
  loading: boolean;
  error: string | null;
}

interface Props {
  api: BatchcraftApi;
  runIds: string[];
  runsById: Record<string, BatchGalleryRun>;
  getCachedRun(runId: string): RunResponse | null;
  loadRun(runId: string): Promise<RunResponse>;
}

export function BatchResultsGallery({
  api,
  runIds,
  runsById,
  getCachedRun,
  loadRun,
}: Props) {
  const [expandedByRun, setExpandedByRun] = useState<Record<string, boolean>>({});
  const artifactCount = runIds.reduce(
    (count, runId) => count + (runsById[runId]?.results.length ?? 0),
    0,
  );

  if (runIds.length === 0) {
    return (
      <section className="section-card quiet-card inactive-card" aria-labelledby="batch-results-heading">
        <div className="section-heading">
          <h2 id="batch-results-heading">Batch Results</h2>
        </div>
        <p>No session Results yet</p>
      </section>
    );
  }

  return (
    <section className="section-card batch-results-section" aria-labelledby="batch-results-heading">
      <div className="section-heading">
        <h2 id="batch-results-heading">Batch Results</h2>
        <div className="batch-results-header-actions">
          <span className="section-note">
            {artifactCount} {artifactCount === 1 ? "artifact" : "artifacts"} across this browser session
          </span>
          <button
            className="button-secondary compact"
            type="button"
            onClick={() => setExpandedByRun(Object.fromEntries(runIds.map((runId) => [runId, true])))}
          >
            Expand all
          </button>
          <button
            className="button-secondary compact"
            type="button"
            onClick={() => setExpandedByRun(Object.fromEntries(runIds.map((runId) => [runId, false])))}
          >
            Collapse all
          </button>
        </div>
      </div>

      <div className="batch-results-runs">
        {runIds.map((runId, index) => {
          const run = runsById[runId];
          const runNumberLabel = run?.runNumber === null || run?.runNumber === undefined
            ? `Run pending ${index + 1}`
            : `Run ${run.runNumber}`;
          const runLabel = run?.runName ? `${run.runName} · ${runNumberLabel}` : runNumberLabel;
          const orderedResults = [...(run?.results ?? [])].sort(
            (left, right) =>
              left.job_ordinal - right.job_ordinal ||
              left.artifact_ordinal - right.artifact_ordinal,
          );
          const expanded = expandedByRun[runId] ?? true;
          const contentId = `batch-results-run-${index}`;
          return (
            <section className="batch-results-run" aria-label={runLabel} key={runId}>
              <div className="batch-results-run-heading">
                <div>
                  <strong>
                    {run?.runName ?? runNumberLabel}
                    {run?.runName ? <span className="run-number-secondary">{runNumberLabel}</span> : null}
                    <span className="run-result-count">{resultCount(orderedResults.length)}</span>
                  </strong>
                  {expanded ? (
                    <details className="technical-details">
                      <summary>Run details</summary>
                      <p>Run ID: <code>{runId}</code></p>
                    </details>
                  ) : null}
                </div>
                <button
                  className="button-secondary compact"
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={contentId}
                  onClick={() => setExpandedByRun((current) => ({
                    ...current,
                    [runId]: !expanded,
                  }))}
                >
                  {expanded ? "Collapse" : "Expand"}
                </button>
              </div>
              {expanded ? (
                <div className="batch-results-run-content" id={contentId}>
                  {run?.loading ? <p className="empty-note">Loading Results...</p> : null}
                  {run?.error ? <p className="operation-error">Unavailable: {run.error}</p> : null}
                  {!run?.loading && !run?.error && orderedResults.length === 0 ? (
                    <p className="empty-note">No Results have been ingested for this Run yet.</p>
                  ) : null}
                  {orderedResults.length > 0 ? (
                    <ResultGallery
                      api={api}
                      runId={runId}
                      execution={run?.execution ?? null}
                      results={orderedResults}
                      runLabel={runLabel}
                      getCachedRun={getCachedRun}
                      loadRun={loadRun}
                    />
                  ) : null}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </section>
  );
}

function resultCount(count: number): string {
  return `${count} ${count === 1 ? "Result" : "Results"}`;
}
