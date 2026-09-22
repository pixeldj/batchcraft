import { useEffect, useEffectEvent, useRef, useState } from "react";

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
  const resultsRefresh = useRef<{
    runId: string;
    observation: string | null;
    generation: number;
    request: AbortController | null;
    failed: boolean;
  } | null>(null);
  const executionFailures = useRef(0);
  const runId = run?.run_id;
  const executionRunId = useRef(runId);

  function requestResults(runId: string, observation?: ExecutionResponse) {
    const scope = resultsRefresh.current;
    if (!scope || scope.runId !== runId) return;
    if (observation) {
      const signature = JSON.stringify([
        observation.jobs.map(({ ordinal, result_count }) => [ordinal, result_count] as const)
          .sort(([left], [right]) => left - right),
        TERMINAL_STATUSES.has(observation.status) ? observation.status
          : observation.status === "running" && !observation.execution_task_active ? "inactive" : null,
      ]);
      if (signature === scope.observation) {
        if (!scope.failed || scope.request) return;
      } else {
        scope.observation = signature;
        scope.generation += 1;
      }
    } else {
      scope.generation += 1;
    }
    if (scope.request) return;

    // Each request covers only the need captured at dispatch, not later observations.
    async function loadResults() {
      if (!scope || resultsRefresh.current !== scope) return;
      const generation = scope.generation;
      const controller = new AbortController();
      scope.request = controller;
      try {
        const nextResults = await api.getResults(runId, controller.signal);
        if (resultsRefresh.current !== scope) return;
        scope.failed = false;
        setResults(nextResults.results);
        setResultsError(null);
      } catch (caught) {
        if (resultsRefresh.current !== scope) return;
        scope.failed = true;
        if (!isAbort(caught)) setResultsError(errorMessage(caught));
      } finally {
        if (resultsRefresh.current === scope) {
          scope.request = null;
          if (scope.generation > generation) void loadResults();
          else setRefreshingResults(false);
        }
      }
    }
    void loadResults();
  }

  const observeResults = useEffectEvent((next: ExecutionResponse) => requestResults(next.run_id, next));

  useEffect(() => {
    resultsRefresh.current = runId ? {
      runId, observation: null, generation: 0, request: null, failed: false,
    } : null;
    const scope = resultsRefresh.current;
    reconciliation.current = null;
    createdReconciliationPolls.current = 0;
    stopReconciliation.current = false;
    stopRetryAvailable.current = false;
    detachReconciliation.current = false;
    detachRetryAvailable.current = false;
    executionFailures.current = 0;
    queueMicrotask(() => {
      if (resultsRefresh.current !== scope) return;
      setRefreshingResults(false);
      setStarting(false);
      setDiscarding(false);
      setRequestingStop(false);
      setReconcilingStop(false);
      setRequestingDetach(false);
      setReconcilingDetach(false);
      setCreatedUnavailable(false);
      setError(null);
    });
    return () => {
      resultsRefresh.current = null;
      scope?.request?.abort();
    };
  }, [runId]);

  useEffect(() => {
    const replaced = executionRunId.current !== runId;
    executionRunId.current = runId;
    const seed = initialExecution?.run_id === runId ? initialExecution : null;
    if (!seed && !replaced) return;
    let current = true;
    queueMicrotask(() => {
      if (!current) return;
      setExecution(seed);
      setPolling(seed?.execution_task_active ?? false);
    });
    return () => { current = false; };
  }, [initialExecution, runId]);

  const resultsSeed = useEffectEvent(() => ({ results: initialResults, error: initialResultsError }));

  useEffect(() => {
    if (!runId) return;
    // Recovery seeds initialize a Run lifetime, not subsequent foreground observations.
    const seed = resultsSeed();
    let current = true;
    queueMicrotask(() => {
      if (!current) return;
      setResults(seed.results);
      setResultsError(seed.error);
    });
    return () => { current = false; };
  }, [runId]);

  useEffect(() => {
    if (!runId || !initialExecution || initialExecution.run_id !== runId) return;
    observeResults(initialExecution);
  }, [api, initialExecution, runId]);

  useEffect(() => {
    onStatusChange(execution?.status ?? (run ? "created" : null));
  }, [execution?.status, onStatusChange, run]);

  useEffect(() => {
    if (!polling || !runId) {
      return;
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    async function poll() {
      if (disposed || !runId) {
        return;
      }
      try {
        const nextExecution = await api.getExecution(runId, controller.signal);
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
        executionFailures.current = 0;
        observeResults(nextExecution);

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
          executionFailures.current += 1;
          if (!isTransient(caught) || executionFailures.current >= 3) {
            setPolling(false);
            return;
          }
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
  }, [api, pollIntervalMs, polling, runId]);

  async function start() {
    if (!run || starting || polling || discarding || createdUnavailable || (execution?.status ?? "created") !== "created") {
      return;
    }
    setStarting(true);
    const scope = resultsRefresh.current;
    reconciliation.current = null;
    setCreatedUnavailable(false);
    setError(null);
    try {
      await api.startRun(run.run_id);
      if (resultsRefresh.current !== scope) return;
      setPolling(true);
    } catch (caught) {
      if (resultsRefresh.current !== scope) return;
      if (caught instanceof ApiError && caught.code === "network_error") {
        setError(`${errorMessage(caught)}. The Start response was ambiguous; checking durable state.`);
        createdReconciliationPolls.current = 0;
        reconciliation.current = "start";
        setPolling(true);
      } else if (caught instanceof ApiError && caught.code === "execution_not_eligible") {
        const message = errorMessage(caught);
        try {
          const nextExecution = await api.getExecution(run.run_id);
          if (resultsRefresh.current !== scope) return;
          setExecution(nextExecution);
          requestResults(run.run_id, nextExecution);
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
          if (resultsRefresh.current === scope) setError(message);
        }
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      if (resultsRefresh.current === scope) setStarting(false);
    }
  }

  async function discard() {
    if (!run || starting || polling || discarding || createdUnavailable || (execution?.status ?? "created") !== "created") {
      return;
    }
    setDiscarding(true);
    const scope = resultsRefresh.current;
    reconciliation.current = null;
    setCreatedUnavailable(false);
    setError(null);
    try {
      const nextExecution = await api.discardRun(run.run_id);
      if (resultsRefresh.current !== scope) return;
      setExecution(nextExecution);
      requestResults(run.run_id, nextExecution);
      onStatusChange(nextExecution.status);
      setPolling(false);
    } catch (caught) {
      if (resultsRefresh.current !== scope) return;
      const message = errorMessage(caught);
      const discardRejected = caught instanceof ApiError && caught.code === "run_discard_not_eligible";
      try {
        const nextExecution = await api.getExecution(run.run_id);
        if (resultsRefresh.current !== scope) return;
        setExecution(nextExecution);
        requestResults(run.run_id, nextExecution);
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
        if (resultsRefresh.current === scope) setError(message);
      }
    } finally {
      if (resultsRefresh.current === scope) setDiscarding(false);
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
    const scope = resultsRefresh.current;
    stopRetryAvailable.current = false;
    setError(null);
    try {
      const response = await api.cancelRun(run.run_id);
      if (resultsRefresh.current !== scope) return;
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
      if (resultsRefresh.current !== scope) return;
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
      if (resultsRefresh.current === scope) setRequestingStop(false);
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
    const scope = resultsRefresh.current;
    detachRetryAvailable.current = false;
    setError(null);
    try {
      const response = await api.detachRun(run.run_id);
      if (resultsRefresh.current !== scope) return;
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
      if (resultsRefresh.current !== scope) return;
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
      if (resultsRefresh.current === scope) setRequestingDetach(false);
    }
  }

  function refreshResults() {
    if (run) {
      setRefreshingResults(true);
      requestResults(run.run_id);
    }
  }

  async function reconcileCancellationRejection(message: string) {
    if (!run) return;
    const scope = resultsRefresh.current;
    try {
      const nextExecution = await api.getExecution(run.run_id);
      if (resultsRefresh.current !== scope) return;
      setExecution(nextExecution);
      const unavailable = nextExecution.status === "running" && !nextExecution.execution_task_active;
      setPolling(nextExecution.status === "running" && nextExecution.execution_task_active);
      setError(unavailable || TERMINAL_STATUSES.has(nextExecution.status) ? null : message);
      requestResults(run.run_id, nextExecution);
    } catch {
      if (resultsRefresh.current === scope) setError(message);
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

function isTransient(error: unknown): boolean {
  return !(error instanceof ApiError) || error.code === "network_error" || (
    error.status !== null && error.status >= 500
  );
}
