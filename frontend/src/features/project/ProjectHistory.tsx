import { useEffect, useRef, useState } from "react";

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
  getCachedRun(runId: string): RunResponse | null;
  loadRun(runId: string): Promise<RunResponse>;
  loadRunAsBatch(runId: string): Promise<void>;
  loadRunAsBatchDisabled?: boolean;
}

interface ResultState {
  loading: boolean;
  results: ResultResponse[];
  error: string | null;
}

interface DetailState {
  loading: boolean;
  run: RunResponse | null;
  error: string | null;
}

export function ProjectHistory({
  api,
  projectId,
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
  getCachedRun,
  loadRun,
  loadRunAsBatch,
  loadRunAsBatchDisabled = false,
}: Omit<Props, "projectId"> & { projectId: string }) {
  const [history, setHistory] = useState<ProjectRunsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [reindexing, setReindexing] = useState(false);
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
  const reindexController = useRef<AbortController | null>(null);

  useEffect(() => {
    const tag = ++requestTag.current;
    const controller = new AbortController();
    reindexController.current?.abort();
    void api.listProjectRuns(projectId, controller.signal).then(
      (response) => {
        if (controller.signal.aborted || tag !== requestTag.current) return;
        if (response.project_id !== projectId) {
          setError("The history response did not match the selected Project.");
          setLoading(false);
          return;
        }
        setError(null);
        setHistory(response);
        setLoading(false);
        setResultsByRun(Object.fromEntries(response.runs.map((run) => [
          run.run_id,
          { loading: true, results: [], error: null },
        ])));
        for (const run of response.runs) {
          void api.getResults(run.run_id, controller.signal).then(
            (resultResponse) => {
              if (controller.signal.aborted || tag !== requestTag.current) return;
              setResultsByRun((current) => ({
                ...current,
                [run.run_id]: { loading: false, results: resultResponse.results, error: null },
              }));
            },
            (caught: unknown) => {
              if (controller.signal.aborted || tag !== requestTag.current || isAbort(caught)) return;
              setResultsByRun((current) => ({
                ...current,
                [run.run_id]: { loading: false, results: [], error: errorMessage(caught) },
              }));
            },
          );
        }
      },
      (caught: unknown) => {
        if (controller.signal.aborted || tag !== requestTag.current || isAbort(caught)) return;
        setError(errorMessage(caught));
        setLoading(false);
      },
    );

    return () => {
      controller.abort();
      reindexController.current?.abort();
    };
  }, [api, projectId, refresh]);

  async function reindex() {
    if (!projectId || reindexing) return;
    const tag = requestTag.current;
    const controller = new AbortController();
    reindexController.current?.abort();
    reindexController.current = controller;
    setReindexing(true);
    setReindexError(null);
    try {
      const response = await api.reindexProject(projectId, controller.signal);
      if (controller.signal.aborted || tag !== requestTag.current) return;
      if (response.project_id !== projectId) {
        throw new Error("The reindex response did not match the selected Project.");
      }
      setReindexError(null);
      setRefresh((current) => current + 1);
    } catch (caught) {
      if (!controller.signal.aborted && tag === requestTag.current && !isAbort(caught)) {
        setReindexError(errorMessage(caught));
      }
    } finally {
      if (!controller.signal.aborted && tag === requestTag.current) setReindexing(false);
    }
  }

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
        <button className="button-secondary compact" type="button" disabled={loading || reindexing} onClick={() => void reindex()}>
          {reindexing ? "Reindexing..." : "Reindex Project"}
        </button>
      </div>

      {loading ? <p role="status">Loading Project history...</p> : null}
      {error ? <p className="operation-error" role="alert">Project history unavailable: {error}</p> : null}
      {reindexError ? <p className="operation-error" role="alert">Project reindex failed: {reindexError}</p> : null}
      {loadBatchError ? <p className="operation-error" role="alert">Run could not be loaded as a Batch: {loadBatchError}</p> : null}

      {history ? (
        <ProjectDiagnostics diagnostics={history.diagnostics} />
      ) : null}

      {!loading && !error && history?.runs.length === 0 ? (
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
                        <span className="history-result-count">{resultCount(resultState)}</span>
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
                        {resultState?.loading ? <p className="empty-note">Loading Results...</p> : null}
                        {resultState?.error ? <p className="operation-error">Results unavailable: {resultState.error}</p> : null}
                        {resultState && !resultState.loading && !resultState.error && resultState.results.length === 0 ? (
                          <p className="empty-note">No Results were recorded for this Run.</p>
                        ) : null}
                        {resultState?.results.length ? (
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
