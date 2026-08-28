import type { BatchcraftApi } from "../../api/client";
import type { ResultResponse } from "../../api/types";

interface Props {
  api: BatchcraftApi;
  result: ResultResponse;
  runLabel?: string;
}

export function ResultCard({ api, result, runLabel }: Props) {
  const url = api.resultUrl(result.download_url);
  const isImage = result.content_type?.startsWith("image/") === true;

  return (
    <article className="result-card">
      {isImage ? (
        <a className="result-image-link" href={url} target="_blank" rel="noreferrer">
          <img
            className="result-image"
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
          {runLabel ? `${runLabel} / ` : null}Job {result.job_ordinal} / Artifact {result.artifact_ordinal}
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
}

function contentLabel(contentType: string | null): string {
  return contentType?.split("/")[1]?.toUpperCase() ?? "FILE";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
