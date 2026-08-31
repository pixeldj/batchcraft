import type { BatchcraftApi } from "../../api/client";
import type { ResultResponse, RunCreatedResponse } from "../../api/types";
import { ResultCard } from "./ResultCard";

interface Props {
  api: BatchcraftApi;
  run: RunCreatedResponse | null;
  results: ResultResponse[];
  error: string | null;
  refreshing: boolean;
  onRefresh(): void;
}

export function ResultsPanel({ api, run, results, error, refreshing, onRefresh }: Props) {
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
        <h2 id="results-heading">Results</h2>
        {run ? (
          <div className="results-actions">
            <span className="section-note">{results.length} artifacts</span>
            <button className="button-secondary compact" type="button" disabled={refreshing} onClick={onRefresh}>
              {refreshing ? "Refreshing..." : "Refresh Results"}
            </button>
          </div>
        ) : null}
      </div>

      {!run ? <p>Results will appear here after a Run starts producing artifacts.</p> : null}
      {run && results.length === 0 ? <p>No Results have been ingested yet.</p> : null}
      {error ? <p className="operation-error" role="alert">Results: {error}</p> : null}

      <div className="results-grid">
        {results.map((result) => (
          <ResultCard
            api={api}
            result={result}
            key={`${result.job_ordinal}-${result.artifact_ordinal}`}
          />
        ))}
      </div>
    </section>
  );
}
