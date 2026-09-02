import { useState } from "react";

import type { BatchcraftApi } from "../../api/client";
import type {
  ExecutionResponse,
  ResultResponse,
  RunCreatedResponse,
  RunResponse,
} from "../../api/types";
import { ResultGallery } from "./ResultGallery";

interface Props {
  api: BatchcraftApi;
  run: RunCreatedResponse | null;
  execution: ExecutionResponse | null;
  results: ResultResponse[];
  error: string | null;
  refreshing: boolean;
  onRefresh(): void;
  getCachedRun(runId: string): RunResponse | null;
  loadRun(runId: string): Promise<RunResponse>;
}

export function ResultsPanel({
  api,
  run,
  execution,
  results,
  error,
  refreshing,
  onRefresh,
  getCachedRun,
  loadRun,
}: Props) {
  const [expanded, setExpanded] = useState(true);

  if (!run && !error) {
    return (
      <section className="section-card quiet-card inactive-card" aria-labelledby="results-heading">
        <div className="section-heading">
          <h2 id="results-heading">Results</h2>
        </div>
        <p>Awaiting a Run</p>
      </section>
    );
  }

  return (
    <section className="section-card results-section" aria-labelledby="results-heading">
      <div className="section-heading">
        <div>
          <h2 id="results-heading">Results</h2>
          {run ? <span className="section-note">{resultCount(results.length)}</span> : null}
        </div>
        {run ? (
          <div className="results-actions">
            <button className="button-secondary compact" type="button" disabled={refreshing} onClick={onRefresh}>
              {refreshing ? "Refreshing..." : "Refresh Results"}
            </button>
            <button
              className="button-secondary compact"
              type="button"
              aria-expanded={expanded}
              aria-controls="current-run-results-content"
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          </div>
        ) : null}
      </div>

      {!run ? <p>Results will appear here after a Run starts producing artifacts.</p> : null}
      {!run && error ? <p className="operation-error" role="alert">Results: {error}</p> : null}
      {run && expanded ? (
        <div id="current-run-results-content">
          {results.length === 0 ? <p>No Results have been ingested yet.</p> : null}
          {error ? <p className="operation-error" role="alert">Results: {error}</p> : null}
          <ResultGallery
            api={api}
            runId={run.run_id}
            execution={execution}
            results={results}
            getCachedRun={getCachedRun}
            loadRun={loadRun}
          />
        </div>
      ) : null}
    </section>
  );
}

function resultCount(count: number): string {
  return `${count} ${count === 1 ? "Result" : "Results"}`;
}
