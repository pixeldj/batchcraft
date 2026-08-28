import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import App from "./App";
import { ApiError, type BatchcraftApi } from "./api/client";
import type {
  ExecutionResponse,
  PreviewResponse,
  ResultResponse,
  RunCreatedResponse,
} from "./api/types";

describe("ComfyUI status", () => {
  it("shows a reachable server and device", async () => {
    const api = makeApi();
    render(<App api={api} />);

    expect(await screen.findByText("ComfyUI Online")).toBeInTheDocument();
    expect(screen.getByText("0.31.0")).toBeInTheDocument();
    expect(screen.getByText("Test GPU")).toBeInTheDocument();
  });

  it("shows an unavailable server without disabling Batch editing", async () => {
    const api = makeApi({
      getComfyUIStatus: vi.fn(async () => ({
        reachable: false,
        version: null,
        devices: [],
        diagnostic: "cannot connect to ComfyUI",
      })),
    });
    render(<App api={api} />);

    expect(await screen.findByText("ComfyUI Offline")).toBeInTheDocument();
    expect(screen.getByText("cannot connect to ComfyUI")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview Batch" })).toBeEnabled();
  });
});

describe("Batch preview", () => {
  it("builds the API request and renders Jobs and compiler warnings", async () => {
    const api = makeApi({ previewBatch: vi.fn(async () => previewResponse()) });
    render(<App api={api} />);
    enterAsset();

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    expect(await screen.findByText("Compiler warnings")).toBeInTheDocument();
    expect(screen.getByText("Unused binding variable")).toBeInTheDocument();
    expect(screen.getByText("A studio portrait of cat.")).toBeInTheDocument();
    expect(screen.getByText("subject = cat")).toBeInTheDocument();
    const request = vi.mocked(api.previewBatch).mock.calls[0][0];
    expect(request.references).toEqual([{ asset_id: "asset-1" }]);
    expect(request.seeds).toEqual({ mode: "fixed", values: [1] });
    expect(request.variable_bindings[0]).toEqual(
      expect.objectContaining({ placeholder: "subject", selected_values: ["cat", "dog"] }),
    );
  });

  it("renders backend validation errors near the Batch editor", async () => {
    const api = makeApi({
      previewBatch: vi.fn(async () => {
        throw new ApiError("Selected value is not in the Variable List", "invalid_batch", 422);
      }),
    });
    render(<App api={api} />);
    enterAsset();

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    expect(
      await screen.findByText("Selected value is not in the Variable List"),
    ).toBeInTheDocument();
  });

  it("rejects invalid workflow and Workflow Profile JSON before fetching", async () => {
    const api = makeApi();
    render(<App api={api} />);
    enterAsset();

    fireEvent.change(screen.getByLabelText("Workflow JSON"), { target: { value: "{" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    expect(await screen.findByText(/Workflow JSON is invalid/)).toBeInTheDocument();
    expect(api.previewBatch).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Workflow JSON"), { target: { value: "{}" } });
    fireEvent.change(screen.getByLabelText("Workflow Profile JSON"), {
      target: { value: "[]" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    expect(await screen.findByText("Workflow Profile JSON must have an object at its root.")).toBeInTheDocument();
    expect(api.previewBatch).not.toHaveBeenCalled();
  });

  it("does not restore a stale preview after the form changes", async () => {
    const pendingPreview = deferred<PreviewResponse>();
    const api = makeApi({ previewBatch: vi.fn(() => pendingPreview.promise) });
    render(<App api={api} />);
    enterAsset();
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    fireEvent.change(screen.getByLabelText("Batch name"), {
      target: { value: "Changed while previewing" },
    });
    pendingPreview.resolve(previewResponse());

    await waitFor(() => expect(screen.getByRole("button", { name: "Preview Batch" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
  });
});

describe("Run creation", () => {
  it("creates a Run from the current form and renders durable metadata", async () => {
    const api = makeApi({ previewBatch: vi.fn(async () => previewResponse()) });
    render(<App api={api} />);
    await reachPreview();

    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    expect(await screen.findByRole("heading", { name: "Run 7" })).toBeInTheDocument();
    expect(screen.getByText("run-123")).toBeInTheDocument();
    expect(screen.getByText("Created · Ready to start")).toBeInTheDocument();
    expect(api.createRun).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Run Created" })).toBeDisabled();
  });

  it("renders Run creation errors", async () => {
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      createRun: vi.fn(async () => {
        throw new ApiError("Project assets were not found: asset-1", "project_asset_not_found", 404);
      }),
    });
    render(<App api={api} />);
    await reachPreview();

    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    expect(await screen.findByText("Project assets were not found: asset-1")).toBeInTheDocument();
  });
});

describe("Run execution polling", () => {
  it("starts the Run, renders progress, and stops polling on success", async () => {
    const secondPoll = deferred<ExecutionResponse>();
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      getExecution: vi
        .fn<BatchcraftApi["getExecution"]>()
        .mockResolvedValueOnce(execution("running"))
        .mockImplementationOnce(() => secondPoll.promise),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    expect(await screen.findByText("Running · Job 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("prompt-1")).toBeInTheDocument();
    expect(api.startRun).toHaveBeenCalledWith("run-123");

    await waitFor(() => expect(api.getExecution).toHaveBeenCalledTimes(2));
    secondPoll.resolve(execution("succeeded"));
    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
    await pause(20);
    expect(api.getExecution).toHaveBeenCalledTimes(2);
  });

  it.each(["failed", "blocked"] as const)("stops polling on %s", async (status) => {
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      getExecution: vi.fn(async () => execution(status)),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    expect(await screen.findByText(status === "failed" ? "Failed" : "Blocked")).toBeInTheDocument();
    if (status === "failed") {
      expect(screen.getAllByText("generation failed").length).toBeGreaterThan(0);
    } else {
      expect(screen.getByText(/Automatic execution stopped/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Retry/i })).not.toBeInTheDocument();
    }
    await pause(20);
    expect(api.getExecution).toHaveBeenCalledOnce();
  });

  it("does not overlap execution polls", async () => {
    const firstPoll = deferred<ExecutionResponse>();
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      getExecution: vi
        .fn<BatchcraftApi["getExecution"]>()
        .mockImplementationOnce(() => firstPoll.promise)
        .mockResolvedValueOnce(execution("succeeded")),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    await waitFor(() => expect(api.getExecution).toHaveBeenCalledOnce());
    await pause(20);
    expect(api.getExecution).toHaveBeenCalledOnce();

    firstPoll.resolve(execution("running"));
    await waitFor(() => expect(api.getExecution).toHaveBeenCalledTimes(2));
  });

  it("observes durable state after an ambiguous Start network failure", async () => {
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      startRun: vi.fn(async () => {
        throw new ApiError("Cannot reach the batchcraft API", "network_error", null);
      }),
      getExecution: vi.fn(async () => execution("succeeded")),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
    expect(api.getExecution).toHaveBeenCalledOnce();
  });

  it("allows Start again when an ambiguous request leaves the Run created", async () => {
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      startRun: vi.fn(async () => {
        throw new ApiError("Cannot reach the batchcraft API", "network_error", null);
      }),
      getExecution: vi.fn(async () => execution("created")),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    expect(
      await screen.findByText("The Run remains created. The Start request was not observed; it is safe to start again."),
    ).toBeInTheDocument();
    expect(api.getExecution).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "Start Run" })).toBeEnabled();
  });
});

describe("Results", () => {
  it("renders ordered image and non-image artifacts with metadata", async () => {
    const artifacts: ResultResponse[] = [
      result(1, 1, "image/png", "first.png", 2048),
      result(1, 2, "application/json", "metadata.json", 512),
      result(2, 1, "image/jpeg", "second.jpg", 4096),
    ];
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({ run_id: "run-123", results: artifacts })),
    });
    const { container } = render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const firstImage = await screen.findByAltText("Result 1 from Job 1: first.png");
    expect(firstImage).toHaveAttribute("src", "http://api.test/api/result/1/1");
    expect(screen.getByRole("link", { name: /JSON\s*Open artifact/ })).toHaveAttribute(
      "href",
      "http://api.test/api/result/1/2",
    );
    expect(screen.getByText("metadata.json")).toBeInTheDocument();
    expect(screen.getByText("512 B")).toBeInTheDocument();

    const cards = container.querySelectorAll(".result-card");
    expect(cards).toHaveLength(3);
    expect(within(cards[0] as HTMLElement).getByText("first.png")).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText("metadata.json")).toBeInTheDocument();
    expect(within(cards[2] as HTMLElement).getByText("second.jpg")).toBeInTheDocument();
  });

  it("can refresh Results after a terminal fetch failure", async () => {
    const artifact = result(1, 1, "image/png", "recovered.png", 1024);
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi
        .fn<BatchcraftApi["getResults"]>()
        .mockRejectedValueOnce(new ApiError("Result index unavailable", "invalid_run_data", 500))
        .mockResolvedValueOnce({ run_id: "run-123", results: [artifact] }),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    expect(await screen.findByText("Results: Result index unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh Results" }));

    expect(await screen.findByAltText("Result 1 from Job 1: recovered.png")).toBeInTheDocument();
    expect(screen.queryByText("Results: Result index unavailable")).not.toBeInTheDocument();
  });
});

function makeApi(overrides: Partial<BatchcraftApi> = {}): BatchcraftApi {
  return {
    getComfyUIStatus: vi.fn(async () => ({
      reachable: true,
      version: "0.31.0",
      devices: ["Test GPU"],
      diagnostic: null,
    })),
    previewBatch: vi.fn(async () => previewResponse()),
    createRun: vi.fn(async () => runResponse()),
    startRun: vi.fn(async (runId: string) => ({ run_id: runId, status: "accepted" })),
    getExecution: vi.fn(async () => execution("succeeded")),
    getResults: vi.fn(async () => ({ run_id: "run-123", results: [] })),
    resultUrl: (url: string) => `http://api.test${url}`,
    ...overrides,
  };
}

function previewResponse(): PreviewResponse {
  return {
    job_count: 2,
    warnings: [
      { code: "unused_binding", message: "Unused binding variable", placeholder: "unused" },
    ],
    jobs: [
      {
        ordinal: 1,
        resolved_prompt: "A studio portrait of cat.",
        resolved_variables: [{ name: "subject", value: "cat" }],
        reference_asset_id: "asset-1",
        seed: 1,
      },
      {
        ordinal: 2,
        resolved_prompt: "A studio portrait of dog.",
        resolved_variables: [{ name: "subject", value: "dog" }],
        reference_asset_id: "asset-1",
        seed: 1,
      },
    ],
  };
}

function runResponse(): RunCreatedResponse {
  return {
    run_id: "run-123",
    run_number: 7,
    project_id: "project-1",
    project_name: "My Project",
    batch_id: "batch-1",
    batch_name: "First experiment",
    job_count: 2,
    durable_status: "created",
  };
}

function execution(status: ExecutionResponse["status"]): ExecutionResponse {
  const terminal = status === "succeeded" || status === "failed" || status === "blocked";
  return {
    run_id: "run-123",
    status,
    started_at: "2026-08-27T12:00:00Z",
    completed_at: terminal ? "2026-08-27T12:01:00Z" : null,
    current_job_ordinal: status === "running" ? 1 : null,
    error: status === "failed" ? "generation failed" : status === "blocked" ? "reconciliation required" : null,
    diagnostics: status === "blocked" ? ["submission outcome unknown"] : [],
    jobs: [
      {
        ordinal: 1,
        status: status === "running" ? "submitted" : status,
        prompt_id: "prompt-1",
        started_at: "2026-08-27T12:00:00Z",
        completed_at: terminal ? "2026-08-27T12:01:00Z" : null,
        error: status === "failed" ? "generation failed" : null,
        diagnostics: status === "blocked" ? ["submission outcome unknown"] : [],
        result_count: status === "succeeded" ? 2 : 0,
      },
      {
        ordinal: 2,
        status: status === "succeeded" ? "succeeded" : "pending",
        prompt_id: status === "succeeded" ? "prompt-2" : null,
        started_at: null,
        completed_at: terminal ? "2026-08-27T12:01:00Z" : null,
        error: null,
        diagnostics: [],
        result_count: status === "succeeded" ? 1 : 0,
      },
    ],
  };
}

function result(
  jobOrdinal: number,
  artifactOrdinal: number,
  contentType: string,
  filename: string,
  byteSize: number,
): ResultResponse {
  return {
    job_ordinal: jobOrdinal,
    artifact_ordinal: artifactOrdinal,
    producing_node_id: "41",
    output_name: "images",
    remote_filename: filename,
    content_type: contentType,
    byte_size: byteSize,
    sha256: "abc123",
    download_url: `/api/result/${jobOrdinal}/${artifactOrdinal}`,
  };
}

function enterAsset() {
  fireEvent.change(screen.getByLabelText("Project Asset ID 1"), {
    target: { value: "asset-1" },
  });
}

async function reachPreview() {
  enterAsset();
  fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
  await screen.findByRole("button", { name: "Create Run" });
}

async function createRunAndStart() {
  await reachPreview();
  fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
  await screen.findByRole("heading", { name: "Run 7" });
  fireEvent.click(screen.getByRole("button", { name: "Start Run" }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function pause(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
