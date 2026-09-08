import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import {
  ApiError,
  type BatchcraftApi,
  type RunCancellationApi,
  type RunDiscardApi,
} from "./api/client";
import type {
  AssetResponse,
  BatchReconstructionResponse,
  ExecutionResponse,
  HistoryResultPageResponse,
  HistoryProvenanceFilters,
  HistoryRunPageResponse,
  LibraryPromptVersion,
  PreviewResponse,
  ProjectResponse,
  ProjectPrompt,
  ResultResponse,
  RunCreatedResponse,
  RunResponse,
  SavedBatchDetail,
} from "./api/types";
import { editableBatchSnapshotToForm, initialBatchForm, newPrompt } from "./features/batch/form";
import { savedBatchToForm } from "./features/batch/savedBatch";
import {
  WORKING_SESSION_RECOVERY_KEY,
  loadWorkingSessionRecovery as loadWorkingSession,
  saveWorkingSessionRecovery as saveWorkingSession,
} from "./features/session/workingSessionRecovery";

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  window.history.replaceState(null, "", "/");
  vi.unstubAllEnvs();
  localStorage.clear();
  sessionStorage.clear();
  saveWorkingSession(populatedBatchForm(), null, "project-1");
});

describe("Session notices", () => {
  it.each(["", "Development - simulated ComfyUI"])("only shows an explicit instance label: %s", async (label) => {
    vi.stubEnv("VITE_BATCHCRAFT_INSTANCE", label);
    render(<App api={makeApi()} />);
    await screen.findByRole("button", { name: "Preview Batch" });
    expect(screen.queryByText("Everyday app")).not.toBeInTheDocument();
    if (label) expect(screen.getByText(label)).toBeInTheDocument();
    else expect(screen.queryByText("Development - simulated ComfyUI")).not.toBeInTheDocument();
  });

  it("dismisses the restored-draft notice without clearing the draft or verifying Preview", async () => {
    const api = makeApi();
    const view = render(<App api={api} />);
    await screen.findByText(/Draft restored from this browser/);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss session notification" }));
    expect(screen.queryByText(/Draft restored from this browser/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Batch name")).toHaveValue("First experiment");
    expect(loadWorkingSession().form.batchName).toBe("First experiment");
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
    expect(api.previewBatch).not.toHaveBeenCalled();

    view.unmount();
    render(<App api={api} />);
    expect(await screen.findByText(/Draft restored from this browser/)).toBeInTheDocument();
  });

  it("clears the restored-draft reminder after a successful current Preview", async () => {
    render(<App api={makeApi()} />);
    await screen.findByText(/Draft restored from this browser/);
    await reachPreview();
    expect(screen.queryByText(/Draft restored from this browser/)).not.toBeInTheDocument();
  });

  it("keeps the restored-draft reminder when Preview fails", async () => {
    render(<App api={makeApi({ previewBatch: vi.fn().mockRejectedValue(new Error("Preview unavailable")) })} />);
    const preview = await screen.findByRole("button", { name: "Preview Batch" });
    await waitFor(() => expect(preview).toBeEnabled());
    fireEvent.click(preview);
    await screen.findByText("Preview unavailable");
    expect(screen.getByText(/Draft restored from this browser/)).toBeInTheDocument();
  });

  it("keeps the reminder when an obsolete Preview finishes", async () => {
    const pending = deferred<PreviewResponse>();
    const api = makeApi({ previewBatch: vi.fn(() => pending.promise) });
    render(<App api={api} />);
    const preview = await screen.findByRole("button", { name: "Preview Batch" });
    await waitFor(() => expect(preview).toBeEnabled());
    fireEvent.click(preview);
    await waitFor(() => expect(api.previewBatch).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Batch name"), { target: { value: "Changed draft" } });
    await act(async () => pending.resolve(previewResponse()));
    expect(screen.getByText(/Draft restored from this browser/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
  });
});

describe("Workspace navigation", () => {
  it("retains the raw dirty Batch, Preview, Run metadata draft, and polling monitor across Gallery and Runs", async () => {
    const form = populatedBatchForm();
    form.batchId = "batch-1";
    form.batchFilesystemKey = "batch_1";
    saveWorkingSession(form, "run-123", "project-1", undefined, "batch-1", 1);
    const detail = savedBatchDetail();
    let status: ExecutionResponse["status"] = "running";
    const api = makeApi({
      getSavedBatch: vi.fn(async () => detail),
      listSavedBatches: vi.fn(async () => ({ batches: [detail] })),
      getRun: vi.fn(async () => runLookupResponse("running")),
      getExecution: vi.fn(async () => execution(status)),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await screen.findByText("Running · Job 1 of 2");
    await screen.findByText("Unsaved changes");
    await expandConfiguration("Variable bindings");
    const raw = "  fox  \n\n wolf \n";
    fireEvent.change(screen.getByLabelText("Values"), { target: { value: raw } });
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await screen.findByRole("button", { name: "Create Another Run" });
    fireEvent.change(screen.getByRole("textbox", { name: /Run Name/ }), { target: { value: "Next experiment" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Notes/ }), { target: { value: "Keep these notes" } });
    const preview = screen.getByRole("region", { name: "Preview" });
    const monitor = currentRunSection();
    const draft = localStorage.getItem(WORKING_SESSION_RECOVERY_KEY);
    expect(api.reindexProject).not.toHaveBeenCalled();
    expect(api.browseProjectResults).not.toHaveBeenCalled();
    expect(api.browseProjectRuns).not.toHaveBeenCalled();

    navigateWorkspace("Gallery");
    expect(preview).not.toBeVisible();
    expect(monitor).not.toBeVisible();
    const strip = screen.getByRole("region", { name: "Current Run" });
    expect(strip).toHaveTextContent("Run 7");
    expect(within(strip).getByText("running")).toBeVisible();
    const polls = vi.mocked(api.getExecution).mock.calls.length;
    await waitFor(() => expect(vi.mocked(api.getExecution).mock.calls.length).toBeGreaterThan(polls));
    await waitFor(() => expect(api.browseProjectResults).toHaveBeenCalledWith("project-1", expect.objectContaining({ limit: 48, cursor: null }), expect.any(AbortSignal)));

    navigateWorkspace("Runs");
    await waitFor(() => expect(api.browseProjectRuns).toHaveBeenCalledWith("project-1", expect.objectContaining({ limit: 25, cursor: null }), expect.any(AbortSignal)));
    status = "succeeded";
    expect(await within(screen.getByRole("region", { name: "Current Run" })).findByText("succeeded")).toBeVisible();
    navigateWorkspace("Batch");
    expect(screen.getByRole("region", { name: "Preview" })).toBe(preview);
    expect(preview).toBeVisible();
    expect(within(preview).getByText("A studio portrait of cat.")).toBeVisible();
    expect(within(preview).getByText("A studio portrait of dog.")).toBeVisible();
    expect(within(preview).getByRole("button", { name: "Create Another Run" })).toBeEnabled();
    expect(currentRunSection()).toBe(monitor);
    expect(within(monitor).getByText("Succeeded")).toBeVisible();
    expect(screen.getByLabelText("Values")).toHaveValue(raw);
    expect(screen.getByRole("textbox", { name: /Run Name/ })).toHaveValue("Next experiment");
    expect(screen.getByRole("textbox", { name: /Notes/ })).toHaveValue("Keep these notes");
    expect(screen.getByText("Unsaved changes")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(localStorage.getItem(WORKING_SESSION_RECOVERY_KEY)).toBe(draft);
    expect(loadWorkingSession().currentRunId).toBe("run-123");
    expect(api.previewBatch).toHaveBeenCalledOnce();
    expect(api.getRun).toHaveBeenCalledOnce();
    expect(api.startRun).not.toHaveBeenCalled();
    expect(api.listProjectRuns).not.toHaveBeenCalled();
  });

  it("keeps a newly started Run visible and polling in Gallery without restarting execution", async () => {
    let status: ExecutionResponse["status"] = "running";
    const api = makeApi({ getExecution: vi.fn(async () => execution(status)) });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    await screen.findByText("Running · Job 1 of 2");
    navigateWorkspace("Gallery");
    const strip = screen.getByRole("region", { name: "Current Run" });
    expect(strip).toBeVisible();
    expect(strip).toHaveTextContent("Run 7");
    expect(strip).toHaveTextContent("Job 1 of 2");
    expect(within(strip).getByText("running")).toBeVisible();
    const polls = vi.mocked(api.getExecution).mock.calls.length;
    await waitFor(() => expect(vi.mocked(api.getExecution).mock.calls.length).toBeGreaterThan(polls));
    status = "succeeded";
    expect(await within(strip).findByText("succeeded")).toBeVisible();
    expect(screen.getByRole("region", { name: "Project browser" })).toBeVisible();
    expect(api.startRun).toHaveBeenCalledExactlyOnceWith("run-123");
    expect(loadWorkingSession().currentRunId).toBe("run-123");
    expect(api.listProjectRuns).not.toHaveBeenCalled();
  });

  it("cancels then accepts historical Batch replacement, invalidating Preview only on acceptance", async () => {
    const frozen = runLookupResponse("succeeded", "historical-run", 12);
    frozen.batch_snapshot.batch.name = "Recovered experiment";
    const api = makeApi({
      browseProjectRuns: vi.fn(async () => projectRunsFor(frozen)),
      getRun: vi.fn(async () => frozen),
      getBatchReconstruction: vi.fn(async () => reconstructionFor(frozen)),
    });
    render(<App api={api} />);
    await reachPreview();
    fireEvent.change(screen.getByRole("textbox", { name: /Run Name/ }), { target: { value: "Keep until replaced" } });
    const draft = localStorage.getItem(WORKING_SESSION_RECOVERY_KEY);
    navigateWorkspace("Runs");
    const run = await screen.findByRole("article", { name: "Run 12" });
    fireEvent.click(within(run).getByRole("button", { name: "Load Run as Batch" }));
    const confirm = screen.getByRole("dialog", { name: "Replace unsaved Batch?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep editing" }));
    expect(api.getBatchReconstruction).not.toHaveBeenCalled();
    expect(localStorage.getItem(WORKING_SESSION_RECOVERY_KEY)).toBe(draft);
    navigateWorkspace("Batch");
    expect(screen.getByRole("button", { name: "Create Run" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: /Run Name/ })).toHaveValue("Keep until replaced");
    navigateWorkspace("Runs");
    fireEvent.click(within(await screen.findByRole("article", { name: "Run 12" })).getByRole("button", { name: "Load Run as Batch" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace Batch" }));
    expect(await screen.findByRole("textbox", { name: "Batch name" })).toHaveValue("Recovered experiment");
    expect(new URLSearchParams(window.location.search).get("view")).toBeNull();
    expect(screen.getByRole("region", { name: "Preview" })).toHaveTextContent("Preview required");
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Project browser" })).not.toBeInTheDocument();
    expect(loadWorkingSession().sourceRunId).toBe("historical-run");
    expect(api.previewBatch).toHaveBeenCalledOnce();
    expect(api.getBatchReconstruction).toHaveBeenCalledExactlyOnceWith("historical-run", expect.any(AbortSignal));
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it.each([false, true])("ignores a dismissed reconstruction even when its mock ignores abort (intervening edit: %s)", async (editDraft) => {
    const frozen = runLookupResponse("succeeded", "historical-run", 12);
    frozen.batch_snapshot.batch.name = "Must not replace the draft";
    const reconstruction = deferred<BatchReconstructionResponse>();
    const api = makeApi({
      browseProjectRuns: vi.fn(async () => projectRunsFor(frozen)),
      getRun: vi.fn(async () => frozen),
      getBatchReconstruction: vi.fn(() => reconstruction.promise),
    });
    render(<App api={api} />);
    await reachPreview();
    navigateWorkspace("Runs");
    const run = await screen.findByRole("article", { name: "Run 12" });
    fireEvent.click(within(run).getByRole("button", { name: "Load Run as Batch" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace Batch" }));
    await waitFor(() => expect(api.getBatchReconstruction).toHaveBeenCalledExactlyOnceWith("historical-run", expect.any(AbortSignal)));
    const signal = vi.mocked(api.getBatchReconstruction).mock.calls[0][1]!;
    expect(signal.aborted).toBe(false);
    fireEvent.click(within(screen.getByRole("dialog", { name: "History inspection" })).getByRole("button", { name: "Close" }));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    navigateWorkspace("Batch");
    if (editDraft) {
      fireEvent.change(screen.getByRole("textbox", { name: "Batch name" }), { target: { value: "Intervening draft" } });
      expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
      await screen.findByRole("button", { name: "Create Run" });
    }
    fireEvent.change(screen.getByRole("textbox", { name: /Run Name/ }), { target: { value: "Keep this Run name" } });
    const draft = localStorage.getItem(WORKING_SESSION_RECOVERY_KEY);
    const preview = screen.getByRole("region", { name: "Preview" });
    navigateWorkspace("Gallery");
    const destination = window.location.href;
    const pushState = vi.spyOn(window.history, "pushState");
    await act(async () => reconstruction.resolve(reconstructionFor(frozen)));

    expect(window.location.href).toBe(destination);
    expect(pushState).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Project browser" })).toBeVisible();
    expect(localStorage.getItem(WORKING_SESSION_RECOVERY_KEY)).toBe(draft);
    expect(loadWorkingSession().sourceRunId).toBeNull();
    expect(screen.queryByText(/loaded as an unsaved Batch draft/)).not.toBeInTheDocument();
    navigateWorkspace("Batch");
    expect(screen.getByRole("textbox", { name: "Batch name" })).toHaveValue(editDraft ? "Intervening draft" : "First experiment");
    expect(screen.getByRole("textbox", { name: /Run Name/ })).toHaveValue("Keep this Run name");
    expect(screen.getByRole("region", { name: "Preview" })).toBe(preview);
    expect(within(preview).getByText("A studio portrait of cat.")).toBeVisible();
    expect(within(preview).getByRole("button", { name: "Create Run" })).toBeEnabled();
    expect(api.previewBatch).toHaveBeenCalledTimes(editDraft ? 2 : 1);
    expect(api.createRun).not.toHaveBeenCalled();
  });

  it("opens Show Results with one atomic history entry and Back restores the unfiltered Runs URL", async () => {
    const frozen = runLookupResponse("succeeded", "historical-run", 12);
    const api = makeApi({
      browseProjectRuns: vi.fn(async () => projectRunsFor(frozen)),
      browseProjectResults: vi.fn(async () => projectResultsFor(frozen, [result(1, 1, "image/png", "history.png", 100)])),
    });
    render(<App api={api} />);
    navigateWorkspace("Runs");
    const run = await screen.findByRole("article", { name: "Run 12" });
    const runsUrl = window.location.href;
    expect(new URL(runsUrl).search).toBe("?view=runs");
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    fireEvent.click(within(run).getByRole("button", { name: "Show Results" }));
    const galleryUrl = window.location.href;
    expect(new URL(galleryUrl).searchParams.get("view")).toBe("gallery");
    expect(new URL(galleryUrl).searchParams.get("run")).toBe(frozen.run_id);
    expect(pushState).toHaveBeenCalledExactlyOnceWith(null, "", new URL(galleryUrl));
    expect(replaceState).not.toHaveBeenCalled();
    await waitFor(() => expect(api.browseProjectResults).toHaveBeenCalledWith("project-1", expect.objectContaining({ run_id: frozen.run_id, cursor: null, limit: 48 }), expect.any(AbortSignal)));
    expect(screen.getByRole("region", { name: "Project browser" })).toHaveTextContent("Clear Run filter");

    act(() => window.history.back());
    await waitFor(() => expect(window.location.href).toBe(runsUrl));
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "Workspace" })).getByRole("button", { name: "Runs" })).toHaveAttribute("aria-current", "page"));
    expect(await screen.findByRole("article", { name: "Run 12" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Clear Run filter/ })).not.toBeInTheDocument();
    expect(api.browseProjectRuns).toHaveBeenLastCalledWith("project-1", expect.objectContaining({ run_id: undefined, cursor: null, limit: 25 }), expect.any(AbortSignal));
    act(() => window.history.forward());
    await waitFor(() => expect(window.location.href).toBe(galleryUrl));
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "Workspace" })).getByRole("button", { name: "Gallery" })).toHaveAttribute("aria-current", "page"));
    expect(pushState).toHaveBeenCalledOnce();
    expect(replaceState).not.toHaveBeenCalled();
    expect(api.listProjectRuns).not.toHaveBeenCalled();
    expect(api.getRun).not.toHaveBeenCalled();
    expect(api.getResults).not.toHaveBeenCalled();
  });

  it("cold-loads Gallery from its URL without restoring Preview and handles Back and Forward", async () => {
    const api = makeApi();
    const first = render(<App api={api} />);
    await reachPreview();
    navigateWorkspace("Gallery");
    await screen.findByRole("region", { name: "Project browser" });
    first.unmount();
    const galleryReads = vi.mocked(api.browseProjectResults).mock.calls.length;
    render(<App api={api} />);
    expect(within(screen.getByRole("navigation", { name: "Workspace" })).getByRole("button", { name: "Gallery" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "Preview Batch" })).not.toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(api.browseProjectResults).mock.calls.length).toBeGreaterThan(galleryReads));
    navigateWorkspace("Runs");
    await waitFor(() => expect(api.browseProjectRuns).toHaveBeenCalled());
    act(() => window.history.back());
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "Workspace" })).getByRole("button", { name: "Gallery" })).toHaveAttribute("aria-current", "page"));
    act(() => window.history.forward());
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "Workspace" })).getByRole("button", { name: "Runs" })).toHaveAttribute("aria-current", "page"));
    navigateWorkspace("Batch");
    expect(screen.getByRole("textbox", { name: "Batch name" })).toHaveValue("First experiment");
    expect(screen.getByRole("region", { name: "Preview" })).toHaveTextContent("Preview required");
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
    expect(api.previewBatch).toHaveBeenCalledOnce();
    expect(api.listProjectRuns).not.toHaveBeenCalled();
    expect(api.getRun).not.toHaveBeenCalled();
    expect(api.getResults).not.toHaveBeenCalled();
  });
});

describe("Workspace provenance filters", () => {
  const basicParams = { q: "portrait & detail", sort: "oldest", run: "historical-run", batch: "batch-1", status: "failed", available: "false" };
  const basicQuery = { q: basicParams.q, sort: "oldest", run_id: basicParams.run, batch_id: basicParams.batch, execution_status: "failed", execution_available: false };
  const typedFilters: HistoryProvenanceFilters = {
    seed: 0,
    parameters: [
      { key: "flag", value_type: "boolean", mode: "equals", value: false },
      { key: "steps", value_type: "integer", mode: "equals", value: 0 },
      { key: "caption", value_type: "string", mode: "equals", value: "" },
      { key: "scale", value_type: "float", mode: "equals", value: 0.125 },
    ],
  };

  it.each(["gallery", "runs"] as const)("passes valid URL provenance and basic filters to %s browsing", async (view) => {
    const filters: HistoryProvenanceFilters = {
      ...typedFilters,
      prompt_version_id: "prompt revision / &",
      workflow_version_id: "workflow-v1",
      profile_version_id: "profile-v1",
      saved_batch_id: "saved-batch-1",
      image_inputs: [{ slot_key: "reference", mode: "base" }],
      created_from: "2026-09-07T12:00:00+05:30",
      created_before: "2026-09-08",
    };
    window.history.replaceState(null, "", `/?${new URLSearchParams({ ...basicParams, view, filters: JSON.stringify(filters) })}`);
    const api = makeApi();
    render(<App api={api} />);
    const browse = view === "gallery" ? api.browseProjectResults : api.browseProjectRuns;
    await waitFor(() => expect(browse).toHaveBeenCalledWith("project-1", {
      ...basicQuery, filters, limit: view === "gallery" ? 48 : 25, cursor: null,
    }, expect.any(AbortSignal)));
    for (const [, query] of vi.mocked(browse).mock.calls) expect(query?.filters).toEqual(filters);
    expect(view === "gallery" ? api.browseProjectRuns : api.browseProjectResults).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: 'Edit caption (string): ""' })).toBeVisible();
    expect(api.getHistoryChoices).not.toHaveBeenCalled();
    expect(api.listProjectRuns).not.toHaveBeenCalled();
  });

  it.each(["gallery", "runs"] as const)("passes raw float tokens and JSON-looking strings unchanged in scope to %s", async (view) => {
    const caption = '{"seed":1,"seed":2} [ ] \\ "value":1.0';
    const raw = `{"parameters":[{"value":9007199254740991.1,"key":"scale","mode":"equals","value_type":"float"},{"key":"caption","value_type":"string","mode":"equals","value":${JSON.stringify(caption)}}]}`;
    window.history.replaceState(null, "", `/?${new URLSearchParams({ ...basicParams, view, filters: raw })}`);
    const api = makeApi();
    render(<App api={api} />);
    const browse = view === "gallery" ? api.browseProjectResults : api.browseProjectRuns;
    await waitFor(() => expect(browse).toHaveBeenCalledWith("project-1", {
      ...basicQuery, filters: JSON.parse(raw), limit: view === "gallery" ? 48 : 25, cursor: null,
    }, expect.any(AbortSignal)));
    expect(new URLSearchParams(window.location.search).get("filters")).toBe(raw);
    expect(view === "gallery" ? api.browseProjectRuns : api.browseProjectResults).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Clear invalid filters" })).not.toBeInTheDocument();
  });

  it("changes and removes an advanced filter without losing any basic filter", async () => {
    window.history.replaceState(null, "", `/?${new URLSearchParams({ ...basicParams, view: "gallery", filters: JSON.stringify({ seed: 0 }) })}`);
    const api = makeApi();
    render(<App api={api} />);
    const edit = await screen.findByRole("button", { name: "Edit Seed: 0" });
    await waitFor(() => expect(edit).toBeEnabled());
    fireEvent.click(edit);
    fireEvent.change(screen.getByLabelText(/^Exact seed/), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    await waitFor(() => expect(api.browseProjectResults).toHaveBeenLastCalledWith("project-1", {
      ...basicQuery, filters: { seed: 7 }, limit: 48, cursor: null,
    }, expect.any(AbortSignal)));
    expect(JSON.parse(new URLSearchParams(window.location.search).get("filters")!)).toEqual({ seed: 7 });
    const remove = screen.getByRole("button", { name: "Remove Seed: 7" });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    await waitFor(() => expect(api.browseProjectResults).toHaveBeenLastCalledWith("project-1", {
      ...basicQuery, limit: 48, cursor: null,
    }, expect.any(AbortSignal)));
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({ ...basicParams, view: "gallery" });
    expect(screen.queryByRole("button", { name: /^Edit Seed:/ })).not.toBeInTheDocument();
  });

  it("restores false, zero, and empty-string types and editor values with Back and Forward", async () => {
    window.history.replaceState(null, "", `/?${new URLSearchParams({ ...basicParams, view: "gallery", filters: JSON.stringify(typedFilters) })}`);
    const api = makeApi();
    render(<App api={api} />);
    const clear = await screen.findByRole("button", { name: "Clear advanced" });
    await waitFor(() => expect(clear).toBeEnabled());
    const filteredUrl = window.location.href;
    fireEvent.click(clear);
    const clearedUrl = window.location.href;
    await waitFor(() => expect(api.browseProjectResults).toHaveBeenLastCalledWith("project-1", { ...basicQuery, limit: 48, cursor: null }, expect.any(AbortSignal)));
    act(() => window.history.back());
    await waitFor(() => expect(window.location.href).toBe(filteredUrl));
    await waitFor(() => expect(api.browseProjectResults).toHaveBeenLastCalledWith("project-1", { ...basicQuery, filters: typedFilters, limit: 48, cursor: null }, expect.any(AbortSignal)));
    for (const [name, text] of [["flag (boolean): false", "false"], ["steps (integer): 0", "0"], ['caption (string): ""', ""]]) {
      const edit = screen.getByRole("button", { name: `Edit ${name}` });
      await waitFor(() => expect(edit).toBeEnabled());
      fireEvent.click(edit);
      expect(screen.getByLabelText(/^Exact value/)).toHaveValue(text);
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    }
    expect(screen.getByRole("button", { name: "Edit Seed: 0" })).toBeVisible();
    act(() => window.history.forward());
    await waitFor(() => expect(window.location.href).toBe(clearedUrl));
    await waitFor(() => expect(api.browseProjectResults).toHaveBeenLastCalledWith("project-1", { ...basicQuery, limit: 48, cursor: null }, expect.any(AbortSignal)));
    expect(screen.queryByRole("button", { name: "Clear advanced" })).not.toBeInTheDocument();
  });

  it.each([
    ["invalid JSON", "{not-json"],
    ["unknown fields", JSON.stringify({ seed: 0, unknown: "must not be ignored" })],
    ["duplicate root keys", '{"seed":1,"seed":2}'],
    ["escaped duplicate root keys", '{"seed":1,"\\u0073eed":2}'],
    ["duplicate parameter keys", '{"parameters":[{"key":"steps","value_type":"integer","mode":"equals","value":1,"value":2}]}'],
    ["escaped duplicate Image Input keys", '{"image_inputs":[{"slot_key":"reference","mode":"base","\\u006dode":"asset","asset_id":"asset-1"}]}'],
    ["rounded fractional seed", '{"seed":9007199254740991.1}'],
    ["decimal seed", '{"seed":1.0}'],
    ["exponent seed", '{"seed":1e0}'],
    ["rounded fractional integer parameter", '{"parameters":[{"value":9007199254740991.1,"key":"steps","mode":"equals","value_type":"integer"}]}'],
    ["decimal integer parameter", '{"parameters":[{"key":"steps","value_type":"integer","mode":"equals","value":1.0}]}'],
    ["exponent integer parameter", '{"parameters":[{"value":1e0,"key":"steps","mode":"equals","value_type":"integer"}]}'],
    ["oversize JSON", `{"seed":0}${" ".repeat(16384)}`],
  ])("blocks both browse endpoints for %s until Clear invalid filters", async (_label, raw) => {
    window.history.replaceState(null, "", `/?${new URLSearchParams({ ...basicParams, view: "gallery", filters: raw })}`);
    const api = makeApi();
    render(<App api={api} />);
    await screen.findByText("ComfyUI Online");
    expect(screen.getByRole("alert")).toHaveTextContent("The history filters in this link are invalid");
    expect(screen.queryByRole("region", { name: "Project browser" })).not.toBeInTheDocument();
    navigateWorkspace("Runs");
    await screen.findByRole("alert");
    expect(new URLSearchParams(window.location.search).get("filters")).toBe(raw);
    expect(screen.getByRole("alert")).toHaveTextContent("Clear them to browse this Project");
    expect(api.browseProjectResults).not.toHaveBeenCalled();
    expect(api.browseProjectRuns).not.toHaveBeenCalled();
    expect(api.reindexProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear invalid filters" }));
    await waitFor(() => expect(api.browseProjectRuns).toHaveBeenLastCalledWith("project-1", {
      ...basicQuery, limit: 25, cursor: null,
    }, expect.any(AbortSignal)));
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({ ...basicParams, view: "runs" });
    expect(screen.queryByRole("button", { name: "Clear invalid filters" })).not.toBeInTheDocument();
    navigateWorkspace("Gallery");
    await waitFor(() => expect(api.browseProjectResults).toHaveBeenLastCalledWith("project-1", {
      ...basicQuery, limit: 48, cursor: null,
    }, expect.any(AbortSignal)));
  });

  it("retains raw Batch and Run metadata drafts and the same Preview through filter edits and removal", async () => {
    const api = makeApi();
    render(<App api={api} />);
    await expandConfiguration("Variable bindings");
    const raw = "  fox  \n\n wolf \n";
    fireEvent.change(screen.getByLabelText("Values"), { target: { value: raw } });
    await reachPreview();
    fireEvent.change(screen.getByRole("textbox", { name: /Run Name/ }), { target: { value: "Unsubmitted Run name" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Notes/ }), { target: { value: "Unsubmitted notes" } });
    const preview = screen.getByRole("region", { name: "Preview" });
    const draft = localStorage.getItem(WORKING_SESSION_RECOVERY_KEY);
    navigateWorkspace("Gallery");
    const add = await screen.findByRole("button", { name: "+ Add filter" });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    fireEvent.click(screen.getByRole("radio", { name: "Seed" }));
    fireEvent.change(screen.getByLabelText(/^Exact seed/), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    await waitFor(() => expect(api.browseProjectResults).toHaveBeenLastCalledWith("project-1", expect.objectContaining({ filters: { seed: 0 } }), expect.any(AbortSignal)));
    navigateWorkspace("Runs");
    const remove = screen.getByRole("button", { name: "Remove Seed: 0" });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    await waitFor(() => expect(api.browseProjectRuns).toHaveBeenLastCalledWith("project-1", expect.not.objectContaining({ filters: expect.anything() }), expect.any(AbortSignal)));
    navigateWorkspace("Batch");
    expect(screen.getByLabelText("Values")).toHaveValue(raw);
    expect(screen.getByRole("textbox", { name: /Run Name/ })).toHaveValue("Unsubmitted Run name");
    expect(screen.getByRole("textbox", { name: /Notes/ })).toHaveValue("Unsubmitted notes");
    expect(screen.getByRole("region", { name: "Preview" })).toBe(preview);
    expect(preview).toBeVisible();
    expect(within(preview).getByRole("button", { name: "Create Run" })).toBeEnabled();
    expect(localStorage.getItem(WORKING_SESSION_RECOVERY_KEY)).toBe(draft);
    expect(api.previewBatch).toHaveBeenCalledOnce();
    expect(api.createRun).not.toHaveBeenCalled();
  });
});

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

describe("Project selection", () => {
  it("loads imported Project history with empty localStorage", async () => {
    localStorage.clear();
    const imported = projectResponse();
    const api = makeApi({
      listProjects: vi.fn(async () => ({ projects: [imported] })),
      browseProjectRuns: vi.fn(async (projectId: string) => ({
        project_id: projectId,
        generation: "generation-1", scanned_at: "2026-08-20T12:00:00Z", next_cursor: null, has_more: false,
        items: [{ result_count: 0, run: {
          run_id: "imported-run",
          batch_id: "imported-batch",
          batch_name: "Imported Batch",
          run_number: 12,
          run_name: "Imported baseline",
          run_description_excerpt: null,
          display_truncated: false,
          created_at: "2026-08-20T12:00:00Z",
          job_count: 2,
          execution_available: false,
          execution_status: null,
          integrity_status: "verified" as const,
          replayable: true,
        } }],
      })),
      getResults: vi.fn(async () => ({ run_id: "imported-run", results: [] })),
    });
    render(<App api={api} />);

    fireEvent.change(await screen.findByRole("combobox", { name: "Active Project" }), {
      target: { value: imported.id },
    });

    expect(api.browseProjectRuns).not.toHaveBeenCalled();
    navigateWorkspace("Runs");
    const history = screen.getByRole("region", { name: "Project browser" });
    expect(history).not.toBeNull();
    expect(await within(history as HTMLElement).findByText("Imported baseline")).toBeInTheDocument();
    expect(within(history as HTMLElement).getByText("Execution unavailable")).toBeInTheDocument();
    expect(api.browseProjectRuns).toHaveBeenCalledWith("project-1", expect.objectContaining({ limit: 25, cursor: null }), expect.any(AbortSignal));
    expect(api.listProjectRuns).not.toHaveBeenCalled();
    expect(loadWorkingSession().currentRunId).toBeNull();
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it("loads Random intent from a Run and requests fresh per-Job seeds for every Preview", async () => {
    const frozen = runLookupResponse("succeeded", "historical-run", 12);
    frozen.batch_snapshot.batch.name = "Recovered experiment";
    frozen.batch_snapshot.seed_intent = { mode: "random", values: [], random_seed_count: 2 };
    frozen.plan.jobs = frozen.plan.jobs.map((job, index) => ({
      ...job,
      seed: [42, 42][index],
    }));
    const reconstruction: BatchReconstructionResponse = {
      run_id: frozen.run_id,
      batch_snapshot: frozen.batch_snapshot,
      resources: {
        prompt_versions: [{ position: 0, historical_version_id: "prompt-v1", status: "linked", reason: null, linked_version_id: "prompt-v1", linked_resource_id: "prompt-1" }],
        workflow_version: { historical_version_id: "workflow-v1", status: "detached", reason: "not imported", linked_version_id: null, linked_resource_id: null },
        workflow_profile_version: { historical_version_id: "profile-v1", status: "detached", reason: "not imported", linked_version_id: null, linked_resource_id: null },
      },
    };
    const previewBatch = vi
      .fn<BatchcraftApi["previewBatch"]>()
      .mockResolvedValueOnce(previewResponseWithSeeds([101, 102]))
      .mockResolvedValueOnce(previewResponseWithSeeds([7, 8]))
      .mockResolvedValueOnce(previewResponseWithSeeds([9, 10]));
    const api = makeApi({
      browseProjectRuns: vi.fn(async () => projectRunsFor(frozen)),
      getRun: vi.fn(async () => frozen),
      getBatchReconstruction: vi.fn(async () => reconstruction),
      previewBatch,
    });
    render(<App api={api} />);
    navigateWorkspace("Runs");
    const article = await screen.findByRole("article", { name: "Run 12" });
    expect(article).not.toBeNull();
    fireEvent.click(within(article as HTMLElement).getByRole("button", { name: "Load Run as Batch" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace Batch" }));

    expect(await screen.findByText("Run 12 loaded as an unsaved Batch draft. Preview to verify the Job plan.")).toBeInTheDocument();
    await waitFor(() => expect(loadWorkingSession().sourceRunId).toBe("historical-run"));
    expect(screen.getByRole("textbox", { name: "Batch name" })).toHaveValue("Recovered experiment");
    const seeds = screen.getByRole("group", { name: "Seeds" });
    fireEvent.click(within(seeds).getByRole("button", { name: "Edit" }));
    expect(within(seeds).getByRole("combobox", { name: "Seed mode" })).toHaveValue("random");
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await waitFor(() => expect(previewBatch).toHaveBeenCalledTimes(1));
    expect(previewBatch.mock.calls[0][0].seeds).toEqual({
      mode: "random",
      values: [],
      random_seed_count: 2,
    });

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await waitFor(() => expect(previewBatch).toHaveBeenCalledTimes(2));
    expect(previewBatch.mock.calls[1][0].seeds.values).toEqual([]);

    fireEvent.change(screen.getByRole("textbox", { name: "Batch name" }), {
      target: { value: "Edited recovered experiment" },
    });
    await waitFor(() => expect(loadWorkingSession().sourceRunId).toBe("historical-run"));
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await waitFor(() => expect(previewBatch).toHaveBeenCalledTimes(3));
    expect(previewBatch.mock.calls[2][0].seeds.values).toEqual([]);
  });

  it("does not let a stale Load Run completion overwrite an intervening form edit", async () => {
    const frozen = runLookupResponse("succeeded", "historical-run", 12);
    frozen.batch_snapshot.batch.name = "Historical name";
    const reconstruction = deferred<BatchReconstructionResponse>();
    const api = makeApi({
      browseProjectRuns: vi.fn(async () => projectRunsFor(frozen)),
      getRun: vi.fn(async () => frozen),
      getBatchReconstruction: vi.fn(() => reconstruction.promise),
    });
    render(<App api={api} />);
    navigateWorkspace("Runs");
    const article = await screen.findByRole("article", { name: "Run 12" });
    fireEvent.click(within(article as HTMLElement).getByRole("button", { name: "Load Run as Batch" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace Batch" }));
    await waitFor(() => expect(api.getBatchReconstruction).toHaveBeenCalledOnce());
    navigateWorkspace("Batch");
    fireEvent.change(screen.getByRole("textbox", { name: "Batch name" }), { target: { value: "Intervening edit" } });

    await act(async () => reconstruction.resolve(reconstructionFor(frozen)));

    expect(screen.getByRole("textbox", { name: "Batch name" })).toHaveValue("Intervening edit");
    expect(loadWorkingSession().sourceRunId).toBeNull();
  });

  it("does not let a stale Load Run completion overwrite a Saved Batch replacement", async () => {
    const frozen = runLookupResponse("succeeded", "historical-run", 12);
    frozen.batch_snapshot.batch.name = "Historical name";
    const reconstruction = deferred<BatchReconstructionResponse>();
    const detail = savedBatchDetail({ name: "Selected Batch", revision: 2 });
    const api = makeApi({
      browseProjectRuns: vi.fn(async () => projectRunsFor(frozen)),
      getRun: vi.fn(async () => frozen),
      getBatchReconstruction: vi.fn(() => reconstruction.promise),
      listSavedBatches: vi.fn(async () => ({ batches: [detail] })),
      getSavedBatch: vi.fn(async () => detail),
    });
    render(<App api={api} />);
    navigateWorkspace("Runs");
    const article = await screen.findByRole("article", { name: "Run 12" });
    fireEvent.click(within(article as HTMLElement).getByRole("button", { name: "Load Run as Batch" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace Batch" }));
    await waitFor(() => expect(api.getBatchReconstruction).toHaveBeenCalledOnce());
    navigateWorkspace("Batch");
    fireEvent.change(await screen.findByRole("combobox", { name: "Saved Batch" }), { target: { value: detail.id } });
    fireEvent.click(await screen.findByRole("button", { name: "Discard and switch" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Batch name" })).toHaveValue("Selected Batch"));

    await act(async () => reconstruction.resolve(reconstructionFor(frozen)));

    expect(screen.getByRole("textbox", { name: "Batch name" })).toHaveValue("Selected Batch");
    expect(loadWorkingSession().sourceRunId).toBeNull();
  });

  it("starts unscoped and does not load Prompt or Asset libraries before selection", async () => {
    localStorage.clear();
    const api = makeApi({ listProjects: vi.fn(async () => ({ projects: [] })) });
    render(<App api={api} />);

    expect(await screen.findByRole("combobox", { name: "Active Project" })).toHaveValue("");
    expect(screen.getByText("Select a Project to load its Prompt library.")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Image Inputs" })).not.toBeInTheDocument();
    expect(api.listPrompts).not.toHaveBeenCalled();
    expect(api.listProjectAssets).not.toHaveBeenCalled();
  });

  it("clears Workflow links and snapshots when switching Project", async () => {
    const form = populatedBatchForm();
    form.workflowLibraryProjectId = "project-1";
    form.workflowId = "workflow-1";
    form.workflowName = "Portrait";
    form.workflowVersionId = "workflow-v1";
    form.workflowVersionNumber = 1;
    form.workflowProfileId = "profile-1";
    form.workflowProfileName = "Default";
    form.workflowProfileVersionId = "profile-v1";
    form.workflowProfileVersionNumber = 1;
    form.workflowProfileWorkflowVersionId = "workflow-v1";
    form.workflowJson = '{"project":"a"}';
    form.workflowProfileJson = '{"profile":"a"}';
    saveWorkingSession(form, null, "project-1");
    const next = projectResponse({ id: "project-2", filesystem_key: "project_2", name: "Next" });
    const api = makeApi({ listProjects: vi.fn(async () => ({ projects: [projectResponse(), next] })) });
    render(<App api={api} />);

    const selector = await screen.findByRole("combobox", { name: "Active Project" });
    fireEvent.change(selector, { target: { value: next.id } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(loadWorkingSession().selectedProjectId).toBe("project-2"));
    const restored = loadWorkingSession().form;
    expect(restored.workflowId).toBeNull();
    expect(restored.workflowProfileId).toBeNull();
    expect(restored.workflowJson).toBe("{}");
    expect(restored.workflowProfileJson).toBe("{}");
  });

  it("confirms before clearing detached Workflow/Profile snapshots", async () => {
    const form = populatedBatchForm();
    form.prompts = [];
    form.imageBindings = [];
    form.workflowLibraryProjectId = null;
    form.workflowId = null;
    form.workflowVersionId = null;
    form.workflowProfileId = null;
    form.workflowProfileVersionId = null;
    form.workflowJson = '{"detached":"workflow"}';
    form.workflowProfileJson = '{"detached":"profile"}';
    saveWorkingSession(form, null, "project-1");
    const next = projectResponse({ id: "project-2", filesystem_key: "project_2", name: "Next" });
    const api = makeApi({ listProjects: vi.fn(async () => ({ projects: [projectResponse(), next] })) });
    render(<App api={api} />);

    const selector = await screen.findByRole("combobox", { name: "Active Project" });
    fireEvent.change(selector, { target: { value: next.id } });
    expect(screen.getByRole("dialog", { name: "Change Project?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(loadWorkingSession().form.workflowJson).toBe('{"detached":"workflow"}');
    expect(loadWorkingSession().form.workflowProfileJson).toBe('{"detached":"profile"}');

    fireEvent.change(selector, { target: { value: next.id } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(loadWorkingSession().selectedProjectId).toBe(next.id));
    expect(loadWorkingSession().form.workflowJson).toBe("{}");
    expect(loadWorkingSession().form.workflowProfileJson).toBe("{}");
  });
});

describe("Batch preview", () => {
  it("keeps section titles while omitting decorative workflow chrome", () => {
    render(<App api={makeApi()} />);

    expect(screen.getByRole("heading", { name: "Batch configuration" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Preview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Run" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Results" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Project browser" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Workspace" })).getAllByRole("button").map((button) => button.textContent)).toEqual(["Batch", "Gallery", "Runs"]);
    expect(screen.queryByRole("heading", { name: "Batch Results" })).not.toBeInTheDocument();
    expect(screen.queryByText("One Batch. An explicit Job plan. A durable Run.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Working draft/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0[1-5] \/ /)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Preview" })).toHaveClass("inactive-card");
    expect(screen.getByRole("region", { name: "Run" })).toHaveClass("inactive-card");
    expect(screen.getByRole("region", { name: "Results" })).toHaveClass("inactive-card");
    expect(screen.getByText("Preview required")).toBeInTheDocument();
    expect(screen.getByText("Create a Run to continue")).toBeInTheDocument();
    expect(screen.getByText("Awaiting a Run")).toBeInTheDocument();
    expect(screen.queryByText("No session Results yet")).not.toBeInTheDocument();
  });

  it("summarizes configured experiment sections before expanding their controls", async () => {
    render(<App api={makeApi()} />);

    const prompts = screen.getByRole("group", { name: "Prompts" });
    const promptEdit = await within(prompts).findByRole("button", { name: "Edit" });
    expect(prompts).toHaveTextContent("1 prompt");
    expect(promptEdit).toHaveAttribute("aria-expanded", "false");
    expect(promptEdit.closest(".section-summary-actions")?.parentElement).toHaveClass("configuration-section-header");
    expect(promptEdit.closest(".configuration-section-header")?.querySelector(".configuration-section-heading")).not.toBeNull();
    expect(within(prompts).queryByRole("button", { name: "Add Prompt" })).not.toBeInTheDocument();

    const bindings = screen.getByRole("group", { name: "Variable bindings" });
    expect(bindings).toHaveTextContent("subject: 2 values · cat, dog");
    expect(within(bindings).getByRole("button", { name: "Edit" })).toHaveAttribute("aria-expanded", "false");

    const seeds = screen.getByRole("group", { name: "Seeds" });
    expect(seeds).toHaveTextContent("Fixed · 1");
    expect(within(seeds).getByRole("button", { name: "Edit" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(promptEdit);
    expect(within(prompts).getByRole("button", { name: "Add Prompt" })).toBeInTheDocument();
  });

  it("places Prompt and Variable Binding actions in one footer after expanded content", async () => {
    render(<App api={makeApi()} />);

    await expandConfiguration("Prompts");
    const prompts = screen.getByRole("group", { name: "Prompts" });
    const addPrompt = within(prompts).getByRole("button", { name: "Add Prompt" });
    const promptDone = within(prompts).getByRole("button", { name: "Done" });
    const promptActions = addPrompt.closest(".configuration-content-actions");
    expect(promptActions).not.toBeNull();
    expect(promptDone.closest(".configuration-content-actions")).toBe(promptActions);
    expect(within(prompts).queryAllByRole("button", { name: "Done" })).toHaveLength(1);
    expect(prompts.querySelector(".section-summary-actions")).toBeNull();

    await expandConfiguration("Variable bindings");
    const bindings = screen.getByRole("group", { name: "Variable bindings" });
    const addBinding = within(bindings).getByRole("button", { name: "Add Binding" });
    const done = within(bindings).getByRole("button", { name: "Done" });
    const actions = addBinding.closest(".configuration-content-actions");
    expect(actions).not.toBeNull();
    expect(done.closest(".configuration-content-actions")).toBe(actions);
    expect(within(bindings).queryAllByRole("button", { name: "Add Binding" })).toHaveLength(1);
    expect(within(bindings).getByText("Binding 1").compareDocumentPosition(actions as Node) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(bindings.querySelector(".section-summary-actions")).toBeNull();
    fireEvent.click(addBinding);
    expect(within(bindings).getAllByLabelText("Values")).toHaveLength(2);
  });

  it("uses the shared bottom Done footer for other expanded configuration sections", async () => {
    const form = populatedBatchForm();
    form.workflowProfileJson = JSON.stringify({
      mappings: {},
      image_inputs: [{ key: "source", label: "Source image", node_id: "1", input_name: "image" }],
      parameters: [{ key: "steps", label: "Steps", node_id: "2", input_name: "steps", value_type: "integer" }],
    });
    saveWorkingSession(form, null, "project-1");
    render(<App api={makeApi()} />);
    await screen.findByRole("button", { name: "Add portrait.png to Source image" });

    for (const [title, action] of [
      ["Workflow Setup", "Change"],
      ["Parameters", "Edit"],
      ["Seeds", "Edit"],
      ["Image Inputs", "Change"],
    ] as const) {
      const section = screen.getByRole("group", { name: title });
      const expand = within(section).queryByRole("button", { name: action });
      if (expand) fireEvent.click(expand);
      const done = within(section).getByRole("button", { name: "Done" });
      expect(done.closest(".configuration-content-actions")).not.toBeNull();
      expect(within(section).queryAllByRole("button", { name: "Done" })).toHaveLength(1);
      expect(section.querySelector(".section-summary-actions")).toBeNull();
    }
  });

  it("edits ordered Variable Binding lines and toggles one exact empty value", async () => {
    render(<App api={makeApi()} />);
    await expandConfiguration("Variable bindings");

    const values = screen.getByLabelText("Values");
    const draft = " fox, silver \n\n wolf  \nfox, silver\n";
    fireEvent.change(values, { target: { value: draft } });

    expect(values).toHaveValue(draft);
    expect(screen.getByText("One value per non-empty line")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add Value/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move value/i })).not.toBeInTheDocument();

    const includeEmpty = screen.getByRole("checkbox", { name: "Include empty value" });
    fireEvent.click(includeEmpty);
    expect(includeEmpty).toBeChecked();
    expect(values).toHaveValue(draft);
    await waitFor(() => expect(loadWorkingSession().form.variableBindings[0].values).toEqual([
      "",
      " fox, silver ",
      " wolf  ",
      "fox, silver",
    ]));

    fireEvent.click(includeEmpty);
    expect(includeEmpty).not.toBeChecked();
    await waitFor(() => expect(loadWorkingSession().form.variableBindings[0].values).toEqual([
      " fox, silver ",
      " wolf  ",
      "fox, silver",
    ]));
  });

  it("treats an empty value as configured and explains it in the summary", () => {
    const form = populatedBatchForm();
    form.variableBindings[0].values = [""];
    saveWorkingSession(form, null, "project-1");

    render(<App api={makeApi()} />);

    const bindings = screen.getByRole("group", { name: "Variable bindings" });
    expect(bindings).toHaveTextContent("subject: 1 value · (empty)");
    expect(within(bindings).getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("preserves an empty value's deterministic position while editing visible lines", async () => {
    const form = populatedBatchForm();
    form.variableBindings[0].values = ["cat", "", "dog"];
    saveWorkingSession(form, null, "project-1");
    render(<App api={makeApi()} />);
    await expandConfiguration("Variable bindings");

    const values = screen.getByLabelText("Values");
    fireEvent.change(values, { target: { value: "fox\ndog" } });
    await waitFor(() => expect(loadWorkingSession().form.variableBindings[0].values).toEqual([
      "fox",
      "",
      "dog",
    ]));

    fireEvent.change(values, { target: { value: "dog" } });
    await waitFor(() => expect(loadWorkingSession().form.variableBindings[0].values).toEqual([
      "",
      "dog",
    ]));
  });

  it("ignores whitespace-only values when preserving an empty value's position", async () => {
    const form = populatedBatchForm();
    form.variableBindings[0].values = ["   ", "", "dog"];
    saveWorkingSession(form, null, "project-1");
    render(<App api={makeApi()} />);
    await expandConfiguration("Variable bindings");

    const values = screen.getByLabelText("Values");
    expect(values).toHaveValue("dog");
    fireEvent.change(values, { target: { value: "wolf" } });
    await waitFor(() => expect(loadWorkingSession().form.variableBindings[0].values).toEqual([
      "",
      "wolf",
    ]));
  });

  it("creates every missing Prompt binding as an empty row and invalidates Preview", async () => {
    const exactVersion = promptVersion({ placeholders: ["subject", "style", "location"] });
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [projectPrompt("prompt-1", "Portrait", exactVersion)] })),
      getPromptVersion: vi.fn(async () => exactVersion),
    });
    render(<App api={api} />);

    const bindings = screen.getByRole("group", { name: "Variable bindings" });
    const create = await within(bindings).findByRole("button", { name: "Create missing bindings" });
    expect(bindings).toHaveTextContent("1 configured · 2 missing");
    await reachPreview();
    expect(screen.getByRole("button", { name: "Create Run" })).toBeEnabled();

    fireEvent.click(create);

    expect(within(bindings).getAllByLabelText("Placeholder").map((input) => (input as HTMLInputElement).value))
      .toEqual(["subject", "style", "location"]);
    expect(within(bindings).getAllByLabelText("Values").map((input) => (input as HTMLTextAreaElement).value))
      .toEqual(["cat\ndog", "", ""]);
    expect(within(bindings).getAllByRole("checkbox", { name: "Include empty value" })
      .every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);
    expect(within(bindings).getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    await waitFor(() => expect(loadWorkingSession().form.variableBindings.map((binding) => ({
      placeholder: binding.placeholder,
      values: binding.values,
    }))).toEqual([
      { placeholder: "subject", values: ["cat", "dog"] },
      { placeholder: "style", values: [] },
      { placeholder: "location", values: [] },
    ]));
  });

  it("restores page scrolling after selecting the first Prompt and creating its missing binding", async () => {
    const form = populatedBatchForm();
    form.prompts = [];
    saveWorkingSession(form, null, "project-1");
    const exactVersion = promptVersion({
      text: "Portrait in {{style}}",
      placeholders: ["style"],
    });
    const api = makeApi({
      listPrompts: vi.fn(async () => ({
        prompts: [projectPrompt("prompt-1", "Portrait", exactVersion)],
      })),
    });
    render(<App api={api} />);

    const dialog = await openPromptLibrary();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to Batch" }));
    expect(screen.getByRole("dialog", { name: "Prompts" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(document.body.style.overflow).toBe("");

    const bindings = screen.getByRole("group", { name: "Variable bindings" });
    fireEvent.click(await within(bindings).findByRole("button", { name: "Create missing bindings" }));
    expect(within(bindings).getAllByLabelText("Placeholder").map((input) => (
      input as HTMLInputElement
    ).value)).toEqual(["subject", "style"]);
    expect(document.body.style.overflow).toBe("");
  });

  it("recomputes missing bindings for Prompt additions while browsing remains presentation-only", async () => {
    const portrait = promptVersion({ placeholders: ["subject"] });
    const editorial = promptVersion({
      id: "editorial-v1",
      prompt_id: "editorial",
      name_snapshot: "Editorial",
      text: "{{subject}} in {{location}}",
      placeholders: ["subject", "location"],
    });
    const api = makeApi({
      listPrompts: vi.fn(async () => ({
        prompts: [projectPrompt("prompt-1", "Portrait", portrait), projectPrompt("editorial", "Editorial", editorial)],
      })),
      getPromptVersion: vi.fn(async (versionId) => versionId === editorial.id ? editorial : portrait),
    });
    render(<App api={api} />);

    const dialog = await openPromptLibrary();
    fireEvent.click(within(dialog).getByText("Editorial", { selector: ".prompt-library-item strong" }).closest("button")!);
    expect(screen.queryByRole("button", { name: "Create missing bindings" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to Batch" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));

    const bindings = screen.getByRole("group", { name: "Variable bindings" });
    expect(await within(bindings).findByRole("button", { name: "Create missing bindings" })).toBeInTheDocument();
    expect(bindings).toHaveTextContent("1 configured · 1 missing");
    fireEvent.click(within(bindings).getByRole("button", { name: "Create missing bindings" }));
    const cards = promptCards();
    fireEvent.click(within(cards[1]).getByRole("button", { name: "Remove" }));
    expect(within(bindings).getAllByLabelText("Placeholder").map((input) => (input as HTMLInputElement).value))
      .toEqual(["subject", "location"]);
    expect(within(bindings).queryByRole("button", { name: "Create missing bindings" })).not.toBeInTheDocument();
  });

  it("uses placeholder metadata from an exact older Prompt revision", async () => {
    const selected = promptVersion({ placeholders: ["subject"] });
    const current = promptVersion({ id: "prompt-v3", version_number: 3, placeholders: ["subject"] });
    const older = promptVersion({
      id: "prompt-v2",
      version_number: 2,
      text: "A {{vintage}} portrait",
      placeholders: ["vintage"],
    });
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [projectPrompt("prompt-1", "Portrait", current)] })),
      listPromptVersions: vi.fn(async () => ({ prompt_versions: [current, older, selected] })),
      getPromptVersion: vi.fn(async () => selected),
    });
    render(<App api={api} />);

    const dialog = await openPromptLibrary();
    fireEvent.click(within(dialog).getByRole("button", { name: "History" }));
    const oldCard = (await screen.findByText("A {{vintage}} portrait")).closest("article")!;
    fireEvent.click(within(oldCard).getByRole("button", { name: "Add this revision" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));

    const bindings = screen.getByRole("group", { name: "Variable bindings" });
    expect(await within(bindings).findByRole("button", { name: "Create missing bindings" })).toBeInTheDocument();
    fireEvent.click(within(bindings).getByRole("button", { name: "Edit" }));
    expect(within(bindings).getByText(/Missing from selected prompts:/).parentElement).toHaveTextContent("vintage");
  });

  it("renders Batch configuration sections in dependency order", () => {
    const form = populatedBatchForm();
    form.workflowProfileJson = JSON.stringify({
      mappings: {},
      image_inputs: [{ key: "source", label: "Source image", node_id: "1", input_name: "image" }],
      parameters: [{ key: "steps", label: "Steps", node_id: "2", input_name: "steps", value_type: "integer" }],
    });
    saveWorkingSession(form, null, "project-1");
    const api = makeApi();
    render(<App api={api} />);

    const project = screen.getByRole("group", { name: "Project" });
    const workflow = screen.getByRole("group", { name: "Workflow Setup" });
    const savedBatch = screen.getByRole("group", { name: "Batch" });
    const prompts = screen.getByRole("group", { name: "Prompts" });
    const variables = screen.getByRole("group", { name: "Variable bindings" });
    const parameters = screen.getByRole("group", { name: "Parameters" });
    const seeds = screen.getByRole("group", { name: "Seeds" });
    const imageInputs = screen.getByRole("group", { name: "Image Inputs" });

    expect(project.nextElementSibling).toBe(savedBatch);
    expect(savedBatch.nextElementSibling).toBe(workflow);
    const ordered = [project, savedBatch, workflow, prompts, variables, parameters, seeds, imageInputs];
    ordered.slice(0, -1).forEach((section, index) => {
      expect(section.compareDocumentPosition(ordered[index + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    });
    expect(imageInputs.compareDocumentPosition(screen.getByRole("button", { name: "Preview Batch" })) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("builds the API request and renders Jobs and compiler warnings", async () => {
    const api = makeApi({ previewBatch: vi.fn(async () => previewResponse()) });
    render(<App api={api} />);
    await enterAsset();

    await waitFor(() => expect(screen.getByRole("button", { name: "Preview Batch" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    expect(await screen.findByText("Compiler warnings")).toBeInTheDocument();
    expect(screen.getByText("Unused binding variable")).toBeInTheDocument();
    expect(screen.getByText("A studio portrait of cat.")).toBeInTheDocument();
    expect(screen.getByText("subject = cat")).toBeInTheDocument();
    expect(screen.getAllByText("Portrait", { selector: ".prompt-identity strong" })).toHaveLength(2);
    expect(screen.queryByText("prompt-v1", { selector: ".prompt-identity code" })).not.toBeInTheDocument();
    const request = vi.mocked(api.previewBatch).mock.calls[0][0];
    expect(request.image_bindings).toEqual([{ slot_key: "source", values: [null, "asset-1"] }]);
    expect(request.seeds).toEqual({ mode: "fixed", values: [1] });
    const preview = screen.getByRole("heading", { name: "Preview" }).closest("section")!;
    expect(within(preview).getAllByText("portrait.png").length).toBeGreaterThan(0);
    expect(within(preview).queryByText(/Base workflow ·/)).not.toBeInTheDocument();
    expect(request.variable_bindings[0]).toEqual(
      { placeholder: "subject", values: ["cat", "dog"] },
    );
  });

  it("previews Base workflow for a named Image Input", async () => {
    const api = makeApi({ previewBatch: vi.fn(async () => previewResponse(2, null)) });
    render(<App api={api} />);
    await screen.findByRole("button", { name: "Add portrait.png to Source image" });

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    await waitFor(() => expect(api.previewBatch).toHaveBeenCalledOnce());
    expect(vi.mocked(api.previewBatch).mock.calls[0][0].image_bindings).toEqual([{ slot_key: "source", values: [null] }]);
    expect(screen.getAllByText("Base workflow · reference-image.png").length).toBeGreaterThanOrEqual(2);
  });

  it("renders backend validation errors near the Batch editor", async () => {
    const api = makeApi({
      previewBatch: vi.fn(async () => {
        throw new ApiError("Binding values contain exact duplicates", "invalid_batch", 422);
      }),
    });
    render(<App api={api} />);
    await enterAsset();

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    expect(
      await screen.findByText("Binding values contain exact duplicates"),
    ).toBeInTheDocument();
  });

  it("rejects invalid workflow and Workflow Profile JSON before fetching", async () => {
    const api = makeApi();
    render(<App api={api} />);
    await enterAsset();

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
    await enterAsset();
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    const busyPreview = screen.getByRole("button", { name: "Previewing..." });
    expect(busyPreview).toBeDisabled();
    expect(busyPreview).toHaveClass("busy");
    expect(busyPreview).toHaveAttribute("aria-busy", "true");

    fireEvent.change(screen.getByLabelText("Batch name"), {
      target: { value: "Changed while previewing" },
    });
    pendingPreview.resolve(previewResponse());

    await waitFor(() => expect(screen.getByRole("button", { name: "Preview Batch" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Preview Batch" })).not.toHaveClass("busy");
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
  });

  it("creates a two-Job Run from the exact BatchRequest stored with its Preview", async () => {
    const assets = [asset("asset-a", "a.png")];
    const api = makeApi({
      listProjectAssets: vi.fn(async () => ({ assets })),
      previewBatch: vi.fn(async () => previewResponse(2)),
      createRun: vi.fn(async () => runResponse("run-two", 2, 2)),
    });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a.png to Source image" }));

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await screen.findByRole("button", { name: "Create Run" });
    const previewRequest = vi.mocked(api.previewBatch).mock.calls[0][0];
    expect(previewRequest.image_bindings).toEqual([{ slot_key: "source", values: [null, "asset-a"] }]);
    expect(screen.getByText("2", { selector: ".count-block strong" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    expect(await screen.findByRole("heading", { name: "Run 2" })).toBeInTheDocument();
    expect(vi.mocked(api.createRun).mock.calls[0][0]).toEqual({
      ...previewRequest,
      run_name: null,
      run_description: null,
    });
    expect(screen.getByText("0 / 2 Jobs")).toBeInTheDocument();
  });

  it("creates and displays immutable Run metadata without invalidating Preview", async () => {
    const artifact = result(1, 1, "image/png", "named.png", 2048);
    const createdRun = runResponse(
      "run-named",
      12,
      2,
      "Baseline",
      "Compare the first stable settings.",
    );
    const frozenRun = {
      ...runLookupResponse("created", "run-named", 12),
      ...createdRun,
    };
    const api = makeApi({
      createRun: vi.fn(async () => createdRun),
      getRun: vi.fn(async () => frozenRun),
      getExecution: vi.fn(async () => execution("succeeded", "run-named")),
      getResults: vi.fn(async () => ({ run_id: "run-named", results: [artifact] })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await enterAsset();
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await screen.findByRole("button", { name: "Create Run" });
    const previewRequest = vi.mocked(api.previewBatch).mock.calls[0][0];

    fireEvent.change(screen.getByRole("textbox", { name: /Run Name/ }), {
      target: { value: "  Baseline  " },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Notes/ }), {
      target: { value: "  Compare the first stable settings.  " },
    });
    expect(api.previewBatch).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Create Run" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    expect(await screen.findByRole("heading", { name: "Baseline" })).toBeInTheDocument();
    expect(api.createRun).toHaveBeenCalledWith({
      ...previewRequest,
      run_name: "Baseline",
      run_description: "Compare the first stable settings.",
    });
    expect(screen.getByRole("textbox", { name: /Run Name/ })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: /Notes/ })).toHaveValue("");
    expect(within(currentRunSection()).getByText("Run 12")).toBeInTheDocument();
    expect(within(currentRunSection()).getByText("Compare the first stable settings."))
      .toBeInTheDocument();
    expect(screen.getByText("Created as Baseline · Run 12.")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "View Run Plan" }));
    const plan = await screen.findByRole("dialog", { name: "Baseline Plan" });
    expect(within(plan).getByText("Baseline · Run 12")).toBeInTheDocument();
    expect(within(plan).getByText("Compare the first stable settings.")).toBeInTheDocument();
    expect(within(plan).getByText("012-baseline")).toBeInTheDocument();
    fireEvent.click(within(plan).getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: "Start Run" }));
    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Batch Results" })).not.toBeInTheDocument();
    fireEvent.click(await within(currentResultsSection()).findByRole("button", {
      name: "Details for Job 1, artifact 1",
    }));
    const details = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(within(details).getByText("Result details · Baseline · Run 12")).toBeInTheDocument();
    expect(within(details).getByText("012-baseline")).toBeInTheDocument();
  });

  it("materializes Random seeds once and consumes the Preview after successful Run creation", async () => {
    const alternate = projectPrompt("prompt-2", "Editorial", promptVersion({
      id: "prompt-v2",
      prompt_id: "prompt-2",
      name_snapshot: "Editorial",
      text: "A second portrait of {{subject}}.",
    }));
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [projectPrompt(), alternate] })),
      previewBatch: vi.fn(async () => previewResponseWithSeeds([31, 32, 33, 34, 35, 36])),
      createRun: vi.fn(async () => runResponse("run-random", 4, 6)),
    });
    render(<App api={api} />);
    await enterAsset();
    await expandConfiguration("Seeds");
    fireEvent.change(screen.getByLabelText("Seed mode"), { target: { value: "random" } });
    fireEvent.change(screen.getByLabelText(/Random seed count/), { target: { value: "3" } });
    await addExistingPrompt("Editorial");

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await screen.findByRole("button", { name: "Create Run" });
    const previewRequest = vi.mocked(api.previewBatch).mock.calls[0][0];
    expect(previewRequest.seeds).toEqual({ mode: "random", values: [], random_seed_count: 3 });
    expect(previewRequest.prompt_versions).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    expect(await screen.findByRole("heading", { name: "Run 4" })).toBeInTheDocument();
    expect(vi.mocked(api.createRun).mock.calls[0][0]).toEqual({
      ...previewRequest,
      seeds: { mode: "random", values: [31, 32, 33, 34, 35, 36], random_seed_count: 3 },
      run_name: null,
      run_description: null,
    });
    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Seed mode")).toHaveValue("random");
    expect(screen.getByLabelText(/Random seed count/)).toHaveValue(3);
  });

  it("retains a Random Preview when Run creation fails", async () => {
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponseWithSeeds([41, 42])),
      createRun: vi.fn(async () => {
        throw new ApiError("Run publication failed", "run_publication_failed", 500);
      }),
    });
    render(<App api={api} />);
    await enterAsset();
    await expandConfiguration("Seeds");
    fireEvent.change(screen.getByLabelText("Seed mode"), { target: { value: "random" } });
    fireEvent.change(screen.getByLabelText(/Random seed count/), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    const createRun = await screen.findByRole("button", { name: "Create Run" });
    const previewRequest = vi.mocked(api.previewBatch).mock.calls[0][0];
    const materializedRequest = {
      ...previewRequest,
      seeds: { mode: "random" as const, values: [41, 42], random_seed_count: 2 },
    };
    fireEvent.change(screen.getByRole("textbox", { name: /Run Name/ }), {
      target: { value: "Retry name" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Notes/ }), {
      target: { value: "Keep on failure" },
    });

    fireEvent.click(createRun);

    expect(await screen.findByText("Run publication failed")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Run Name/ })).toHaveValue("Retry name");
    expect(screen.getByRole("textbox", { name: /Notes/ })).toHaveValue("Keep on failure");
    expect(screen.getByRole("button", { name: "Create Run" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    await waitFor(() => expect(api.createRun).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.createRun).mock.calls[0][0]).toEqual({
      ...materializedRequest,
      run_name: "Retry name",
      run_description: "Keep on failure",
    });
    expect(vi.mocked(api.createRun).mock.calls[1][0]).toEqual({
      ...materializedRequest,
      run_name: "Retry name",
      run_description: "Keep on failure",
    });
  });

  it("invalidates Preview after Image Input edits and requires Preview before creation", async () => {
    const assets = [
      asset("asset-a", "a.png"),
      asset("asset-b", "b.png"),
      asset("asset-c", "c.png"),
    ];
    const api = makeApi({
      listProjectAssets: vi.fn(async () => ({ assets })),
      previewBatch: vi
        .fn<BatchcraftApi["previewBatch"]>()
        .mockResolvedValueOnce(previewResponse(2))
        .mockResolvedValueOnce(previewResponse(3)),
      createRun: vi.fn(async () => runResponse("run-three", 3, 3)),
    });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a.png to Source image" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await screen.findByRole("button", { name: "Create Run" });

    fireEvent.click(screen.getByRole("button", { name: "Add c.png to Source image" }));

    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await waitFor(() => expect(api.previewBatch).toHaveBeenCalledTimes(2));
    expect(screen.getByText("3", { selector: ".count-block strong" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    expect(await screen.findByRole("heading", { name: "Run 3" })).toBeInTheDocument();
    expect(vi.mocked(api.createRun).mock.calls[0][0].image_bindings).toEqual([{ slot_key: "source", values: [null, "asset-a", "asset-c"] }]);
  });

  it("constructs typed Parameter overrides and invalidates Preview after edits", async () => {
    const form = populatedBatchForm();
    form.workflowProfileJson = JSON.stringify({ mappings: {}, image_inputs: [], parameters: [
      { key: "caption", label: "Caption", node_id: "1", input_name: "caption", value_type: "string" },
      { key: "enabled", label: "Enabled", node_id: "1", input_name: "enabled", value_type: "boolean" },
    ] });
    form.imageBindings = [];
    form.parameterBindings = [
      { parameterKey: "unknown", valueType: "string", mode: "values", alternatives: [{ kind: "override", value: "remove me" }], range: { start: "0", end: "1", step: "0.1", includeBase: false } },
      { parameterKey: "caption", valueType: "string", mode: "values", alternatives: [{ kind: "base" }], range: { start: "0", end: "1", step: "0.1", includeBase: false } },
    ];
    saveWorkingSession(form, null, "project-1");
    const parameterPreview = previewResponse();
    parameterPreview.jobs.forEach((job) => {
      job.resolved_parameters = [
        { parameter_key: "caption", label: "Caption", value: "" },
        { parameter_key: "enabled", label: "Enabled", value: false },
      ];
      job.resolved_parameter_sets = [{ set_key: "display", set_label: "Display", row_ordinal: 1, row_label: "Editorial" }];
    });
    const api = makeApi({ previewBatch: vi.fn(async () => parameterPreview) });
    render(<App api={api} />);
    await screen.findByText(/Draft restored from this browser/);
    await expandConfiguration("Parameters");

    expect(screen.getByRole("checkbox", { name: "Include Base workflow for Caption" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Include Base workflow for Enabled" })).toBeChecked();
    expect(screen.queryByText("unknown")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add override for Caption" }));
    fireEvent.click(screen.getByRole("button", { name: "Add override for Enabled" }));
    fireEvent.change(screen.getByLabelText("Enabled override 2"), { target: { value: "false" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await screen.findByRole("button", { name: "Create Run" });

    expect(vi.mocked(api.previewBatch).mock.calls[0][0].parameter_bindings).toEqual([
      { parameter_key: "caption", mode: "values", values: [null, ""] },
      { parameter_key: "enabled", mode: "values", values: [null, false] },
    ]);
    expect(screen.getAllByText('"" (empty string)').length).toBeGreaterThan(0);
    expect(screen.getAllByText("false").length).toBeGreaterThan(0);
    expect([...document.querySelectorAll(".resolved-preset")].some((node) => node.textContent === "Display: Editorial")).toBe(true);
    fireEvent.change(screen.getByLabelText("Caption override 2"), { target: { value: "changed" } });
    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
  });

  it("collapses complete Parameters without changing values or invalidating Preview", async () => {
    const form = populatedBatchForm();
    form.workflowProfileJson = JSON.stringify({ mappings: {}, image_inputs: [], parameters: [
      { key: "steps", label: "Steps", node_id: "1", input_name: "steps", value_type: "integer" },
    ] });
    form.imageBindings = [];
    form.parameterBindings = [{
      parameterKey: "steps", valueType: "integer", mode: "values",
      alternatives: [{ kind: "base" }, { kind: "override", value: "30" }],
      range: { start: "0", end: "10", step: "1", includeBase: false },
    }];
    saveWorkingSession(form, null, "project-1");
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponseWithSeeds([501, 502, 503])),
    });
    render(<App api={api} />);
    await screen.findByText(/Draft restored/);
    await expandConfiguration("Parameters");
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await screen.findByRole("button", { name: "Create Run" });

    const section = screen.getByRole("group", { name: "Parameters" });
    fireEvent.click(within(section).getByRole("button", { name: "Done" }));

    expect(screen.getByRole("button", { name: "Create Run" })).toBeInTheDocument();
    expect(api.previewBatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.previewBatch).mock.calls[0][0].parameter_bindings).toEqual([
      { parameter_key: "steps", mode: "values", values: [null, 30] },
    ]);
  });

  it("invalidates Preview when a Preset is created and sends linked members only in the set", async () => {
    const form = populatedBatchForm();
    form.workflowProfileJson = JSON.stringify({ mappings: {}, image_inputs: [], parameters: [
      { key: "width", label: "Width", node_id: "1", input_name: "width", value_type: "integer" },
      { key: "height", label: "Height", node_id: "1", input_name: "height", value_type: "integer" },
      { key: "steps", label: "Steps", node_id: "1", input_name: "steps", value_type: "integer" },
    ] });
    form.imageBindings = [];
    saveWorkingSession(form, null, "project-1");
    const api = makeApi();
    render(<App api={api} />);
    await screen.findByText(/Draft restored/);
    await expandConfiguration("Parameters");
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await screen.findByRole("button", { name: "Create Run" });

    fireEvent.click(screen.getByRole("button", { name: "Create preset" }));
    const picker = screen.getByRole("group", { name: "Choose at least two independent parameters" });
    fireEvent.click(within(picker).getByRole("checkbox", { name: "Width" }));
    fireEvent.click(within(picker).getByRole("checkbox", { name: "Height" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Create preset" }));
    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add override for Width" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await waitFor(() => expect(api.previewBatch).toHaveBeenCalledTimes(2));
    const request = vi.mocked(api.previewBatch).mock.calls[1][0];
    expect(request.parameter_bindings.map((binding) => binding.parameter_key)).toEqual(["steps"]);
    expect(request.linked_parameter_sets[0]).toMatchObject({ set_key: "width_height", members: ["width", "height"] });
  });

  it("offers Add Parameter for a Workflow without a Profile and opens New Profile", async () => {
    const workflowVersion = {
      id: "workflow-v1",
      workflow_id: "workflow-1",
      project_id: "project-1",
      version_number: 1,
      name_snapshot: "Portrait workflow",
      workflow: { "1": { class_type: "KSampler", inputs: { steps: 20 } } },
      content_sha256: "workflow-sha",
      note: null,
      created_at: "2026-08-27T12:00:00Z",
      archived_at: null,
    };
    const form = populatedBatchForm();
    form.workflowLibraryProjectId = "project-1";
    form.workflowId = workflowVersion.workflow_id;
    form.workflowName = workflowVersion.name_snapshot;
    form.workflowVersionId = workflowVersion.id;
    form.workflowVersionNumber = workflowVersion.version_number;
    form.workflowContentSha256 = workflowVersion.content_sha256;
    form.workflowJson = JSON.stringify(workflowVersion.workflow);
    form.workflowProfileJson = "{}";
    form.imageBindings = [];
    saveWorkingSession(form, null, "project-1");
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [{
        id: workflowVersion.workflow_id,
        project_id: "project-1",
        name: workflowVersion.name_snapshot,
        description: null,
        created_at: "2026-08-27T12:00:00Z",
        updated_at: "2026-08-27T12:00:00Z",
        archived_at: null,
        latest_active_version: workflowVersion,
      }] })),
      listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [workflowVersion] })),
      listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [] })),
      getWorkflowVersion: vi.fn(async () => workflowVersion),
    });
    render(<App api={api} />);

    await screen.findByText(/Draft restored/);
    await expandConfiguration("Parameters");
    fireEvent.click(screen.getByRole("button", { name: "Add Parameter" }));

    expect(await screen.findByRole("dialog", { name: "New Profile" })).toBeInTheDocument();
  });
});

describe("PromptVersion editor", () => {
  it("supports stable library add, reorder, and removal to an empty selection", async () => {
    const alternate = projectPrompt("prompt-2", "Editorial", promptVersion({
      id: "prompt-v2",
      prompt_id: "prompt-2",
      name_snapshot: "Editorial snapshot",
      text: "Editorial {{subject}}",
    }));
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [projectPrompt(), alternate] })),
    });
    render(<App api={api} />);

    expect(screen.getByRole("group", { name: "Prompts" })).toBeInTheDocument();
    expect(screen.getByText("A studio portrait of {{subject}}.")).toBeInTheDocument();
    expect(within(promptCards()[0]).getByRole("button", { name: "Remove" })).toBeEnabled();

    await addExistingPrompt("Editorial");
    expect(promptCards()).toHaveLength(2);
    const secondCard = promptCards()[1];
    expect(within(secondCard).getByText("Editorial {{subject}}")).toBeInTheDocument();
    expect(within(secondCard).getByText("Saved as Editorial snapshot")).toBeInTheDocument();
    fireEvent.click(within(secondCard).getByRole("button", { name: "Move up" }));

    expect(within(promptCards()[0]).getByText("Editorial {{subject}}")).toBeInTheDocument();

    fireEvent.click(within(promptCards()[0]).getByRole("button", { name: "Remove" }));
    expect(promptCards()).toHaveLength(1);
    expect(within(promptCards()[0]).getByText("Portrait")).toBeInTheDocument();
    fireEvent.click(within(promptCards()[0]).getByRole("button", { name: "Remove" }));

    expect(promptCards()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Add Prompt" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    expect(await screen.findByText("Add at least one PromptVersion.")).toBeInTheDocument();
    expect(api.previewBatch).not.toHaveBeenCalled();
  });

  it("keeps Preview while editing the library and invalidates it only when the new revision is added", async () => {
    const nextVersion = promptVersion({
      id: "prompt-v2",
      version_number: 2,
      text: "Changed {{subject}} in {{style}}",
      placeholders: ["subject", "style"],
    });
    const api = makeApi({ createPromptVersion: vi.fn(async () => nextVersion) });
    render(<App api={api} />);
    await reachPreview();
    expect(screen.getByRole("button", { name: "Create Run" })).toBeEnabled();

    await expandConfiguration("Prompts");
    fireEvent.click(screen.getByRole("button", { name: "Add Prompt" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Prompt" }));
    fireEvent.change(screen.getByLabelText("Prompt template"), {
      target: { value: "Changed {{subject}} in {{style}}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save revision" }));

    expect(await screen.findByRole("button", { name: "Add to Batch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Run" })).toBeEnabled();
    expect(api.createPromptVersion).toHaveBeenCalledWith("prompt-1", {
      text: "Changed {{subject}} in {{style}}",
      note: null,
    });
    expect(screen.queryByRole("button", { name: "Create missing bindings" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add to Batch" }));
    expect(await screen.findByRole("button", { name: "Create missing bindings" })).toBeInTheDocument();
    expect(await screen.findByText(/Preview required/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
  });

  it("retains Preview while browsing, searching, and opening History", async () => {
    const api = makeApi();
    render(<App api={api} />);
    await reachPreview();

    const promptSection = screen.getByRole("group", { name: "Prompts" });
    const editPrompts = within(promptSection).queryByRole("button", { name: "Edit" });
    if (editPrompts) fireEvent.click(editPrompts);
    fireEvent.click(screen.getByRole("button", { name: "Add Prompt" }));
    fireEvent.change(screen.getByLabelText("Search Prompts"), { target: { value: "portrait" } });
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(await screen.findByRole("heading", { name: "History" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Run" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Create Run" })).toBeEnabled();
  });
});

describe("Browser working-session restoration", () => {
  it("recomputes missing bindings after Saved Batch recovery without silently dirtying it", async () => {
    const detail = savedBatchDetail({
      prompt_selections: [{
        prompt_version_id: "prompt-v1",
        name_snapshot: "Portrait",
        text: "A studio portrait of {{subject}} and {{style}}.",
        prompt_id: "prompt-1",
        prompt_name: "Portrait",
        version_number: 1,
        prompt_archived_at: null,
        version_archived_at: null,
      }],
      variable_bindings: [{ placeholder: "subject", values: ["wolf"] }],
    });
    const recovered = savedBatchToForm(detail, projectResponse());
    saveWorkingSession(recovered, null, "project-1", undefined, detail.id, detail.revision);
    const exactVersion = promptVersion({
      text: "A studio portrait of {{subject}} and {{style}}.",
      placeholders: ["subject", "style"],
    });
    const api = makeApi({
      getSavedBatch: vi.fn(async () => detail),
      listSavedBatches: vi.fn(async () => ({ batches: [detail] })),
      listPrompts: vi.fn(async () => ({ prompts: [projectPrompt("prompt-1", "Portrait", exactVersion)] })),
      getPromptVersion: vi.fn(async () => exactVersion),
    });

    render(<App api={api} />);

    expect(await screen.findByText("Saved")).toBeInTheDocument();
    const bindings = screen.getByRole("group", { name: "Variable bindings" });
    expect(await within(bindings).findByRole("button", { name: "Create missing bindings" })).toBeInTheDocument();
    expect(loadWorkingSession().form.variableBindings.map((binding) => ({
      placeholder: binding.placeholder,
      values: binding.values,
    }))).toEqual([{ placeholder: "subject", values: ["wolf"] }]);
    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();

    fireEvent.click(within(bindings).getByRole("button", { name: "Create missing bindings" }));
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();
    await waitFor(() => expect(loadWorkingSession().form.variableBindings.map((binding) => ({
      placeholder: binding.placeholder,
      values: binding.values,
    }))).toEqual([
      { placeholder: "subject", values: ["wolf"] },
      { placeholder: "style", values: [] },
    ]));
  });

  it("restores ordered named Image Inputs after remount but requires a new Preview", async () => {
    const assets = [asset("asset-a", "a.png"), asset("asset-b", "b.png")];
    const api = makeApi({ listProjectAssets: vi.fn(async () => ({ assets })) });
    const form = populatedBatchForm();
    form.prompts[0].text = "Restored portrait of {{subject}}";
    form.prompts.push({
      ...newPrompt(2),
      versionId: "prompt-editorial",
      promptName: "Editorial",
      snapshotName: "Editorial",
      text: "Editorial image of {{subject}}",
    });
    form.variableBindings[0].values = ["fox", "wolf"];
    form.seedMode = "explicit";
    form.seedValues = "9, 3";
    form.workflowJson = '{"workflow":true}';
    form.workflowProfileJson = profileJson([
      { key: "style", label: "Style", node_id: "1", input_name: "image" },
      { key: "pose", label: "Pose", node_id: "2", input_name: "image" },
    ]);
    form.imageBindings = [
      { slot_key: "style", values: ["asset-b"] },
      { slot_key: "pose", values: ["asset-a"] },
    ];
    saveWorkingSession(form, null, "project-1");

    render(<App api={api} />);

    expect(await screen.findByText(/Draft restored from this browser/)).toBeInTheDocument();
    expect(screen.getByText("Restored portrait of {{subject}}")).toBeInTheDocument();
    expect(screen.getByText("Editorial image of {{subject}}")).toBeInTheDocument();
    await expandConfiguration("Variable bindings");
    await expandConfiguration("Seeds");
    expect(screen.getByLabelText("Values")).toHaveValue("fox\nwolf");
    expect(screen.getByLabelText("Seed mode")).toHaveValue("explicit");
    expect(screen.getByLabelText(/Explicit seeds/)).toHaveValue("9, 3");
    expect(screen.getByLabelText("Workflow JSON")).toHaveValue('{"workflow":true}');
    expect(screen.getByRole("button", { name: "Remove b.png from Style" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Remove a.png from Pose" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
  });

  it("recovers linked Workflow/Profile snapshots from the backend while preserving Range text", async () => {
    const form = populatedBatchForm();
    form.workflowLibraryProjectId = "project-1";
    form.workflowId = "workflow-1";
    form.workflowVersionId = "workflow-v2";
    form.workflowVersionNumber = 2;
    form.workflowContentSha256 = "workflow-sha";
    form.workflowProfileId = "profile-1";
    form.workflowProfileVersionId = "profile-v3";
    form.workflowProfileVersionNumber = 3;
    form.workflowProfileWorkflowVersionId = "workflow-v2";
    form.workflowProfileContentSha256 = "profile-sha";
    form.workflowJson = '{"large":"browser copy must be omitted"}';
    form.workflowProfileJson = JSON.stringify({ mappings: {}, image_inputs: [], parameters: [
      { key: "steps", label: "Steps", node_id: "3", input_name: "steps", value_type: "float" },
    ] });
    form.imageBindings = [];
    form.parameterBindings = [{
      parameterKey: "steps",
      valueType: "float",
      mode: "range",
      alternatives: [{ kind: "override", value: "30" }],
      range: { start: "30.00", end: "0.00", step: "-2.50", includeBase: true },
    }];
    saveWorkingSession(form, null, "project-1");
    const stored = JSON.parse(localStorage.getItem("batchcraft.working-session-recovery.v4") ?? "{}") as {
      draft: { workflowJson: unknown; workflowProfileJson: unknown };
    };
    expect(stored.draft.workflowJson).toBeNull();
    expect(stored.draft.workflowProfileJson).toBeNull();

    const api = makeApi({
      getWorkflowVersion: vi.fn(async () => ({
        id: "workflow-v2", workflow_id: "workflow-1", project_id: "project-1",
        version_number: 2, name_snapshot: "Workflow", workflow: { node: "restored" },
        content_sha256: "workflow-sha", note: null, created_at: "2026-08-27T12:00:00Z", archived_at: null,
      })),
      getWorkflowProfileVersion: vi.fn(async () => ({
        id: "profile-v3", workflow_profile_id: "profile-1", workflow_id: "workflow-1",
        project_id: "project-1", workflow_version_id: "workflow-v2", version_number: 3,
        name_snapshot: "Profile", profile: { mappings: {}, image_inputs: [], parameters: [
          { key: "steps", label: "Steps", node_id: "3", input_name: "steps", value_type: "float" },
        ] }, content_sha256: "profile-sha", note: null,
        created_at: "2026-08-27T12:00:00Z", archived_at: null,
      })),
    });
    render(<App api={api} />);

    await waitFor(() => expect(api.getWorkflowProfileVersion).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByLabelText("Workflow Profile JSON") as HTMLTextAreaElement).value).toContain('"steps"'));
    await screen.findByRole("group", { name: "Parameters" });
    await expandConfiguration("Parameters");
    expect(await screen.findByRole("button", { name: "Range" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Steps range start")).toHaveValue("30.00");
    expect(screen.getByLabelText("Steps range end")).toHaveValue("0.00");
    expect(screen.getByLabelText("Steps range step")).toHaveValue("-2.50");
    expect(screen.getByRole("checkbox", { name: "Include Base workflow for Steps" })).toBeChecked();
  });

  it("restores exact Run snapshots when linked Workflow/Profile rows disappear before restart", async () => {
    const frozen = runLookupResponse("succeeded", "historical-run", 12);
    frozen.batch_snapshot.workflow_selection.workflow = { node: "frozen" };
    frozen.batch_snapshot.workflow_selection.workflow_profile = {
      mappings: {}, image_inputs: [], parameters: [],
    };
    const linked = reconstructionFor(frozen);
    linked.resources.workflow_version = {
      historical_version_id: "workflow-v4", status: "linked", reason: null,
      linked_version_id: "workflow-v4", linked_resource_id: "workflow-1",
    };
    linked.resources.workflow_profile_version = {
      historical_version_id: "profile-v4", status: "linked", reason: null,
      linked_version_id: "profile-v4", linked_resource_id: "profile-1",
    };
    saveWorkingSession(
      editableBatchSnapshotToForm(linked),
      null,
      "project-1",
      undefined,
      null,
      null,
      frozen.run_id,
    );
    const api = makeApi({
      getWorkflowVersion: vi.fn(async () => { throw new Error("WorkflowVersion row disappeared"); }),
      getWorkflowProfileVersion: vi.fn(async () => { throw new Error("ProfileVersion row disappeared"); }),
      getRun: vi.fn(async () => frozen),
      getBatchReconstruction: vi.fn(async () => reconstructionFor(frozen)),
    });

    render(<App api={api} />);

    await waitFor(() => expect(api.getBatchReconstruction).toHaveBeenCalledWith(
      frozen.run_id,
      expect.any(AbortSignal),
    ));
    await waitFor(() => expect(screen.getByLabelText("Workflow JSON")).toHaveValue(
      JSON.stringify(frozen.batch_snapshot.workflow_selection.workflow, null, 2),
    ));
    expect(screen.getByLabelText("Workflow Profile JSON")).toHaveValue(
      JSON.stringify(frozen.batch_snapshot.workflow_selection.workflow_profile, null, 2),
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await waitFor(() => expect(api.previewBatch).toHaveBeenCalledOnce());
  });

  it("finishes historical restoration after an intervening edit without overwriting it", async () => {
    const frozen = runLookupResponse("succeeded", "historical-run", 12);
    const reconstruction = reconstructionFor(frozen);
    const pending = deferred<BatchReconstructionResponse>();
    saveWorkingSession(
      editableBatchSnapshotToForm(reconstruction),
      null,
      "project-1",
      undefined,
      null,
      null,
      frozen.run_id,
    );
    const api = makeApi({
      getRun: vi.fn(async () => frozen),
      getBatchReconstruction: vi.fn(() => pending.promise),
    });
    render(<App api={api} />);
    await waitFor(() => expect(api.getBatchReconstruction).toHaveBeenCalled());

    fireEvent.change(screen.getByRole("textbox", { name: "Batch name" }), {
      target: { value: "Intervening edit" },
    });
    await act(async () => pending.resolve(reconstruction));

    expect(screen.getByRole("textbox", { name: "Batch name" })).toHaveValue("Intervening edit");
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await waitFor(() => expect(api.previewBatch).toHaveBeenCalledOnce());
  });

  it("restores an unsaved draft over its verified Saved Batch baseline", async () => {
    const form = populatedBatchForm();
    form.batchId = "batch-1";
    form.batchFilesystemKey = "batch_1";
    form.batchName = "Unsaved draft name";
    form.variableBindings[0].values = ["unsaved fox"];
    saveWorkingSession(form, null, "project-1", undefined, "batch-1", 4);
    const detail = savedBatchDetail({
      id: "batch-1",
      filesystem_key: "batch_1",
      name: "Persisted name",
      revision: 4,
      variable_bindings: [{ placeholder: "subject", values: ["persisted wolf"] }],
    });
    const api = makeApi({
      listSavedBatches: vi.fn(async () => ({ batches: [detail] })),
      getSavedBatch: vi.fn(async () => detail),
    });

    render(<App api={api} />);

    expect(await screen.findByDisplayValue("Unsaved draft name")).toBeInTheDocument();
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();
    await expandConfiguration("Variable bindings");
    expect(screen.getByLabelText("Values")).toHaveValue("unsaved fox");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("recovers Random seed intent without recovering materialized Preview seeds", async () => {
    const form = populatedBatchForm();
    form.seedMode = "random";
    form.randomSeedCount = "3";
    form.seedValues = "111, 222, 333";
    saveWorkingSession(form, null, "project-1");
    const api = makeApi();

    render(<App api={api} />);

    await expandConfiguration("Seeds");
    expect(screen.getByLabelText("Seed mode")).toHaveValue("random");
    expect(loadWorkingSession().form.randomSeedCount).toBe("3");
    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
    const previewBatch = screen.getByRole("button", { name: "Preview Batch" });
    await waitFor(() => expect(previewBatch).toBeEnabled());
    fireEvent.click(previewBatch);
    await waitFor(() => expect(api.previewBatch).toHaveBeenCalledOnce());
    expect(vi.mocked(api.previewBatch).mock.calls[0][0].seeds).toEqual({
      mode: "random",
      values: [],
      random_seed_count: 3,
    });
  });

  it("refetches a recovered source Run but requests fresh Random seeds for Preview", async () => {
    const frozen = runLookupResponse("succeeded", "historical-run", 12);
    frozen.batch_snapshot.seed_intent = { mode: "random", values: [], random_seed_count: 2 };
    frozen.plan.jobs = frozen.plan.jobs.map((job, index) => ({ ...job, seed: [303, 404][index] }));
    const reconstruction = reconstructionFor(frozen);
    const recovered = editableBatchSnapshotToForm(reconstruction);
    saveWorkingSession(recovered, null, "project-1", undefined, null, null, frozen.run_id);
    const api = makeApi({
      getRun: vi.fn(async () => frozen),
      getBatchReconstruction: vi.fn(async () => reconstruction),
      previewBatch: vi.fn(async () => previewResponseWithSeeds([505, 606])),
    });

    render(<App api={api} />);

    expect(await screen.findByText(/Draft restored from this browser/)).toBeInTheDocument();
    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    await waitFor(() => expect(api.getBatchReconstruction).toHaveBeenCalledWith("historical-run", expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await waitFor(() => expect(api.previewBatch).toHaveBeenCalledOnce());
    expect(vi.mocked(api.previewBatch).mock.calls[0][0].seeds).toEqual({
      mode: "random",
      values: [],
      random_seed_count: 2,
    });
    expect(loadWorkingSession().sourceRunId).toBe("historical-run");
    expect(localStorage.getItem(WORKING_SESSION_RECOVERY_KEY)).not.toContain("303");
  });

  it("reconstructs a running closed-tab session from backend truth and keeps Preview invalid", async () => {
    const artifact = result(1, 1, "image/png", "recovered.png", 512);
    const firstApi = makeApi({
      createRun: vi.fn(async () => runResponse("run-live", 17)),
      getRun: vi.fn(async () => runLookupResponse("running", "run-live", 17)),
      getExecution: vi.fn(async () => execution("running", "run-live")),
      getResults: vi.fn(async () => ({ run_id: "run-live", results: [artifact] })),
    });
    const firstMount = render(<App api={firstApi} pollIntervalMs={5} />);
    await expandConfiguration("Variable bindings");
    fireEvent.change(screen.getByLabelText("Values"), { target: { value: "closed-tab fox" } });
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    await screen.findByRole("heading", { name: "Run 17" });
    fireEvent.click(screen.getByRole("button", { name: "Start Run" }));
    expect(await screen.findByText("Running · Job 1 of 2")).toBeInTheDocument();
    await waitFor(() => expect(loadWorkingSession().currentRunId).toBe("run-live"));
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    firstMount.unmount();

    const getExecution = vi
      .fn<BatchcraftApi["getExecution"]>()
      .mockResolvedValueOnce(execution("running", "run-live"))
      .mockResolvedValueOnce(execution("succeeded", "run-live"));
    const recoveredApi = makeApi({
      getRun: vi.fn(async () => runLookupResponse("running", "run-live", 17)),
      getExecution,
      getResults: vi.fn(async () => ({ run_id: "run-live", results: [artifact] })),
    });
    render(<App api={recoveredApi} pollIntervalMs={5} />);

    expect(await screen.findByText(/Draft restored from this browser/)).toBeInTheDocument();
    await expandConfiguration("Variable bindings");
    expect(screen.getByLabelText("Values")).toHaveValue("closed-tab fox");
    expect(await screen.findByRole("heading", { name: "Run 17" })).toBeInTheDocument();
    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
    expect(await screen.findAllByAltText("Result 1 from Job 1: recovered.png")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Batch Results" })).not.toBeInTheDocument();
    expect(getExecution).toHaveBeenCalledTimes(2);
    expect(recoveredApi.startRun).not.toHaveBeenCalled();
    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Another Run" })).not.toBeInTheDocument();
  });

  it("keeps Preview usable when localStorage writes fail", async () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    const api = makeApi();
    render(<App api={api} />);
    await enterAsset();

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    expect(await screen.findByRole("button", { name: "Create Run" })).toBeEnabled();
    expect(api.previewBatch).toHaveBeenCalledOnce();
    write.mockRestore();
  });

  it("surfaces a missing Image Input asset and blocks Preview", async () => {
    const form = populatedBatchForm();
    form.imageBindings = [{ slot_key: "source", values: ["asset-missing"] }];
    saveWorkingSession(form, null, "project-1");
    const api = makeApi();
    render(<App api={api} />);

    await waitFor(() => {
      expect(screen.getByText("Missing Project Asset 1")).toBeInTheDocument();
      expect(screen.getByText(/One or more selected Project Assets are missing/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    expect(
      await screen.findByText(/Selected Image Input assets are no longer available/),
    ).toBeInTheDocument();
    expect(api.previewBatch).not.toHaveBeenCalled();
  });
});

describe("Image Input controls", () => {
  it("collapses to an accurate summary without changing values or Preview validity", async () => {
    const form = populatedBatchForm();
    form.workflowProfileJson = profileJson([
      { key: "style", label: "Style", node_id: "1", input_name: "image" },
      { key: "pose", label: "Pose", node_id: "2", input_name: "image" },
    ]);
    form.imageBindings = [
      { slot_key: "style", values: [null, "asset-a"] },
      { slot_key: "pose", values: ["asset-b"] },
    ];
    saveWorkingSession(form, null, "project-1");
    const api = makeApi({
      listProjectAssets: vi.fn(async () => ({
        assets: [asset("asset-a", "a.png"), asset("asset-b", "b.png")],
      })),
      previewBatch: vi.fn(async () => previewResponse()),
    });
    render(<App api={api} />);

    await screen.findByRole("button", { name: "Remove a.png from Style" });
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await screen.findByRole("button", { name: "Create Run" });

    const imageInputs = screen.getByRole("group", { name: "Image Inputs" });
    expect(imageInputs).toHaveTextContent("2 image inputs · 3 alternatives · 1 uses Base workflow");
    fireEvent.click(within(imageInputs).getByRole("button", { name: "Done" }));

    expect(within(imageInputs).queryByRole("heading", { name: "Style" })).not.toBeInTheDocument();
    expect(within(imageInputs).getByRole("button", { name: "Change" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Create Run" })).toBeEnabled();
    expect(loadWorkingSession().form.imageBindings).toEqual(form.imageBindings);

    fireEvent.click(within(imageInputs).getByRole("button", { name: "Change" }));
    expect(within(imageInputs).getByRole("button", { name: "Remove a.png from Style" })).toHaveAttribute("aria-pressed", "true");
    expect(within(imageInputs).getByRole("button", { name: "Remove b.png from Pose" })).toHaveAttribute("aria-pressed", "true");
  });

  it("renders one control per slot in Profile order and fetches the library once", async () => {
    const form = populatedBatchForm();
    form.workflowProfileJson = profileJson([
      { key: "style", label: "Style", node_id: "1", input_name: "image" },
      { key: "pose", label: "Pose", node_id: "2", input_name: "image" },
    ]);
    form.imageBindings = [
      { slot_key: "style", values: [null] },
      { slot_key: "pose", values: ["asset-a"] },
    ];
    saveWorkingSession(form, null, "project-1");
    const api = makeApi({ listProjectAssets: vi.fn(async () => ({ assets: [asset("asset-a", "a.png")] })) });
    render(<App api={api} />);

    await screen.findAllByRole("button", { name: /a\.png/ });
    const imageInputs = screen.getByRole("group", { name: "Image Inputs" });
    expect(within(imageInputs).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Style", "Pose"]);
    expect(within(imageInputs).getByRole("button", { name: "Base workflow for Style" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Remove a.png from Pose" })).toHaveAttribute("aria-pressed", "true");
    expect(api.listProjectAssets).toHaveBeenCalledOnce();
  });

  it("preserves ordered alternatives independently across named slots", async () => {
    const form = populatedBatchForm();
    form.workflowProfileJson = profileJson([
      { key: "style", label: "Style", node_id: "1", input_name: "image" },
      { key: "pose", label: "Pose", node_id: "2", input_name: "image" },
    ]);
    form.imageBindings = [
      { slot_key: "style", values: [null] },
      { slot_key: "pose", values: [null] },
    ];
    saveWorkingSession(form, null, "project-1");
    const assets = [
      asset("asset-a", "a.png"),
      asset("asset-b", "b.png"),
      asset("asset-c", "c.png"),
    ];
    render(<App api={makeApi({ listProjectAssets: vi.fn(async () => ({ assets })) })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Add a.png to Style" }));
    fireEvent.click(screen.getByRole("button", { name: "Add b.png to Style" }));
    fireEvent.click(screen.getByRole("button", { name: "Add c.png to Pose" }));

    expect(loadWorkingSession().form.imageBindings).toEqual([
      { slot_key: "style", values: [null, "asset-a", "asset-b"] },
      { slot_key: "pose", values: [null, "asset-c"] },
    ]);
    const selected = screen.getByRole("list", { name: "Style selected alternatives" });
    expect(within(selected).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Base workflow · reference-image.pngRemove",
      "a.pngRemove",
      "b.pngRemove",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Remove a.png from Style" }));

    expect(loadWorkingSession().form.imageBindings[0]).toEqual({
      slot_key: "style",
      values: [null, "asset-b"],
    });
  });

  it("excludes Base workflow independently and invalidates Preview", async () => {
    render(<App api={makeApi()} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Base workflow for Source image" }));

    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    expect(loadWorkingSession().form.imageBindings).toEqual([{ slot_key: "source", values: ["asset-1"] }]);
  });
});

describe("Run creation", () => {
  it("creates a Run from the current form and renders durable metadata", async () => {
    const api = makeApi({ previewBatch: vi.fn(async () => previewResponse()) });
    render(<App api={api} />);
    await reachPreview();

    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    expect(await screen.findByRole("heading", { name: "Run 7" })).toBeInTheDocument();
    expect(within(currentRunSection()).getByText("run-123")).toBeInTheDocument();
    expect(screen.getByText("Created · Ready to start")).toBeInTheDocument();
    expect(screen.getByText("Run 7 is frozen and ready to start.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Run" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard Run" })).toBeEnabled();
    expect(api.createRun).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Create Another Run" })).toBeDisabled();
    expect(screen.getByText("Created as Run 7.")).toBeInTheDocument();
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

  it("preserves a newly durable Run and reports a Preview job-count mismatch", async () => {
    const api = makeApi({ createRun: vi.fn(async () => runResponse("run-mismatch", 9, 3)) });
    render(<App api={api} />);
    await reachPreview();

    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    expect(await screen.findByRole("heading", { name: "Run 9" })).toBeInTheDocument();
    expect(within(currentRunSection()).getByText("run-mismatch")).toBeInTheDocument();
    expect(screen.getByText(/Run 9 was created with 3 Jobs, but the inspected Preview has 2/))
      .toHaveClass("consistency-error");
    expect(screen.getByText("Run 9 was created but does not match this Preview.")).toBeInTheDocument();
  });

  it("keeps the frozen Run Plan inspectable after creation and current Batch edits", async () => {
    const frozen = runLookupResponse("created", "run-plan", 27);
    frozen.prompt_versions = [
      { id: "prompt-b", name: "Editorial", text: "Editorial {{subject}}" },
      { id: "prompt-a", name: "Portrait", text: "Portrait {{subject}}" },
    ];
    frozen.jobs = [
      { ordinal: 1, prompt_version_id: "prompt-b" },
      { ordinal: 2, prompt_version_id: "prompt-a" },
    ];
    frozen.plan.jobs = [
      {
        ordinal: 1,
        prompt_version_id: "prompt-b",
        prompt_version_name: "Editorial",
        resolved_prompt: "Editorial cat",
        resolved_variables: [
          { name: "subject", value: "cat" },
          { name: "style", value: "editorial" },
        ],
        resolved_image_inputs: [{ slot_key: "source", label: "Source image", asset_id: null, filename: null }],
        resolved_parameters: [{ parameter_key: "steps", label: "Steps", value: null }, { parameter_key: "width", label: "Width", value: 1024 }, { parameter_key: "height", label: "Height", value: null }],
        resolved_parameter_sets: [{ set_key: "resolution", set_label: "Resolution", row_ordinal: 1, row_label: "Landscape" }],
        seed: 123,
      },
      {
        ordinal: 2,
        prompt_version_id: "prompt-a",
        prompt_version_name: "Portrait",
        resolved_prompt: "Portrait dog",
        resolved_variables: [
          { name: "subject", value: "dog" },
          { name: "style", value: "editorial" },
        ],
        resolved_image_inputs: [{ slot_key: "source", label: "Source image", asset_id: "asset-1", filename: "portrait.png" }],
        resolved_parameters: [{ parameter_key: "steps", label: "Steps", value: 30 }, { parameter_key: "width", label: "Width", value: 768 }, { parameter_key: "height", label: "Height", value: 1024 }],
        resolved_parameter_sets: [{ set_key: "resolution", set_label: "Resolution", row_ordinal: 2, row_label: null }],
        seed: 456,
      },
    ];
    frozen.batch_snapshot.prompt_versions = [
      { id: "prompt-b", prompt_id: "prompt-2", version_number: 2, name: "Editorial", text: "Editorial {{subject}}" },
      { id: "prompt-a", prompt_id: "prompt-1", version_number: 4, name: "Portrait", text: "Portrait {{subject}}" },
    ];
    frozen.batch_snapshot.image_bindings = [{ slot_key: "source", values: [null, "asset-1"] }];
    frozen.batch_snapshot.parameter_bindings = [{
      parameter_key: "steps", mode: "range", include_base: true,
      range: { start: "30", end: "0", step: "-15" },
    }];
    frozen.batch_snapshot.linked_parameter_sets = [{ set_key: "resolution", set_label: "Resolution", members: ["width", "height"], rows: [
      { row_label: "Landscape", values: { width: 1024, height: null } },
      { row_label: null, values: { width: 768, height: 1024 } },
    ] }];
    frozen.batch_snapshot.workflow_selection.workflow_profile = {
      mappings: {}, image_inputs: [{ key: "source", label: "Source image", node_id: "1", input_name: "image" }],
      parameters: [{ key: "steps", label: "Steps", node_id: "2", input_name: "steps", value_type: "integer" }, { key: "width", label: "Width", node_id: "2", input_name: "width", value_type: "integer" }, { key: "height", label: "Height", node_id: "2", input_name: "height", value_type: "integer" }],
    };
    frozen.batch_snapshot.workflow_selection.workflow = {
      "1": { inputs: { image: "old-reference.png" } },
      "2": { inputs: { steps: 20, width: 1344, height: 768 } },
    };
    frozen.batch_snapshot.seed_intent = { mode: "random", values: [], random_seed_count: 2 };
    frozen.batch_snapshot.variable_bindings.push({ placeholder: "style", values: ["editorial"] });
    const api = makeApi({
      createRun: vi.fn(async () => runResponse("run-plan", 27, 2)),
      getRun: vi.fn(async () => frozen),
    });
    render(<App api={api} />);
    await reachPreview();

    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    await screen.findByRole("button", { name: "View Run Plan" });
    expect(screen.getByText(/2 prompts · 2 variable combinations · 1 image slot · 2 alternatives · Resolution: 2 rows · 2 seeds/))
      .toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Batch name"), { target: { value: "Edited afterward" } });
    const runPlanTrigger = screen.getByRole("button", { name: "View Run Plan" });
    fireEvent.click(runPlanTrigger);

    const dialog = screen.getByRole("dialog", { name: "Run 27 Plan" });
    const overlay = dialog.closest("[data-overlay-level='run-plan']");
    expect(overlay?.parentElement).toBe(document.body);
    expect(dialog.querySelector(".run-plan-content")).not.toBeNull();
    expect(within(dialog).getByRole("heading", { name: "First experiment" })).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("Edited afterward");
    expect([...dialog.querySelectorAll(".run-plan-prompts > li > strong")].map((node) => node.textContent))
      .toEqual(["Editorial", "Portrait"]);
    expect(within(dialog).getByText("2 values · cat, dog")).toBeInTheDocument();
    expect(within(dialog).getByText("1 value · editorial")).toBeInTheDocument();
    expect(within(dialog).getByText("Random · 2 requested")).toBeInTheDocument();
    expect(within(dialog).getByText("123, 456")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Base workflow · 20").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Base workflow · old-reference.png").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText(/Height: Base workflow · 768/).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("portrait.png").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("asset-1").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Steps").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("30").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("30 → 0 by -15")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Resolution").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Landscape").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Row 2").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("4 alternatives")).toBeInTheDocument();
    expect(within(dialog).queryByText("steps")).not.toBeInTheDocument();
    expect(within(dialog).getByText("KREA2 Outfit · v4")).toBeInTheDocument();
    expect(within(dialog).getByText("General · v4")).toBeInTheDocument();
    expect(within(dialog).getByText("Editorial cat")).toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Run 27 Plan" })).not.toBeInTheDocument();
    expect(runPlanTrigger).toHaveFocus();
  });

  it("shows exact snapshot divergence and clears it after an exact revert", async () => {
    const api = makeApi({
      getRun: vi.fn(async (runId: string) => {
        const frozen = runLookupResponse("created", runId, 7);
        frozen.batch_snapshot = vi.mocked(api.previewBatch).mock.calls[0][0].batch_snapshot;
        return frozen;
      }),
    });
    render(<App api={api} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    await screen.findByRole("button", { name: "View Run Plan" });
    expect(screen.queryByText("The current Batch has changed since this Run was created.")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Batch name"), { target: { value: "Edited afterward" } });
    expect(screen.getByText("The current Batch has changed since this Run was created.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View Run Plan" }));
    expect(screen.getByRole("dialog", { name: "Run 7 Plan" })).toHaveTextContent("First experiment");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Run 7 Plan" })).getByRole("button", { name: "Close" }));

    fireEvent.change(screen.getByLabelText("Batch name"), { target: { value: "First experiment" } });
    expect(screen.queryByText("The current Batch has changed since this Run was created.")).not.toBeInTheDocument();
  });

  it("uses the creation request snapshot before the frozen Run finishes loading", async () => {
    const frozenRequest = deferred<RunResponse>();
    let recoveryAtLookup: ReturnType<typeof loadWorkingSession> | null = null;
    const api = makeApi({ getRun: vi.fn(() => {
      recoveryAtLookup = loadWorkingSession();
      return frozenRequest.promise;
    }) });
    render(<App api={api} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    await screen.findByText("Run 7 is frozen and ready to start.");
    expect(recoveryAtLookup).toMatchObject({ currentRunId: "run-123", selectedProjectId: "project-1" });
    expect(loadWorkingSession().currentRunId).toBe("run-123");
    expect(loadWorkingSession().selectedProjectId).toBe("project-1");

    fireEvent.change(screen.getByLabelText("Batch name"), { target: { value: "Changed while loading" } });
    expect(screen.getByText("The current Batch has changed since this Run was created.")).toBeInTheDocument();

    const frozen = runLookupResponse("created");
    frozen.batch_snapshot = vi.mocked(api.previewBatch).mock.calls[0][0].batch_snapshot;
    frozenRequest.resolve(frozen);
    await screen.findByRole("button", { name: "View Run Plan" });
    expect(screen.getByText("The current Batch has changed since this Run was created.")).toBeInTheDocument();
  });
});

describe("Active Run rediscovery", () => {
  it("discovers an active Run when no pointer was persisted", async () => {
    const live = runLookupResponse("running", "run-live", 31);
    const activeExecution = execution("running", "run-live");
    activeExecution.execution_task_active = false;
    const api = makeApi({
      getActiveExecution: vi.fn(async () => ({ run_id: "run-live" })),
      getRun: vi.fn(async () => live),
      getExecution: vi.fn(async () => activeExecution),
    });

    render(<App api={api} />);

    expect(await screen.findByRole("heading", { name: "Run 31" })).toBeInTheDocument();
    expect(screen.getByText("Running · Control unavailable")).toBeInTheDocument();
    await waitFor(() => expect(loadWorkingSession().currentRunId).toBe("run-live"));
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it("uses a discovered active Run ahead of a different persisted pointer", async () => {
    seedWorkingSession("run-old");
    const api = makeApi({
      getActiveExecution: vi.fn(async () => ({ run_id: "run-active" })),
      getRun: vi.fn(async (runId: string) => runLookupResponse("succeeded", runId, runId === "run-active" ? 32 : 30)),
      getExecution: vi.fn(async (runId: string) => execution("succeeded", runId)),
    });

    render(<App api={api} />);

    expect(await screen.findByRole("heading", { name: "Run 32" })).toBeInTheDocument();
    await waitFor(() => expect(loadWorkingSession().currentRunId).toBe("run-active"));
    expect(api.getRun).toHaveBeenCalledExactlyOnceWith("run-active", expect.any(AbortSignal));
    expect(api.getResults).not.toHaveBeenCalledWith("run-old", expect.anything());
  });

  it("monitors a discovered cross-Project Run without assigning it to the draft", async () => {
    const foreign = runLookupResponse("running", "run-foreign", 33);
    foreign.project_id = "project-2";
    foreign.batch_id = "batch-2";
    foreign.batch_snapshot.project = { id: "project-2", filesystem_key: "project_2", name: "Other" };
    foreign.batch_snapshot.batch = { id: "batch-2", filesystem_key: "batch_2", name: "Other", description: null };
    const activeExecution = execution("running", foreign.run_id);
    activeExecution.execution_task_active = false;
    const api = makeApi({
      getActiveExecution: vi.fn(async () => ({ run_id: foreign.run_id })),
      getRun: vi.fn(async () => foreign),
      getExecution: vi.fn(async () => activeExecution),
    });

    render(<App api={api} />);

    expect(await screen.findByRole("heading", { name: "Run 33" })).toBeInTheDocument();
    expect(screen.getByText(/active Run from another Project or Batch/)).toBeInTheDocument();
    expect(loadWorkingSession().currentRunId).toBeNull();
    expect(loadWorkingSession().form.projectId).toBe("project-1");
  });

  it("does not rescan the draft Project when a foreign monitored Run becomes terminal", async () => {
    const foreign = runLookupResponse("running", "run-foreign", 33);
    foreign.project_id = "project-2";
    foreign.batch_snapshot.project = { id: "project-2", filesystem_key: "project_2", name: "Other" };
    const terminal = deferred<ExecutionResponse>();
    const api = makeApi({
      getActiveExecution: vi.fn(async () => ({ run_id: foreign.run_id })),
      getRun: vi.fn(async () => foreign),
      getExecution: vi.fn()
        .mockResolvedValueOnce(execution("running", foreign.run_id))
        .mockImplementation(() => terminal.promise),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await waitFor(() => expect(api.getExecution).toHaveBeenCalledTimes(2));
    expect(api.reindexProject).not.toHaveBeenCalled();
    navigateWorkspace("Gallery");
    await waitFor(() => expect(api.reindexProject).toHaveBeenCalledTimes(1));
    await act(async () => terminal.resolve(execution("succeeded", foreign.run_id)));
    expect(await within(screen.getByRole("region", { name: "Current Run" })).findByText("succeeded")).toBeVisible();
    await pause(20);
    expect(api.reindexProject).toHaveBeenCalledExactlyOnceWith("project-1");
  });

  it("shows a mismatched active monitor without erasing the persisted pointer", async () => {
    seedWorkingSession("run-draft");
    const foreign = runLookupResponse("running", "run-foreign", 34);
    foreign.batch_id = "other-batch";
    foreign.batch_snapshot.batch.id = "other-batch";
    const activeExecution = execution("running", foreign.run_id);
    activeExecution.execution_task_active = false;
    const api = makeApi({
      getActiveExecution: vi.fn(async () => ({ run_id: foreign.run_id })),
      getRun: vi.fn(async () => foreign),
      getExecution: vi.fn(async () => activeExecution),
    });

    render(<App api={api} />);

    expect(await screen.findByRole("heading", { name: "Run 34" })).toBeInTheDocument();
    await waitFor(() => expect(loadWorkingSession().currentRunId).toBe("run-draft"));
    expect(api.getRun).toHaveBeenCalledExactlyOnceWith("run-foreign", expect.any(AbortSignal));
  });

  it("retries transient active, Run, execution, and Project lookup failures", async () => {
    const listProjects = vi.fn<BatchcraftApi["listProjects"]>()
      .mockResolvedValueOnce({ projects: [] })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ projects: [projectResponse()] });
    const getActiveExecution = vi.fn<BatchcraftApi["getActiveExecution"]>()
      .mockRejectedValueOnce(new ApiError("offline", "network_error", null))
      .mockResolvedValue({ run_id: "run-live" });
    const getRun = vi.fn<BatchcraftApi["getRun"]>()
      .mockRejectedValueOnce(new ApiError("offline", "network_error", null))
      .mockResolvedValue(runLookupResponse("succeeded", "run-live", 35));
    const getExecution = vi.fn<BatchcraftApi["getExecution"]>()
      .mockRejectedValueOnce(new ApiError("offline", "network_error", null))
      .mockResolvedValue(execution("succeeded", "run-live"));
    const api = makeApi({ listProjects, getActiveExecution, getRun, getExecution });

    render(<App api={api} />);

    expect(await screen.findByRole("heading", { name: "Run 35" })).toBeInTheDocument();
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(3));
    expect(getActiveExecution).toHaveBeenCalledTimes(2);
    expect(getRun).toHaveBeenCalledTimes(2);
    expect(getExecution).toHaveBeenCalledTimes(2);
  });

  it("renders execution progress without waiting for Results", async () => {
    const pendingResults = deferred<{ run_id: string; results: ResultResponse[] }>();
    const activeExecution = execution("running", "run-live");
    activeExecution.execution_task_active = false;
    const api = makeApi({
      getActiveExecution: vi.fn(async () => ({ run_id: "run-live" })),
      getRun: vi.fn(async () => runLookupResponse("running", "run-live", 36)),
      getExecution: vi.fn(async () => activeExecution),
      getResults: vi.fn(() => pendingResults.promise),
    });

    render(<App api={api} />);

    expect(await screen.findByText("Running · Control unavailable")).toBeInTheDocument();
    expect(screen.getByText("0 of 2 Jobs succeeded")).toBeInTheDocument();
  });

  it("keeps the final Results request alive when execution polling reaches terminal state", async () => {
    const pendingResults = deferred<{ run_id: string; results: ResultResponse[] }>();
    const running = execution("running", "run-live");
    const getExecution = vi.fn<BatchcraftApi["getExecution"]>()
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(execution("succeeded", "run-live"));
    const getResults = vi.fn<BatchcraftApi["getResults"]>()
      .mockResolvedValueOnce({ run_id: "run-live", results: [] })
      .mockImplementationOnce(() => pendingResults.promise);
    const api = makeApi({
      getActiveExecution: vi.fn(async () => ({ run_id: "run-live" })),
      getRun: vi.fn(async () => runLookupResponse("running", "run-live", 38)),
      getExecution,
      getResults,
    });

    render(<App api={api} pollIntervalMs={5} />);

    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
    await waitFor(() => expect(getResults).toHaveBeenCalledTimes(2));
    pendingResults.resolve({
      run_id: "run-live",
      results: [result(1, 1, "image/png", "final.png", 512)],
    });
    expect(await screen.findByAltText("Result 1 from Job 1: final.png")).toBeInTheDocument();
  });

  it("preserves a submitted pointer after backend restart reports no active task", async () => {
    seedWorkingSession("run-submitted");
    const uncontrolled = execution("running", "run-submitted");
    uncontrolled.execution_task_active = false;
    const api = makeApi({
      getActiveExecution: vi.fn(async () => ({ run_id: null })),
      getRun: vi.fn(async () => runLookupResponse("running", "run-submitted", 37)),
      getExecution: vi.fn(async () => uncontrolled),
    });

    render(<App api={api} />);

    expect(await screen.findByText("Running · Control unavailable")).toBeInTheDocument();
    expect(loadWorkingSession().currentRunId).toBe("run-submitted");
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it("revalidates on pageshow and visible visibilitychange", async () => {
    const getActiveExecution = vi.fn(async () => ({ run_id: null }));
    const api = makeApi({ getActiveExecution });
    render(<App api={api} />);
    await waitFor(() => expect(getActiveExecution).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new PageTransitionEvent("pageshow"));
    await waitFor(() => expect(getActiveExecution).toHaveBeenCalledTimes(2));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(getActiveExecution).toHaveBeenCalledTimes(3));
  });

  it("coalesces concurrent lifecycle revalidation and never submits execution", async () => {
    const pending = deferred<{ run_id: string | null }>();
    const getActiveExecution = vi.fn(() => pending.promise);
    const api = makeApi({ getActiveExecution });
    render(<App api={api} />);
    await waitFor(() => expect(getActiveExecution).toHaveBeenCalledOnce());

    window.dispatchEvent(new PageTransitionEvent("pageshow"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await pause(20);

    expect(getActiveExecution).toHaveBeenCalledOnce();
    expect(api.startRun).not.toHaveBeenCalled();
    pending.resolve({ run_id: null });
    await waitFor(() => expect(getActiveExecution).toHaveBeenCalledTimes(2));
  });
});

describe("Discard unstarted Run", () => {
  it("keeps discarded provenance inspectable and permits another immutable Run", async () => {
    const createRun = vi
      .fn<BatchcraftApi["createRun"]>()
      .mockResolvedValueOnce(runResponse("run-discarded", 7))
      .mockResolvedValueOnce(runResponse("run-next", 8));
    const api = makeApi({
      createRun,
      discardRun: vi.fn(async (runId: string) => execution("cancelled", runId)),
      browseProjectRuns: vi.fn(async () => projectRunsFor(runLookupResponse("cancelled", "run-discarded", 7))),
      getRun: vi.fn(async (runId: string) => {
        const runNumber = runId === "run-discarded" ? 7 : 8;
        const frozen = runLookupResponse("created", runId, runNumber);
        frozen.batch_snapshot = vi.mocked(api.previewBatch).mock.calls[0][0].batch_snapshot;
        return frozen;
      }),
    });
    render(<App api={api} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    await screen.findByRole("button", { name: "View Run Plan" });

    expect(api.reindexProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard Run" }));

    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(api.reindexProject).not.toHaveBeenCalled();
    expect(api.discardRun).toHaveBeenCalledWith("run-discarded");
    expect(screen.queryByRole("button", { name: "Start Run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard Run" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View Run Plan" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Active Project" })).toBeEnabled();
    const createAnother = screen.getByRole("button", { name: "Create Another Run" });
    expect(createAnother).toBeEnabled();
    fireEvent.click(createAnother);

    expect(await screen.findByRole("heading", { name: "Run 8" })).toBeInTheDocument();
    expect(within(currentRunSection()).getByText("run-next")).toBeInTheDocument();
    await waitFor(() => expect(loadWorkingSession().currentRunId).toBe("run-next"));
    navigateWorkspace("Runs");
    const historyRun = await screen.findByRole("article", { name: "Run 7" });
    await waitFor(() => expect(api.reindexProject).toHaveBeenCalledExactlyOnceWith("project-1"));
    fireEvent.click(await within(historyRun).findByRole("button", { name: "View Run Plan" }));
    const plan = await screen.findByRole("dialog", { name: "Run 7 Plan" });
    expect(plan).toHaveTextContent("007-run");
    expect(plan).toHaveTextContent("A studio portrait of cat.");
    expect(api.getRun).toHaveBeenCalledWith("run-discarded");
    expect(api.getRun).toHaveBeenCalledTimes(2);
  });

  it("keeps an ineligible created Run inspectable without wedging the workspace", async () => {
    const createRun = vi
      .fn<BatchcraftApi["createRun"]>()
      .mockResolvedValueOnce(runResponse("run-ineligible", 7))
      .mockResolvedValueOnce(runResponse("run-next", 8));
    const api = makeApi({
      createRun,
      discardRun: vi.fn(async () => {
        throw new ApiError("Run can no longer be discarded", "run_discard_not_eligible", 409);
      }),
      getExecution: vi.fn(async () => execution("created", "run-ineligible")),
      getRun: vi.fn(async (runId: string) => {
        const runNumber = runId === "run-ineligible" ? 7 : 8;
        const frozen = runLookupResponse("created", runId, runNumber);
        frozen.batch_snapshot = vi.mocked(api.previewBatch).mock.calls[0][0].batch_snapshot;
        return frozen;
      }),
    });
    render(<App api={api} pollIntervalMs={1} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    await screen.findByRole("button", { name: "Discard Run" });

    fireEvent.click(screen.getByRole("button", { name: "Discard Run" }));

    expect(await screen.findByText("Created · Not executable")).toBeInTheDocument();
    expect(screen.getByText("This Run's persisted execution state is not eligible to start or discard.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard Run" })).not.toBeInTheDocument();
    expect(within(currentRunSection()).getByText("run-ineligible")).toBeInTheDocument();
    await waitFor(() => expect(
      screen.getByRole("combobox", { name: "Active Project" }),
    ).toBeEnabled());
    const createAnother = screen.getByRole("button", { name: "Create Another Run" });
    expect(createAnother).toBeEnabled();
    fireEvent.click(createAnother);
    expect(await screen.findByRole("heading", { name: "Run 8" })).toBeInTheDocument();
    expect(createRun).toHaveBeenCalledTimes(2);
    expect(api.getExecution).toHaveBeenCalledWith("run-ineligible");
  });

  it("reconciles a discarded Run when the response is lost", async () => {
    const api = makeApi({
      discardRun: vi.fn(async () => {
        throw new ApiError("Cannot reach the batchcraft API", "network_error", null);
      }),
      getExecution: vi.fn(async () => execution("cancelled")),
    });
    render(<App api={api} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard Run" }));

    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByText("Cannot reach the batchcraft API")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Run" })).not.toBeInTheDocument();
    expect(api.getExecution).toHaveBeenCalledWith("run-123");
    expect(api.getExecution).toHaveBeenCalledTimes(1);
  });

  it("reconciles execution when Start wins the discard race", async () => {
    const api = makeApi({
      discardRun: vi.fn(async () => {
        throw new ApiError("Run can no longer be discarded", "run_discard_not_eligible", 409);
      }),
      getExecution: vi.fn(async () => execution("running")),
    });
    render(<App api={api} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard Run" }));

    expect(await screen.findByText(/^Running/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard Run" })).not.toBeInTheDocument();
    expect(api.getExecution).toHaveBeenCalledWith("run-123");
  });

  it("disables discard while Start is in progress", async () => {
    const startRequest = deferred<{ run_id: string; status: string }>();
    const api = makeApi({
      startRun: vi.fn(() => startRequest.promise),
    });
    render(<App api={api} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    await screen.findByRole("button", { name: "Discard Run" });

    fireEvent.click(screen.getByRole("button", { name: "Start Run" }));
    expect(screen.getByRole("button", { name: "Discard Run" })).toBeDisabled();
    startRequest.resolve({ run_id: "run-123", status: "accepted" });
    await screen.findByText("Succeeded");
  });

  it("disables repeated discard while the request is in progress", async () => {
    const discardRequest = deferred<ExecutionResponse>();
    const api = makeApi({ discardRun: vi.fn(() => discardRequest.promise) });
    render(<App api={api} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard Run" }));
    expect(screen.getByRole("button", { name: "Discarding..." })).toBeDisabled();
    discardRequest.resolve(execution("cancelled"));
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: "Discard Run" })).not.toBeInTheDocument();
    expect(screen.queryByText("Job details")).not.toBeInTheDocument();
    expect(screen.getByText("prompt-1").closest(".job-secondary-metadata")).not.toBeNull();
    expect(api.startRun).toHaveBeenCalledWith("run-123");

    await waitFor(() => expect(api.getExecution).toHaveBeenCalledTimes(2));
    secondPoll.resolve(execution("succeeded"));
    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard Run" })).not.toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: "Discard Run" })).not.toBeInTheDocument();
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

describe("Stop after current Job", () => {
  it("confirms once, preserves completed Results, and unlocks after durable cancellation", async () => {
    const cancellationRequest = deferred<Awaited<ReturnType<RunCancellationApi["cancelRun"]>>>();
    const terminalPoll = deferred<ExecutionResponse>();
    const artifact = result(1, 1, "image/png", "kept.png", 2048);
    const api = makeApi({
      cancelRun: vi.fn(() => cancellationRequest.promise),
      getExecution: vi
        .fn<BatchcraftApi["getExecution"]>()
        .mockResolvedValueOnce(execution("running"))
        .mockImplementationOnce(() => terminalPoll.promise),
      getResults: vi.fn(async () => ({ run_id: "run-123", results: [artifact] })),
    });
    const mounted = render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    expect(await screen.findByText("Running · Job 1 of 2")).toBeInTheDocument();
    const stopAction = screen.getByRole("button", { name: "Stop after current Job" });
    fireEvent.click(stopAction);
    const confirmation = screen.getByRole("group", { name: "Confirm stop after current Job" });
    expect(within(confirmation).getByText("Stop this Run after the current Job finishes?"))
      .toBeInTheDocument();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Keep Running" }));
    expect(api.cancelRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Stop after current Job" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop Run" }));
    expect(screen.getByRole("button", { name: "Requesting stop..." })).toBeDisabled();
    expect(api.cancelRun).toHaveBeenCalledOnce();
    expect(api.cancelRun).toHaveBeenCalledWith("run-123");

    cancellationRequest.resolve({
      run_id: "run-123",
      mode: "after_current_job",
      requested_at: "2026-09-01T12:00:00Z",
      created: true,
      state: "stopping_after_current_job",
    });
    expect(await screen.findByText("Stopping after current Job · Job 1 of 2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop after current Job" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Active Project" })).toBeDisabled();

    terminalPoll.resolve(stoppedExecution());
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    const runSection = currentRunSection();
    expect(within(runSection).getByText("succeeded")).toBeInTheDocument();
    expect(within(runSection).getByText("cancelled")).toBeInTheDocument();
    expect(await within(currentResultsSection()).findByAltText("Result 1 from Job 1: kept.png"))
      .toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Batch Results" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Active Project" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Create Another Run" })).toBeEnabled();

    fireEvent.click(within(currentResultsSection()).getByRole("button", { name: "Details for Job 1, artifact 1" }));
    const details = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    const technical = within(details).getByText("Technical details").closest("details");
    expect(within(technical as HTMLElement).getByText("prompt-1")).toBeInTheDocument();
    expect(within(technical as HTMLElement).getByText("Integrity").nextElementSibling).toHaveTextContent("verified");
    mounted.unmount();

    const recoveredApi = makeApi({
      getExecution: vi.fn(async () => stoppedExecution()),
      getResults: vi.fn(async () => ({ run_id: "run-123", results: [artifact] })),
    });
    render(<App api={recoveredApi} pollIntervalMs={5} />);
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(await within(currentResultsSection()).findByAltText("Result 1 from Job 1: kept.png")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Batch Results" })).not.toBeInTheDocument();
    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    expect(loadWorkingSession().currentRunId).toBe("run-123");
    await pause(20);
    expect(recoveredApi.getExecution).toHaveBeenCalledOnce();
    expect(recoveredApi.startRun).not.toHaveBeenCalled();
    expect(recoveredApi.cancelRun).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguous response before allowing another Stop request", async () => {
    const reconciliationPoll = deferred<ExecutionResponse>();
    const laterPoll = deferred<ExecutionResponse>();
    const api = makeApi({
      cancelRun: vi.fn(async () => {
        throw new ApiError("Cannot reach the batchcraft API", "network_error", null);
      }),
      getExecution: vi
        .fn<BatchcraftApi["getExecution"]>()
        .mockResolvedValueOnce(execution("running"))
        .mockImplementationOnce(() => reconciliationPoll.promise)
        .mockImplementation(() => laterPoll.promise),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    await screen.findByText("Running · Job 1 of 2");

    fireEvent.click(screen.getByRole("button", { name: "Stop after current Job" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop Run" }));

    expect(await screen.findByRole("button", { name: "Checking stop request..." })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Stop after current Job" })).not.toBeInTheDocument();
    await waitFor(() => expect(api.getExecution).toHaveBeenCalledTimes(2));
    reconciliationPoll.resolve(execution("running"));
    expect(await screen.findByText("The Stop request was not observed; it is safe to request again."))
      .toBeInTheDocument();
    expect(vi.mocked(api.getExecution).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("button", { name: "Stop after current Job" })).toBeEnabled();
  });

  it("does not lose an acknowledged Stop request to an older running poll", async () => {
    const stalePoll = deferred<ExecutionResponse>();
    const laterPoll = deferred<ExecutionResponse>();
    const api = makeApi({
      getExecution: vi
        .fn<BatchcraftApi["getExecution"]>()
        .mockResolvedValueOnce(execution("running"))
        .mockImplementationOnce(() => stalePoll.promise)
        .mockImplementation(() => laterPoll.promise),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    await screen.findByText("Running · Job 1 of 2");
    await waitFor(() => expect(api.getExecution).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Stop after current Job" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop Run" }));
    expect(await screen.findByText("Stopping after current Job · Job 1 of 2")).toBeInTheDocument();

    stalePoll.resolve(execution("running"));
    await waitFor(() => expect(api.getExecution).toHaveBeenCalledTimes(3));
    expect(screen.getByText("Stopping after current Job · Job 1 of 2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop after current Job" })).not.toBeInTheDocument();
  });

  it.each([
    ["failed", "Failed"],
    ["blocked", "Blocked"],
    ["succeeded", "Succeeded"],
  ] as const)("keeps a post-request %s outcome authoritative", async (status, label) => {
    const nextExecution = execution(status);
    nextExecution.cancellation = {
      mode: "after_current_job",
      requested_at: "2026-09-01T12:00:00Z",
      state: "finished",
    };
    const api = makeApi({ getExecution: vi.fn(async () => nextExecution) });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.queryByText("Cancelled")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop after current Job" })).not.toBeInTheDocument();
  });
});

describe("Stop waiting", () => {
  it("confirms uncertainty, preserves Results, and unlocks only after durable detach", async () => {
    const detachRequest = deferred<Awaited<ReturnType<RunCancellationApi["detachRun"]>>>();
    const terminalPoll = deferred<ExecutionResponse>();
    const artifact = result(1, 1, "image/png", "already-downloaded.png", 2048);
    const api = makeApi({
      detachRun: vi.fn(() => detachRequest.promise),
      getExecution: vi
        .fn<BatchcraftApi["getExecution"]>()
        .mockResolvedValueOnce(execution("running"))
        .mockImplementationOnce(() => terminalPoll.promise),
      getResults: vi.fn(async () => ({ run_id: "run-123", results: [artifact] })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    expect(await screen.findByText("Running · Job 1 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    const confirmation = screen.getByRole("group", { name: "Confirm Stop waiting" });
    expect(within(confirmation).getByText("Stop waiting for this Job?")).toBeInTheDocument();
    expect(within(confirmation).getByText(/remote ComfyUI Job may continue running/))
      .toBeInTheDocument();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Keep Waiting" }));
    expect(api.detachRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    expect(screen.getByRole("button", { name: "Stopping local wait..." })).toBeDisabled();
    expect(api.detachRun).toHaveBeenCalledOnce();
    expect(api.detachRun).toHaveBeenCalledWith("run-123");

    detachRequest.resolve({
      run_id: "run-123",
      mode: "detach",
      requested_at: "2026-09-01T12:00:00Z",
      created: true,
      state: "detach_requested",
    });
    expect(await screen.findByText("Stopping local wait")).toBeInTheDocument();
    expect(screen.getByText(/remote ComfyUI Job may continue running/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Active Project" })).toBeDisabled();

    expect(api.reindexProject).not.toHaveBeenCalled();
    terminalPoll.resolve(detachedExecution());
    expect(await screen.findByText("Blocked: Remote outcome unknown")).toBeInTheDocument();
    expect(screen.getByText(/No later Job will start/)).toBeInTheDocument();
    const runSection = currentRunSection();
    expect(within(runSection).getByText("submitted")).toBeInTheDocument();
    expect(within(runSection).getByText("pending")).toBeInTheDocument();
    expect(await within(currentResultsSection()).findByAltText(
      "Result 1 from Job 1: already-downloaded.png",
    )).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Active Project" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Create Another Run" })).toBeEnabled();
    await pause(20);
    expect(api.getExecution).toHaveBeenCalledTimes(2);
    expect(api.reindexProject).not.toHaveBeenCalled();
    navigateWorkspace("Gallery");
    await waitFor(() => expect(api.reindexProject).toHaveBeenCalledExactlyOnceWith("project-1"));
  });

  it("reconciles an ambiguous detach response before allowing another request", async () => {
    const reconciliationPoll = deferred<ExecutionResponse>();
    const laterPoll = deferred<ExecutionResponse>();
    const api = makeApi({
      detachRun: vi.fn(async () => {
        throw new ApiError("Cannot reach the batchcraft API", "network_error", null);
      }),
      getExecution: vi
        .fn<BatchcraftApi["getExecution"]>()
        .mockResolvedValueOnce(execution("running"))
        .mockImplementationOnce(() => reconciliationPoll.promise)
        .mockImplementation(() => laterPoll.promise),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    await screen.findByText("Running · Job 1 of 2");

    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    expect(await screen.findByRole("button", { name: "Checking Stop waiting request..." }))
      .toBeDisabled();

    reconciliationPoll.resolve(execution("running"));
    expect(await screen.findByText(
      "The Stop waiting request was not observed; it is safe to request again.",
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop waiting" })).toBeEnabled();
  });

  it("reconciles an ineligible detach to an uncontrolled Run without a transient error", async () => {
    const uncontrolled = execution("running");
    uncontrolled.execution_task_active = false;
    const api = makeApi({
      detachRun: vi.fn(async () => {
        throw new ApiError(
          "Run is not eligible for cancellation",
          "run_cancellation_not_eligible",
          409,
        );
      }),
      getExecution: vi
        .fn<BatchcraftApi["getExecution"]>()
        .mockResolvedValueOnce(execution("running"))
        .mockResolvedValueOnce(uncontrolled),
    });
    render(<App api={api} pollIntervalMs={10_000} />);
    await createRunAndStart();
    await screen.findByText("Running · Job 1 of 2");

    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));

    expect(await screen.findByText("Running · Control unavailable")).toBeInTheDocument();
    expect(screen.getByText(/this backend process no longer controls it/)).toBeInTheDocument();
    expect(screen.queryByText("Run is not eligible for cancellation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop waiting" })).not.toBeInTheDocument();
    await waitFor(() => expect(
      screen.getByRole("button", { name: "Create Another Run" }),
    ).toBeEnabled());
  });

  it("reconciles an ineligible detach to a terminal outcome immediately", async () => {
    const api = makeApi({
      detachRun: vi.fn(async () => {
        throw new ApiError(
          "Run is not eligible for cancellation",
          "run_cancellation_not_eligible",
          409,
        );
      }),
      getExecution: vi
        .fn<BatchcraftApi["getExecution"]>()
        .mockResolvedValueOnce(execution("running"))
        .mockResolvedValueOnce(execution("succeeded")),
    });
    render(<App api={api} pollIntervalMs={10_000} />);
    await createRunAndStart();
    await screen.findByText("Running · Job 1 of 2");

    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));

    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
    expect(screen.queryByText("Run is not eligible for cancellation")).not.toBeInTheDocument();
    await waitFor(() => expect(
      screen.getByRole("button", { name: "Create Another Run" }),
    ).toBeEnabled());
  });

  it.each([
    ["failed", "Failed"],
    ["succeeded", "Succeeded"],
  ] as const)("keeps a proven %s outcome authoritative", async (status, label) => {
    const nextExecution = execution(status);
    nextExecution.cancellation = {
      mode: "detach",
      requested_at: "2026-09-01T12:00:00Z",
      state: "finished",
    };
    const api = makeApi({ getExecution: vi.fn(async () => nextExecution) });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.queryByText("Blocked: Remote outcome unknown")).not.toBeInTheDocument();
  });
});

describe("Repeated Runs", () => {
  it("creates a second Run from the same valid Preview after success", async () => {
    const createRun = vi
      .fn<BatchcraftApi["createRun"]>()
      .mockResolvedValueOnce(runResponse("run-1", 7))
      .mockResolvedValueOnce(runResponse("run-2", 8));
    const api = makeApi({
      createRun,
      getExecution: vi.fn(async (runId: string) => execution("succeeded", runId)),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
    const previewRequest = vi.mocked(api.previewBatch).mock.calls[0][0];

    const createAnother = screen.getByRole("button", { name: "Create Another Run" });
    await waitFor(() => expect(createAnother).toBeEnabled());
    fireEvent.click(createAnother);

    expect(await screen.findByRole("heading", { name: "Run 8" })).toBeInTheDocument();
    expect(within(currentRunSection()).getByText("run-2")).toBeInTheDocument();
    expect(createRun).toHaveBeenCalledTimes(2);
    expect(createRun.mock.calls[0][0]).toEqual({
      ...previewRequest,
      run_name: null,
      run_description: null,
    });
    expect(createRun.mock.calls[1][0]).toEqual({
      ...previewRequest,
      run_name: null,
      run_description: null,
    });
    expect(previewRequest.prompt_versions.map((prompt) => prompt.name)).toEqual(["Portrait"]);
    expect(within(screen.getByRole("group", { name: "Prompts" })).getByText("1 prompt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Run" })).toBeEnabled();
    expect(loadWorkingSession().currentRunId).toBe("run-2");
  });

  it.each(["failed", "blocked"] as const)(
    "allows a new Run after a %s Run without offering Retry",
    async (status) => {
      const createRun = vi
        .fn<BatchcraftApi["createRun"]>()
        .mockResolvedValueOnce(runResponse("run-1", 7))
        .mockResolvedValueOnce(runResponse("run-2", 8));
      const api = makeApi({
        createRun,
        getExecution: vi.fn(async (runId: string) => execution(status, runId)),
      });
      render(<App api={api} pollIntervalMs={5} />);
      await createRunAndStart();
      expect(
        await screen.findByText(status === "failed" ? "Failed" : "Blocked"),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Retry/i })).not.toBeInTheDocument();

      const createAnother = screen.getByRole("button", { name: "Create Another Run" });
      await waitFor(() => expect(createAnother).toBeEnabled());
      if (status === "blocked") {
        expect(screen.getByText(/previous Run is unchanged/)).toBeInTheDocument();
      }
      fireEvent.click(createAnother);

      expect(await screen.findByRole("heading", { name: "Run 8" })).toBeInTheDocument();
      expect(createRun).toHaveBeenCalledTimes(2);
    },
  );

  it("does not allow a running Run workspace to be replaced", async () => {
    const pending = deferred<ExecutionResponse>();
    const api = makeApi({
      getExecution: vi
        .fn<BatchcraftApi["getExecution"]>()
        .mockResolvedValueOnce(execution("running"))
        .mockImplementation(() => pending.promise),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    expect(await screen.findByText("Running · Job 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Another Run" })).toBeDisabled();
    expect(await screen.findByText("The current Run is still running.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Active Project" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Saved Batch" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save As" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("dialog", { name: "Save Batch" })).toBeInTheDocument();
    expect(api.createRun).toHaveBeenCalledOnce();
  });

  it("keeps the previous terminal Run visible when another creation fails", async () => {
    const createRun = vi
      .fn<BatchcraftApi["createRun"]>()
      .mockResolvedValueOnce(runResponse("run-1", 7))
      .mockRejectedValueOnce(new ApiError("Run publication failed", "run_publication_failed", 500));
    const api = makeApi({
      createRun,
      getExecution: vi.fn(async (runId: string) => execution("succeeded", runId)),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    await screen.findByText("Succeeded");

    const createAnother = screen.getByRole("button", { name: "Create Another Run" });
    await waitFor(() => expect(createAnother).toBeEnabled());
    fireEvent.click(createAnother);

    expect(await screen.findByText("Run publication failed")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Run 7" })).toBeInTheDocument();
    expect(within(currentRunSection()).getByText("run-1")).toBeInTheDocument();
  });
});

describe("Current Run restoration", () => {
  it("restores a running Run and resumes polling without submitting execution", async () => {
    seedWorkingSession("run-running");
    const nextPoll = deferred<ExecutionResponse>();
    const api = makeApi({
      getRun: vi.fn(async () => runLookupResponse("running", "run-running", 11)),
      getExecution: vi
        .fn<BatchcraftApi["getExecution"]>()
        .mockResolvedValueOnce(execution("running", "run-running"))
        .mockImplementationOnce(() => nextPoll.promise),
      getResults: vi.fn(async () => ({ run_id: "run-running", results: [] })),
    });
    render(<App api={api} pollIntervalMs={5} />);

    expect(await screen.findByRole("heading", { name: "Run 11" })).toBeInTheDocument();
    expect(screen.getByText("Running · Job 1 of 2")).toBeInTheDocument();
    expect(api.getRun).toHaveBeenCalledWith("run-running", expect.any(AbortSignal));
    await waitFor(() => expect(api.getExecution).toHaveBeenCalledTimes(2));
    expect(api.startRun).not.toHaveBeenCalled();
    nextPoll.resolve(execution("succeeded", "run-running"));
    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
  });

  it("restores an uncontrolled running Run without polling and permits replacement", async () => {
    seedWorkingSession("run-uncontrolled");
    const uncontrolled = execution("running", "run-uncontrolled");
    uncontrolled.execution_task_active = false;
    const api = makeApi({
      createRun: vi.fn(async () => runResponse("run-replacement", 12)),
      getRun: vi.fn(async () => runLookupResponse("running", "run-uncontrolled", 11)),
      getExecution: vi.fn(async () => uncontrolled),
      getResults: vi.fn(async (runId) => ({ run_id: runId, results: [] })),
    });
    render(<App api={api} pollIntervalMs={5} />);

    expect(await screen.findByText("Running · Control unavailable")).toBeInTheDocument();
    expect(screen.getByText(/cannot resume it automatically/)).toBeInTheDocument();
    expect(screen.queryByText("Watching execution state...")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop waiting" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Active Project" })).toBeEnabled();
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await pause(20);
    expect(api.getExecution).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    const createAnother = await screen.findByRole("button", { name: "Create Another Run" });
    expect(createAnother).toBeEnabled();
    fireEvent.click(createAnother);

    expect(await screen.findByRole("heading", { name: "Run 12" })).toBeInTheDocument();
    expect(api.createRun).toHaveBeenCalledOnce();
    expect(loadWorkingSession().currentRunId).toBe("run-replacement");
  });

  it("restores a created Run with Start available and does not start automatically", async () => {
    seedWorkingSession("run-created");
    const api = makeApi({
      getRun: vi.fn(async () => runLookupResponse("created", "run-created", 12)),
      getExecution: vi.fn(async () => execution("created", "run-created")),
      getResults: vi.fn(async () => ({ run_id: "run-created", results: [] })),
    });
    render(<App api={api} />);

    expect(await screen.findByRole("heading", { name: "Run 12" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Run" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard Run" })).toBeEnabled();
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it("restores a cancelled Run as terminal, not startable, and not creation-blocking", async () => {
    seedWorkingSession("run-cancelled");
    const api = makeApi({
      getRun: vi.fn(async () => runLookupResponse("cancelled", "run-cancelled", 15)),
      getExecution: vi.fn(async () => execution("cancelled", "run-cancelled")),
      getResults: vi.fn(async () => ({ run_id: "run-cancelled", results: [] })),
    });
    render(<App api={api} />);

    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard Run" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Active Project" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    expect(await screen.findByRole("button", { name: "Create Another Run" })).toBeEnabled();
  });

  it("restores a durable pending Stop request and resumes polling without requesting again", async () => {
    seedWorkingSession("run-stopping");
    const pendingPoll = deferred<ExecutionResponse>();
    const stopping = execution("running", "run-stopping");
    stopping.cancellation = {
      mode: "after_current_job",
      requested_at: "2026-09-01T12:00:00Z",
      state: "stopping_after_current_job",
    };
    const api = makeApi({
      getRun: vi.fn(async () => runLookupResponse("running", "run-stopping", 17)),
      getExecution: vi
        .fn<BatchcraftApi["getExecution"]>()
        .mockResolvedValueOnce(stopping)
        .mockImplementationOnce(() => pendingPoll.promise),
      getResults: vi.fn(async () => ({ run_id: "run-stopping", results: [] })),
    });
    render(<App api={api} pollIntervalMs={5} />);

    expect(await screen.findByText("Stopping after current Job · Job 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("The current Job will finish normally and keep its Results. No later Job will start."))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop after current Job" })).not.toBeInTheDocument();
    expect(api.cancelRun).not.toHaveBeenCalled();
    await waitFor(() => expect(api.getExecution).toHaveBeenCalledTimes(2));
  });

  it("restores a detached Run as terminal with Results and never resumes polling", async () => {
    seedWorkingSession("run-detached");
    const artifact = result(1, 1, "image/png", "restored-detached.png", 1024);
    const api = makeApi({
      getRun: vi.fn(async () => runLookupResponse("blocked", "run-detached", 18)),
      getExecution: vi.fn(async () => detachedExecution("run-detached")),
      getResults: vi.fn(async () => ({ run_id: "run-detached", results: [artifact] })),
    });
    render(<App api={api} pollIntervalMs={5} />);

    expect(await screen.findByText("Blocked: Remote outcome unknown")).toBeInTheDocument();
    expect(await screen.findByAltText("Result 1 from Job 1: restored-detached.png"))
      .toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Active Project" })).toBeEnabled();
    expect(api.startRun).not.toHaveBeenCalled();
    await pause(20);
    expect(api.getExecution).toHaveBeenCalledOnce();
  });

  it.each([
    ["failed", "Failed"],
    ["blocked", "Blocked"],
  ] as const)("restores a %s Run from backend execution state", async (status, label) => {
    seedWorkingSession(`run-${status}`);
    const api = makeApi({
      getRun: vi.fn(async () => runLookupResponse(status, `run-${status}`, 16)),
      getExecution: vi.fn(async () => execution(status, `run-${status}`)),
      getResults: vi.fn(async () => ({ run_id: `run-${status}`, results: [] })),
    });

    render(<App api={api} />);

    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it("restores a succeeded Run and its Results", async () => {
    seedWorkingSession("run-succeeded");
    const artifact = result(1, 1, "image/png", "restored.png", 1024);
    const api = makeApi({
      getRun: vi.fn(async () => runLookupResponse("succeeded", "run-succeeded", 13)),
      getExecution: vi.fn(async () => execution("succeeded", "run-succeeded")),
      getResults: vi.fn(async () => ({ run_id: "run-succeeded", results: [artifact] })),
    });
    render(<App api={api} />);

    expect(await screen.findByRole("heading", { name: "Run 13" })).toBeInTheDocument();
    expect(await screen.findAllByAltText("Result 1 from Job 1: restored.png")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Batch Results" })).not.toBeInTheDocument();
    expect(api.getResults).toHaveBeenCalledOnce();
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it("clears a missing restored Run ID and leaves the Batch usable", async () => {
    seedWorkingSession("run-missing");
    const api = makeApi({
      getRun: vi.fn(async () => {
        throw new ApiError("Run was not found", "run_not_found", 404);
      }),
    });
    render(<App api={api} />);

    expect(await screen.findByText(/The Run monitor could not be restored/)).toBeInTheDocument();
    await waitFor(() => expect(loadWorkingSession().currentRunId).toBeNull());
    expect(screen.getByRole("button", { name: "Preview Batch" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    expect(await screen.findByRole("button", { name: "Create Run" })).toBeEnabled();
  });

  it("monitors a restored Run from another Project or Batch without erasing its pointer", async () => {
    seedWorkingSession("run-mismatch");
    const api = makeApi({
      getRun: vi.fn(async () => ({
        ...runLookupResponse("succeeded", "run-mismatch", 14),
        project_id: "another-project",
      })),
      getExecution: vi.fn(async () => execution("succeeded", "run-mismatch")),
      getResults: vi.fn(async () => ({
        run_id: "run-mismatch",
        results: [result(1, 1, "image/png", "cross-batch.png", 512)],
      })),
    });
    render(<App api={api} />);

    expect(
      await screen.findByText("The previous Run belongs to another Project or Batch and is being monitored independently. Its pointer and the current draft were retained."),
    ).toBeInTheDocument();
    await waitFor(() => expect(loadWorkingSession().currentRunId).toBe("run-mismatch"));
    expect(api.getExecution).toHaveBeenCalledWith("run-mismatch", expect.any(AbortSignal));
    expect(screen.getByRole("heading", { name: "Run 14" })).toBeInTheDocument();
    expect(await within(currentResultsSection()).findByAltText("Result 1 from Job 1: cross-batch.png"))
      .toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Batch Results" })).not.toBeInTheDocument();
  });

  it("does not let an old Run Result response replace a newly created Run workspace", async () => {
    const oldResults = deferred<{ run_id: string; results: ResultResponse[] }>();
    const createRun = vi
      .fn<BatchcraftApi["createRun"]>()
      .mockResolvedValueOnce(runResponse("run-a", 7))
      .mockResolvedValueOnce(runResponse("run-b", 8));
    const getResults = vi
      .fn<BatchcraftApi["getResults"]>()
      .mockResolvedValueOnce({ run_id: "run-a", results: [] })
      .mockImplementationOnce(() => oldResults.promise);
    const api = makeApi({
      createRun,
      getExecution: vi.fn(async (runId: string) => execution("succeeded", runId)),
      getResults,
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    await screen.findByText("Succeeded");
    fireEvent.click(screen.getByRole("button", { name: "Refresh Results" }));
    await waitFor(() => expect(getResults).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Create Another Run" }));
    expect(await screen.findByRole("heading", { name: "Run 8" })).toBeInTheDocument();
    oldResults.resolve({
      run_id: "run-a",
      results: [result(1, 1, "image/png", "old-run.png", 1024)],
    });
    await pause(0);

    expect(screen.queryByAltText("Result 1 from Job 1: old-run.png")).not.toBeInTheDocument();
    expect(within(currentRunSection()).getByText("run-b")).toBeInTheDocument();
  });
});

describe("Results", () => {
  it("renders ordered image-first cards without technical metadata", async () => {
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
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const currentResults = screen.getByRole("heading", { name: "Results" }).closest("section");
    expect(currentResults).not.toBeNull();
    const scope = within(currentResults as HTMLElement);

    const firstImage = await scope.findByAltText("Result 1 from Job 1: first.png");
    expect(firstImage).toHaveAttribute("src", "http://api.test/api/result/1/1");
    expect(firstImage).toHaveClass("result-image");
    expect(firstImage.closest(".result-preview-frame")).not.toBeInTheDocument();
    expect(firstImage.closest("button.result-image-button")).not.toBeNull();

    // No visible technical metadata: filename, node, output, type, size.
    expect(scope.queryByText("first.png")).not.toBeInTheDocument();
    expect(scope.queryByText("metadata.json")).not.toBeInTheDocument();
    expect(scope.queryByText("512 B")).not.toBeInTheDocument();
    expect(scope.queryByText("41")).not.toBeInTheDocument();
    expect(scope.queryByText(/Node/i)).not.toBeInTheDocument();
    expect(scope.queryByText(/Output/i)).not.toBeInTheDocument();

    expect(scope.queryByText(/Job 00/)).not.toBeInTheDocument();
    expect(scope.queryByText("verified")).not.toBeInTheDocument();
    const nonImage = scope.getByRole("link", { name: /JSON\s*Open artifact/ });
    expect(nonImage).toHaveAttribute("href", "http://api.test/api/result/1/2");
    expect(scope.getAllByRole("button", { name: /Details for Job/ }).map((button) => button.getAttribute("aria-label")))
      .toEqual(["Details for Job 1, artifact 1", "Details for Job 1, artifact 2", "Details for Job 2, artifact 1"]);

    const cards = currentResults?.querySelectorAll(".result-card") ?? [];
    expect(cards).toHaveLength(3);
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

  it("keeps current Results collapsed as new Results arrive and reopens loaded interactions without refetching", async () => {
    const first = result(1, 1, "image/png", "first.png", 100);
    const second = result(2, 1, "image/png", "second.png", 100);
    const getResults = vi
      .fn<BatchcraftApi["getResults"]>()
      .mockResolvedValueOnce({ run_id: "run-123", results: [first] })
      .mockResolvedValue({ run_id: "run-123", results: [first, second] });
    const api = makeApi({
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults,
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const current = currentResultsSection();
    expect(await within(current).findByAltText("Result 1 from Job 1: first.png")).toBeInTheDocument();
    expect(within(current).getByText("1 Result")).toBeInTheDocument();
    const fetchesBeforeCollapse = getResults.mock.calls.length;
    fireEvent.click(within(current).getByRole("button", { name: "Collapse" }));

    expect(within(current).queryByAltText("Result 1 from Job 1: first.png")).not.toBeInTheDocument();
    expect(within(current).getByRole("button", { name: "Expand" })).toHaveAttribute("aria-expanded", "false");
    expect(getResults).toHaveBeenCalledTimes(fetchesBeforeCollapse);

    fireEvent.click(within(current).getByRole("button", { name: "Refresh Results" }));
    await within(current).findByText("2 Results");
    expect(within(current).queryByAltText("Result 1 from Job 2: second.png")).not.toBeInTheDocument();
    expect(within(current).getByRole("button", { name: "Expand" })).toBeInTheDocument();

    const fetchesBeforeExpand = getResults.mock.calls.length;
    fireEvent.click(within(current).getByRole("button", { name: "Expand" }));
    const image = within(current).getByAltText("Result 1 from Job 2: second.png");
    expect(getResults).toHaveBeenCalledTimes(fetchesBeforeExpand);
    fireEvent.click(image.closest("button") as HTMLElement);
    const lightbox = await screen.findByRole("dialog", { name: "Result image preview" });
    fireEvent.click(within(lightbox).getByRole("button", { name: "ⓘ Details" }));
    expect(await screen.findByRole("dialog", { name: "Job 002 · Artifact 1" })).toBeInTheDocument();
  });
});

describe("Result lightbox", () => {
  function completedRunApi(apiOverrides: Partial<BatchcraftApi> = {}) {
    return makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      getExecution: vi.fn(async () => execution("succeeded")),
      ...apiOverrides,
    });
  }

  const threeImages: ResultResponse[] = [
    result(1, 1, "image/png", "first.png", 100),
    result(2, 1, "image/jpeg", "second.jpg", 100),
    result(3, 1, "image/png", "third.png", 100),
  ];

  async function openFirstImage() {
    const image = await screen.findByAltText("Result 1 from Job 1: first.png");
    fireEvent.click(image.closest("button") as HTMLElement);
    return await screen.findByRole("dialog", { name: "Result image preview" });
  }

  it("opens on image click and closes via the explicit Close control", async () => {
    const frozen = runLookupResponse();
    frozen.plan.jobs[0].resolved_parameters = [{ parameter_key: "enabled", label: "Enabled", value: false }];
    const api = completedRunApi({
      getResults: vi.fn(async () => ({ run_id: "run-123", results: threeImages })),
      getRun: vi.fn(async () => frozen),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const lightbox = await openFirstImage();
    const lightboxOverlay = lightbox.closest("[data-overlay-level='lightbox']");
    expect(lightboxOverlay?.parentElement).toBe(document.body);
    expect(within(lightbox).getByText("1 of 3")).toBeInTheDocument();
    expect(within(lightbox).getByText("Job 001")).toBeInTheDocument();
    const fullImage = within(lightbox).getByRole("link", { name: "Open full image in new tab" });
    expect(fullImage).toHaveAttribute("href", "http://api.test/api/result/1/1");
    expect(fullImage).toHaveAttribute("target", "_blank");
    expect(fullImage).toHaveAttribute("rel", "noopener noreferrer");
    const previewImage = within(lightbox).getByAltText("Result 1 from Job 1: first.png");
    const fit = previewImage.parentElement;
    expect(fit).toHaveClass("lightbox-image-fit");
    expect(fit?.parentElement).toHaveClass("lightbox-image-stage");
    expect(previewImage).toHaveClass("result-lightbox-image");

    fireEvent.click(within(lightbox).getByRole("button", { name: "ⓘ Details" }));
    const details = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    const detailsOverlay = details.closest("[data-overlay-level='details']");
    expect(detailsOverlay?.parentElement).toBe(document.body);
    expect(lightboxOverlay).toHaveClass("overlay-layer-lightbox");
    expect(detailsOverlay).toHaveClass("overlay-layer-details");
    expect(within(details).getByText("A studio portrait of cat.", { exact: false })).toBeInTheDocument();
    expect(within(details).getByText("Enabled")).toBeInTheDocument();
    expect(within(details).getByText("false")).toBeInTheDocument();
    expect(within(details).queryByText("enabled")).not.toBeInTheDocument();
    fireEvent.click(within(details).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog", { name: "Result image preview" })).toBeInTheDocument();

    fireEvent.click(within(lightbox).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Result image preview" })).not.toBeInTheDocument();
  });

  it("closes with Escape", async () => {
    const api = completedRunApi({
      getResults: vi.fn(async () => ({ run_id: "run-123", results: threeImages })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const lightbox = await openFirstImage();
    fireEvent.keyDown(lightbox, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Result image preview" })).not.toBeInTheDocument();
  });

  it("navigates deterministically with Previous/Next and disables unavailable directions", async () => {
    const api = completedRunApi({
      getResults: vi.fn(async () => ({ run_id: "run-123", results: threeImages })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const image = await screen.findByAltText("Result 1 from Job 1: first.png");
    fireEvent.click(image.closest("button") as HTMLElement);
    const lightbox = await screen.findByRole("dialog", { name: "Result image preview" });

    // First item: Previous disabled, no wrap-around.
    expect(within(lightbox).getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(within(lightbox).getByRole("button", { name: "Next" })).toBeEnabled();
    fireEvent.click(within(lightbox).getByRole("button", { name: "Previous" }));
    expect(within(lightbox).getByText("1 of 3")).toBeInTheDocument();

    fireEvent.click(within(lightbox).getByRole("button", { name: "Next" }));
    expect(within(lightbox).getByText("2 of 3")).toBeInTheDocument();
    fireEvent.click(within(lightbox).getByRole("button", { name: "Next" }));
    expect(within(lightbox).getByText("3 of 3")).toBeInTheDocument();

    // Last item: Next disabled, no wrap-around.
    expect(within(lightbox).getByRole("button", { name: "Next" })).toBeDisabled();
    expect(within(lightbox).getByRole("button", { name: "Previous" })).toBeEnabled();
    fireEvent.click(within(lightbox).getByRole("button", { name: "Next" }));
    expect(within(lightbox).getByText("3 of 3")).toBeInTheDocument();
  });

  it("navigates with keyboard arrows", async () => {
    const api = completedRunApi({
      getResults: vi.fn(async () => ({ run_id: "run-123", results: threeImages })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const lightbox = await openFirstImage();
    fireEvent.keyDown(lightbox, { key: "ArrowRight" });
    expect(within(lightbox).getByText("2 of 3")).toBeInTheDocument();
    fireEvent.keyDown(lightbox, { key: "ArrowLeft" });
    expect(within(lightbox).getByText("1 of 3")).toBeInTheDocument();
    // ArrowLeft at the first item does not wrap.
    fireEvent.keyDown(lightbox, { key: "ArrowLeft" });
    expect(within(lightbox).getByText("1 of 3")).toBeInTheDocument();
  });

  it("opens historical Results with Run labels and deterministic lightbox navigation", async () => {
    const frozen = runLookupResponse("succeeded");
    const api = makeApi({
      browseProjectResults: vi.fn(async () => projectResultsFor(frozen, threeImages)),
      getRun: vi.fn(async () => frozen),
      getResults: vi.fn(async () => ({ run_id: "run-123", results: threeImages })),
    });
    render(<App api={api} />);

    navigateWorkspace("Gallery");
    const image = await screen.findByAltText("Run 7, Run 7, Job 1, artifact 1: first.png");
    fireEvent.click(image.closest("button") as HTMLElement);

    const lightbox = await screen.findByRole("dialog", { name: "Project Result image" });
    expect(within(lightbox).getByText("1/3")).toHaveAccessibleName("1 of 3 loaded images");
    expect(within(lightbox).getByRole("img")).toHaveAccessibleName("Run 7, Run 7, Job 1, artifact 1: first.png");
    fireEvent.keyDown(lightbox, { key: "ArrowRight" });
    expect(within(lightbox).getByText("2/3")).toHaveAccessibleName("2 of 3 loaded images");
    expect(api.listProjectRuns).not.toHaveBeenCalled();
    expect(api.getResults).not.toHaveBeenCalled();
    expect(api.getRun).not.toHaveBeenCalled();
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it("keeps the gallery usable when one image fails to load", async () => {
    const api = completedRunApi({
      getResults: vi.fn(async () => ({
        run_id: "run-123",
        results: [result(1, 1, "image/png", "broken.png", 100), result(2, 1, "image/png", "ok.png", 100)],
      })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const broken = await screen.findByAltText("Result 1 from Job 1: broken.png");
    fireEvent.error(broken);
    const failedSlot = await screen.findByText("Image unavailable");
    expect(failedSlot).toBeInTheDocument();

    const okImage = screen.getByAltText("Result 1 from Job 2: ok.png");
    const button = okImage.closest("button");
    expect((button as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(button as HTMLElement);
    const lightbox = await screen.findByRole("dialog", { name: "Result image preview" });
    // The failed image is excluded from navigation.
    expect(within(lightbox).getByText("1 of 1")).toBeInTheDocument();
  });

  it("renders images without any cropping wrapper structure", async () => {
    const api = completedRunApi({
      getResults: vi.fn(async () => ({ run_id: "run-123", results: threeImages })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const image = await screen.findByAltText("Result 1 from Job 1: first.png");
    const button = image.closest("button.result-image-button");
    expect(button).not.toBeNull();
    // The image is a direct child of the button: no aspect-ratio frame or
    // overflow container between the button and the image.
    expect(image.parentElement).toBe(button);
    expect(image.closest(".result-preview-frame")).not.toBeInTheDocument();
    expect(image.closest(".asset-preview-frame")).not.toBeInTheDocument();
  });
});

describe("Result Details", () => {
  function frozenProvenanceRun(runId = "run-123", runNumber = 7) {
    const frozen = runLookupResponse("succeeded", runId, runNumber);
    frozen.batch_snapshot.prompt_versions[0].version_number = 3;
    frozen.plan.jobs[0] = {
      ...frozen.plan.jobs[0],
      resolved_prompt: "A studio portrait of a cat in cinematic light.",
      resolved_variables: [
        { name: "subject", value: "cat" },
        { name: "style", value: "cinematic" },
      ],
      seed: 38192831,
      resolved_image_inputs: [
        { slot_key: "style", label: "Style image", asset_id: "ref-02", filename: "ref-02.png" },
        { slot_key: "pose", label: "Pose image", asset_id: null, filename: null },
      ],
    };
    frozen.plan.jobs[1] = {
      ...frozen.plan.jobs[1],
      resolved_prompt: "A studio portrait of a dog in natural light.",
      resolved_variables: [
        { name: "subject", value: "dog" },
        { name: "style", value: "natural" },
      ],
      seed: 992211,
      resolved_image_inputs: [
        { slot_key: "style", label: "Style image", asset_id: "ref-03", filename: "ref-03.png" },
        { slot_key: "pose", label: "Pose image", asset_id: null, filename: null },
      ],
    };
    return frozen;
  }

  it("opens the correct Result with frozen generation provenance and secondary technical metadata", async () => {
    const frozen = frozenProvenanceRun();
    const getRun = vi.fn(async () => frozen);
    const artifacts = [
      result(2, 1, "image/png", "dog.png", 4096),
      result(1, 1, "image/png", "cat.png", 2048),
    ];
    const api = makeApi({
      getRun,
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({ run_id: "run-123", results: artifacts })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const results = currentResultsSection();
    fireEvent.click(await within(results).findByRole("button", { name: "Details for Job 1, artifact 1" }));

    const dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(within(dialog).getByText("Portrait · v3")).toBeInTheDocument();
    expect(within(dialog).getByText("A studio portrait of a cat in cinematic light.", { exact: false }))
      .toBeInTheDocument();
    expect(within(dialog).getByText("subject")).toBeInTheDocument();
    expect(within(dialog).getByText("cat")).toBeInTheDocument();
    expect(within(dialog).getByText("style")).toBeInTheDocument();
    expect(within(dialog).getByText("cinematic")).toBeInTheDocument();
    expect(within(dialog).getByText("38192831")).toBeInTheDocument();
    expect(within(dialog).getByText("ref-02.png")).toBeInTheDocument();
    expect(within(dialog).getByText("KREA2 Outfit · v4")).toBeInTheDocument();
    expect(within(dialog).getByText("General · v4")).toBeInTheDocument();

    const technical = within(dialog).getByText("Technical details").closest("details");
    expect(technical).not.toHaveAttribute("open");
    expect(within(technical as HTMLElement).getByText("cat.png")).toBeInTheDocument();
    expect(within(technical as HTMLElement).getByText("2.0 KB")).toBeInTheDocument();
    expect(within(technical as HTMLElement).getByText("abc123")).toBeInTheDocument();
    expect(within(technical as HTMLElement).getByText("Integrity").nextElementSibling).toHaveTextContent("verified");

    // Run creation already loaded and cached the frozen Run Plan.
    expect(getRun).toHaveBeenCalledTimes(1);
  });

  it("shows Base workflow for a frozen named slot", async () => {
    const frozen = frozenProvenanceRun();
    frozen.plan.jobs[0].resolved_image_inputs = [
      { slot_key: "source", label: "Source image", asset_id: null, filename: null },
    ];
    frozen.batch_snapshot.workflow_selection.workflow = {
      "1": { inputs: { image: "old-reference.png" } },
    };
    const api = makeApi({
      getRun: vi.fn(async () => frozen),
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({
        run_id: "run-123",
        results: [result(1, 1, "image/png", "base.png", 100)],
      })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    fireEvent.click(await within(currentResultsSection()).findByRole("button", {
      name: "Details for Job 1, artifact 1",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(within(dialog).getByText("Base workflow · old-reference.png")).toBeInTheDocument();
  });

  it("renders a Parameter label and exact value without concatenating its technical key", async () => {
    const frozen = frozenProvenanceRun();
    frozen.plan.jobs[0].resolved_parameters = [
      { parameter_key: "cfg_internal", label: "Guidance", value: null },
      { parameter_key: "caption_internal", label: "Caption", value: "" },
    ];
    frozen.batch_snapshot.workflow_selection.workflow = {
      "7": { inputs: { cfg: 7 } },
    };
    frozen.batch_snapshot.workflow_selection.workflow_profile = {
      mappings: {},
      image_inputs: [],
      parameters: [{ key: "cfg_internal", label: "Guidance", node_id: "7", input_name: "cfg", value_type: "float" }],
    };
    const api = makeApi({
      getRun: vi.fn(async () => frozen),
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({
        run_id: "run-123",
        results: [result(1, 1, "image/png", "parameters.png", 100)],
      })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    fireEvent.click(await within(currentResultsSection()).findByRole("button", {
      name: "Details for Job 1, artifact 1",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(within(dialog).getByText("Guidance").nextElementSibling).toHaveTextContent(/^Base workflow · 7$/);
    expect(within(dialog).getByText("Caption").nextElementSibling).toHaveTextContent(/^"" \(empty string\)$/);
    expect(dialog).not.toHaveTextContent("cfg_internal");
    expect(dialog).not.toHaveTextContent("caption_internal");
  });

  it("renders the selected Preset row label in Result Details", async () => {
    const frozen = frozenProvenanceRun();
    frozen.plan.jobs[0].resolved_parameter_sets = [{ set_key: "resolution", set_label: "Resolution", row_ordinal: 1, row_label: "Landscape" }];
    const api = makeApi({
      getRun: vi.fn(async () => frozen),
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({ run_id: "run-123", results: [result(1, 1, "image/png", "preset.png", 100)] })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    fireEvent.click(await within(currentResultsSection()).findByRole("button", { name: "Details for Job 1, artifact 1" }));
    const dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(within(dialog).getByText("Resolution preset").nextElementSibling).toHaveTextContent("Landscape");
  });

  it("uses the Job ordinal and preserves artifact-specific technical metadata", async () => {
    const frozen = frozenProvenanceRun();
    const api = makeApi({
      getRun: vi.fn(async () => frozen),
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({
        run_id: "run-123",
        results: [
          result(1, 1, "image/png", "cat-primary.png", 100),
          result(1, 2, "image/png", "cat-mask.png", 200),
          result(2, 1, "image/png", "dog.png", 300),
        ],
      })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    const results = currentResultsSection();

    fireEvent.click(await within(results).findByRole("button", { name: "Details for Job 1, artifact 2" }));
    let dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 2" });
    expect(within(dialog).getByText("A studio portrait of a cat in cinematic light.", { exact: false }))
      .toBeInTheDocument();
    expect(within(dialog).getByText("cat-mask.png")).toBeInTheDocument();
    expect(within(dialog).getByText("200 B")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    fireEvent.click(within(results).getByRole("button", { name: "Details for Job 2, artifact 1" }));
    dialog = await screen.findByRole("dialog", { name: "Job 002 · Artifact 1" });
    expect(within(dialog).getByText("A studio portrait of a dog in natural light.", { exact: false }))
      .toBeInTheDocument();
    expect(within(dialog).getByText("992211")).toBeInTheDocument();
    expect(within(dialog).queryByText("cat-mask.png")).not.toBeInTheDocument();
  });

  it("isolates cached frozen Run provenance across Project History interactions and form edits", async () => {
    const form = populatedBatchForm();
    form.imageBindings = [{ slot_key: "source", values: ["asset-1"] }];
    saveWorkingSession(form, null, "project-1");
    const runA = frozenProvenanceRun("run-a", 10);
    runA.plan.jobs[0].resolved_prompt = "Frozen prompt from Run A";
    const runB = frozenProvenanceRun("run-b", 11);
    runB.plan.jobs[0].resolved_prompt = "Frozen prompt from Run B";
    const getRun = vi.fn(async (runId: string) => runId === "run-a" ? runA : runB);
    const api = makeApi({
      getRun,
      browseProjectRuns: vi.fn(async () => ({
        ...projectRunsFor(runA),
        items: [...projectRunsFor(runA).items, ...projectRunsFor(runB).items],
      })),
      browseProjectResults: vi.fn(async () => ({
        ...projectResultsFor(runA, [result(1, 1, "image/png", "run-a.png", 100)]),
        items: [
          ...projectResultsFor(runA, [result(1, 1, "image/png", "run-a.png", 100)]).items,
          ...projectResultsFor(runB, [result(1, 1, "image/png", "run-b.png", 100)]).items,
        ],
      })),
      getExecution: vi.fn(async (runId: string) => execution("succeeded", runId)),
      getResults: vi.fn(async (runId: string) => ({
        run_id: runId,
        results: [result(1, 1, "image/png", `${runId}.png`, 100)],
      })),
    });
    render(<App api={api} />);

    navigateWorkspace("Runs");
    const runARegion = await screen.findByRole("article", { name: "Run 10" });
    expect(getRun).not.toHaveBeenCalled();
    fireEvent.click(await within(runARegion).findByRole("button", { name: "View Run Plan" }));
    const plan = await screen.findByRole("dialog", { name: "Run 10 Plan" });
    expect(plan).toHaveTextContent("Frozen prompt from Run A");
    fireEvent.click(within(plan).getByRole("button", { name: "Close" }));
    navigateWorkspace("Batch");
    await expandConfiguration("Variable bindings");
    fireEvent.change(screen.getByLabelText("Values"), { target: { value: "Mutable draft fox" } });
    navigateWorkspace("Gallery");
    const detailsB = await screen.findByRole("button", { name: "Details for Run 11, Run 11, Job 1, artifact 1: run-b.png" });
    fireEvent.click(detailsB);
    let dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(await within(dialog).findByText("Frozen prompt from Run B", { exact: false })).toBeInTheDocument();
    expect(within(dialog).queryByText("Frozen prompt from Run A", { exact: false })).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("Mutable draft fox");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    fireEvent.click(detailsB);
    dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(within(dialog).getByText("Frozen prompt from Run B", { exact: false })).toBeInTheDocument();
    expect(getRun).toHaveBeenCalledTimes(2);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Details for Run 10, Run 10, Job 1, artifact 1: run-a.png" }));
    dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(dialog).toHaveTextContent("Frozen prompt from Run A");
    expect(dialog).not.toHaveTextContent("Frozen prompt from Run B");
    expect(dialog).not.toHaveTextContent("Mutable draft fox");
    expect(getRun).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed provenance load retryable inside Details", async () => {
    const frozen = frozenProvenanceRun();
    const getRun = vi
      .fn<BatchcraftApi["getRun"]>()
      .mockRejectedValueOnce(new ApiError("creation lookup failed", "network_error", 503))
      .mockRejectedValueOnce(new ApiError("details lookup failed", "network_error", 503))
      .mockResolvedValueOnce(frozen);
    const api = makeApi({
      getRun,
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({
        run_id: "run-123",
        results: [result(1, 1, "image/png", "retry.png", 100)],
      })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    fireEvent.click(await within(currentResultsSection()).findByRole("button", {
      name: "Details for Job 1, artifact 1",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(await within(dialog).findByText(/details lookup failed/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByText("Portrait · v3")).toBeInTheDocument();
    expect(getRun).toHaveBeenCalledTimes(3);
  });

  it("does not let a stale Details request overwrite a newly selected Result", async () => {
    const frozen = frozenProvenanceRun();
    const pending = deferred<RunResponse>();
    const getRun = vi
      .fn<BatchcraftApi["getRun"]>()
      .mockRejectedValueOnce(new ApiError("creation lookup failed", "network_error", 503))
      .mockImplementationOnce(() => pending.promise);
    const api = makeApi({
      getRun,
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({
        run_id: "run-123",
        results: [
          result(1, 1, "image/png", "cat.png", 100),
          result(2, 1, "image/png", "dog.png", 100),
        ],
      })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    const results = currentResultsSection();

    fireEvent.click(await within(results).findByRole("button", { name: "Details for Job 1, artifact 1" }));
    let dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(within(dialog).getByText("Loading frozen Run provenance...")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.click(within(results).getByRole("button", { name: "Details for Job 2, artifact 1" }));
    dialog = await screen.findByRole("dialog", { name: "Job 002 · Artifact 1" });

    pending.resolve(frozen);
    expect(await within(dialog).findByText("A studio portrait of a dog in natural light.", { exact: false }))
      .toBeInTheDocument();
    expect(within(dialog).queryByText("A studio portrait of a cat in cinematic light.", { exact: false }))
      .not.toBeInTheDocument();
    expect(getRun).toHaveBeenCalledTimes(2);
  });
});

describe("Current Results without Batch Results", () => {
  it("replaces current Results on successive Runs and restores only the latest Run after reload", async () => {
    const createRun = vi
      .fn<BatchcraftApi["createRun"]>()
      .mockResolvedValueOnce(runResponse("run-a", 10))
      .mockResolvedValueOnce(runResponse("run-b", 11));
    const resultsByRun: Record<string, ResultResponse[]> = {
      "run-a": [
        result(1, 1, "image/png", "a1.png", 100),
        result(2, 1, "image/png", "a2.png", 100),
      ],
      "run-b": [
        result(1, 1, "image/png", "b1.png", 100),
        result(1, 2, "application/json", "b2.json", 100),
      ],
    };
    const api = makeApi({
      createRun,
      getRun: vi.fn(async (runId: string) => runLookupResponse("succeeded", runId, runId === "run-a" ? 10 : 11)),
      getExecution: vi.fn(async (runId: string) => execution("succeeded", runId)),
      getResults: vi.fn(async (runId: string) => ({ run_id: runId, results: resultsByRun[runId] ?? [] })),
    });
    const mounted = render(<App api={api} pollIntervalMs={5} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    await screen.findByRole("heading", { name: "Run 10" });
    fireEvent.click(screen.getByRole("button", { name: "Start Run" }));
    expect(await within(currentResultsSection()).findByAltText("Result 1 from Job 1: a1.png")).toBeInTheDocument();
    expect(within(currentResultsSection()).getByAltText("Result 1 from Job 2: a2.png")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Batch Results" })).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole("button", { name: "Create Another Run" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create Another Run" }));
    await screen.findByRole("heading", { name: "Run 11" });
    expect(within(currentResultsSection()).queryByRole("img")).not.toBeInTheDocument();
    expect(within(currentResultsSection()).getByText("0 Results")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start Run" }));

    expect(await within(currentResultsSection()).findByAltText("Result 1 from Job 1: b1.png")).toBeInTheDocument();
    expect(within(currentResultsSection()).getAllByRole("img")).toHaveLength(1);
    expect(within(currentResultsSection()).getByRole("link", { name: /JSON\s*Open artifact/ })).toBeInTheDocument();
    expect(screen.queryByAltText(/a1\.png/)).not.toBeInTheDocument();
    expect(loadWorkingSession().currentRunId).toBe("run-b");
    mounted.unmount();
    vi.mocked(api.getRun).mockClear();
    vi.mocked(api.getResults).mockClear();
    vi.mocked(api.startRun).mockClear();

    render(<App api={api} />);

    await screen.findByRole("heading", { name: "Run 11" });
    expect(await within(currentResultsSection()).findByAltText("Result 1 from Job 1: b1.png")).toBeInTheDocument();
    expect(within(currentResultsSection()).getByText("2 Results")).toBeInTheDocument();
    expect(screen.queryByAltText(/a1\.png/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Batch Results" })).not.toBeInTheDocument();
    expect(api.getRun).toHaveBeenCalledExactlyOnceWith("run-b", expect.any(AbortSignal));
    expect(api.getResults).toHaveBeenCalledExactlyOnceWith("run-b", expect.any(AbortSignal));
    expect(api.startRun).not.toHaveBeenCalled();
    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
  });

  it.each([null, "run-b"])("ignores deprecated historical session IDs with current Run %s", async (currentRunId) => {
    saveWorkingSession(populatedBatchForm(), currentRunId, "project-1");
    const stored = JSON.parse(localStorage.getItem(WORKING_SESSION_RECOVERY_KEY)!);
    stored.session_run_ids = ["run-missing", "run-other", "run-bad", "run-a", "run-b"];
    localStorage.setItem(WORKING_SESSION_RECOVERY_KEY, JSON.stringify(stored));
    const api = makeApi({
      getRun: vi.fn(async (runId: string) =>
        runLookupResponse("succeeded", runId, runId === "run-a" ? 10 : 11),
      ),
      getExecution: vi.fn(async (runId: string) => execution("succeeded", runId)),
      getResults: vi.fn(async (runId: string) => ({
        run_id: runId,
        results: [result(1, 1, "image/png", `${runId}.png`, 100)],
      })),
    });
    render(<App api={api} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Preview Batch" })).toBeEnabled());
    expect(api.browseProjectRuns).not.toHaveBeenCalled();
    expect(api.browseProjectResults).not.toHaveBeenCalled();
    expect(api.listProjectRuns).not.toHaveBeenCalled();
    if (currentRunId) {
      await screen.findByRole("heading", { name: "Run 11" });
      expect(await within(currentResultsSection()).findByAltText("Result 1 from Job 1: run-b.png")).toBeInTheDocument();
      expect(api.getRun).toHaveBeenCalledExactlyOnceWith(currentRunId, expect.any(AbortSignal));
      expect(api.getExecution).toHaveBeenCalledExactlyOnceWith(currentRunId, expect.any(AbortSignal));
      expect(api.getResults).toHaveBeenCalledExactlyOnceWith(currentRunId, expect.any(AbortSignal));
    } else {
      expect(api.getRun).not.toHaveBeenCalled();
      expect(api.getExecution).not.toHaveBeenCalled();
      expect(api.getResults).not.toHaveBeenCalled();
      expect(within(currentResultsSection()).getByText("Awaiting a Run")).toBeInTheDocument();
    }
    expect(loadWorkingSession().currentRunId).toBe(currentRunId);
    expect(screen.queryByRole("region", { name: "Batch Results" })).not.toBeInTheDocument();
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it("clears current Results when selecting another Saved Batch", async () => {
    const artifact = result(1, 1, "image/png", "old-batch.png", 100);
    const api = makeApi({
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({ run_id: "run-123", results: [artifact] })),
      listSavedBatches: vi.fn(async () => ({
        batches: [
          {
            id: "batch-1",
            project_id: "project-1",
            filesystem_key: "batch_1",
            name: "First experiment",
            revision: 1,
            updated_at: "2026-08-27T12:00:00Z",
            archived_at: null,
          },
          {
            id: "batch-2",
            project_id: "project-1",
            filesystem_key: "batch_2",
            name: "Other experiment",
            revision: 1,
            updated_at: "2026-08-27T12:00:00Z",
            archived_at: null,
          },
        ],
      })),
      getSavedBatch: vi.fn(async () => ({
        id: "batch-2",
        project_id: "project-1",
        filesystem_key: "batch_2",
        name: "Other experiment",
        description: null,
        revision: 1,
        seed_mode: "fixed" as const,
        seed_values: [1],
        random_seed_count: null,
        selected_workflow_version_id: null,
        selected_workflow_profile_id: null,
        selected_workflow_profile_version_id: null,
        created_at: "2026-08-27T12:00:00Z",
        updated_at: "2026-08-27T12:00:00Z",
        archived_at: null,
        prompt_selections: [],
        variable_bindings: [],
        image_bindings: [],
        parameter_bindings: [],
        linked_parameter_sets: [],
        selected_workflow_version: null,
        selected_workflow_profile_name: null,
        selected_workflow_profile_archived_at: null,
        selected_workflow_profile_version: null,
      })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    expect(await within(currentResultsSection()).findByAltText("Result 1 from Job 1: old-batch.png")).toBeInTheDocument();

    fireEvent.change(await screen.findByRole("combobox", { name: "Saved Batch" }), {
      target: { value: "batch-2" },
    });
    await screen.findByRole("dialog", { name: "Switch Batch?" });
    fireEvent.click(screen.getByRole("button", { name: "Discard and switch" }));
    await waitFor(() => expect(loadWorkingSession().currentRunId).toBeNull());

    expect(within(currentResultsSection()).queryByRole("img")).not.toBeInTheDocument();
    expect(within(currentResultsSection()).getByText("Awaiting a Run")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Batch Results" })).not.toBeInTheDocument();
  });

  it("keeps healthy Project History Results when another Run's provenance is unavailable", async () => {
    const badRun = runLookupResponse("succeeded", "run-bad", 21);
    const goodRun = runLookupResponse("succeeded", "run-good", 22);
    const api = makeApi({
      browseProjectResults: vi.fn(async () => ({
        ...projectResultsFor(goodRun, []),
        items: [
          ...projectResultsFor(badRun, [result(1, 1, "image/png", "broken.png", 100)]).items,
          ...projectResultsFor(goodRun, [result(1, 1, "image/png", "healthy.png", 100)]).items,
        ],
      })),
      getRun: vi.fn(async (runId: string) => {
        if (runId === "run-bad") {
          throw new ApiError("Run data is invalid", "invalid_run_data", 500);
        }
        return runLookupResponse("succeeded", runId, 22);
      }),
      getResults: vi.fn(async (runId: string) => ({
        run_id: runId,
        results: [result(1, 1, "image/png", "healthy.png", 100)],
      })),
    });
    render(<App api={api} />);

    navigateWorkspace("Gallery");
    const bad = await screen.findByRole("button", { name: /Details for Run 21,/ });
    const good = screen.getByRole("button", { name: /Details for Run 22,/ });
    fireEvent.click(bad);
    expect(await screen.findByText("Run data is invalid")).toBeInTheDocument();
    expect(screen.getByAltText("Run 22, Run 22, Job 1, artifact 1: healthy.png")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    fireEvent.click(good);
    const details = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(details).toHaveTextContent("healthy.png");
    expect(details).toHaveTextContent("A studio portrait of cat.");
    expect(api.getRun).toHaveBeenCalledTimes(2);
  });
});

function makeApi(
  overrides: Partial<BatchcraftApi & RunDiscardApi & RunCancellationApi> = {},
): BatchcraftApi & RunDiscardApi & RunCancellationApi {
  const prompt = {
    id: "prompt-1",
    project_id: "project-1",
    name: "Portrait",
    description: null,
    created_at: "2026-08-27T12:00:00Z",
    updated_at: "2026-08-27T12:00:00Z",
    archived_at: null,
  };
  const version = {
    id: "prompt-v1",
    prompt_id: "prompt-1",
    version_number: 1,
    name_snapshot: "Portrait",
    text: "A studio portrait of {{subject}}.",
    note: null,
    created_at: "2026-08-27T12:00:00Z",
    archived_at: null,
    placeholders: ["subject"],
  };
  return {
    getComfyUIStatus: vi.fn(async () => ({
      reachable: true,
      version: "0.31.0",
      devices: ["Test GPU"],
      diagnostic: null,
    })),
    listProjects: vi.fn(async () => ({ projects: [projectResponse()] })),
    createProject: vi.fn(async () => projectResponse()),
    getProject: vi.fn(async () => projectResponse()),
    updateProject: vi.fn(async () => projectResponse()),
    adoptProject: vi.fn(async () => projectResponse()),
    importProject: vi.fn(async () => ({
      project_id: "project-1",
      filesystem_key: "project_1",
      name: "My Project",
      batch_count: 0,
      asset_count: 0,
      run_count: 0,
      diagnostic_count: 0,
    })),
    reindexProject: vi.fn(async () => ({
      project_id: "project-1",
      filesystem_key: "project_1",
      name: "My Project",
      batch_count: 0,
      asset_count: 0,
      run_count: 0,
      diagnostic_count: 0,
    })),
    listProjectRuns: vi.fn(async (projectId: string) => ({
      project_id: projectId,
      runs: [],
      diagnostics: [],
    })),
    browseProjectDiagnostics: vi.fn(async (projectId: string) => ({ project_id: projectId, generation: null, scanned_at: null, items: [], next_cursor: null, has_more: false })),
    browseProjectRuns: vi.fn(async (projectId: string) => ({ project_id: projectId, generation: null, scanned_at: null, items: [], next_cursor: null, has_more: false })),
    browseProjectResults: vi.fn(async (projectId: string) => ({ project_id: projectId, generation: null, scanned_at: null, items: [], next_cursor: null, has_more: false })),
    listAdoptableProjects: vi.fn(async () => ({ projects: [] })),
    getHistoryChoices: vi.fn(async (projectId: string) => ({ project_id: projectId, generation: null, items: [], has_more: false })),
    listSavedBatches: vi.fn(async () => ({ batches: [] })),
    createSavedBatch: vi.fn(),
    getSavedBatch: vi.fn(async () => { throw new ApiError("Saved Batch was not found", "saved_batch_not_found", 404); }),
    updateSavedBatch: vi.fn(),
    archiveSavedBatch: vi.fn(),
    listAdoptableSavedBatches: vi.fn(async () => ({ batches: [] })),
    adoptSavedBatch: vi.fn(),
    listProjectAssets: vi.fn(async () => ({ assets: [asset("asset-1", "portrait.png")] })),
    uploadProjectAssets: vi.fn(async () => ({ assets: [] })),
    listPrompts: vi.fn(async () => ({
      prompts: [{ ...prompt, latest_active_version: version }],
    })),
    createPrompt: vi.fn(async () => ({ prompt, version })),
    getPrompt: vi.fn(async () => prompt),
    updatePrompt: vi.fn(async () => prompt),
    listPromptVersions: vi.fn(async () => ({ prompt_versions: [version] })),
    createPromptVersion: vi.fn(async () => version),
    getPromptVersion: vi.fn(async () => version),
    listWorkflows: vi.fn(async () => ({ workflows: [] })),
    createWorkflow: vi.fn(),
    getWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
    archiveWorkflow: vi.fn(),
    listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [] })),
    createWorkflowVersion: vi.fn(),
    getWorkflowVersion: vi.fn(),
    archiveWorkflowVersion: vi.fn(),
    listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [] })),
    createWorkflowProfile: vi.fn(),
    getWorkflowProfile: vi.fn(),
    updateWorkflowProfile: vi.fn(),
    archiveWorkflowProfile: vi.fn(),
    listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [] })),
    createWorkflowProfileVersion: vi.fn(),
    getWorkflowProfileVersion: vi.fn(),
    archiveWorkflowProfileVersion: vi.fn(),
    previewBatch: vi.fn(async () => previewResponse()),
    createRun: vi.fn(async () => runResponse()),
    getActiveExecution: vi.fn(async () => ({ run_id: null })),
    getRun: vi.fn(async () => runLookupResponse()),
    getBatchReconstruction: vi.fn(),
    importRunPromptVersion: vi.fn(),
    importRunWorkflowVersion: vi.fn(),
    importRunWorkflowProfileVersion: vi.fn(),
    startRun: vi.fn(async (runId: string) => ({ run_id: runId, status: "accepted" })),
    discardRun: vi.fn(async (runId: string) => execution("cancelled", runId)),
    cancelRun: vi.fn(async (runId: string) => ({
      run_id: runId,
      mode: "after_current_job" as const,
      requested_at: "2026-09-01T12:00:00Z",
      created: true,
      state: "stopping_after_current_job" as const,
    })),
    detachRun: vi.fn(async (runId: string) => ({
      run_id: runId,
      mode: "detach" as const,
      requested_at: "2026-09-01T12:00:00Z",
      created: true,
      state: "detach_requested" as const,
    })),
    getExecution: vi.fn(async () => execution("succeeded")),
    getResults: vi.fn(async () => ({ run_id: "run-123", results: [] })),
    resultUrl: (url: string) => `http://api.test${url}`,
    assetUrl: (url: string) => `http://api.test${url}`,
    ...overrides,
  };
}

function previewResponse(jobCount = 2, imageAssetId: string | null = "asset-1"): PreviewResponse {
  const subjects = ["cat", "dog", "bird"];
  return {
    job_count: jobCount,
    warnings: [
      { code: "unused_binding", message: "Unused binding variable", placeholder: "unused" },
    ],
    jobs: Array.from({ length: jobCount }, (_, index) => {
      const subject = subjects[index] ?? `subject-${index + 1}`;
      return {
        ordinal: index + 1,
        prompt_version_id: "prompt-v1",
        prompt_version_name: "Portrait",
        resolved_prompt: `A studio portrait of ${subject}.`,
        resolved_variables: [{ name: "subject", value: subject }],
        resolved_image_inputs: [{
          slot_key: "source",
          label: "Source image",
          asset_id: imageAssetId,
          filename: imageAssetId ? "portrait.png" : null,
        }],
        resolved_parameters: [],
        resolved_parameter_sets: [],
        seed: 1,
      };
    }),
  };
}

function previewResponseWithSeeds(seeds: number[]): PreviewResponse {
  const response = previewResponse(seeds.length);
  return {
    ...response,
    jobs: response.jobs.map((job, index) => ({ ...job, seed: seeds[index] })),
  };
}

function runResponse(
  runId = "run-123",
  runNumber = 7,
  jobCount = 2,
  runName: string | null = null,
  runDescription: string | null = null,
): RunCreatedResponse {
  return {
    run_id: runId,
    run_number: runNumber,
    run_name: runName,
    run_description: runDescription,
    filesystem_key: `${String(runNumber).padStart(3, "0")}-${runName ? "baseline" : "run"}`,
    project_id: "project-1",
    project_name: "My Project",
    batch_id: "batch-1",
    batch_name: "First experiment",
    job_count: jobCount,
    durable_status: "created",
  };
}

function runLookupResponse(
  status: ExecutionResponse["status"] = "succeeded",
  runId = "run-123",
  runNumber = 7,
): RunResponse {
  return {
    ...runResponse(runId, runNumber),
    created_at: "2026-08-27T12:00:00Z",
    prompt_versions: [
      { id: "prompt-v1", name: "Portrait", text: "A studio portrait of {{subject}}." },
    ],
    jobs: [
      { ordinal: 1, prompt_version_id: "prompt-v1" },
      { ordinal: 2, prompt_version_id: "prompt-v1" },
    ],
    plan: {
      job_count: 2,
      warnings: [
        { code: "unused_binding", message: "Unused binding variable", placeholder: "unused" },
      ],
      jobs: previewResponse().jobs,
    },
    batch_snapshot: {
      format: "batchcraft.batch-snapshot",
      format_version: 1,
      project: { id: "project-1", filesystem_key: "project_1", name: "My Project" },
      source_saved_batch: { id: "batch-1", revision: 3 },
      batch: {
        id: "batch-1",
        filesystem_key: "batch_1",
        name: "First experiment",
        description: "Frozen Batch description",
      },
      prompt_versions: [
        {
          id: "prompt-v1",
          prompt_id: "prompt-1",
          version_number: 1,
          name: "Portrait",
          text: "A studio portrait of {{subject}}.",
        },
      ],
      variable_bindings: [
        {
          placeholder: "subject",
          values: ["cat", "dog"],
        },
      ],
      image_bindings: [{ slot_key: "source", values: ["asset-1"] }],
      parameter_bindings: [],
      linked_parameter_sets: [],
      seed_intent: { mode: "fixed", values: [1], random_seed_count: null },
      workflow_selection: {
        workflow_id: "workflow-1",
        workflow_version_id: "workflow-v4",
        workflow_name: "KREA2 Outfit",
        workflow_version_number: 4,
        workflow_profile_id: "profile-1",
        workflow_profile_version_id: "profile-v4",
        workflow_profile_name: "General",
        workflow_profile_version_number: 4,
        workflow: {},
        workflow_profile: JSON.parse(profileJson([
          { key: "source", label: "Source image", node_id: "1", input_name: "image" },
        ])),
      },
    },
    execution: execution(status, runId),
  };
}

function reconstructionFor(run: RunResponse): BatchReconstructionResponse {
  return {
    run_id: run.run_id,
    batch_snapshot: run.batch_snapshot,
    resources: {
      prompt_versions: run.batch_snapshot.prompt_versions.map((prompt, position) => ({
        position,
        historical_version_id: prompt.id,
        status: "linked" as const,
        reason: null,
        linked_version_id: prompt.id,
        linked_resource_id: prompt.prompt_id,
      })),
      workflow_version: {
        historical_version_id: run.batch_snapshot.workflow_selection.workflow_version_id,
        status: "detached",
        reason: "not imported",
        linked_version_id: null,
        linked_resource_id: null,
      },
      workflow_profile_version: {
        historical_version_id: run.batch_snapshot.workflow_selection.workflow_profile_version_id,
        status: "detached",
        reason: "not imported",
        linked_version_id: null,
        linked_resource_id: null,
      },
    },
  };
}

function navigateWorkspace(view: "Batch" | "Gallery" | "Runs") {
  fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace" })).getByRole("button", { name: view }));
}

function projectRunsFor(run: RunResponse): HistoryRunPageResponse {
  return {
    project_id: run.project_id,
    generation: "generation-1",
    scanned_at: run.created_at,
    next_cursor: null,
    has_more: false,
    items: [{ result_count: 0, run: {
      run_id: run.run_id,
      batch_id: run.batch_id,
      batch_name: run.batch_name,
      run_number: run.run_number,
      run_name: run.run_name,
      run_description_excerpt: run.run_description,
      display_truncated: false,
      created_at: run.created_at,
      job_count: run.job_count,
      execution_available: true,
      execution_status: run.execution.status,
      integrity_status: "verified" as const,
      replayable: true,
    } }],
  };
}

function projectResultsFor(run: RunResponse, results: ResultResponse[]): HistoryResultPageResponse {
  return {
    ...projectRunsFor(run),
    items: results.map((result) => ({
      run: projectRunsFor(run).items[0].run,
      job_id: `${run.run_id}-job-${result.job_ordinal}`,
      job_ordinal: result.job_ordinal,
      artifact_ordinal: result.artifact_ordinal,
      filename_excerpt: result.remote_filename,
      filename_truncated: false,
      content_type: result.content_type,
      byte_size: result.byte_size,
      sha256: result.sha256,
      integrity_status: result.integrity_status,
      download_url: result.download_url,
      download_unavailable_reason: result.download_url ? null : "artifact_unavailable",
    })),
  };
}

function execution(status: ExecutionResponse["status"], runId = "run-123"): ExecutionResponse {
  if (status === "created" || status === "cancelled") {
    return {
      run_id: runId,
      status,
      execution_task_active: false,
      started_at: null,
      completed_at: status === "cancelled" ? "2026-08-27T12:01:00Z" : null,
      current_job_ordinal: null,
      error: null,
      diagnostics: status === "cancelled" ? ["discarded_before_start"] : [],
      jobs: [1, 2].map((ordinal) => ({
        ordinal,
        status: "pending",
        prompt_id: null,
        started_at: null,
        completed_at: null,
        error: null,
        diagnostics: [],
        result_count: 0,
      })),
    };
  }
  const terminal = status === "succeeded" || status === "failed" || status === "blocked";
  return {
    run_id: runId,
    status,
    execution_task_active: status === "running",
    started_at: "2026-08-27T12:00:00Z",
    completed_at: terminal ? "2026-08-27T12:01:00Z" : null,
    current_job_ordinal: status === "running" ? 1 : null,
    error: status === "failed" ? "generation failed" : status === "blocked" ? "reconciliation required" : null,
    diagnostics: status === "blocked" ? ["submission outcome unknown"] : [],
    jobs: [
      {
        ordinal: 1,
        status: status === "running" || status === "blocked" ? "submitted" : status,
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

function stoppedExecution(runId = "run-123"): ExecutionResponse {
  return {
    run_id: runId,
    status: "cancelled",
    execution_task_active: false,
    started_at: "2026-09-01T11:59:00Z",
    completed_at: "2026-09-01T12:01:00Z",
    current_job_ordinal: null,
    error: null,
    diagnostics: ["stopped_after_current_job"],
    cancellation: {
      mode: "after_current_job",
      requested_at: "2026-09-01T12:00:00Z",
      state: "cancelled",
    },
    jobs: [
      {
        ordinal: 1,
        status: "succeeded",
        prompt_id: "prompt-1",
        started_at: "2026-09-01T11:59:00Z",
        completed_at: "2026-09-01T12:01:00Z",
        error: null,
        diagnostics: [],
        result_count: 1,
      },
      {
        ordinal: 2,
        status: "cancelled",
        prompt_id: null,
        started_at: null,
        completed_at: "2026-09-01T12:00:00Z",
        error: null,
        diagnostics: [],
        result_count: 0,
      },
    ],
  };
}

function detachedExecution(runId = "run-123"): ExecutionResponse {
  return {
    run_id: runId,
    status: "blocked",
    execution_task_active: false,
    started_at: "2026-09-01T11:59:00Z",
    completed_at: null,
    current_job_ordinal: 1,
    error: "User detached from current Job while remote completion was unconfirmed.",
    diagnostics: ["User detached from current Job while remote completion was unconfirmed."],
    cancellation: {
      mode: "detach",
      requested_at: "2026-09-01T12:00:00Z",
      state: "detached",
    },
    jobs: [
      {
        ordinal: 1,
        status: "submitted",
        prompt_id: "prompt-1",
        started_at: "2026-09-01T11:59:00Z",
        completed_at: null,
        error: null,
        diagnostics: [],
        result_count: 1,
      },
      {
        ordinal: 2,
        status: "pending",
        prompt_id: null,
        started_at: null,
        completed_at: null,
        error: null,
        diagnostics: [],
        result_count: 0,
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
    integrity_status: "verified",
    download_url: `/api/result/${jobOrdinal}/${artifactOrdinal}`,
  };
}

function asset(assetId: string, filename: string): AssetResponse {
  return {
    asset_id: assetId,
    original_filename: filename,
    content_type: "image/png",
    byte_size: 2048,
    sha256: `${assetId}-sha256`,
    created_at: "2026-08-27T12:00:00Z",
    content_url: `/api/assets/${assetId}`,
  };
}

function projectResponse(overrides: Partial<ProjectResponse> = {}): ProjectResponse {
  return {
    id: "project-1",
    filesystem_key: "project_1",
    name: "My Project",
    description: null,
    created_at: "2026-08-27T12:00:00Z",
    updated_at: "2026-08-27T12:00:00Z",
    archived_at: null,
    ...overrides,
  };
}

function populatedBatchForm() {
  const form = initialBatchForm();
  const prompt = newPrompt(1);
  form.projectId = "project-1";
  form.projectFilesystemKey = "project_1";
  form.projectName = "My Project";
  prompt.promptName = "Portrait";
  prompt.snapshotName = "Portrait";
  prompt.text = "A studio portrait of {{subject}}.";
  form.prompts = [prompt];
  form.workflowJson = JSON.stringify({ "1": { inputs: { image: "reference-image.png" } } });
  form.workflowProfileJson = profileJson([
    { key: "source", label: "Source image", node_id: "1", input_name: "image" },
  ]);
  form.imageBindings = [{ slot_key: "source", values: [null] }];
  return form;
}

function savedBatchDetail(overrides: Partial<SavedBatchDetail> = {}): SavedBatchDetail {
  return {
    id: "batch-1",
    project_id: "project-1",
    filesystem_key: "batch_1",
    name: "Batch",
    description: null,
    revision: 1,
    seed_mode: "fixed",
    seed_values: [1],
    random_seed_count: null,
    selected_workflow_version_id: null,
    selected_workflow_profile_id: null,
    selected_workflow_profile_version_id: null,
    selected_workflow_profile_name: null,
    selected_workflow_profile_archived_at: null,
    created_at: "2026-08-30T00:00:00Z",
    updated_at: "2026-08-30T00:00:00Z",
    archived_at: null,
    prompt_selections: [],
    variable_bindings: [{ placeholder: "subject", values: ["wolf"] }],
    image_bindings: [],
    parameter_bindings: [],
    linked_parameter_sets: [],
    selected_workflow_version: null,
    selected_workflow_profile_version: null,
    ...overrides,
  };
}

function profileJson(imageInputs: unknown[]): string {
  return JSON.stringify({ mappings: {}, image_inputs: imageInputs, parameters: [] });
}

function seedWorkingSession(runId: string) {
  const form = populatedBatchForm();
  form.imageBindings = [{ slot_key: "source", values: ["asset-1"] }];
  saveWorkingSession(form, runId, "project-1");
}

function currentResultsSection(): HTMLElement {
  const section = screen.getByRole("heading", { name: "Results" }).closest("section");
  if (!section) {
    throw new Error("Current Results section was not rendered");
  }
  return section;
}

function currentRunSection(): HTMLElement {
  const section = document.querySelector<HTMLElement>(".run-card");
  if (!section) {
    throw new Error("Current Run section was not rendered");
  }
  return section;
}

function promptVersion(
  overrides: Partial<LibraryPromptVersion> = {},
): LibraryPromptVersion {
  return {
    id: "prompt-v1",
    prompt_id: "prompt-1",
    version_number: 1,
    name_snapshot: "Portrait",
    text: "A studio portrait of {{subject}}.",
    note: null,
    created_at: "2026-08-27T12:00:00Z",
    archived_at: null,
    placeholders: ["subject"],
    ...overrides,
  };
}

function projectPrompt(
  id = "prompt-1",
  name = "Portrait",
  version = promptVersion({ prompt_id: id }),
): ProjectPrompt {
  return {
    id,
    project_id: "project-1",
    name,
    description: null,
    created_at: "2026-08-27T12:00:00Z",
    updated_at: "2026-08-27T12:00:00Z",
    archived_at: null,
    latest_active_version: version,
  };
}

async function addExistingPrompt(name: string) {
  const dialog = await openPromptLibrary();
  const nameNode = within(dialog).getByText(name, { selector: ".prompt-library-item strong" });
  const item = nameNode.closest("button");
  if (!item) throw new Error(`Prompt item was not rendered for ${name}`);
  fireEvent.click(item);
  fireEvent.click(within(dialog).getByRole("button", { name: "Add to Batch" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
}

async function openPromptLibrary(): Promise<HTMLElement> {
  await pause(0);
  await waitFor(() => expect(
    within(screen.getByRole("group", { name: "Prompts" }))
      .queryByText("Loading Prompt library..."),
  ).not.toBeInTheDocument());
  await waitFor(() => {
    if (screen.queryByRole("dialog", { name: "Prompts" })) return;
    const section = screen.getByRole("group", { name: "Prompts" });
    const add = within(section).queryByRole("button", { name: "Add Prompt" });
    if (add && !add.hasAttribute("disabled")) {
      fireEvent.click(add);
      throw new Error("Waiting for the Add Prompt dialog");
    }
    const edit = within(section).queryByRole("button", { name: "Edit" });
    if (edit) {
      fireEvent.click(edit);
      throw new Error("Waiting for the Prompt editor");
    }
    throw new Error("Prompt section is not ready");
  });
  const dialog = screen.getByRole("dialog", { name: "Prompts" });
  return dialog;
}

async function expandConfiguration(title: string, action = "Edit") {
  const section = screen.getByRole("group", { name: title });
  const existingButton = within(section).queryByRole("button", { name: action });
  if (!existingButton && action === "Edit" && within(section).queryByRole("button", { name: "Done" })) return;
  const button = existingButton ?? await within(section).findByRole("button", { name: action });
  if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
}

function promptCards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".prompt-card")];
}

async function enterAsset() {
  fireEvent.click(await screen.findByRole("button", { name: "Add portrait.png to Source image" }));
}

async function reachPreview() {
  await enterAsset();
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
