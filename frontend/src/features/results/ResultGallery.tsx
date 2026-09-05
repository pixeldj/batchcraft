import { useMemo, useState } from "react";

import type { BatchcraftApi } from "../../api/client";
import type { ExecutionResponse, ResultResponse, RunResponse } from "../../api/types";
import { ResultDetailsDialog } from "./ResultDetailsDialog";
import { ResultLightbox, type LightboxItem } from "./ResultLightbox";

interface Props {
  api: BatchcraftApi;
  runId: string | null;
  execution?: ExecutionResponse | null;
  results: ResultResponse[];
  runLabel?: string;
  getCachedRun(runId: string): RunResponse | null;
  loadRun(runId: string): Promise<RunResponse>;
}

/**
 * Shared image-first Result gallery used by the current-Run Results
 * panel and Project History. Deterministic ordering is
 * Job ordinal, then artifact ordinal. Result Details joins each card back to
 * its owning frozen Run by Run ID and Job ordinal.
 */
export function ResultGallery({
  api,
  runId,
  execution = null,
  results,
  runLabel,
  getCachedRun,
  loadRun,
}: Props) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [failedKeys, setFailedKeys] = useState<Set<string>>(new Set());
  const [restoreTarget, setRestoreTarget] = useState<HTMLElement | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<{
    result: ResultResponse;
    restoreTarget: HTMLElement | null;
  } | null>(null);

  const ordered = useMemo(
    () =>
      [...results].sort(
        (left, right) =>
          left.job_ordinal - right.job_ordinal || left.artifact_ordinal - right.artifact_ordinal,
      ),
    [results],
  );

  const imageItems = useMemo<LightboxItem[]>(() => {
    return ordered.flatMap((result) => {
      const key = itemKey(result);
      if (!isImage(result) || result.integrity_status !== "verified" || failedKeys.has(key)) {
        return [];
      }
      const multi =
        ordered.filter((other) => other.job_ordinal === result.job_ordinal).length > 1;
      return [
        {
          key,
          url: api.resultUrl(result.download_url),
          alt: altText(result, runLabel),
          label: itemLabel(result, multi),
          result,
        },
      ];
    });
  }, [ordered, failedKeys, api, runLabel]);

  function open(item: LightboxItem) {
    const index = imageItems.indexOf(item);
    if (index === -1) {
      return;
    }
    setRestoreTarget(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setOpenIndex(index);
  }

  function close() {
    setOpenIndex(null);
  }

  function openDetails(result: ResultResponse, target: HTMLElement) {
    setDetailsTarget({ result, restoreTarget: target });
  }

  return (
    <>
      <div className="results-grid">
        {ordered.map((result) => {
          const key = itemKey(result);
          const itemIndex = imageItems.findIndex((item) => item.key === key);
          const failed = failedKeys.has(key);
          return (
            <article className="result-card" key={key}>
              {result.integrity_status !== "verified" ? (
                <div className="artifact-placeholder result-integrity-unavailable">
                  <span>{result.integrity_status.toUpperCase()}</span>
                  <strong>Artifact unavailable</strong>
                </div>
              ) : isImage(result) ? (
                <button
                  className="result-image-button"
                  type="button"
                  disabled={failed}
                  onClick={() => {
                    const item = imageItems[itemIndex];
                    if (item) {
                      open(item);
                    }
                  }}
                >
                  {failed ? (
                    <span className="result-image-failed">Image unavailable</span>
                  ) : (
                    // Deliberate guard: the image MUST render at its natural
                    // aspect ratio. Never wrap it in an aspect-ratio frame or
                    // apply object-fit; regression tests assert this structure.
                    <img
                      className="result-image"
                      src={api.resultUrl(result.download_url)}
                      alt={altText(result, runLabel)}
                      onError={() => {
                        setFailedKeys((previous) => new Set(previous).add(key));
                      }}
                    />
                  )}
                </button>
              ) : (
                <a
                  className="artifact-placeholder"
                  href={api.resultUrl(result.download_url)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span>{contentLabel(result.content_type)}</span>
                  <strong>Open artifact</strong>
                </a>
              )}
              {runId ? (
                <button
                  className="result-info-button"
                  type="button"
                  aria-label={`Details for Job ${result.job_ordinal}, artifact ${result.artifact_ordinal}`}
                  title="Result details"
                  onClick={(event) => openDetails(result, event.currentTarget)}
                >
                  <span aria-hidden="true">ⓘ</span>
                </button>
              ) : null}
            </article>
          );
        })}
      </div>
      {openIndex !== null && imageItems[openIndex] ? (
        <ResultLightbox
          items={imageItems}
          index={openIndex}
          restoreTarget={restoreTarget}
          onClose={close}
          onDetails={(result, target) => openDetails(result, target)}
          onNavigate={(delta) => {
            setOpenIndex((current) => {
              if (current === null) {
                return current;
              }
              const next = current + delta;
              return next >= 0 && next < imageItems.length ? next : current;
            });
          }}
        />
      ) : null}
      {runId && detailsTarget ? (
        <ResultDetailsDialog
          key={`${runId}-${itemKey(detailsTarget.result)}`}
          runId={runId}
          result={detailsTarget.result}
          execution={execution}
          restoreTarget={detailsTarget.restoreTarget}
          getCachedRun={getCachedRun}
          loadRun={loadRun}
          onClose={() => setDetailsTarget(null)}
        />
      ) : null}
    </>
  );
}

function isImage(result: ResultResponse): boolean {
  return result.content_type?.startsWith("image/") === true;
}

function itemKey(result: ResultResponse): string {
  return `${result.job_ordinal}-${result.artifact_ordinal}`;
}

function altText(result: ResultResponse, runLabel?: string): string {
  const prefix = runLabel ? `${runLabel} / ` : "";
  return `Result ${result.artifact_ordinal} from Job ${result.job_ordinal}: ${prefix}${result.remote_filename}`;
}

function itemLabel(result: ResultResponse, multiArtifactJob: boolean): string {
  const base = `Job ${String(result.job_ordinal).padStart(3, "0")}`;
  return multiArtifactJob ? `${base} #${result.artifact_ordinal}` : base;
}

function contentLabel(contentType: string | null): string {
  return contentType?.split("/")[1]?.toUpperCase() ?? "FILE";
}
