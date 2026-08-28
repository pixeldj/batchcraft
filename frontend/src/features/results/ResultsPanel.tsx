import type { BatchcraftApi } from "../../api/client";
import type { ResultResponse, RunCreatedResponse } from "../../api/types";

interface Props {
  api: BatchcraftApi;
  run: RunCreatedResponse | null;
  results: ResultResponse[];
  error: string | null;
  refreshing: boolean;
  onRefresh(): void;
}

export function ResultsPanel({ api, run, results, error, refreshing, onRefresh }: Props) {
  return (
    <section className="section-card results-section" aria-labelledby="results-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">04 / Review</p>
          <h2 id="results-heading">Results</h2>
        </div>
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
        {results.map((result) => {
          const url = api.resultUrl(result.download_url);
          const isImage = result.content_type?.startsWith("image/") === true;
          return (
            <article className="result-card" key={`${result.job_ordinal}-${result.artifact_ordinal}`}>
              {isImage ? (
                <a href={url} target="_blank" rel="noreferrer">
                  <img
                    src={url}
                    alt={`Result ${result.artifact_ordinal} from Job ${result.job_ordinal}: ${result.remote_filename}`}
                  />
                </a>
              ) : (
                <a className="artifact-placeholder" href={url} target="_blank" rel="noreferrer">
                  <span>{contentLabel(result.content_type)}</span>
                  <strong>Open artifact</strong>
                </a>
              )}
              <div className="result-body">
                <div className="result-ordinal">
                  Job {result.job_ordinal} / Artifact {result.artifact_ordinal}
                </div>
                <strong className="result-filename">{result.remote_filename}</strong>
                <dl>
                  <div><dt>Node</dt><dd>{result.producing_node_id}</dd></div>
                  <div><dt>Output</dt><dd>{result.output_name}</dd></div>
                  <div><dt>Type</dt><dd>{result.content_type ?? "Unknown"}</dd></div>
                  <div><dt>Size</dt><dd>{formatBytes(result.byte_size)}</dd></div>
                </dl>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function contentLabel(contentType: string | null): string {
  return contentType?.split("/")[1]?.toUpperCase() ?? "FILE";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
