import { useEffect, useRef, useState } from "react";

import {
  ApiError,
  type BatchcraftApi,
  type RunCancellationApi,
  type RunDiscardApi,
} from "../../api/client";
import type {
  ExecutionResponse,
  ResultResponse,
  RunCreatedResponse,
  RunStatus,
} from "../../api/types";
import { errorMessage } from "../../utils/errors";

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "blocked", "cancelled"]);

export function useRunExecution(
  api: BatchcraftApi & RunDiscardApi & RunCancellationApi,
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
  const [discarding, setDiscarding] = useState(false);
  const [requestingStop, setRequestingStop] = useState(false);
  const [reconcilingStop, setReconcilingStop] = useState(false);
  const [requestingDetach, setRequestingDetach] = useState(false);
  const [reconcilingDetach, setReconcilingDetach] = useState(false);
  const [polling, setPolling] = useState(initialExecution?.execution_task_active ?? false);
  const [refreshingResults, setRefreshingResults] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultsError, setResultsError] = useState<string | null>(initialResultsError);
  const [createdUnavailable, setCreatedUnavailable] = useState(false);
  const reconciliation = useRef<"start" | "discard" | null>(null);
  const createdReconciliationPolls = useRef(0);
  const stopReconciliation = useRef(false);
  const stopRetryAvailable = useRef(false);
  const detachReconciliation = useRef(false);
  const detachRetryAvailable = useRef(false);

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
        setExecution((current) => (
          current?.cancellation?.mode === "detach" &&
          nextExecution.status === "running" &&
          nextExecution.cancellation?.mode !== "detach"
            ? { ...nextExecution, cancellation: current.cancellation }
            : current?.cancellation &&
          nextExecution.status === "running" &&
          !nextExecution.cancellation
            ? { ...nextExecution, cancellation: current.cancellation }
            : nextExecution
        ));

        if (stopReconciliation.current) {
          stopReconciliation.current = false;
          setReconcilingStop(false);
          stopRetryAvailable.current = nextExecution.status === "running" && !nextExecution.cancellation;
          setError(
            stopRetryAvailable.current
              ? "The Stop request was not observed; it is safe to request again."
              : null,
          );
        }
        if (nextExecution.cancellation || TERMINAL_STATUSES.has(nextExecution.status)) {
          stopRetryAvailable.current = false;
        }
        if (detachReconciliation.current) {
          detachReconciliation.current = false;
          setReconcilingDetach(false);
          detachRetryAvailable.current = (
            nextExecution.status === "running" &&
            nextExecution.cancellation?.mode !== "detach"
          );
          setError(
            detachRetryAvailable.current
              ? "The Stop waiting request was not observed; it is safe to request again."
              : null,
          );
        }
        if (
          nextExecution.cancellation?.mode === "detach" ||
          TERMINAL_STATUSES.has(nextExecution.status)
        ) {
          detachRetryAvailable.current = false;
        }

        if (reconciliation.current && nextExecution.status === "created") {
          createdReconciliationPolls.current += 1;
          if (createdReconciliationPolls.current >= 3) {
            const reconciliationKind = reconciliation.current;
            setCreatedUnavailable(reconciliationKind === "discard");
            setError(reconciliationKind === "start"
              ? "The Run remains created. The Start request was not observed; it is safe to start again."
              : "This Run's persisted execution state is not eligible to start or discard.");
            reconciliation.current = null;
            setPolling(false);
            return;
          }
        } else {
          reconciliation.current = null;
          setCreatedUnavailable(false);
          if (!stopRetryAvailable.current && !detachRetryAvailable.current) {
            setError(null);
          }
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

        if (
          TERMINAL_STATUSES.has(nextExecution.status) ||
          (nextExecution.status === "running" && !nextExecution.execution_task_active)
        ) {
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
    if (!run || starting || polling || discarding || createdUnavailable || (execution?.status ?? "created") !== "created") {
      return;
    }
    setStarting(true);
    reconciliation.current = null;
    setCreatedUnavailable(false);
    setError(null);
    try {
      await api.startRun(run.run_id);
      setPolling(true);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "network_error") {
        setError(`${errorMessage(caught)}. The Start response was ambiguous; checking durable state.`);
        createdReconciliationPolls.current = 0;
        reconciliation.current = "start";
        setPolling(true);
      } else if (caught instanceof ApiError && caught.code === "execution_not_eligible") {
        const message = errorMessage(caught);
        try {
          const nextExecution = await api.getExecution(run.run_id);
          setExecution(nextExecution);
          setCreatedUnavailable(
            nextExecution.status === "created" && !nextExecution.execution_task_active,
          );
          setPolling(nextExecution.execution_task_active);
          setError(
            nextExecution.status === "created" && !nextExecution.execution_task_active
              ? message
              : null,
          );
        } catch {
          setError(message);
        }
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setStarting(false);
    }
  }

  async function discard() {
    if (!run || starting || polling || discarding || createdUnavailable || (execution?.status ?? "created") !== "created") {
      return;
    }
    setDiscarding(true);
    reconciliation.current = null;
    setCreatedUnavailable(false);
    setError(null);
    try {
      const nextExecution = await api.discardRun(run.run_id);
      setExecution(nextExecution);
      onStatusChange(nextExecution.status);
      setPolling(false);
    } catch (caught) {
      const message = errorMessage(caught);
      const discardRejected = caught instanceof ApiError && caught.code === "run_discard_not_eligible";
      try {
        const nextExecution = await api.getExecution(run.run_id);
        setExecution(nextExecution);
        onStatusChange(nextExecution.status);
        if (discardRejected && nextExecution.status === "created") {
          createdReconciliationPolls.current = 0;
          reconciliation.current = "discard";
          setPolling(true);
          setError(`${message}. Checking durable state.`);
        } else {
          setCreatedUnavailable(false);
          setPolling(nextExecution.execution_task_active);
          setError(nextExecution.status === "created" ? message : null);
        }
      } catch {
        setError(message);
      }
    } finally {
      setDiscarding(false);
    }
  }

  async function stopAfterCurrentJob() {
    if (
      !run ||
      requestingStop ||
      reconcilingStop ||
      requestingDetach ||
      reconcilingDetach ||
      execution?.status !== "running" ||
      execution.cancellation
    ) {
      return;
    }
    setRequestingStop(true);
    stopRetryAvailable.current = false;
    setError(null);
    try {
      const response = await api.cancelRun(run.run_id);
      setExecution((current) => current ? {
        ...current,
        cancellation: {
          mode: response.mode,
          requested_at: response.requested_at,
          state: response.state,
        },
      } : current);
      setPolling(true);
    } catch (caught) {
      const message = errorMessage(caught);
      if (caught instanceof ApiError && caught.code === "network_error") {
        stopReconciliation.current = true;
        setReconcilingStop(true);
        setError(`${message}. The Stop response was ambiguous; checking durable state.`);
        setPolling(true);
      } else if (caught instanceof ApiError && caught.code === "run_cancellation_not_eligible") {
        await reconcileCancellationRejection(message);
      } else {
        setError(message);
      }
    } finally {
      setRequestingStop(false);
    }
  }

  async function detachFromCurrentJob() {
    if (
      !run ||
      requestingStop ||
      reconcilingStop ||
      requestingDetach ||
      reconcilingDetach ||
      execution?.status !== "running" ||
      execution.cancellation?.mode === "detach"
    ) {
      return;
    }
    setRequestingDetach(true);
    detachRetryAvailable.current = false;
    setError(null);
    try {
      const response = await api.detachRun(run.run_id);
      setExecution((current) => current ? {
        ...current,
        cancellation: {
          mode: response.mode,
          requested_at: response.requested_at,
          state: response.state,
        },
      } : current);
      setPolling(true);
    } catch (caught) {
      const message = errorMessage(caught);
      if (caught instanceof ApiError && caught.code === "network_error") {
        detachReconciliation.current = true;
        setReconcilingDetach(true);
        setError(`${message}. The Stop waiting response was ambiguous; checking durable state.`);
        setPolling(true);
      } else if (caught instanceof ApiError && caught.code === "run_cancellation_not_eligible") {
        await reconcileCancellationRejection(message);
      } else {
        setError(message);
      }
    } finally {
      setRequestingDetach(false);
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

  async function reconcileCancellationRejection(message: string) {
    if (!run) return;
    try {
      const nextExecution = await api.getExecution(run.run_id);
      setExecution(nextExecution);
      const unavailable = nextExecution.status === "running" && !nextExecution.execution_task_active;
      setPolling(nextExecution.status === "running" && nextExecution.execution_task_active);
      setError(unavailable || TERMINAL_STATUSES.has(nextExecution.status) ? null : message);
      try {
        const nextResults = await api.getResults(run.run_id);
        setResults(nextResults.results);
        setResultsError(null);
      } catch (caught) {
        setResultsError(errorMessage(caught));
      }
    } catch {
      setError(message);
    }
  }

  const executionControlUnavailable = (
    execution?.status === "running" && !execution.execution_task_active
  );

  return {
    execution,
    results,
    starting,
    discarding,
    requestingStop,
    reconcilingStop,
    requestingDetach,
    reconcilingDetach,
    polling,
    refreshingResults,
    error,
    resultsError,
    createdUnavailable,
    executionControlUnavailable,
    start,
    discard,
    stopAfterCurrentJob,
    detachFromCurrentJob,
    refreshResults,
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
