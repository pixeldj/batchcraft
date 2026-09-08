import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { BatchcraftApi } from "../../api/client";
import type {
  HistoricalRunResponse,
  ProjectImportResponse,
  ProjectRunsResponse,
  ResultResponse,
  RunResponse,
} from "../../api/types";
import { ProjectHistory } from "./ProjectHistory";

describe("ProjectHistory", () => {
  it("loads twelve Runs with at most two outstanding Result reads, once each, preserving order", async () => {
    const runs = Array.from({ length: 12 }, (_, index) => historicalRun({
      run_id: `run-${index}`, run_name: `History ${index}`,
      batch_id: `batch-${index % 2}`, batch_name: `Experiment ${index % 2}`,
    }));
    const pending = runs.map(() => deferred<{ run_id: string; results: ResultResponse[] }>());
    let outstanding = 0;
    let maximum = 0;
    const api = makeApi({
      reindexProject: vi.fn(() => new Promise<ProjectImportResponse>(() => {})),
      listProjectRuns: vi.fn(async () => ({ project_id: "project-1", runs, diagnostics: [] })),
      getResults: vi.fn(async (runId: string) => {
        maximum = Math.max(maximum, ++outstanding);
        const response = await pending[runs.findIndex((run) => run.run_id === runId)].promise;
        outstanding--;
        return response;
      }),
    });
    renderHistory(api, "project-1");
    await waitFor(() => expect(api.getResults).toHaveBeenCalledTimes(2));
    // Complete the second worker first so completion order differs from display order.
    for (const index of [1, 0, 3, 2, 5, 4, 7, 6, 9, 8, 11, 10]) {
      await act(async () => pending[index].resolve({ run_id: runs[index].run_id, results: [] }));
      expect(outstanding).toBeLessThanOrEqual(2);
    }
    expect(maximum).toBe(2);
    expect(vi.mocked(api.getResults).mock.calls.map(([id]) => id)).toEqual(runs.map((run) => run.run_id));
    expect(screen.getAllByText("0 Results")).toHaveLength(12);
    for (const batch of [0, 1]) {
      const articles = within(screen.getByRole("region", { name: `Batch Experiment ${batch}` })).getAllByRole("article");
      expect(articles.map((article) => article.querySelector("strong")?.textContent))
        .toEqual(runs.filter((_, index) => index % 2 === batch).map((run) => run.run_name));
    }
    expect(api.reindexProject).toHaveBeenCalledTimes(1);
  });

  it.each(["switch", "unmount"])("stops queued Result reads after %s even when in-flight reads settle late", async (action) => {
    const pending = deferred<{ run_id: string; results: ResultResponse[] }>();
    const api = makeApi({
      reindexProject: vi.fn(() => new Promise<ProjectImportResponse>(() => {})),
      listProjectRuns: vi.fn(async (projectId: string) => ({
        project_id: projectId,
        runs: projectId === "old" ? Array.from({ length: 12 }, (_, index) => historicalRun({ run_id: `old-${index}` })) : [],
        diagnostics: [],
      })),
      getResults: vi.fn(() => pending.promise),
    });
    const view = renderHistory(api, "old");
    await waitFor(() => expect(api.getResults).toHaveBeenCalledTimes(2));
    if (action === "switch") view.rerender(history(api, "new"));
    else view.unmount();
    expect(vi.mocked(api.getResults).mock.calls.every(([, signal]) => signal?.aborted)).toBe(true);
    await act(async () => pending.resolve({ run_id: "old-0", results: [result()] }));
    expect(api.getResults).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(api.reindexProject).toHaveBeenCalledWith("old");
  });

  it("ignores stale Project and Result responses after Project switching", async () => {
    const oldHistory = deferred<ProjectRunsResponse>();
    const oldResults = deferred<{ run_id: string; results: ResultResponse[] }>();
    const api = makeApi({
      listProjectRuns: vi.fn((projectId: string) => projectId === "old"
        ? oldHistory.promise
        : Promise.resolve({
          project_id: "new",
          runs: [historicalRun({ run_id: "new-run", run_name: "New history" })],
          diagnostics: [],
        })),
      getResults: vi.fn((runId: string) => runId === "old-run"
        ? oldResults.promise
        : Promise.resolve({ run_id: runId, results: [] })),
    });
    const view = renderHistory(api, "old");

    view.rerender(history(api, "new"));
    expect(await screen.findByText("New history")).toBeInTheDocument();
    oldHistory.resolve({
      project_id: "old",
      runs: [historicalRun({ run_id: "old-run", run_name: "Stale history" })],
      diagnostics: [],
    });
    oldResults.resolve({ run_id: "old-run", results: [result()] });

    await waitFor(() => expect(screen.queryByText("Stale history")).not.toBeInTheDocument());
    expect(api.listProjectRuns).toHaveBeenCalledWith("old", expect.any(AbortSignal));
    expect(api.listProjectRuns).toHaveBeenCalledWith("new", expect.any(AbortSignal));
  });

  it("groups Runs by Batch and isolates unavailable and degraded history", async () => {
    const healthy = historicalRun({ run_id: "healthy", run_name: "Healthy run" });
    const degraded = historicalRun({
      run_id: "degraded",
      run_name: "Recovered run",
      execution_available: false,
      execution_status: null,
      integrity_status: "degraded",
      replayable: false,
    });
    const api = makeApi({
      listProjectRuns: vi.fn(async () => ({
        project_id: "project-1",
        runs: [healthy, degraded],
        diagnostics: [{
          scope: "result",
          filesystem_key: "outputs/missing.png",
          entity_id: "job-1:1",
          code: "missing_result",
          message: "Recorded Result is missing.",
        }],
      })),
      getResults: vi.fn(async (runId: string) => {
        if (runId === "degraded") throw new Error("result index unavailable");
        return { run_id: runId, results: [result()] };
      }),
    });
    renderHistory(api, "project-1");

    const batch = await screen.findByRole("region", { name: "Batch First experiment" });
    expect(within(batch).getByText("Healthy run")).toBeInTheDocument();
    expect(within(batch).getByText("Recovered run")).toBeInTheDocument();
    expect(await within(batch).findByText("1 Result")).toBeInTheDocument();
    expect(await within(batch).findByText("Result count unavailable")).toBeInTheDocument();
    expect(within(batch).getByText("Execution unavailable")).toBeInTheDocument();
    expect(within(batch).getByText("degraded")).toBeInTheDocument();
    fireEvent.click(screen.getByText("1 Project diagnostic"));
    expect(screen.getByText("Recorded Result is missing.")).toBeInTheDocument();
  });

  it("opens frozen Plan and Result details without exposing execution actions", async () => {
    const frozen = runResponse();
    const startRun = vi.fn();
    const api = makeApi({
      listProjectRuns: vi.fn(async () => ({
        project_id: "project-1",
        runs: [historicalRun()],
        diagnostics: [],
      })),
      getResults: vi.fn(async () => ({ run_id: "run-1", results: [result()] })),
      getRun: vi.fn(async () => frozen),
      startRun,
    });
    renderHistory(api, "project-1");

    const runRegion = await screen.findByRole("article");
    fireEvent.click(within(runRegion).getByRole("button", { name: "Open" }));
    fireEvent.click(await within(runRegion).findByRole("button", { name: "View Run Plan" }));
    const plan = screen.getByRole("dialog", { name: "Baseline Plan" });
    expect(plan).toBeInTheDocument();
    expect(within(plan).getAllByText("Base workflow · frozen-reference.png").length).toBeGreaterThan(0);
    expect(within(plan).getAllByText("Base workflow · 20").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    const card = runRegion.querySelector(".result-card");
    expect(card).not.toHaveTextContent(/Job|verified/i);
    fireEvent.click(within(runRegion).getByRole("button", { name: "Details for Job 1, artifact 1" }));
    const details = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(within(details).getByText("Base workflow · frozen-reference.png")).toBeInTheDocument();
    expect(within(details).getByText("Base workflow · 20")).toBeInTheDocument();
    fireEvent.click(within(details).getByText("Technical details"));
    expect(within(details).getByText("Job ordinal").nextElementSibling).toHaveTextContent("1");
    expect(within(details).getByText("Integrity").nextElementSibling).toHaveTextContent("verified");
    expect(screen.getByText(/A studio portrait of cat\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard Run" })).not.toBeInTheDocument();
    expect(startRun).not.toHaveBeenCalled();
  });

  it("offers Load Run as Batch only for replayable Runs", async () => {
    const loadRunAsBatch = vi.fn(async () => undefined);
    const api = makeApi({
      listProjectRuns: vi.fn(async () => ({
        project_id: "project-1",
        runs: [
          historicalRun({ run_id: "replayable", run_name: "Replayable", replayable: true }),
          historicalRun({ run_id: "degraded", run_name: "Degraded", replayable: false }),
        ],
        diagnostics: [],
      })),
      getRun: vi.fn(async () => runResponse()),
    });
    renderHistory(api, "project-1", loadRunAsBatch);

    const runs = await screen.findAllByRole("article");
    fireEvent.click(within(runs[0]).getByRole("button", { name: "Open" }));
    fireEvent.click(within(runs[1]).getByRole("button", { name: "Open" }));
    fireEvent.click(within(runs[0]).getByRole("button", { name: "Load Run as Batch" }));

    await waitFor(() => expect(loadRunAsBatch).toHaveBeenCalledWith("replayable"));
    expect(within(runs[1]).queryByRole("button", { name: "Load Run as Batch" })).not.toBeInTheDocument();
  });

  it("shows cached history and Results during the automatic scan, then refreshes without manual reindex", async () => {
    const scan = deferred<ProjectImportResponse>();
    const api = makeApi({
      reindexProject: vi.fn(() => scan.promise),
      listProjectRuns: vi.fn()
        .mockResolvedValueOnce({ project_id: "project-1", runs: [historicalRun({ execution_status: "running" })], diagnostics: [] })
        .mockResolvedValue({ project_id: "project-1", runs: [historicalRun()], diagnostics: [] }),
      getResults: vi.fn()
        .mockResolvedValueOnce({ run_id: "run-1", results: [result()] })
        .mockResolvedValue({ run_id: "run-1", results: [result(), { ...result(), artifact_ordinal: 2 }] }),
      getRun: vi.fn(async () => runResponse()),
    });
    renderHistory(api, "project-1");
    expect(await screen.findByText("running")).toBeInTheDocument();
    expect(await screen.findByText("1 Result")).toBeInTheDocument();
    expect(screen.getByText("Checking Project history...")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("img")).toBeInTheDocument();
    await act(async () => scan.resolve(importResponse("project-1")));
    expect(await screen.findByText("succeeded")).toBeInTheDocument();
    expect(await screen.findByText("2 Results")).toBeInTheDocument();
    expect(api.reindexProject).toHaveBeenCalledTimes(1);
  });

  it.each(["scan", "history", "results"])("retains known history and Results after a %s refresh failure and allows retry", async (failure) => {
    const api = makeApi({
      listProjectRuns: vi.fn(async () => ({ project_id: "project-1", runs: [historicalRun()], diagnostics: [] })),
      getResults: vi.fn(async () => ({ run_id: "run-1", results: [result()] })),
      getRun: vi.fn(async () => runResponse()),
    });
    renderHistory(api, "project-1");
    await waitFor(() => expect(api.listProjectRuns).toHaveBeenCalledTimes(2));
    await screen.findByText("1 Result");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("img")).toBeInTheDocument();
    const failing = failure === "scan" ? api.reindexProject : failure === "history" ? api.listProjectRuns : api.getResults;
    vi.mocked(failing).mockRejectedValueOnce(new Error("Storage unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Reindex Project" }));
    expect(await screen.findByText(/Use Reindex Project to retry|use Reindex Project to retry/)).toBeInTheDocument();
    expect(screen.getByText("Baseline")).toBeInTheDocument();
    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(screen.queryByText(/No indexed Runs|No Results were recorded/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reindex Project" }));
    await waitFor(() => expect(screen.queryByText(/Storage unavailable/)).not.toBeInTheDocument());
  });

  it("deduplicates StrictMode and rerenders, serializes lifecycle scans, and never imports", async () => {
    const scan = deferred<ProjectImportResponse>();
    const importProject = vi.fn();
    const api = makeApi({ reindexProject: vi.fn(() => scan.promise), importProject });
    const view = render(<StrictMode>{history(api, "project-1")}</StrictMode>);
    await waitFor(() => expect(api.reindexProject).toHaveBeenCalledTimes(1));
    view.rerender(<StrictMode>{history(api, "project-1")}</StrictMode>);
    await act(async () => {});
    expect(api.reindexProject).toHaveBeenCalledTimes(1);
    view.rerender(<StrictMode>{history(api, "project-1", undefined, 1)}</StrictMode>);
    await act(async () => {});
    expect(api.reindexProject).toHaveBeenCalledTimes(1);
    await act(async () => scan.resolve(importResponse("project-1")));
    await waitFor(() => expect(api.reindexProject).toHaveBeenCalledTimes(2));
    view.rerender(<StrictMode>{history(api, "project-1", undefined, 1)}</StrictMode>);
    await act(async () => {});
    expect(api.reindexProject).toHaveBeenCalledTimes(2);
    expect(importProject).not.toHaveBeenCalled();
  });

  it("ignores a late scan after switching Project", async () => {
    const scan = deferred<ProjectImportResponse>();
    const api = makeApi({
      reindexProject: vi.fn((id: string) => id === "old" ? scan.promise : Promise.resolve(importResponse(id))),
    });
    const view = renderHistory(api, "old");
    await waitFor(() => expect(api.reindexProject).toHaveBeenCalledWith("old"));
    view.rerender(history(api, "new"));
    await waitFor(() => expect(api.reindexProject).toHaveBeenCalledWith("new"));
    await act(async () => scan.resolve(importResponse("old")));
    expect(vi.mocked(api.listProjectRuns).mock.calls.filter(([id]) => id === "old")).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps pending Result workers bounded when a scan finishes before they do", async () => {
    const scan = deferred<ProjectImportResponse>();
    const runs = [historicalRun(), historicalRun({ run_id: "run-2" }), historicalRun({ run_id: "run-3" })];
    const pending: { id: string; resolve: (value: { run_id: string; results: ResultResponse[] }) => void }[] = [];
    let outstanding = 0;
    let maximum = 0;
    const api = makeApi({
      listProjectRuns: vi.fn(async () => ({ project_id: "project-1", runs, diagnostics: [] })),
      reindexProject: vi.fn(() => scan.promise),
      getResults: vi.fn(async (id: string) => {
        maximum = Math.max(maximum, ++outstanding);
        const read = deferred<{ run_id: string; results: ResultResponse[] }>();
        pending.push({ id, resolve: read.resolve });
        const response = await read.promise;
        outstanding--;
        return response;
      }),
    });
    renderHistory(api, "project-1");
    await waitFor(() => expect(api.getResults).toHaveBeenCalledTimes(2));
    await act(async () => scan.resolve(importResponse("project-1")));
    expect(api.getResults).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.getResults).mock.calls.every(([, signal]) => !signal?.aborted)).toBe(true);
    for (let index = 0; index < 5; index++) {
      await waitFor(() => expect(pending.length).toBeGreaterThan(index));
      await act(async () => pending[index].resolve({ run_id: pending[index].id, results: [] }));
    }
    expect(maximum).toBe(2);
    expect(vi.mocked(api.getResults).mock.calls.map(([id]) => id)).toEqual([...runs.slice(0, 2), ...runs].map((run) => run.run_id));
  });

  it("replaces previously verified Results with unavailable placeholders when integrity changes", async () => {
    const scan = deferred<ProjectImportResponse>();
    const api = makeApi({
      reindexProject: vi.fn(() => scan.promise),
      listProjectRuns: vi.fn(async () => ({ project_id: "project-1", runs: [historicalRun()], diagnostics: [] })),
      getResults: vi.fn()
        .mockResolvedValueOnce({ run_id: "run-1", results: [result()] })
        .mockResolvedValue({ run_id: "run-1", results: [{ ...result(), integrity_status: "corrupt" }] }),
      getRun: vi.fn(async () => runResponse()),
    });
    renderHistory(api, "project-1");
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(await screen.findByRole("img")).toBeInTheDocument();
    await act(async () => scan.resolve(importResponse("project-1")));
    expect(await screen.findByText("CORRUPT")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("does not describe a failed scan of an empty index as a confirmed empty Project", async () => {
    const api = makeApi({ reindexProject: vi.fn(async () => { throw new Error("Storage unavailable"); }) });
    renderHistory(api, "project-1");
    expect(await screen.findByRole("alert")).toHaveTextContent("history may be stale");
    expect(screen.queryByText(/No indexed Runs/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reindex Project" })).toBeEnabled();
  });

  it("retains metadata without images when execution disappears and an empty Result read succeeds", async () => {
    const scan = deferred<ProjectImportResponse>();
    const emptyResults = deferred<{ run_id: string; results: ResultResponse[] }>();
    const available = { project_id: "project-1", runs: [historicalRun()], diagnostics: [] };
    const api = makeApi({
      reindexProject: vi.fn(() => scan.promise),
      listProjectRuns: vi.fn()
        .mockResolvedValueOnce(available)
        .mockResolvedValueOnce({ ...available, runs: [historicalRun({ execution_available: false, execution_status: null })] })
        .mockImplementation(async () => ({ ...available })),
      getResults: vi.fn()
        .mockResolvedValueOnce({ run_id: "run-1", results: [result()] })
        .mockImplementationOnce(() => emptyResults.promise)
        .mockRejectedValueOnce(new Error("Result verification unavailable"))
        .mockResolvedValue({ run_id: "run-1", results: [result()] }),
      getRun: vi.fn(async () => runResponse()),
    });
    renderHistory(api, "project-1");
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(await screen.findByRole("img")).toBeInTheDocument();
    await act(async () => scan.resolve(importResponse("project-1")));
    expect(await screen.findByText("Execution unavailable")).toBeInTheDocument();
    // Hide images as soon as history reports unavailable execution, before the Result read settles.
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await act(async () => emptyResults.resolve({ run_id: "run-1", results: [] }));
    expect(screen.getByText(/Last known Result metadata is retained/)).toBeInTheDocument();
    expect(screen.getByText("Result count unavailable")).toBeInTheDocument();
    const metadata = screen.getByRole("list", { name: "Last known Results" });
    fireEvent.click(within(metadata).getByText("portrait.png (Job 1, artifact 1)"));
    expect(within(metadata).getByText("Last known integrity (not current verification)").nextElementSibling).toHaveTextContent("verified");
    expect(within(metadata).getByText("abc123")).toBeInTheDocument();
    expect(within(metadata).getByText("1024")).toBeInTheDocument();
    expect(within(metadata).queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByText("No Results were recorded for this Run.")).not.toBeInTheDocument();
    expect(screen.queryByText("0 Results")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reindex Project" }));
    expect(await screen.findByText(/Result verification unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Last known Results" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reindex Project" }));
    expect(await screen.findByRole("img")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Last known Results" })).not.toBeInTheDocument();
    expect(screen.getByText("1 Result")).toBeInTheDocument();
  });

  it("does not confirm no Results for initially unavailable execution with an empty successful listing", async () => {
    const api = makeApi({
      listProjectRuns: vi.fn(async () => ({
        project_id: "project-1",
        runs: [historicalRun({ execution_available: false, execution_status: null })],
        diagnostics: [],
      })),
      getRun: vi.fn(async () => runResponse()),
    });
    renderHistory(api, "project-1");
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    await waitFor(() => expect(api.getResults).toHaveBeenCalled());
    expect(screen.getByText(/No verified Result metadata is available in this view/)).toBeInTheDocument();
    expect(screen.getByText("Result count unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No Results were recorded for this Run.")).not.toBeInTheDocument();
    expect(screen.queryByText("0 Results")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it.each(["empty", "error"])("ignores an old available generation's delayed %s reply after accepting unavailable history", async (outcome) => {
    const scan = deferred<ProjectImportResponse>();
    const oldRead = deferred<{ run_id: string; results: ResultResponse[] }>();
    const unavailableRead = deferred<{ run_id: string; results: ResultResponse[] }>();
    const available = { project_id: "project-1", runs: [historicalRun()], diagnostics: [] };
    const api = makeApi({
      reindexProject: vi.fn(() => scan.promise),
      listProjectRuns: vi.fn()
        .mockResolvedValueOnce(available)
        .mockResolvedValueOnce(available)
        .mockResolvedValue({ ...available, runs: [historicalRun({ execution_available: false, execution_status: null })] }),
      getResults: vi.fn()
        .mockResolvedValueOnce({ run_id: "run-1", results: [result()] })
        .mockImplementationOnce(async () => {
          const response = await oldRead.promise;
          if (outcome === "error") throw new Error("Superseded Result error");
          return response;
        })
        .mockImplementationOnce(() => unavailableRead.promise),
      getRun: vi.fn(async () => runResponse()),
    });
    renderHistory(api, "project-1");
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(await screen.findByRole("img")).toBeInTheDocument();
    await act(async () => scan.resolve(importResponse("project-1")));
    await waitFor(() => expect(api.getResults).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Reindex Project" }));
    expect(await screen.findByText("Execution unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await act(async () => oldRead.resolve({ run_id: "run-1", results: [] }));
    await waitFor(() => expect(api.getResults).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("list", { name: "Last known Results" })).toHaveTextContent("portrait.png");
    expect(screen.queryByText(/Superseded Result error/)).not.toBeInTheDocument();
    await act(async () => unavailableRead.resolve({ run_id: "run-1", results: [] }));
    expect(screen.getByRole("list", { name: "Last known Results" })).toHaveTextContent("portrait.png");
    expect(screen.queryByText("No Results were recorded for this Run.")).not.toBeInTheDocument();
  });

  it("keeps the acceptance latch through available history, a superseded unavailable read, and a current read error", async () => {
    const scan = deferred<ProjectImportResponse>();
    const unavailableRead = deferred<{ run_id: string; results: ResultResponse[] }>();
    const failedRead = deferred<void>();
    const freshRead = deferred<{ run_id: string; results: ResultResponse[] }>();
    const available = { project_id: "project-1", runs: [historicalRun()], diagnostics: [] };
    const api = makeApi({
      reindexProject: vi.fn(() => scan.promise),
      listProjectRuns: vi.fn()
        .mockResolvedValueOnce(available)
        .mockResolvedValueOnce({ ...available, runs: [historicalRun({ execution_available: false, execution_status: null })] })
        .mockResolvedValue(available),
      getResults: vi.fn()
        .mockResolvedValueOnce({ run_id: "run-1", results: [result()] })
        .mockImplementationOnce(() => unavailableRead.promise)
        .mockImplementationOnce(async () => { await failedRead.promise; throw new Error("Current verification failed"); })
        .mockImplementationOnce(() => freshRead.promise),
      getRun: vi.fn(async () => runResponse()),
    });
    renderHistory(api, "project-1");
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(await screen.findByRole("img")).toBeInTheDocument();
    await act(async () => scan.resolve(importResponse("project-1")));
    await waitFor(() => expect(api.getResults).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Execution unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reindex Project" }));
    expect(await screen.findByText("succeeded")).toBeInTheDocument();
    expect(api.getResults).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Last known Results" })).toHaveTextContent("portrait.png");
    await act(async () => unavailableRead.resolve({ run_id: "run-1", results: [{ ...result(), remote_filename: "superseded.png" }] }));
    await waitFor(() => expect(api.getResults).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("list", { name: "Last known Results" })).not.toHaveTextContent("superseded.png");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await act(async () => failedRead.resolve());
    expect(await screen.findByText(/Current verification failed/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reindex Project" }));
    await waitFor(() => expect(api.getResults).toHaveBeenCalledTimes(4));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await act(async () => freshRead.resolve({ run_id: "run-1", results: [result()] }));
    expect(await screen.findByRole("img")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Last known Results" })).not.toBeInTheDocument();
  });
});

function renderHistory(
  api: BatchcraftApi,
  projectId: string | null,
  loadRunAsBatch: (runId: string) => Promise<void> = async () => undefined,
) {
  return render(history(api, projectId, loadRunAsBatch));
}

function history(
  api: BatchcraftApi,
  projectId: string | null,
  loadRunAsBatch: (runId: string) => Promise<void> = async () => undefined,
  historyRevision = 0,
) {
  return (
    <ProjectHistory
      api={api}
      projectId={projectId}
      historyRevision={historyRevision}
      getCachedRun={() => null}
      loadRun={(runId) => api.getRun(runId)}
      loadRunAsBatch={loadRunAsBatch}
    />
  );
}

function makeApi(overrides: Partial<BatchcraftApi> = {}): BatchcraftApi {
  return {
    getHistoryChoices: vi.fn(async (projectId: string) => ({ project_id: projectId, generation: null, items: [], has_more: false })),
    listProjectRuns: vi.fn(async (projectId: string) => ({ project_id: projectId, runs: [], diagnostics: [] })),
    reindexProject: vi.fn(async (id: string) => importResponse(id)),
    getResults: vi.fn(async (runId: string) => ({ run_id: runId, results: [] })),
    getRun: vi.fn(),
    startRun: vi.fn(),
    resultUrl: (url: string) => url,
    ...overrides,
  } as BatchcraftApi;
}

function importResponse(projectId: string): ProjectImportResponse {
  return { project_id: projectId, filesystem_key: projectId, name: projectId, batch_count: 1, asset_count: 0, run_count: 1, diagnostic_count: 0 };
}

function historicalRun(overrides: Partial<HistoricalRunResponse> = {}): HistoricalRunResponse {
  return {
    run_id: "run-1",
    batch_id: "batch-1",
    batch_filesystem_key: "batch_1",
    batch_name: "First experiment",
    run_number: 7,
    filesystem_key: "007-baseline",
    run_name: "Baseline",
    run_description: "Imported historical Run",
    created_at: "2026-08-27T12:00:00Z",
    job_count: 1,
    execution_available: true,
    execution_status: "succeeded",
    started_at: "2026-08-27T12:01:00Z",
    completed_at: "2026-08-27T12:02:00Z",
    integrity_status: "verified",
    replayable: true,
    ...overrides,
  };
}

function result(): ResultResponse {
  return {
    job_ordinal: 1,
    artifact_ordinal: 1,
    producing_node_id: "41",
    output_name: "images",
    remote_filename: "portrait.png",
    content_type: "image/png",
    byte_size: 1024,
    sha256: "abc123",
    integrity_status: "verified",
    download_url: "/api/runs/run-1/results/1/1",
  };
}

function runResponse(): RunResponse {
  const job = {
    ordinal: 1,
    prompt_version_id: "prompt-v1",
    prompt_version_name: "Portrait",
    resolved_prompt: "A studio portrait of cat.",
    resolved_variables: [{ name: "subject", value: "cat" }],
    resolved_image_inputs: [{ slot_key: "source", label: "Source image", asset_id: null, filename: null }],
    resolved_parameters: [{ parameter_key: "steps", label: "Steps", value: null }],
    resolved_parameter_sets: [],
    seed: 1,
  };
  return {
    run_id: "run-1",
    run_number: 7,
    run_name: "Baseline",
    run_description: "Imported historical Run",
    filesystem_key: "007-baseline",
    project_id: "project-1",
    project_name: "Project",
    batch_id: "batch-1",
    batch_name: "First experiment",
    job_count: 1,
    durable_status: "created",
    created_at: "2026-08-27T12:00:00Z",
    prompt_versions: [{ id: "prompt-v1", name: "Portrait", text: "A studio portrait of {{subject}}." }],
    jobs: [{ ordinal: 1, prompt_version_id: "prompt-v1" }],
    plan: { job_count: 1, warnings: [], jobs: [job] },
    batch_snapshot: {
      format: "batchcraft.batch-snapshot",
      format_version: 1,
      project: { id: "project-1", filesystem_key: "project_1", name: "Project" },
      source_saved_batch: null,
      batch: { id: "batch-1", filesystem_key: "batch_1", name: "First experiment", description: null },
      prompt_versions: [{
        id: "prompt-v1",
        prompt_id: null,
        version_number: null,
        name: "Portrait",
        text: "A studio portrait of {{subject}}.",
      }],
      variable_bindings: [{ placeholder: "subject", values: ["cat"] }],
      image_bindings: [{ slot_key: "source", values: [null] }],
      parameter_bindings: [{ parameter_key: "steps", mode: "values", values: [null] }],
      linked_parameter_sets: [],
      seed_intent: { mode: "fixed", values: [1], random_seed_count: null },
      workflow_selection: {
        workflow_id: null,
        workflow_version_id: null,
        workflow_name: null,
        workflow_version_number: null,
        workflow_profile_id: null,
        workflow_profile_version_id: null,
        workflow_profile_name: null,
        workflow_profile_version_number: null,
        workflow: {
          "10": { class_type: "LoadImage", inputs: { image: "frozen-reference.png" } },
          "11": { class_type: "KSampler", inputs: { steps: 20 } },
        },
        workflow_profile: {
          image_inputs: [{ key: "source", label: "Source image", node_id: "10", input_name: "image" }],
          parameters: [{ key: "steps", label: "Steps", node_id: "11", input_name: "steps", value_type: "integer" }],
        },
      },
    },
    execution: {
      run_id: "run-1",
      status: "succeeded",
      execution_task_active: false,
      started_at: "2026-08-27T12:01:00Z",
      completed_at: "2026-08-27T12:02:00Z",
      current_job_ordinal: null,
      error: null,
      diagnostics: [],
      jobs: [{
        ordinal: 1,
        status: "succeeded",
        prompt_id: "prompt-1",
        started_at: "2026-08-27T12:01:00Z",
        completed_at: "2026-08-27T12:02:00Z",
        error: null,
        diagnostics: [],
        result_count: 1,
      }],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
