import { useEffect, useEffectEvent } from "react";

import type { BatchcraftApi, RunCancellationApi, RunDiscardApi } from "../../api/client";
import type {
  ExecutionResponse,
  ResultResponse,
  RunCreatedResponse,
  RunResponse,
  RunStatus,
} from "../../api/types";
import { ResultsPanel } from "../results/ResultsPanel";
import { RunPanel } from "./RunPanel";
import { useRunExecution } from "./useRunExecution";
import { runDisplayLabel } from "./runDisplay";

interface Props {
  api: BatchcraftApi & RunDiscardApi & RunCancellationApi;
  run: RunCreatedResponse | RunResponse | null;
  pollIntervalMs: number;
  initialExecution: ExecutionResponse | null;
  initialResults: ResultResponse[];
  initialResultsError: string | null;
  onStatusChange(status: RunStatus | null): void;
  onHistoryChange?(projectId: string): void;
  onCreatedUnavailableChange(runId: string, unavailable: boolean): void;
  onExecutionControlUnavailableChange(runId: string, unavailable: boolean): void;
  getCachedRun(runId: string): RunResponse | null;
  loadRun(runId: string): Promise<RunResponse>;
  batchDiverged: boolean;
  visible: boolean;
  onOpenRun(): void;
}

export function RunWorkspace({
  api,
  run,
  pollIntervalMs,
  initialExecution,
  initialResults,
  initialResultsError,
  onStatusChange,
  onHistoryChange,
  onCreatedUnavailableChange,
  onExecutionControlUnavailableChange,
  getCachedRun,
  loadRun,
  batchDiverged,
  visible,
  onOpenRun,
}: Props) {
  const execution = useRunExecution(
    api,
    run,
    pollIntervalMs,
    initialExecution,
    initialResults,
    initialResultsError,
    onStatusChange,
  );

  const notifyHistory = useEffectEvent(() => {
    if (run) onHistoryChange?.(run.project_id);
  });
  const historyStatus = execution.execution?.status ?? (run ? "created" : null);
  useEffect(() => {
    if (historyStatus && historyStatus !== "running") notifyHistory();
  }, [run?.run_id, historyStatus]);

  useEffect(() => {
    if (run) {
      onCreatedUnavailableChange(run.run_id, execution.createdUnavailable);
    }
  }, [execution.createdUnavailable, onCreatedUnavailableChange, run]);

  useEffect(() => {
    if (run) {
      onExecutionControlUnavailableChange(run.run_id, execution.executionControlUnavailable);
    }
  }, [execution.executionControlUnavailable, onExecutionControlUnavailableChange, run]);

  return (
    <>
      {!visible && run ? (
        <section className="workspace-run-strip" aria-label="Current Run">
          <div>
            <span className={`status-pill ${historyStatus}`}>{historyStatus}</span>
            <strong>{runDisplayLabel(run)}</strong>
            <span>{run.project_name} / {run.batch_name}</span>
          </div>
          <div>
            <span>{execution.execution?.current_job_ordinal ? `Job ${execution.execution.current_job_ordinal} of ${run.job_count}` : `${run.job_count} Jobs`}</span>
            <button className="button-secondary compact" type="button" onClick={onOpenRun}>View current Run</button>
          </div>
        </section>
      ) : null}
      <div hidden={!visible} id="current-run-workspace">
      <RunPanel
        run={run}
        execution={execution.execution}
        starting={execution.starting}
        discarding={execution.discarding}
        requestingStop={execution.requestingStop}
        reconcilingStop={execution.reconcilingStop}
        requestingDetach={execution.requestingDetach}
        reconcilingDetach={execution.reconcilingDetach}
        polling={execution.polling}
        error={execution.error}
        createdUnavailable={execution.createdUnavailable}
        executionControlUnavailable={execution.executionControlUnavailable}
        batchDiverged={batchDiverged}
        onStart={execution.start}
        onDiscard={execution.discard}
        onStopAfterCurrentJob={execution.stopAfterCurrentJob}
        onDetachFromCurrentJob={execution.detachFromCurrentJob}
      />
      <ResultsPanel
        api={api}
        run={run}
        execution={execution.execution}
        results={execution.results}
        error={execution.resultsError}
        refreshing={execution.refreshingResults}
        onRefresh={execution.refreshResults}
        getCachedRun={getCachedRun}
        loadRun={loadRun}
      />
      </div>
    </>
  );
}
