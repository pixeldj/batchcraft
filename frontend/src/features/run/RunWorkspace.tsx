import type { BatchcraftApi } from "../../api/client";
import type { RunCreatedResponse } from "../../api/types";
import { ResultsPanel } from "../results/ResultsPanel";
import { RunPanel } from "./RunPanel";
import { useRunExecution } from "./useRunExecution";

interface Props {
  api: BatchcraftApi;
  run: RunCreatedResponse | null;
  pollIntervalMs: number;
}

export function RunWorkspace({ api, run, pollIntervalMs }: Props) {
  const execution = useRunExecution(api, run, pollIntervalMs);

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
        results={execution.results}
        error={execution.resultsError}
        refreshing={execution.refreshingResults}
        onRefresh={execution.refreshResults}
      />
    </>
  );
}
