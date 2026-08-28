import { useEffect, useRef, useState } from "react";

import { ApiError, type BatchcraftApi } from "../../api/client";
import type {
  ExecutionResponse,
  ResultResponse,
  RunCreatedResponse,
  RunStatus,
} from "../../api/types";
import { errorMessage } from "../../utils/errors";

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "blocked"]);

export function useRunExecution(
  api: BatchcraftApi,
  run: RunCreatedResponse | null,
  pollIntervalMs: number,
  initialExecution: ExecutionResponse | null,
  initialResults: ResultResponse[],
  initialResultsError: string | null,
  onStatusChange: (status: RunStatus | null) => void,
) {
  const [execution, setExecution] = useState<ExecutionResponse | null>(initialExecution);
  const [results, setResults] = useState<ResultResponse[]>(initialResults);
  const [starting, setStarting] = useState(false);
  const [polling, setPolling] = useState(initialExecution?.status === "running");
  const [refreshingResults, setRefreshingResults] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultsError, setResultsError] = useState<string | null>(initialResultsError);
  const reconcilingStart = useRef(false);
  const createdReconciliationPolls = useRef(0);

  useEffect(() => {
    onStatusChange(execution?.status ?? (run ? "created" : null));
  }, [execution?.status, onStatusChange, run]);

  useEffect(() => {
    if (!polling || !run) {
      return;
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    async function poll() {
      if (disposed || !run) {
        return;
      }
      try {
        const nextExecution = await api.getExecution(run.run_id, controller.signal);
        if (disposed) {
          return;
        }
        setExecution(nextExecution);

        if (reconcilingStart.current && nextExecution.status === "created") {
          createdReconciliationPolls.current += 1;
          if (createdReconciliationPolls.current >= 3) {
            setError("The Run remains created. The Start request was not observed; it is safe to start again.");
            reconcilingStart.current = false;
            setPolling(false);
            return;
          }
        } else {
          reconcilingStart.current = false;
          setError(null);
        }

        try {
          const nextResults = await api.getResults(run.run_id, controller.signal);
          if (!disposed) {
            setResults(nextResults.results);
            setResultsError(null);
          }
        } catch (caught) {
          if (!isAbort(caught) && !disposed) {
            setResultsError(errorMessage(caught));
          }
        }

        if (TERMINAL_STATUSES.has(nextExecution.status)) {
          setPolling(false);
          return;
        }
      } catch (caught) {
        if (!isAbort(caught) && !disposed) {
          setError(errorMessage(caught));
        }
      }

      if (!disposed) {
        timer = setTimeout(poll, pollIntervalMs);
      }
    }

    void poll();
    return () => {
      disposed = true;
      controller.abort();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [api, pollIntervalMs, polling, run]);

  async function start() {
    if (!run || starting || polling) {
      return;
    }
    setStarting(true);
    reconcilingStart.current = false;
    setError(null);
    try {
      await api.startRun(run.run_id);
      setPolling(true);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "network_error") {
        setError(`${errorMessage(caught)}. The Start response was ambiguous; checking durable state.`);
        createdReconciliationPolls.current = 0;
        reconcilingStart.current = true;
        setPolling(true);
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setStarting(false);
    }
  }

  async function refreshResults() {
    if (!run || refreshingResults) {
      return;
    }
    setRefreshingResults(true);
    setResultsError(null);
    try {
      const nextResults = await api.getResults(run.run_id);
      setResults(nextResults.results);
    } catch (caught) {
      setResultsError(errorMessage(caught));
    } finally {
      setRefreshingResults(false);
    }
  }

  return {
    execution,
    results,
    starting,
    polling,
    refreshingResults,
    error,
    resultsError,
    start,
    refreshResults,
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
