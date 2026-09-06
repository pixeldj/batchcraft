import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { BatchcraftApi } from "../../api/client";
import type {
  HistoricalRunResponse,
  ProjectRunsResponse,
  ResultResponse,
  RunResponse,
} from "../../api/types";
import { errorMessage } from "../../utils/errors";
import { ResultGallery } from "../results/ResultGallery";
import { RunPlanDialog } from "../run/RunPlanDialog";

interface Props {
  api: BatchcraftApi;
  projectId: string | null;
  historyRevision?: number;
  getCachedRun(runId: string): RunResponse | null;
  loadRun(runId: string): Promise<RunResponse>;
  loadRunAsBatch(runId: string): Promise<void>;
  loadRunAsBatchDisabled?: boolean;
}

interface ResultState {
  loading: boolean;
  results: ResultResponse[];
  error: string | null;
  verificationUnavailable?: boolean;
}

interface DetailState {
  loading: boolean;
  run: RunResponse | null;
  error: string | null;
}

export function ProjectHistory({
  api,
  projectId,
  historyRevision,
  getCachedRun,
  loadRun,
  loadRunAsBatch,
  loadRunAsBatchDisabled,
}: Props) {
  if (!projectId) {
    return (
      <section className="section-card quiet-card inactive-card" aria-labelledby="project-history-heading">
        <div className="section-heading"><h2 id="project-history-heading">Project History</h2></div>
        <p>Select a verified Project</p>
      </section>
    );
  }
  return (
    <VerifiedProjectHistory
      key={projectId}
      api={api}
      projectId={projectId}
      historyRevision={historyRevision}
      getCachedRun={getCachedRun}
      loadRun={loadRun}
      loadRunAsBatch={loadRunAsBatch}
      loadRunAsBatchDisabled={loadRunAsBatchDisabled}
    />
  );
}

function VerifiedProjectHistory({
  api,
  projectId,
  historyRevision = 0,
  getCachedRun,
  loadRun,
  loadRunAsBatch,
  loadRunAsBatchDisabled = false,
}: Omit<Props, "projectId"> & { projectId: string }) {
  const [history, setHistory] = useState<(ProjectRunsResponse & { generation: number }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [reindexing, setReindexing] = useState(true);
  const [reindexError, setReindexError] = useState<string | null>(null);
  const [loadingBatchRunId, setLoadingBatchRunId] = useState<string | null>(null);
  const [loadBatchError, setLoadBatchError] = useState<string | null>(null);
  const [resultsByRun, setResultsByRun] = useState<Record<string, ResultState>>({});
  const [detailsByRun, setDetailsByRun] = useState<Record<string, DetailState>>({});
  const [expandedByRun, setExpandedByRun] = useState<Record<string, boolean>>({});
  const [planTarget, setPlanTarget] = useState<{
    run: RunResponse;
    restoreTarget: HTMLElement | null;
  } | null>(null);
  const requestTag = useRef(0);
  const scanQueue = useRef<Promise<void>>(Promise.resolve());
  const initialRead = useRef<Promise<void>>(Promise.resolve());
  const resultQueue = useRef<Promise<void>>(Promise.resolve());
  const resultsController = useRef<AbortController | null>(null);
  const historyGeneration = useRef(0);

  const acceptHistory = useEffectEvent((response: ProjectRunsResponse) => {
    const generation = ++historyGeneration.current;
    setHistory({ ...response, generation });
    // Latch immediately: a later available index alone cannot reverify retained Results.
    setResultsByRun((current) => {
      const next = { ...current };
      for (const run of response.runs) {
        if (!run.execution_available) {
          next[run.run_id] = {
            loading: false,
            results: current[run.run_id]?.results ?? [],
            error: current[run.run_id]?.error ?? null,
            verificationUnavailable: true,
          };
        }
      }
      return next;
    });
  });

  useEffect(() => {
    const tag = ++requestTag.current;
    const controller = new AbortController();
    resultsController.current = controller;
    initialRead.current = api.listProjectRuns(projectId, controller.signal).then(
      (response) => {
        if (controller.signal.aborted || tag !== requestTag.current) return;
        if (response.project_id !== projectId) {
          setError("The history response did not match the selected Project.");
          setLoading(false);
          return;
        }
        setError(null);
        acceptHistory(response);
        setLoading(false);
      },
      (caught: unknown) => {
        if (controller.signal.aborted || tag !== requestTag.current || isAbort(caught)) return;
        setError(errorMessage(caught));
        setLoading(false);
      },
    );

    return () => {
      controller.abort();
      requestTag.current = tag + 1;
    };
  }, [api, projectId]);

  useEffect(() => {
    if (!history) return;
    const response = history;
    const controller = resultsController.current!;
    // Finish the pending two workers before rechecking Results from a newer index.
    resultQueue.current = resultQueue.current.then(async () => {
      if (controller.signal.aborted || response.generation !== historyGeneration.current) return;
      let nextRun = 0;
      async function loadResults() {
        while (!controller.signal.aborted && response.generation === historyGeneration.current && nextRun < response.runs.length) {
          const run = response.runs[nextRun++];
          try {
            const resultResponse = await api.getResults(run.run_id, controller.signal);
            if (controller.signal.aborted || response.generation !== historyGeneration.current) return;
            if (resultResponse.run_id !== run.run_id) throw new Error("The Result response did not match the Run.");
            setResultsByRun((current) => ({
              ...current,
              [run.run_id]: {
                loading: false,
                // Missing execution can synthesize an empty listing, not proof of no Results.
                results: !run.execution_available && resultResponse.results.length === 0
                  ? current[run.run_id]?.results ?? []
                  : resultResponse.results,
                error: null,
                verificationUnavailable: !run.execution_available,
              },
            }));
          } catch (caught) {
            if (controller.signal.aborted || response.generation !== historyGeneration.current || isAbort(caught)) return;
            setResultsByRun((current) => ({
              ...current,
              [run.run_id]: {
                loading: false,
                results: current[run.run_id]?.results ?? [],
                error: errorMessage(caught),
                verificationUnavailable: !run.execution_available || current[run.run_id]?.verificationUnavailable,
              },
            }));
          }
        }
      }
      await Promise.all([loadResults(), loadResults()]);
    });
  }, [api, history]);

  useEffect(() => {
    const controller = new AbortController();
    // Do not abort a dispatched POST: the backend may still be scanning. Join it
    // before starting a newer lifecycle refresh; StrictMode's discarded setup never sends.
    scanQueue.current = scanQueue.current.then(async () => {
      await initialRead.current;
      if (controller.signal.aborted) return;
      setReindexing(true);
      setReindexError(null);
      try {
        const response = await api.reindexProject(projectId);
        if (controller.signal.aborted) return;
        if (response.project_id !== projectId) {
          throw new Error("The reindex response did not match the selected Project.");
        }
        const refreshed = await api.listProjectRuns(projectId, controller.signal);
        if (controller.signal.aborted) return;
        if (refreshed.project_id !== projectId) throw new Error("The history response did not match the selected Project.");
        acceptHistory(refreshed);
        setError(null);
      } catch (caught) {
        if (!controller.signal.aborted && !isAbort(caught)) {
          setReindexError(errorMessage(caught));
        }
      } finally {
        if (!controller.signal.aborted) setReindexing(false);
      }
    });
    return () => controller.abort();
  }, [api, projectId, historyRevision, refresh]);

  function toggleRun(run: HistoricalRunResponse) {
    const expanded = expandedByRun[run.run_id] ?? false;
    setExpandedByRun((current) => ({ ...current, [run.run_id]: !expanded }));
    if (expanded || detailsByRun[run.run_id]?.run) return;
    const cached = getCachedRun(run.run_id);
    if (cached) {
      setDetailsByRun((current) => ({
        ...current,
        [run.run_id]: { loading: false, run: cached, error: null },
      }));
      return;
    }
    const tag = requestTag.current;
    setDetailsByRun((current) => ({
      ...current,
      [run.run_id]: { loading: true, run: null, error: null },
    }));
    void loadRun(run.run_id).then(
      (loadedRun) => {
        if (tag !== requestTag.current) return;
        setDetailsByRun((current) => ({
          ...current,
          [run.run_id]: { loading: false, run: loadedRun, error: null },
        }));
      },
      (caught: unknown) => {
        if (tag !== requestTag.current) return;
        setDetailsByRun((current) => ({
          ...current,
          [run.run_id]: { loading: false, run: null, error: errorMessage(caught) },
        }));
      },
    );
  }

  async function loadAsBatch(runId: string) {
    if (loadingBatchRunId || loadRunAsBatchDisabled) return;
    setLoadingBatchRunId(runId);
    setLoadBatchError(null);
    try {
      await loadRunAsBatch(runId);
    } catch (caught) {
      setLoadBatchError(errorMessage(caught));
    } finally {
      setLoadingBatchRunId(null);
    }
  }

  const groups = history ? groupByBatch(history.runs) : [];

  return (
    <section className="section-card project-history-section" aria-labelledby="project-history-heading">
      <div className="section-heading">
        <div>
          <h2 id="project-history-heading">Project History</h2>
          <p className="section-note">Filesystem-indexed Runs for the selected Project</p>
        </div>
        <button className="button-secondary compact" type="button" disabled={loading || reindexing} onClick={() => setRefresh((current) => current + 1)}>
          {reindexing ? "Reindexing..." : "Reindex Project"}
        </button>
      </div>

      {loading ? <p role="status">Loading Project history...</p> : null}
      {reindexing ? <p role="status">Checking Project history...</p> : null}
      {error ? <p className="operation-error" role="alert">Project history unavailable: {error}</p> : null}
      {reindexError ? <p className="operation-error" role="alert">Project history may be stale. Known history is retained. Check Project storage and use Reindex Project to retry: {reindexError}</p> : null}
      {loadBatchError ? <p className="operation-error" role="alert">Run could not be loaded as a Batch: {loadBatchError}</p> : null}

      {history ? (
        <ProjectDiagnostics diagnostics={history.diagnostics} />
      ) : null}

      {!loading && !reindexing && !reindexError && !error && history?.runs.length === 0 ? (
        <p className="empty-note">No indexed Runs were found for this Project.</p>
      ) : null}

      <div className="project-history-batches">
        {groups.map(({ batchId, batchName, batchFilesystemKey, runs }) => (
          <section className="project-history-batch" aria-label={`Batch ${batchName}`} key={batchId}>
            <div className="project-history-batch-heading">
              <div>
                <h3>{batchName}</h3>
                <code>{batchFilesystemKey}</code>
              </div>
              <span>{runs.length} {runs.length === 1 ? "Run" : "Runs"}</span>
            </div>
            <div className="project-history-runs">
              {runs.map((historicalRun) => {
                const expanded = expandedByRun[historicalRun.run_id] ?? false;
                const resultState = resultsByRun[historicalRun.run_id];
                const verificationUnavailable = !historicalRun.execution_available || resultState?.verificationUnavailable;
                const detailState = detailsByRun[historicalRun.run_id];
                const runLabel = historicalRun.run_name
                  ? `${historicalRun.run_name} · Run ${historicalRun.run_number}`
                  : `Run ${historicalRun.run_number}`;
                const contentId = `project-history-run-${historicalRun.run_id}`;
                return (
                  <article className={`project-history-run integrity-${historicalRun.integrity_status}`} key={historicalRun.run_id}>
                    <div className="project-history-run-heading">
                      <div>
                        <strong>{historicalRun.run_name ?? `Run ${historicalRun.run_number}`}</strong>
                        {historicalRun.run_name ? <span className="run-number-secondary">Run {historicalRun.run_number}</span> : null}
                        <span className="project-history-created">{formatTimestamp(historicalRun.created_at)}</span>
                      </div>
                      <div className="project-history-run-statuses">
                        <span className={`status-pill ${historicalRun.execution_status ?? "unavailable"}`}>
                          {historicalRun.execution_available && historicalRun.execution_status
                            ? historicalRun.execution_status.replaceAll("_", " ")
                            : "Execution unavailable"}
                        </span>
                        <span className={`integrity-pill ${historicalRun.integrity_status}`}>
                          {historicalRun.integrity_status}
                        </span>
                        <span className="history-result-count">{verificationUnavailable ? "Result count unavailable" : resultCount(resultState)}</span>
                        <button
                          className="button-secondary compact"
                          type="button"
                          aria-expanded={expanded}
                          aria-controls={contentId}
                          onClick={() => toggleRun(historicalRun)}
                        >
                          {expanded ? "Collapse" : "Open"}
                        </button>
                      </div>
                    </div>
                    {expanded ? (
                      <div className="project-history-run-content" id={contentId}>
                        {historicalRun.run_description ? <p>{historicalRun.run_description}</p> : null}
                        <dl className="project-history-metadata">
                          <div><dt>Jobs</dt><dd>{historicalRun.job_count}</dd></div>
                          <div><dt>Replay</dt><dd>{historicalRun.replayable ? "Replayable" : "Degraded inputs"}</dd></div>
                          <div><dt>Run folder</dt><dd><code>{historicalRun.filesystem_key}</code></dd></div>
                        </dl>
                        {detailState?.loading ? <p className="empty-note">Loading frozen Run Plan...</p> : null}
                        {detailState?.error ? <p className="operation-error">Frozen Run Plan unavailable: {detailState.error}</p> : null}
                        {detailState?.run ? (
                          <button
                            className="button-secondary compact"
                            type="button"
                            onClick={(event) => setPlanTarget({ run: detailState.run as RunResponse, restoreTarget: event.currentTarget })}
                          >
                            View Run Plan
                          </button>
                        ) : null}
                        {historicalRun.replayable ? (
                          <button
                            className="button-secondary compact"
                            type="button"
                            disabled={loadRunAsBatchDisabled || loadingBatchRunId !== null}
                            onClick={() => void loadAsBatch(historicalRun.run_id)}
                          >
                            {loadingBatchRunId === historicalRun.run_id ? "Loading Batch..." : "Load Run as Batch"}
                          </button>
                        ) : null}
                        {verificationUnavailable ? (
                          <p className="operation-error" role="status">
                            Execution records are unavailable or awaiting revalidation. Result count and current integrity cannot be confirmed.
                            {resultState?.results.length ? " Last known Result metadata is retained below; images are hidden until verification succeeds." : " No verified Result metadata is available in this view."}
                            {" Check Run storage and use Reindex Project to retry."}
                          </p>
                        ) : !resultState || resultState.loading ? <p className="empty-note">Loading Results...</p> : null}
                        {resultState?.error ? <p className="operation-error">Results could not be refreshed; known metadata is retained. Use Reindex Project to retry: {resultState.error}</p> : null}
                        {!verificationUnavailable && resultState && !resultState.loading && !resultState.error && resultState.results.length === 0 ? (
                          <p className="empty-note">No Results were recorded for this Run.</p>
                        ) : null}
                        {resultState?.results.length ? verificationUnavailable ? (
                          <ul aria-label="Last known Results">
                            {resultState.results.map((result) => (
                              <li key={`${result.job_ordinal}-${result.artifact_ordinal}`}>
                                <details>
                                  <summary>{result.remote_filename} (Job {result.job_ordinal}, artifact {result.artifact_ordinal})</summary>
                                  <dl className="project-history-metadata">
                                    <div><dt>Last known integrity (not current verification)</dt><dd>{result.integrity_status}</dd></div>
                                    <div><dt>Content type</dt><dd>{result.content_type ?? "Unknown"}</dd></div>
                                    <div><dt>Byte size</dt><dd>{result.byte_size}</dd></div>
                                    <div><dt>SHA-256</dt><dd><code>{result.sha256}</code></dd></div>
                                    <div><dt>Producing node</dt><dd>{result.producing_node_id}</dd></div>
                                    <div><dt>Output name</dt><dd>{result.output_name}</dd></div>
                                  </dl>
                                </details>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <ResultGallery
                            api={api}
                            runId={historicalRun.run_id}
                            execution={detailState?.run?.execution ?? null}
                            results={resultState.results}
                            runLabel={runLabel}
                            getCachedRun={getCachedRun}
                            loadRun={loadRun}
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {planTarget ? (
        <RunPlanDialog
          run={planTarget.run}
          restoreTarget={planTarget.restoreTarget}
          onClose={() => setPlanTarget(null)}
        />
      ) : null}
    </section>
  );
}

function ProjectDiagnostics({ diagnostics }: { diagnostics: ProjectRunsResponse["diagnostics"] }) {
  if (diagnostics.length === 0) {
    return <p className="project-history-diagnostic-summary verified">Project diagnostics: none</p>;
  }
  return (
    <details className="project-history-diagnostics">
      <summary>{diagnostics.length} Project {diagnostics.length === 1 ? "diagnostic" : "diagnostics"}</summary>
      <ul>
        {diagnostics.map((diagnostic, index) => (
          <li key={`${diagnostic.code}-${diagnostic.entity_id ?? diagnostic.filesystem_key ?? index}`}>
            <strong>{diagnostic.scope} · {diagnostic.code.replaceAll("_", " ")}</strong>
            <span>{diagnostic.message}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function groupByBatch(runs: HistoricalRunResponse[]) {
  const groups = new Map<string, {
    batchId: string;
    batchName: string;
    batchFilesystemKey: string;
    runs: HistoricalRunResponse[];
  }>();
  for (const run of runs) {
    const group = groups.get(run.batch_id) ?? {
      batchId: run.batch_id,
      batchName: run.batch_name,
      batchFilesystemKey: run.batch_filesystem_key,
      runs: [],
    };
    group.runs.push(run);
    groups.set(run.batch_id, group);
  }
  return [...groups.values()];
}

function resultCount(state: ResultState | undefined): string {
  if (!state || state.loading) return "Results loading";
  if (state.error) return "Result count unavailable";
  return `${state.results.length} ${state.results.length === 1 ? "Result" : "Results"}`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
