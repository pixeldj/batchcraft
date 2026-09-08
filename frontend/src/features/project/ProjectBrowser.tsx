import { useEffect, useRef, useState, type ReactNode } from "react";

import type { BatchcraftApi } from "../../api/client";
import type {
  HistoryQuery,
  HistoryResultItemResponse,
  HistoryRunSummaryResponse,
  ResultResponse,
  RunResponse,
  RunStatus,
} from "../../api/types";
import { errorMessage } from "../../utils/errors";
import { useModalDialog } from "../../components/useModalDialog";
import { ResultDetailsDialog, type ResultDetailsFilter } from "../results/ResultDetailsDialog";
import { RunPlanDialog } from "../run/RunPlanDialog";
import { HistoryFilters } from "./HistoryFilters";
import { mergeResultDetailsFilter } from "./mergeResultDetailsFilter";
import { HistoryDiagnostics } from "./HistoryDiagnostics";
import {
  historyResultIdentity as identity,
  useProjectBrowserHistory,
} from "./useProjectBrowserHistory";

export interface ProjectBrowserProps {
  api: BatchcraftApi;
  projectId: string | null;
  projectName: string;
  active: boolean;
  view: "gallery" | "runs";
  query: HistoryQuery;
  onQueryChange(query: HistoryQuery): void;
  onViewChange(view: "gallery" | "runs", query?: HistoryQuery): void;
  onOpenBatch(): void;
  historyRevision: number;
  getCachedRun(runId: string): RunResponse | null;
  loadRun(runId: string): Promise<RunResponse>;
  loadRunAsBatch(runId: string, signal: AbortSignal): Promise<void>;
  loadRunAsBatchDisabled: boolean;
  hasUnsavedChanges: boolean;
}

export function ProjectBrowser(props: ProjectBrowserProps) {
  if (!props.projectId)
    return (
      <section
        className="project-browser"
        hidden={!props.active}
        aria-label="Project browser"
      >
        <div className="pb-empty">
          <p className="pb-kicker">Your experiment archive</p>
          <h2>A Project gives your work a home.</h2>
          <p>
            Select or create a Project in Batch to start browsing its Runs and
            Results.
          </p>
          <button className="button-secondary" onClick={props.onOpenBatch}>
            Open Batch
          </button>
        </div>
      </section>
    );
  return (
    <Browser key={props.projectId} {...props} projectId={props.projectId} />
  );
}

function Browser({
  api,
  projectId,
  projectName,
  active,
  view,
  query,
  onQueryChange,
  onViewChange,
  onOpenBatch,
  historyRevision,
  getCachedRun,
  loadRun,
  loadRunAsBatch,
  loadRunAsBatchDisabled,
  hasUnsavedChanges,
}: ProjectBrowserProps & { projectId: string }) {
  const history = useProjectBrowserHistory(
    api,
    projectId,
    active,
    view,
    query,
    historyRevision,
  );
  const [density, setDensity] = useState("comfortable");
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());
  const [imagePage, setImagePage] = useState(history.page?.response.items);
  if (imagePage !== history.page?.response.items) {
    setImagePage(history.page?.response.items);
    setFailedImages(new Set());
  }
  const [inspection, setInspection] = useState<
    | { kind: "diagnostics" }
    | { kind: "loading"; label: string }
    | { kind: "error"; message: string }
    | { kind: "plan"; run: RunResponse }
    | { kind: "details"; run: RunResponse; result: ResultResponse }
    | { kind: "confirm"; run: HistoryRunSummaryResponse }
    | null
  >(null);
  const [viewedImage, setViewedImage] = useState<{
    identity: string;
    restoreTarget: HTMLElement;
  } | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<HTMLElement | null>(null);
  const request = useRef(0);
  const batchController = useRef<AbortController | null>(null);
  const inspectionScope = JSON.stringify([
    active,
    projectId,
    view,
    query.q ?? "",
    query.sort ?? "newest",
    query.run_id ?? null,
    query.batch_id ?? null,
    query.execution_status ?? null,
    query.execution_available ?? null,
    query.filters ?? null,
  ]);
  useEffect(() => {
    const sequence = request;
    const restore = batchController;
    return () => {
      sequence.current++;
      restore.current?.abort();
    };
  }, [inspectionScope]);
  // Scope the inspection to the visible destination, including external Back/Forward changes.
  const [scope, setScope] = useState(inspectionScope);
  if (scope !== inspectionScope) {
    setScope(inspectionScope);
    setInspection(null);
    setViewedImage(null);
    setBatchLoading(false);
  }

  const results =
    history.page?.view === "gallery" ? history.page.response.items : [];
  const runs = history.page?.view === "runs" ? history.page.response.items : [];
  const filteredRun = [...results, ...runs].find((item) => item.run.run_id === query.run_id)?.run;
  const images = results.filter(
    (item) =>
      imageAvailable(item) &&
      !history.unavailableRuns.has(item.run.run_id) &&
      !history.awaitingResults.has(identity(item)) &&
      !failedImages.has(identity(item)),
  );
  const selectedIndex = viewedImage
    ? images.findIndex((item) => identity(item) === viewedImage.identity)
    : -1;
  const selected = images[selectedIndex];
  const basicFiltered = !!(
    query.q ||
    query.run_id ||
    query.batch_id ||
    query.execution_status ||
    query.execution_available != null
  );
  const filtered = basicFiltered || Object.keys(query.filters ?? {}).length > 0;
  const count = history.page?.response.items.length ?? 0;
  const busy = !!inspection || !!viewedImage;

  function changeQuery(patch: HistoryQuery) {
    onQueryChange({ ...query, ...patch, cursor: null });
  }
  function capture(target: HTMLElement) {
    setRestoreTarget(target);
  }
  function close() {
    request.current++;
    batchController.current?.abort();
    batchController.current = null;
    setBatchLoading(false);
    setInspection(null);
  }
  async function validatedRun(runId: string) {
    const run = getCachedRun(runId) ?? (await loadRun(runId));
    if (run.project_id !== projectId || run.run_id !== runId)
      throw new Error("The frozen Run did not match this Project and Run.");
    return run;
  }
  async function inspect(runId: string, item?: HistoryResultItemResponse) {
    const tag = ++request.current;
    setInspection({
      kind: "loading",
      label: item ? "Loading Result details..." : "Loading frozen Run Plan...",
    });
    try {
      const run = await validatedRun(runId);
      if (tag !== request.current) return;
      if (!item) {
        setInspection({ kind: "plan", run });
        return;
      }
      // Run Plans expose ordinals, not Job IDs. Join actual artifacts by the
      // validated owning Run, frozen Job ordinal, artifact ordinal, and hash.
      const response = await api.getResults(runId);
      if (tag !== request.current) return;
      if (response.run_id !== runId)
        throw new Error("Result metadata did not match the selected Run.");
      const result = response.results.find(
        (candidate) =>
          candidate.job_ordinal === item.job_ordinal &&
          candidate.artifact_ordinal === item.artifact_ordinal,
      );
      if (
        !result ||
        result.sha256 !== item.sha256 ||
        !run.plan.jobs.some((job) => job.ordinal === item.job_ordinal)
      ) {
        throw new Error(
          "This Result could not be matched to its frozen Job. Refresh history and try again.",
        );
      }
      setInspection({ kind: "details", run, result });
    } catch (caught) {
      if (tag === request.current)
        setInspection({ kind: "error", message: errorMessage(caught) });
    }
  }
  async function restoreBatch(run: HistoryRunSummaryResponse) {
    if (loadRunAsBatchDisabled || batchLoading) return;
    const tag = ++request.current;
    const controller = new AbortController();
    batchController.current?.abort();
    batchController.current = controller;
    setBatchLoading(true);
    setInspection({ kind: "loading", label: "Loading Run as Batch..." });
    try {
      await validatedRun(run.run_id);
      if (tag !== request.current || controller.signal.aborted) return;
      await loadRunAsBatch(run.run_id, controller.signal);
      if (tag === request.current && !controller.signal.aborted)
        setInspection(null);
    } catch (caught) {
      if (tag === request.current && !controller.signal.aborted)
        setInspection({ kind: "error", message: errorMessage(caught) });
    } finally {
      if (batchController.current === controller) {
        batchController.current = null;
        if (tag === request.current) setBatchLoading(false);
      }
    }
  }
  function showResults(run: HistoryRunSummaryResponse) {
    onViewChange("gallery", { ...query, run_id: run.run_id, cursor: null });
  }
  function filterGallery(filter: ResultDetailsFilter) {
    const nextQuery = mergeResultDetailsFilter(query, filter);
    close();
    setViewedImage(null);
    onViewChange("gallery", nextQuery);
  }

  return (
    <section
      className="project-browser"
      hidden={!active}
      aria-label="Project browser"
    >
      <header className="pb-heading">
        <div>
          <p className="pb-kicker">{projectName} / Archive</p>
          <h2>
            {view === "gallery" ? "Gallery" : "Runs"}
            <span className="pb-heading-note">
              {view === "gallery"
                ? "The work, in view."
                : "Experiments, recorded."}
            </span>
          </h2>
        </div>
        <div className="pb-actions">
          <button
            className="button-secondary"
            disabled={history.loading || busy}
            onClick={() => {
              setFailedImages(new Set());
              history.refresh();
            }}
          >
            Refresh
          </button>
          <button
            className="button-link"
            disabled={history.scanning || busy}
            onClick={history.repair}
          >
            Reindex Project
          </button>
          <button
            className="button-link"
            disabled={busy}
            onClick={(event) => {
              capture(event.currentTarget);
              setInspection({ kind: "diagnostics" });
            }}
          >
            Diagnostics
          </button>
        </div>
      </header>

      <div className="pb-toolbar">
        <Search
          key={query.q ?? ""}
          value={query.q ?? ""}
          disabled={busy}
          onSubmit={(q) => changeQuery({ q })}
        />
        <label>
          Order
          <select
            value={query.sort ?? "newest"}
            disabled={busy}
            onChange={(event) =>
              changeQuery({ sort: event.target.value as "newest" | "oldest" })
            }
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
        <details className="pb-filters">
          <summary>Status{query.execution_status || query.execution_available != null ? " (active)" : ""}</summary>
          <div>
            <label>
              Execution status
              <select
                disabled={busy}
                value={query.execution_status ?? ""}
                onChange={(event) =>
                  changeQuery({
                    execution_status: (event.target.value ||
                      null) as RunStatus | null,
                  })
                }
              >
                <option value="">All statuses</option>
                {[
                  "created",
                  "running",
                  "succeeded",
                  "failed",
                  "blocked",
                  "cancelled",
                ].map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Execution availability
              <select
                disabled={busy}
                value={
                  query.execution_available == null
                    ? ""
                    : String(query.execution_available)
                }
                onChange={(event) =>
                  changeQuery({
                    execution_available:
                      event.target.value === ""
                        ? null
                        : event.target.value === "true",
                  })
                }
              >
                <option value="">All records</option>
                <option value="true">Available</option>
                <option value="false">Unavailable</option>
              </select>
            </label>
          </div>
        </details>
        {view === "gallery" ? (
          <label className="pb-density">
            Image size
            <select
              value={density}
              disabled={busy}
              onChange={(event) => setDensity(event.target.value)}
            >
              <option value="compact">Compact</option>
              <option value="comfortable">Comfortable</option>
              <option value="spacious">Spacious</option>
            </select>
          </label>
        ) : null}
      </div>
      <div className="pb-provenance-filters">
        <HistoryFilters api={api} projectId={projectId} value={query} disabled={busy} onChange={onQueryChange} />
      </div>
      {basicFiltered ? (
        <div className="pb-chips" aria-label="Active filters">
          {query.q ? (
            <button disabled={busy} onClick={() => changeQuery({ q: "" })}>
              Search: {query.q} <span aria-hidden="true">x</span>
              <span className="visually-hidden">Clear search</span>
            </button>
          ) : null}
          {query.run_id ? (
            <button
              disabled={busy}
              onClick={() => changeQuery({ run_id: null })}
              title={query.run_id}
            >
              Run:{" "}
              {filteredRun ? runName(filteredRun) : "Selected Run"}{" "}
              <span aria-hidden="true">x</span>
              <span className="visually-hidden">Clear Run filter</span>
            </button>
          ) : null}
          {query.batch_id ? (
            <button
              disabled={busy}
              onClick={() => changeQuery({ batch_id: null })}
            >
              Batch:{" "}
              {results.find((item) => item.run.batch_id === query.batch_id)?.run
                .batch_name ??
                runs.find((item) => item.run.batch_id === query.batch_id)?.run
                  .batch_name ??
                "Selected Batch"}{" "}
              <span aria-hidden="true">x</span>
              <span className="visually-hidden">Clear Batch filter</span>
            </button>
          ) : null}
          {query.execution_status ? (
            <button
              disabled={busy}
              onClick={() => changeQuery({ execution_status: null })}
            >
              {query.execution_status} <span aria-hidden="true">x</span>
              <span className="visually-hidden">Clear status</span>
            </button>
          ) : null}
          {query.execution_available != null ? (
            <button
              disabled={busy}
              onClick={() => changeQuery({ execution_available: null })}
            >
              Execution{" "}
              {query.execution_available ? "available" : "unavailable"}{" "}
              <span aria-hidden="true">x</span>
              <span className="visually-hidden">Clear availability</span>
            </button>
          ) : null}
          <button
            className="button-link"
            disabled={busy}
            onClick={() => onQueryChange({ sort: query.sort })}
          >
            Clear filters
          </button>
        </div>
      ) : null}

      <div className="pb-page-meta">
        <span>
          {count} {view === "gallery" ? "Results" : "Runs"} on this page
        </span>
        <span role="status">
          {history.scanning
            ? "Checking Project history..."
            : history.loading
              ? "Loading history..."
              : history.updated
                ? "History updated. Refresh when you are ready."
                : history.page?.response.scanned_at
                  ? `Indexed ${formatDate(history.page.response.scanned_at)}`
                  : "Index scan not yet confirmed"}
        </span>
      </div>
      {history.error ? (
        <p className="pb-warning" role="alert">
          History may be stale. Known content is retained. {history.error} Use
          Refresh to retry.
        </p>
      ) : null}
      {history.scanError ? (
        <p className="pb-warning" role="alert">
          Project history may be stale. Known content is retained. Check storage
          and use Reindex Project to retry. {history.scanError}
        </p>
      ) : null}
      {history.diagnostics > 0 ? (
        <p className="pb-warning" role="status">
          {history.diagnostics}{" "}
          {history.diagnostics === 1 ? "record needs" : "records need"}{" "}
          attention. Some history or artifacts may be unavailable.
        </p>
      ) : null}

      {!history.page && history.loading ? (
        <div className="pb-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : null}
      {history.page &&
      count === 0 &&
      !history.loading &&
      !history.error &&
      !history.scanError ? (
        <div className="pb-empty">
          {history.page.response.generation === null && !history.confirmed ? (
            <>
              <h3>Checking the archive</h3>
              <p>
                The index has not been reconciled yet. This is not a confirmed
                empty Project.
              </p>
            </>
          ) : filtered ? (
            <>
              <h3>No matches in this view.</h3>
              <p>Try a different search or clear your filters.</p>
              <button
                className="button-secondary"
                onClick={() => onQueryChange({ sort: query.sort })}
              >
                Clear filters
              </button>
            </>
          ) : view === "gallery" ? (
            <>
              <h3>No Results to show yet.</h3>
              <p>Runs without Results are still part of your history.</p>
              <button
                className="button-secondary"
                onClick={() => onViewChange("runs")}
              >
                Browse Runs
              </button>
            </>
          ) : (
            <>
              <h3>Your first experiment starts in Batch.</h3>
              <p>No Runs have been indexed for this Project.</p>
              <button className="button-secondary" onClick={onOpenBatch}>
                Open Batch
              </button>
            </>
          )}
        </div>
      ) : null}

      {view === "gallery" ? (
        <div className={`pb-gallery pb-density-${density}`}>
          {results.map((item) => {
            const key = identity(item);
            const awaitingRefresh = history.awaitingResults.has(key);
            const unavailable =
              !item.run.execution_available ||
              history.unavailableRuns.has(item.run.run_id);
            const downloadable =
              !unavailable &&
              !awaitingRefresh &&
              item.integrity_status === "verified" &&
              !!item.download_url;
            const image =
              imageAvailable(item) &&
              !unavailable &&
              !awaitingRefresh &&
              !failedImages.has(key);
            return (
              <article
                className="pb-result"
                key={key}
                data-result-identity={key}
                data-run-id={item.run.run_id}
                data-job-id={item.job_id}
                data-artifact-ordinal={item.artifact_ordinal}
              >
                {image ? (
                  <button
                    className="pb-image-button"
                    aria-label={`View ${resultLabel(item)}`}
                    onClick={(event) => {
                      setViewedImage({
                        identity: key,
                        restoreTarget: event.currentTarget,
                      });
                    }}
                  >
                    <img
                      src={api.resultUrl(item.download_url!)}
                      alt={resultLabel(item)}
                      loading="lazy"
                      decoding="async"
                      onError={() =>
                        setFailedImages((old) => new Set(old).add(key))
                      }
                    />
                  </button>
                ) : (
                  <div className="pb-artifact">
                    <span>{item.content_type ?? "Artifact"}</span>
                    <strong>
                      {unavailable
                        ? "Execution unavailable"
                        : awaitingRefresh
                          ? "Awaiting history refresh"
                          : !downloadable
                            ? "Artifact unavailable"
                            : failedImages.has(key)
                              ? "Image unavailable"
                              : "File Result"}
                    </strong>
                    {downloadable ? (
                      <a
                        href={api.resultUrl(item.download_url!)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open original
                      </a>
                    ) : (
                      <span>Last known metadata retained</span>
                    )}
                  </div>
                )}
                <div className="pb-result-caption">
                  <div>
                    <strong>{runName(item.run)}</strong>
                    <span>{item.run.batch_name}</span>
                  </div>
                  <button
                    className="button-link"
                    aria-label={`Details for ${resultLabel(item)}`}
                    onClick={(event) => {
                      capture(event.currentTarget);
                      void inspect(item.run.run_id, item);
                    }}
                  >
                    Details
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="pb-runs">
          {runs.map(({ run, result_count }) => (
            <article
              className="pb-run"
              key={run.run_id}
              aria-label={runName(run)}
            >
              <div className="pb-run-number" aria-hidden="true">
                {String(run.run_number).padStart(3, "0")}
              </div>
              <div className="pb-run-title">
                <h3>{runName(run)}</h3>
                <span className="visually-hidden">Run {run.run_number}</span>
                <button
                  className="button-link"
                  title={`Filter to Batch ${run.batch_name}`}
                  onClick={() => changeQuery({ batch_id: run.batch_id })}
                >
                  {run.batch_name}
                </button>
                <time>{formatDate(run.created_at)}</time>
                {run.run_description_excerpt ? (
                  <p>
                    {run.run_description_excerpt}
                    {run.display_truncated ? "..." : ""}
                  </p>
                ) : null}
              </div>
              <div className="pb-run-facts">
                <span
                  className={`status-pill ${run.execution_status ?? "unavailable"}`}
                >
                  {!run.execution_available ||
                  history.unavailableRuns.has(run.run_id)
                    ? "Execution unavailable"
                    : (run.execution_status ?? "Status unavailable")}
                </span>
                <span>{run.job_count} Jobs</span>
                <span>
                  {!run.execution_available ||
                  history.unavailableRuns.has(run.run_id)
                    ? "Result count unavailable"
                    : `${result_count} Results`}
                </span>
                {run.integrity_status !== "verified" ? (
                  <span className="pb-integrity">Degraded history</span>
                ) : null}
              </div>
              <div className="pb-run-actions">
                <button
                  className="button-secondary"
                  onClick={() => showResults(run)}
                >
                  Show Results
                </button>
                <button
                  className="button-link"
                  onClick={(event) => {
                    capture(event.currentTarget);
                    void inspect(run.run_id);
                  }}
                >
                  View Run Plan
                </button>
                <button
                  className="button-link"
                  disabled={
                    !run.replayable || loadRunAsBatchDisabled || batchLoading
                  }
                  onClick={(event) => {
                    capture(event.currentTarget);
                    if (hasUnsavedChanges)
                      setInspection({ kind: "confirm", run });
                    else void restoreBatch(run);
                  }}
                >
                  Load Run as Batch
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {history.page ? (
        <nav className="pb-pagination" aria-label="History pages">
          <button
            className="button-secondary"
            disabled={
              history.loading || busy || history.updated || !history.canPrevious
            }
            onClick={() => history.navigate(-1)}
          >
            Previous page
          </button>
          <span>Page {history.pageNumber}</span>
          <button
            className="button-secondary"
            disabled={
              history.loading ||
              busy ||
              history.updated ||
              !history.page.response.has_more
            }
            onClick={() => history.navigate(1)}
          >
            Next page
          </button>
          {history.pageNumber > 1 ? (
            <button
              className="button-link"
              disabled={busy || history.loading}
              onClick={history.refresh}
            >
              First page
            </button>
          ) : null}
        </nav>
      ) : null}

      {active && inspection?.kind === "diagnostics" ? (
        <HistoryDiagnostics
          api={api}
          projectId={projectId}
          onClose={close}
          onReindex={history.scanning ? undefined : history.repair}
        />
      ) : null}
      {active && viewedImage ? (
        <BrowserModal
          label="Project Result image"
          toolbar={
            <>
              <div className="pb-viewer-navigation">
                <button className="button-secondary" disabled={!!inspection || !selected || selectedIndex <= 0}
                  onClick={() => setViewedImage({ ...viewedImage, identity: identity(images[selectedIndex - 1]) })}>Previous</button>
                <span aria-label={`${selectedIndex + 1} of ${images.length} loaded images`}>{selectedIndex + 1}/{images.length}</span>
                <button className="button-secondary" disabled={!!inspection || !selected || selectedIndex === images.length - 1}
                  onClick={() => setViewedImage({ ...viewedImage, identity: identity(images[selectedIndex + 1]) })}>Next</button>
              </div>
              <button className="button-secondary" disabled={!!inspection || !selected}
                onClick={(event) => {
                  if (!selected) return;
                  capture(event.currentTarget);
                  void inspect(selected.run.run_id, selected);
                }}>Image Details</button>
            </>
          }
          restoreTarget={viewedImage.restoreTarget}
          onClose={() => {
            close();
            setViewedImage(null);
          }}
          onNavigate={(delta) => {
            if (inspection) return;
            const item = images[selectedIndex + delta];
            if (item)
              setViewedImage({ ...viewedImage, identity: identity(item) });
          }}
        >
          {selected ? (
            <>
              <a className="pb-viewer-link" href={api.resultUrl(selected.download_url!)} target="_blank" rel="noreferrer" aria-label="Open original image in a new tab">
              <img
                className="pb-viewer-image"
                src={api.resultUrl(selected.download_url!)}
                alt={resultLabel(selected)}
                decoding="async"
                onError={() =>
                  setFailedImages((old) => new Set(old).add(identity(selected)))
                }
              />
              </a>
              <p className="pb-viewer-caption">
                {resultLabel(selected)} / {selected.run.batch_name}
              </p>
            </>
          ) : (
            <p role="status">
              {history.awaitingResults.has(viewedImage.identity)
                ? "Awaiting history refresh. Close the viewer and Refresh history; last known metadata is retained."
                : "This image is no longer available. Close the viewer and Refresh history."}
            </p>
          )}
        </BrowserModal>
      ) : null}
      {active && inspection?.kind === "plan" ? (
        <RunPlanDialog
          run={inspection.run}
          restoreTarget={restoreTarget}
          onClose={close}
        />
      ) : null}
      {active && inspection?.kind === "details" ? (
        <ResultDetailsDialog
          runId={inspection.run.run_id}
          result={inspection.result}
          execution={inspection.run.execution}
          restoreTarget={restoreTarget}
          getCachedRun={() => inspection.run}
          loadRun={validatedRun}
          onClose={close}
          onFilter={filterGallery}
        />
      ) : null}
      {active &&
       inspection &&
       inspection.kind !== "diagnostics" &&
       inspection.kind !== "plan" &&
      inspection.kind !== "details" ? (
        <BrowserModal
          label={
            inspection.kind === "confirm"
              ? "Replace unsaved Batch?"
              : "History inspection"
          }
          restoreTarget={restoreTarget}
          onClose={close}
        >
          {inspection.kind === "loading" ? (
            <p role="status">{inspection.label}</p>
          ) : null}
          {inspection.kind === "error" ? (
            <div role="alert">
              <h3>Inspection unavailable</h3>
              <p>{inspection.message}</p>
              <p>
                Close this dialog and retry the selected record, or Refresh
                history.
              </p>
            </div>
          ) : null}
          {inspection.kind === "confirm" ? (
            <>
              <h3>Replace unsaved Batch?</h3>
              <p>
                Loading {runName(inspection.run)} will replace your unsaved
                Batch changes. The historical Run stays unchanged. A fresh
                Preview is required before creating a new Run.
              </p>
              <div className="pb-actions">
                <button className="button-secondary" onClick={close}>
                  Keep editing
                </button>
                <button
                  className="button-primary"
                  disabled={loadRunAsBatchDisabled || batchLoading}
                  onClick={() => void restoreBatch(inspection.run)}
                >
                  Replace Batch
                </button>
              </div>
            </>
          ) : null}
        </BrowserModal>
      ) : null}
    </section>
  );
}

function Search({
  value,
  disabled,
  onSubmit,
}: {
  value: string;
  disabled: boolean;
  onSubmit(value: string): void;
}) {
  const [text, setText] = useState(value);
  return (
    <form
      className="pb-search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(text.trim());
      }}
    >
      <label>
        Run names and notes
        <input
          type="search"
          maxLength={200}
          value={text}
          placeholder="Find an experiment..."
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <button className="button-secondary" type="submit" disabled={disabled}>
        Search
      </button>
    </form>
  );
}

function BrowserModal({
  label,
  restoreTarget,
  onClose,
  onNavigate,
  toolbar,
  children,
}: {
  label: string;
  restoreTarget: HTMLElement | null;
  onClose(): void;
  onNavigate?(delta: number): void;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const modal = useModalDialog(ref, onClose, restoreTarget, closeRef);
  return (
    <dialog
      ref={ref}
      className={`pb-modal${toolbar ? " pb-image-modal" : ""}`}
      aria-label={label}
      {...modal}
      onKeyDown={(event) => {
        modal.onKeyDown(event);
        if (event.defaultPrevented) return;
        if (
          onNavigate &&
          (event.key === "ArrowLeft" || event.key === "ArrowRight")
        ) {
          event.preventDefault();
          onNavigate(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <div className="pb-modal-heading">
        {toolbar ?? <span className="pb-kicker">{label}</span>}
        <button className="button-secondary" onClick={onClose} ref={closeRef}>
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}

function runName(run: HistoryRunSummaryResponse) {
  return run.run_name ?? `Run ${run.run_number}`;
}
function resultLabel(item: HistoryResultItemResponse) {
  return `${runName(item.run)}, Run ${item.run.run_number}, Job ${item.job_ordinal}, artifact ${item.artifact_ordinal}: ${item.filename_excerpt}`;
}
function imageAvailable(item: HistoryResultItemResponse) {
  return (
    item.run.execution_available &&
    item.integrity_status === "verified" &&
    !!item.download_url &&
    item.content_type?.startsWith("image/") === true
  );
}
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
