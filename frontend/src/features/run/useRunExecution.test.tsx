import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, BatchcraftApiClient } from "../../api/client";
import type { ExecutionResponse, ResultResponse, ResultsResponse, RunCreatedResponse } from "../../api/types";
import { useRunExecution } from "./useRunExecution";

const empty: ResultResponse[] = [];
const onStatus = vi.fn();
const artifact: ResultResponse = {
  job_ordinal: 1, artifact_ordinal: 1, producing_node_id: "9", output_name: "images",
  remote_filename: "kept.png", content_type: "image/png", byte_size: 10,
  sha256: "a".repeat(64), integrity_status: "verified", download_url: "/result/1/1",
};

function listed(counts: number[]): ResultResponse[] {
  return counts.flatMap((count, index) => Array.from({ length: count }, (_, ordinal) => ({
    ...artifact, job_ordinal: index + 1, artifact_ordinal: ordinal + 1,
    download_url: `/result/${index + 1}/${ordinal + 1}`,
  })));
}

function run(runId = "a"): RunCreatedResponse {
  return {
    run_id: runId, run_number: 1, run_name: null, run_description: null, filesystem_key: "001-run",
    project_id: "project", project_name: "Project", batch_id: "batch", batch_name: "Batch",
    job_count: 3, durable_status: "published",
  };
}

function observation(
  counts = [0, 0, 0],
  status: ExecutionResponse["status"] = "running",
  active = status === "running",
  runId = "a",
): ExecutionResponse {
  return {
    run_id: runId, status, execution_task_active: active,
    started_at: "2026-09-21T10:00:00Z", completed_at: status === "running" ? null : "2026-09-21T10:01:00Z",
    current_job_ordinal: status === "running" ? 3 : null, error: null, diagnostics: [],
    jobs: counts.map((count, index) => ({
      ordinal: index + 1, result_count: count,
      status: index < 2 || status === "succeeded" ? "succeeded" : "submitted",
      prompt_id: `prompt-${index}`, started_at: "2026-09-21T10:00:00Z",
      completed_at: index < 2 || status === "succeeded" ? "2026-09-21T10:00:01Z" : null,
      error: null, diagnostics: [],
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function created(runId = "a"): ExecutionResponse {
  return {
    ...observation([0, 0, 0], "created", false, runId),
    started_at: null, completed_at: null, current_job_ordinal: null,
    jobs: [1, 2, 3].map((ordinal) => ({
      ordinal, status: "pending", prompt_id: null, started_at: null, completed_at: null,
      error: null, diagnostics: [], result_count: 0,
    })),
  };
}

function setup(initial = observation(), results = empty) {
  const api = new BatchcraftApiClient();
  // Fresh allocations on every poll deliberately rule out object-identity comparisons.
  const getExecution = vi.spyOn(api, "getExecution").mockImplementation(async () => structuredClone(initial));
  const getResults = vi.spyOn(api, "getResults").mockImplementation(async (runId) => ({
    run_id: runId, results: listed(initial.jobs.map((job) => job.result_count)),
  }));
  const hook = () => renderHook(
    ({ currentRun, seed }) => useRunExecution(api, currentRun, 100, seed, results, null, onStatus),
    { initialProps: { currentRun: run(initial.run_id), seed: initial as ExecutionResponse | null } },
  );
  return { api, getExecution, getResults, hook };
}

async function flush() { await act(async () => {}); }
async function poll() { await act(async () => { await vi.advanceTimersByTimeAsync(100); }); }

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("current Run Results coordination", () => {
  it.each(["pending", "settled"])("ignores reordered equivalent Job tuples with a %s Results request", async (state) => {
    const pending = deferred<ResultsResponse>();
    const { hook, getExecution, getResults } = setup(observation([1, 2, 0]));
    if (state === "pending") getResults.mockImplementationOnce(() => pending.promise);
    const { result } = hook();
    await flush();
    const reordered = observation([1, 2, 0]);
    reordered.jobs.reverse();
    getExecution.mockImplementation(async () => structuredClone(reordered));
    await poll();
    await poll();
    expect(getResults).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ run_id: "a", results: listed([1, 2, 0]) }));
    await poll();
    expect(getResults).toHaveBeenCalledTimes(1);
    expect(getExecution).toHaveBeenCalledTimes(4);
    expect(result.current.execution?.jobs.map((job) => job.ordinal)).toEqual([3, 2, 1]);
  });

  it.each(([
    { action: "start", busy: "starting", method: "startRun", running: false },
    { action: "discard", busy: "discarding", method: "discardRun", running: false },
    { action: "stopAfterCurrentJob", busy: "requestingStop", method: "cancelRun", running: true },
    { action: "detachFromCurrentJob", busy: "requestingDetach", method: "detachRun", running: true },
  ] as const).flatMap((testCase) => ["resolve", "reject"].map((outcome) => ({ ...testCase, outcome }))))(
    "resets $action on replacement and isolates late $outcome", async ({ action, busy, method, running, outcome }) => {
      const old = deferred<void>();
      const current = deferred<void>();
      const { api, hook, getExecution } = setup(running ? observation() : created());
      vi.spyOn(api, "startRun")
        .mockImplementationOnce(async () => { await old.promise; return { run_id: "a", status: "running" }; })
        .mockImplementationOnce(async () => { await current.promise; return { run_id: "b", status: "running" }; });
      vi.spyOn(api, "discardRun")
        .mockImplementationOnce(async () => { await old.promise; return { ...created(), status: "cancelled", completed_at: "2026-09-21T10:00:02Z" }; })
        .mockImplementationOnce(async () => { await current.promise; return { ...created("b"), status: "cancelled", completed_at: "2026-09-21T10:00:02Z" }; });
      for (const cancel of ["cancelRun", "detachRun"] as const) {
        const mode = cancel === "cancelRun" ? "after_current_job" : "detach";
        const state = cancel === "cancelRun" ? "stopping_after_current_job" : "detach_requested";
        vi.spyOn(api, cancel)
          .mockImplementationOnce(async () => {
            await old.promise;
            return { run_id: "a", mode, requested_at: "2026-09-21T10:00:02Z", state, created: true };
          })
          .mockImplementationOnce(async () => {
            await current.promise;
            return { run_id: "b", mode, requested_at: "2026-09-21T10:00:02Z", state, created: true };
          });
      }
      const { result, rerender, unmount } = hook();
      await flush();
      act(() => { void result.current[action](); });
      expect(result.current[busy]).toBe(true);
      const seed = running ? observation([0, 0, 0], "running", true, "b") : null;
      getExecution.mockImplementation(async () => seed ?? created("b"));
      rerender({ currentRun: run("b"), seed });
      await flush();
      expect(result.current[busy]).toBe(false);
      act(() => { void result.current[action](); });
      expect(api[method]).toHaveBeenCalledTimes(2);
      expect(result.current[busy]).toBe(true);
      const polls = getExecution.mock.calls.length;
      await act(async () => {
        if (outcome === "resolve") old.resolve();
        else old.reject(new ApiError("old network failure", "network_error", null));
      });
      expect(result.current[busy]).toBe(true);
      expect(result.current.error).toBeNull();
      expect(result.current.execution).toEqual(seed);
      expect(result.current.reconcilingStop).toBe(false);
      expect(result.current.reconcilingDetach).toBe(false);
      expect(getExecution).toHaveBeenCalledTimes(polls);
      await act(async () => current.reject(new ApiError("new failure", "request_failed", 400)));
      expect(result.current[busy]).toBe(false);
      expect(result.current.error).toBe("new failure");
      unmount();
    });

  it("fetches 1, 1, 2, 3 times across first, unchanged, changed and terminal-unchanged observations", async () => {
    const { hook, getExecution, getResults } = setup();
    const { result } = hook();
    await flush();
    expect(getResults).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 4; index++) await poll();
    expect(getExecution).toHaveBeenCalledTimes(5);
    expect(getResults).toHaveBeenCalledTimes(1);
    getExecution.mockImplementation(async () => observation([1, 0, 0]));
    getResults.mockResolvedValue({ run_id: "a", results: listed([1, 0, 0]) });
    await poll();
    expect(getResults).toHaveBeenCalledTimes(2);
    getExecution.mockImplementation(async () => observation([1, 0, 0], "succeeded"));
    await poll();
    expect(getResults).toHaveBeenCalledTimes(3);
    expect(getExecution).toHaveBeenCalledTimes(7);
    expect(result.current.polling).toBe(false);
    await poll();
    expect(getExecution).toHaveBeenCalledTimes(7);
  });

  it.each(["stopAfterCurrentJob", "detachFromCurrentJob"] as const)("resets pending %s reconciliation on replacement", async (action) => {
    const { api, hook, getExecution } = setup();
    vi.spyOn(api, action === "stopAfterCurrentJob" ? "cancelRun" : "detachRun")
      .mockRejectedValue(new ApiError("ambiguous old action", "network_error", null));
    const { result, rerender } = hook();
    await flush();
    await act(async () => { await result.current[action](); });
    expect(result.current[action === "stopAfterCurrentJob" ? "reconcilingStop" : "reconcilingDetach"]).toBe(true);
    const seed = observation([0, 0, 0], "running", true, "b");
    const nextPoll = deferred<ExecutionResponse>();
    getExecution.mockImplementationOnce(() => nextPoll.promise).mockResolvedValue(seed);
    rerender({ currentRun: run("b"), seed });
    await flush();
    expect(result.current.reconcilingStop).toBe(false);
    expect(result.current.reconcilingDetach).toBe(false);
    expect(result.current.error).toBeNull();
    await act(async () => nextPoll.resolve(seed));
    expect(result.current.error).toBeNull();
    expect(result.current.polling).toBe(true);
  });

  it.each(["start", "discard"] as const)("does not carry %s created-state reconciliation into a new Run", async (action) => {
    const { api, hook, getExecution } = setup(created());
    vi.spyOn(api, "startRun").mockRejectedValue(new ApiError("ambiguous start", "network_error", null));
    vi.spyOn(api, "discardRun").mockRejectedValue(new ApiError("not pristine", "run_discard_not_eligible", 409));
    const { result, rerender } = hook();
    await flush();
    await act(async () => { await result.current[action](); });
    await poll();
    expect(result.current.polling).toBe(true);
    const seed = { ...created("b"), execution_task_active: true };
    getExecution.mockResolvedValue(seed);
    rerender({ currentRun: run("b"), seed });
    await flush();
    for (let index = 0; index < 3; index++) await poll();
    expect(result.current.polling).toBe(true);
    expect(result.current.createdUnavailable).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("starts a new Run with its own execution failure budget", async () => {
    const { hook, getExecution } = setup();
    const { result, rerender } = hook();
    await flush();
    getExecution.mockRejectedValue(new ApiError("old poll failed", "network_error", null));
    await poll();
    await poll();
    expect(result.current.polling).toBe(true);
    const seed = observation([0, 0, 0], "running", true, "b");
    getExecution.mockRejectedValueOnce(new ApiError("new poll failed", "network_error", null)).mockResolvedValue(seed);
    rerender({ currentRun: run("b"), seed });
    await flush();
    expect(result.current.polling).toBe(true);
    expect(result.current.error).toBe("Network error: new poll failed");
    await poll();
    expect(result.current.error).toBeNull();
    expect(result.current.execution).toEqual(seed);
  });

  it("does not reset live execution when the same Run loses its recovery seed", async () => {
    const { hook, getExecution } = setup();
    const { result, rerender } = hook();
    await flush();
    rerender({ currentRun: run(), seed: null });
    await flush();
    expect(result.current.execution?.status).toBe("running");
    expect(result.current.polling).toBe(true);
    await poll();
    expect(getExecution).toHaveBeenCalledTimes(2);
  });

  it("clears old created-state ineligibility and errors for a replacement Run", async () => {
    const { api, hook } = setup(created());
    vi.spyOn(api, "discardRun").mockRejectedValue(new ApiError("not pristine", "run_discard_not_eligible", 409));
    const start = vi.spyOn(api, "startRun").mockRejectedValue(new ApiError("new start failed", "request_failed", 400));
    const { result, rerender } = hook();
    await flush();
    await act(async () => { await result.current.discard(); });
    await poll();
    await poll();
    expect(result.current.createdUnavailable).toBe(true);
    expect(result.current.error).not.toBeNull();
    rerender({ currentRun: run("b"), seed: null });
    await flush();
    expect(result.current.createdUnavailable).toBe(false);
    expect(result.current.error).toBeNull();
    await act(async () => { await result.current.start(); });
    expect(start).toHaveBeenCalledExactlyOnceWith("b");
    expect(result.current.error).toBe("new start failed");
  });

  it("compares each ordinal/count rather than aggregate totals, including recovered observations", async () => {
    const { hook, getResults, getExecution } = setup(observation([1, 0, 0]));
    const { rerender } = hook();
    await flush();
    getExecution.mockImplementation(async () => observation([0, 1, 0]));
    getResults.mockResolvedValue({ run_id: "a", results: listed([0, 1, 0]) });
    await poll();
    expect(getResults).toHaveBeenCalledTimes(2);
    rerender({ currentRun: run(), seed: observation([0, 1, 0]) });
    await flush();
    expect(getResults).toHaveBeenCalledTimes(2);
    getExecution.mockImplementation(async () => observation([1, 0, 0]));
    getResults.mockResolvedValue({ run_id: "a", results: listed([1, 0, 0]) });
    rerender({ currentRun: run(), seed: observation([1, 0, 0]) });
    await flush();
    expect(getResults).toHaveBeenCalledTimes(3);
  });

  it.each(["terminal", "inactive"])("always lists first %s observation with zero Results", async (kind) => {
    const initial = observation([0, 0, 0], kind === "terminal" ? "succeeded" : "running", false);
    const { hook, getExecution, getResults } = setup(initial);
    const { result } = hook();
    await flush();
    expect(getResults).toHaveBeenCalledTimes(1);
    expect(getExecution).not.toHaveBeenCalled();
    expect(result.current.executionControlUnavailable).toBe(kind === "inactive");
  });

  it("refreshes on active ownership loss without calling durable running terminal", async () => {
    const { hook, getExecution, getResults } = setup();
    const { result } = hook();
    await flush();
    getExecution.mockImplementation(async () => observation([0, 0, 0], "running", false));
    await poll();
    expect(getResults).toHaveBeenCalledTimes(2);
    expect(result.current.execution?.status).toBe("running");
    expect(result.current.executionControlUnavailable).toBe(true);
    expect(result.current.polling).toBe(false);
  });

  it("coalesces multiple changes and terminal state behind a slow request; final work survives polling cleanup", async () => {
    const first = deferred<ResultsResponse>();
    const final = deferred<ResultsResponse>();
    const { hook, getExecution, getResults } = setup();
    getResults.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => final.promise);
    const { result } = hook();
    await flush();
    for (const counts of [[1, 0, 0], [1, 1, 0]]) {
      getExecution.mockImplementation(async () => observation(counts));
      await poll();
    }
    getExecution.mockImplementation(async () => observation([1, 1, 0], "succeeded"));
    await poll();
    expect(result.current.execution?.status).toBe("succeeded");
    expect(result.current.polling).toBe(false);
    expect(getResults).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve({ run_id: "a", results: [] }));
    expect(getResults).toHaveBeenCalledTimes(2);
    expect(getResults.mock.calls[1][1]?.aborted).toBe(false);
    await act(async () => final.resolve({ run_id: "a", results: listed([1, 1, 0]) }));
    expect(result.current.results).toEqual(listed([1, 1, 0]));
    await poll();
    expect(getResults).toHaveBeenCalledTimes(2);
  });

  it("does not queue trailing work for unchanged polls during a slow request", async () => {
    const pending = deferred<ResultsResponse>();
    const { hook, getExecution, getResults } = setup();
    getResults.mockImplementationOnce(() => pending.promise);
    hook();
    await flush();
    for (let index = 0; index < 5; index++) await poll();
    expect(getExecution).toHaveBeenCalledTimes(6);
    await act(async () => pending.resolve({ run_id: "a", results: [] }));
    await poll();
    expect(getResults).toHaveBeenCalledTimes(1);
  });

  it("retries a failed refresh only on a later successful execution poll, even with unchanged counts", async () => {
    const pending = deferred<ResultsResponse>();
    const { hook, getExecution, getResults } = setup(observation([1, 0, 0]), [artifact]);
    getResults.mockImplementationOnce(() => pending.promise);
    const { result } = hook();
    await flush();
    await act(async () => pending.reject(new Error("listing failed")));
    expect(result.current.resultsError).toBe("listing failed");
    expect(result.current.results).toEqual([artifact]);
    expect(getResults).toHaveBeenCalledTimes(1);
    getExecution.mockRejectedValueOnce(new ApiError("offline", "network_error", null));
    await poll();
    expect(getResults).toHaveBeenCalledTimes(1);
    await poll();
    expect(getResults).toHaveBeenCalledTimes(2);
    expect(result.current.resultsError).toBeNull();
  });

  it("retains Results on final failure and allows manual recovery without a retry loop", async () => {
    const { hook, getExecution, getResults } = setup(observation([1, 0, 0]), [artifact]);
    const { result } = hook();
    await flush();
    getExecution.mockImplementation(async () => observation([1, 0, 0], "succeeded"));
    getResults.mockRejectedValueOnce(new Error("final failed"));
    await poll();
    expect(result.current.resultsError).toBe("final failed");
    expect(result.current.results).toEqual([artifact]);
    await poll();
    expect(getResults).toHaveBeenCalledTimes(2);
    await act(async () => result.current.refreshResults());
    expect(getResults).toHaveBeenCalledTimes(3);
    expect(result.current.resultsError).toBeNull();
    expect(result.current.refreshingResults).toBe(false);
  });

  it("coalesces manual refresh during automatic work and bounds followups after failures", async () => {
    const pending = deferred<ResultsResponse>();
    const { hook, getResults } = setup();
    getResults.mockImplementationOnce(() => pending.promise).mockRejectedValueOnce(new Error("followup failed"));
    const { result } = hook();
    await flush();
    act(() => { result.current.refreshResults(); result.current.refreshResults(); });
    expect(getResults).toHaveBeenCalledTimes(1);
    expect(result.current.refreshingResults).toBe(true);
    await act(async () => pending.reject(new Error("first failed")));
    expect(getResults).toHaveBeenCalledTimes(2);
    expect(result.current.resultsError).toBe("followup failed");
    expect(result.current.refreshingResults).toBe(false);
    await flush();
    expect(getResults).toHaveBeenCalledTimes(2);
  });

  it.each(["stopAfterCurrentJob", "detachFromCurrentJob"] as const)("coordinates %s rejection without blocking controls on Results", async (action) => {
    const pending = deferred<ResultsResponse>();
    const final = deferred<ResultsResponse>();
    const { api, hook, getExecution, getResults } = setup();
    vi.spyOn(api, action === "stopAfterCurrentJob" ? "cancelRun" : "detachRun")
      .mockRejectedValue(new ApiError("not eligible", "run_cancellation_not_eligible", 409));
    getResults.mockImplementationOnce(() => pending.promise).mockImplementationOnce(() => final.promise);
    const { result } = hook();
    await flush();
    await poll();
    expect(getExecution).toHaveBeenCalledTimes(2);
    getExecution.mockImplementation(async () => observation([0, 0, 0], "succeeded"));
    await act(async () => { await result.current[action](); });
    expect(result.current.execution?.status).toBe("succeeded");
    expect(result.current.requestingStop).toBe(false);
    expect(result.current.requestingDetach).toBe(false);
    expect(result.current.polling).toBe(false);
    expect(getResults).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ run_id: "a", results: [] }));
    expect(getResults).toHaveBeenCalledTimes(2);
    await act(async () => final.resolve({ run_id: "a", results: [] }));
    expect(result.current.resultsError).toBeNull();
  });

  it.each(["success", "failure"])("ignores old Run late %s and cleanup without clearing new busy state or launching old queued work", async (outcome) => {
    const old = deferred<ResultsResponse>();
    const current = deferred<ResultsResponse>();
    const { hook, getResults } = setup(observation([0, 0, 0], "succeeded"));
    getResults.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
    const { result, rerender } = hook();
    await flush();
    act(() => result.current.refreshResults());
    const oldSignal = getResults.mock.calls[0][1];
    rerender({ currentRun: run("b"), seed: observation([0, 0, 0], "succeeded", false, "b") });
    await flush();
    act(() => result.current.refreshResults());
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      if (outcome === "success") old.resolve({ run_id: "a", results: [artifact] });
      else old.reject(new Error("old failure"));
    });
    expect(result.current.refreshingResults).toBe(true);
    expect(result.current.resultsError).toBeNull();
    expect(result.current.results).toEqual([]);
    expect(getResults.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    await act(async () => current.resolve({ run_id: "b", results: [] }));
    expect(getResults.mock.calls.map(([id]) => id)).toEqual(["a", "b", "b"]);
    expect(result.current.refreshingResults).toBe(false);
  });

  it.each(["success", "failure"])("aborts on unmount and discards queued work after late %s", async (outcome) => {
    const pending = deferred<ResultsResponse>();
    const { hook, getResults } = setup();
    getResults.mockImplementationOnce(() => pending.promise);
    const { result, unmount } = hook();
    await flush();
    act(() => result.current.refreshResults());
    unmount();
    expect(getResults.mock.calls[0][1]?.aborted).toBe(true);
    await act(async () => {
      if (outcome === "success") pending.resolve({ run_id: "a", results: [artifact] });
      else pending.reject(new Error("late failure"));
    });
    expect(getResults).toHaveBeenCalledTimes(1);
  });
});
