import type { BatchcraftApi } from "../../api/client";
import type { ResultResponse } from "../../api/types";
import { ResultCard } from "./ResultCard";

export interface BatchGalleryRun {
  runId: string;
  runNumber: number | null;
  results: ResultResponse[];
  loading: boolean;
  error: string | null;
}

interface Props {
  api: BatchcraftApi;
  runIds: string[];
  runsById: Record<string, BatchGalleryRun>;
}

export function BatchResultsGallery({ api, runIds, runsById }: Props) {
  const artifactCount = runIds.reduce(
    (count, runId) => count + (runsById[runId]?.results.length ?? 0),
    0,
  );

  return (
    <section className="section-card batch-results-section" aria-labelledby="batch-results-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">05 / Session Review</p>
          <h2 id="batch-results-heading">Batch Results</h2>
        </div>
        <span className="section-note">
          {artifactCount} {artifactCount === 1 ? "artifact" : "artifacts"} across this browser session
        </span>
      </div>

      {runIds.length === 0 ? (
        <p>Results from Runs created for this Batch in this browser session will accumulate here.</p>
      ) : (
        <div className="batch-results-runs">
          {runIds.map((runId) => {
            const run = runsById[runId];
            const runLabel = run?.runNumber === null || run?.runNumber === undefined
              ? `Run ${runId}`
              : `Run ${run.runNumber}`;
            const orderedResults = [...(run?.results ?? [])].sort(
              (left, right) =>
                left.job_ordinal - right.job_ordinal ||
                left.artifact_ordinal - right.artifact_ordinal,
            );
            return (
              <section className="batch-results-run" aria-label={runLabel} key={runId}>
                <div className="batch-results-run-heading">
                  <strong>{runLabel}</strong>
                  <code>{runId}</code>
                </div>
                {run?.loading ? <p className="empty-note">Loading Results...</p> : null}
                {run?.error ? <p className="operation-error">Unavailable: {run.error}</p> : null}
                {!run?.loading && !run?.error && orderedResults.length === 0 ? (
                  <p className="empty-note">No Results have been ingested for this Run yet.</p>
                ) : null}
                {orderedResults.length > 0 ? (
                  <div className="results-grid">
                    {orderedResults.map((result) => (
                      <ResultCard
                        api={api}
                        result={result}
                        runLabel={runLabel}
                        key={`${result.job_ordinal}-${result.artifact_ordinal}`}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
