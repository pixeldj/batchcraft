import { useEffect } from "react";

import type { BatchcraftApi } from "../../api/client";
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
  api: BatchcraftApi;
  run: RunCreatedResponse | RunResponse | null;
  pollIntervalMs: number;
  initialExecution: ExecutionResponse | null;
  initialResults: ResultResponse[];
  initialResultsError: string | null;
  onStatusChange(status: RunStatus | null): void;
  onResultsChange(runId: string, results: ResultResponse[]): void;
  getCachedRun(runId: string): RunResponse | null;
  loadRun(runId: string): Promise<RunResponse>;
}

export function RunWorkspace({
  api,
  run,
  pollIntervalMs,
  initialExecution,
  initialResults,
  initialResultsError,
  onStatusChange,
  onResultsChange,
  getCachedRun,
  loadRun,
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

  return (
    <>
      <RunPanel
        run={run}
        execution={execution.execution}
        starting={execution.starting}
        polling={execution.polling}
        error={execution.error}
        onStart={execution.start}
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
