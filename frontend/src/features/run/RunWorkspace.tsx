import { useEffect } from "react";

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

interface Props {
  api: BatchcraftApi & RunDiscardApi & RunCancellationApi;
  run: RunCreatedResponse | RunResponse | null;
  pollIntervalMs: number;
  initialExecution: ExecutionResponse | null;
  initialResults: ResultResponse[];
  initialResultsError: string | null;
  onStatusChange(status: RunStatus | null): void;
  onCreatedUnavailableChange(runId: string, unavailable: boolean): void;
  onExecutionControlUnavailableChange(runId: string, unavailable: boolean): void;
  onResultsChange(
    runId: string,
    execution: ExecutionResponse | null,
    results: ResultResponse[],
    error: string | null,
  ): void;
  getCachedRun(runId: string): RunResponse | null;
  loadRun(runId: string): Promise<RunResponse>;
  batchDiverged: boolean;
}

export function RunWorkspace({
  api,
  run,
  pollIntervalMs,
  initialExecution,
  initialResults,
  initialResultsError,
  onStatusChange,
  onCreatedUnavailableChange,
  onExecutionControlUnavailableChange,
  onResultsChange,
  getCachedRun,
  loadRun,
  batchDiverged,
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

  useEffect(() => {
    if (run) {
      onResultsChange(
        run.run_id,
        execution.execution,
        execution.results,
        execution.resultsError,
      );
    }
  }, [execution.execution, execution.results, execution.resultsError, onResultsChange, run]);

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
    </>
  );
}
