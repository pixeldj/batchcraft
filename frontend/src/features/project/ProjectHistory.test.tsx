import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BatchcraftApi } from "../../api/client";
import type {
  HistoricalRunResponse,
  ProjectRunsResponse,
  ResultResponse,
  RunResponse,
} from "../../api/types";
import { ProjectHistory } from "./ProjectHistory";

describe("ProjectHistory", () => {
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
) {
  return (
    <ProjectHistory
      api={api}
      projectId={projectId}
      getCachedRun={() => null}
      loadRun={(runId) => api.getRun(runId)}
      loadRunAsBatch={loadRunAsBatch}
    />
  );
}

function makeApi(overrides: Partial<BatchcraftApi> = {}): BatchcraftApi {
  return {
    listProjectRuns: vi.fn(async (projectId: string) => ({ project_id: projectId, runs: [], diagnostics: [] })),
    reindexProject: vi.fn(),
    getResults: vi.fn(async (runId: string) => ({ run_id: runId, results: [] })),
    getRun: vi.fn(),
    startRun: vi.fn(),
    resultUrl: (url: string) => url,
    ...overrides,
  } as BatchcraftApi;
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
