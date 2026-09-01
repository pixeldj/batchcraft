import { useEffect } from "react";

import type { BatchcraftApi, RunDiscardApi } from "../../api/client";
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
  api: BatchcraftApi & RunDiscardApi;
  run: RunCreatedResponse | RunResponse | null;
  pollIntervalMs: number;
  initialExecution: ExecutionResponse | null;
  initialResults: ResultResponse[];
  initialResultsError: string | null;
  onStatusChange(status: RunStatus | null): void;
  onCreatedUnavailableChange(runId: string, unavailable: boolean): void;
  onResultsChange(runId: string, results: ResultResponse[]): void;
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
      onResultsChange(run.run_id, execution.results);
    }
  }, [execution.results, onResultsChange, run]);

  useEffect(() => {
    if (run) {
      onCreatedUnavailableChange(run.run_id, execution.createdUnavailable);
    }
  }, [execution.createdUnavailable, onCreatedUnavailableChange, run]);

  return (
    <>
      <RunPanel
        run={run}
        execution={execution.execution}
        starting={execution.starting}
        discarding={execution.discarding}
        polling={execution.polling}
        error={execution.error}
        createdUnavailable={execution.createdUnavailable}
        batchDiverged={batchDiverged}
        onStart={execution.start}
        onDiscard={execution.discard}
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
