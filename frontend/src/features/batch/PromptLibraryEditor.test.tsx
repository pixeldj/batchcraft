import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiError, type BatchcraftApi } from "../../api/client";
import type {
  LibraryPromptVersion,
  ProjectPrompt,
  Prompt,
  PromptsResponse,
} from "../../api/types";
import type { PromptForm } from "./form";
import { PromptLibraryEditor } from "./PromptLibraryEditor";

describe("PromptLibraryEditor library loading", () => {
  it("clears old Project data and ignores a stale response", async () => {
    const oldRequest = deferred<PromptsResponse>();
    const api = makeApi({
      listPrompts: vi.fn((projectId: string) => projectId === "old" ? oldRequest.promise : Promise.resolve({
        prompts: [libraryPrompt("new-prompt", "New Project Prompt")],
      })),
    });
    const callbacks = callbackProps();
    const view = render(
      <PromptLibraryEditor api={api} projectId="old" prompts={[]} {...callbacks} />,
    );
    await waitFor(() => expect(api.listPrompts).toHaveBeenCalledWith("old", expect.any(AbortSignal)));

    view.rerender(<PromptLibraryEditor api={api} projectId="new" prompts={[]} {...callbacks} />);

    expect(screen.queryByText("Old Project Prompt")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Add Prompt" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose existing" }));
    expect(await screen.findByText("New Project Prompt")).toBeInTheDocument();
    await act(async () => oldRequest.resolve({ prompts: [libraryPrompt("old-prompt", "Old Project Prompt")] }));
    expect(screen.queryByText("Old Project Prompt")).not.toBeInTheDocument();
  });

  it("shows a specific missing-Project error and retries", async () => {
    const listPrompts = vi.fn<BatchcraftApi["listPrompts"]>()
      .mockRejectedValueOnce(new ApiError("missing", "project_not_found", 404))
      .mockResolvedValueOnce({ prompts: [] });
    const api = makeApi({ listPrompts });
    render(<PromptLibraryEditor api={api} projectId="missing" prompts={[]} {...callbackProps()} />);

    expect(await screen.findByText("Project was not found. Check the Project ID and try again.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("This Project has no active Prompts.")).toBeInTheDocument();
    expect(listPrompts).toHaveBeenCalledTimes(2);
  });

  it("does not load an empty Project ID", () => {
    const api = makeApi();
    render(<PromptLibraryEditor api={api} projectId="" prompts={[]} {...callbackProps()} />);

    expect(screen.getByText("Select a Project to load its Prompt library.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Prompt" })).toBeDisabled();
    expect(api.listPrompts).not.toHaveBeenCalled();
  });

  it("warns when a linked Prompt is unregistered", async () => {
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [] })),
      getPromptVersion: vi.fn(async () => { throw new ApiError("unavailable", "prompt_version_not_found", 404); }),
    });
    render(
      <PromptLibraryEditor
        api={api}
        projectId="project-1"
        prompts={[formPrompt({ promptId: "gone" })]}
        {...callbackProps()}
      />,
    );

    expect(await screen.findByText("The linked Prompt is not registered in this Project.")).toBeInTheDocument();
  });

  it("uses the Project library's current logical name without changing the snapshot", async () => {
    const stored = formPrompt({ promptName: "Old logical name", snapshotName: "Version snapshot" });
    const callbacks = callbackProps();
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [libraryPrompt("prompt-1", "Current logical name")] })),
    });
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[stored]} {...callbacks} />);

    expect(await screen.findByText("Current logical name")).toBeInTheDocument();
    expect(screen.getByText("Saved as Version snapshot")).toBeInTheDocument();
    expect(callbacks.onMetadataChange).toHaveBeenCalledWith([{
      ...stored,
      promptName: "Current logical name",
    }]);
    expect(callbacks.onChange).not.toHaveBeenCalled();
  });
});

describe("PromptLibraryEditor selection and creation", () => {
  it("chooses latest_active_version directly and blocks a duplicate version", async () => {
    const first = libraryPrompt("prompt-1", "First", version({ id: "version-2", prompt_id: "prompt-1", version_number: 2 }));
    const latest = version({ id: "version-5", prompt_id: "prompt-2", version_number: 5, text: "latest text" });
    const second = libraryPrompt("prompt-2", "Second", latest);
    const callbacks = callbackProps();
    const api = makeApi({ listPrompts: vi.fn(async () => ({ prompts: [first, second] })) });
    render(
      <PromptLibraryEditor
        api={api}
        projectId="project-1"
        prompts={[formPrompt({ promptId: first.id, versionId: "version-2", versionNumber: 2 })]}
        {...callbacks}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add Prompt" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose existing" }));
    const picker = screen.getByRole("dialog", { name: "Add Prompt" });
    expect(picker).toHaveClass("prompt-dialog");
    const firstCard = within(picker).getByText("First").closest(".repeater-card");
    const secondCard = within(picker).getByText("Second").closest(".repeater-card");
    expect(within(firstCard as HTMLElement).getByRole("button", { name: "Already added" })).toBeDisabled();
    fireEvent.click(within(secondCard as HTMLElement).getByRole("button", { name: "Use latest version" }));

    expect(callbacks.onChange).toHaveBeenCalledWith([
      expect.any(Object),
      expect.objectContaining({
        promptId: "prompt-2",
        promptName: "Second",
        versionId: "version-5",
        versionNumber: 5,
        snapshotName: latest.name_snapshot,
        text: "latest text",
      }),
    ]);
    expect(api.listPromptVersions).not.toHaveBeenCalled();
  });

  it("preserves a failed create draft and appends returned v1 after success", async () => {
    const createdVersion = version({ id: "created-v1", prompt_id: "created", version_number: 1, text: "new text" });
    const createdPrompt = prompt("created", "Created Prompt");
    const createPrompt = vi.fn<BatchcraftApi["createPrompt"]>()
      .mockRejectedValueOnce(new ApiError("Name already exists", "prompt_name_conflict", 409))
      .mockResolvedValueOnce({ prompt: createdPrompt, version: createdVersion });
    const callbacks = callbackProps();
    const api = makeApi({ createPrompt, listPrompts: vi.fn(async () => ({ prompts: [] })) });
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[]} {...callbacks} />);

    fireEvent.click(await screen.findByRole("button", { name: "Add Prompt" }));
    fireEvent.click(screen.getByRole("button", { name: "Create new" }));
    fireEvent.change(screen.getByLabelText("Prompt name"), { target: { value: "Created Prompt" } });
    fireEvent.change(screen.getByLabelText("Prompt template"), { target: { value: "new text" } });
    fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: "description" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Prompt" }));

    expect(await screen.findByText("Name already exists")).toBeInTheDocument();
    expect(screen.getByLabelText("Prompt template")).toHaveValue("new text");
    fireEvent.click(screen.getByRole("button", { name: "Create Prompt" }));

    await waitFor(() => expect(callbacks.onChange).toHaveBeenCalledWith([
      expect.objectContaining({ versionId: "created-v1", promptId: "created", text: "new text" }),
    ]));
    expect(createPrompt).toHaveBeenLastCalledWith("project-1", {
      name: "Created Prompt",
      text: "new text",
      description: "description",
    });
  });

  it("ignores a create response after the Project changes", async () => {
    const request = deferred<{ prompt: Prompt; version: LibraryPromptVersion }>();
    const callbacks = callbackProps();
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [] })),
      createPrompt: vi.fn(() => request.promise),
    });
    const view = render(
      <PromptLibraryEditor api={api} projectId="project-1" prompts={[]} {...callbacks} />,
    );
    const add = await screen.findByRole("button", { name: "Add Prompt" });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    fireEvent.click(screen.getByRole("button", { name: "Create new" }));
    fireEvent.change(screen.getByLabelText("Prompt name"), { target: { value: "Stale" } });
    fireEvent.change(screen.getByLabelText("Prompt template"), { target: { value: "stale text" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Prompt" }));

    view.rerender(
      <PromptLibraryEditor api={api} projectId="project-2" prompts={[]} {...callbacks} />,
    );
    await act(() => request.resolve({
      prompt: prompt("stale", "Stale"),
      version: version({ id: "stale-v1", prompt_id: "stale", text: "stale text" }),
    }));

    expect(callbacks.onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("PromptLibraryEditor version operations", () => {
  it("loads history lazily and selects an older unarchived version", async () => {
    const current = version({ id: "v2", version_number: 2, text: "current" });
    const older = version({ id: "v1", version_number: 1, text: "older", note: "Original wording" });
    const archived = version({ id: "v0", version_number: 0, text: "archived", archived_at: "2026-08-20T00:00:00Z" });
    const logicalPrompt = libraryPrompt("prompt-1", "Current logical name", current);
    const callbacks = callbackProps();
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [logicalPrompt] })),
      listPromptVersions: vi.fn(async () => ({ prompt_versions: [current, older, archived] })),
    });
    render(
      <PromptLibraryEditor api={api} projectId="project-1" prompts={[formPrompt({ text: "current", versionId: "v2", versionNumber: 2 })]} {...callbacks} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "History / change version" }));
    expect(await screen.findByText("Original wording")).toBeInTheDocument();
    expect(api.listPromptVersions).toHaveBeenCalledWith("prompt-1", true, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "History / change version" }));
    expect(screen.getByText("Original wording")).toBeInTheDocument();
    expect(api.listPromptVersions).toHaveBeenCalledTimes(1);
    const olderCard = screen.getByText("older").closest(".repeater-card");
    const archivedCard = screen.getByText("archived").closest(".repeater-card");
    expect(within(archivedCard as HTMLElement).getByRole("button", { name: "Archived" })).toBeDisabled();
    fireEvent.click(within(olderCard as HTMLElement).getByRole("button", { name: "Use this version" }));

    expect(callbacks.onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        versionId: "v1",
        versionNumber: 1,
        snapshotName: older.name_snapshot,
        text: "older",
        promptName: "Current logical name",
      }),
    ]);
  });

  it("retains a failed edit and replaces the selection only after success", async () => {
    const next = version({ id: "v3", version_number: 3, text: "edited" });
    const createPromptVersion = vi.fn<BatchcraftApi["createPromptVersion"]>()
      .mockRejectedValueOnce(new ApiError("Write failed", "write_failed", 500))
      .mockResolvedValueOnce(next);
    const callbacks = callbackProps();
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [libraryPrompt()] })),
      createPromptVersion,
    });
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[formPrompt()]} {...callbacks} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit as new version" }));
    fireEvent.change(screen.getByLabelText("Prompt template"), { target: { value: "edited" } });
    fireEvent.change(screen.getByLabelText("Version note (optional)"), { target: { value: "Make it shorter" } });
    fireEvent.click(screen.getByRole("button", { name: "Create version" }));

    expect(await screen.findByText("Write failed")).toBeInTheDocument();
    expect(callbacks.onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Prompt template")).toHaveValue("edited");
    fireEvent.click(screen.getByRole("button", { name: "Create version" }));

    await waitFor(() => expect(callbacks.onChange).toHaveBeenCalledWith([
      expect.objectContaining({ versionId: "v3", versionNumber: 3, text: "edited" }),
    ]));
    expect(createPromptVersion).toHaveBeenLastCalledWith("prompt-1", {
      text: "edited",
      note: "Make it shorter",
    });
  });

  it("renames through metadata without changing snapshot fields", async () => {
    const original = formPrompt({ promptName: "Current name", snapshotName: "Saved name", text: "frozen text" });
    const callbacks = callbackProps();
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [libraryPrompt("prompt-1", "Current name")] })),
      updatePrompt: vi.fn(async () => ({ ...prompt("prompt-1", "Renamed"), updated_at: "2026-08-29T12:00:00Z" })),
    });
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[original]} {...callbacks} />);

    fireEvent.click(await screen.findByRole("button", { name: "Rename Prompt" }));
    fireEvent.change(screen.getByLabelText("Prompt name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() => expect(callbacks.onMetadataChange).toHaveBeenCalledWith([{
      ...original,
      promptName: "Renamed",
    }]));
    expect(callbacks.onChange).not.toHaveBeenCalled();
  });
});

describe("PromptLibraryEditor ordering and linkage", () => {
  it("moves and removes entries, including the final selection", async () => {
    const first = formPrompt({ key: 1, promptId: "p1", versionId: "v1", promptName: "One" });
    const second = formPrompt({ key: 2, promptId: "p2", versionId: "v2", promptName: "Two" });
    const callbacks = callbackProps();
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [libraryPrompt("p1", "One"), libraryPrompt("p2", "Two")] })),
    });
    const view = render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[first, second]} {...callbacks} />);
    await screen.findByText("One");

    const secondCard = screen.getByText("Two").closest("article");
    fireEvent.click(within(secondCard as HTMLElement).getByRole("button", { name: "Move up" }));
    expect(callbacks.onChange).toHaveBeenLastCalledWith([second, first]);
    fireEvent.click(within(secondCard as HTMLElement).getByRole("button", { name: "Remove" }));
    expect(callbacks.onChange).toHaveBeenLastCalledWith([first]);

    view.rerender(<PromptLibraryEditor api={api} projectId="project-1" prompts={[first]} {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(callbacks.onChange).toHaveBeenLastCalledWith([]);
    expect(screen.getByRole("button", { name: "Add Prompt" })).toBeEnabled();
  });

  it("reconnects an exact detached snapshot through metadata", async () => {
    const detached = formPrompt({
      libraryProjectId: null,
      promptId: null,
      promptName: "Saved name",
      snapshotName: "Saved name",
      text: "saved text",
    });
    const callbacks = callbackProps();
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [libraryPrompt("prompt-1", "Current name")] })),
      getPromptVersion: vi.fn(async () => version({ name_snapshot: "Saved name", text: "saved text" })),
    });
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[detached]} {...callbacks} />);

    await waitFor(() => expect(callbacks.onMetadataChange).toHaveBeenCalledWith([{
      ...detached,
      libraryProjectId: "project-1",
      promptId: "prompt-1",
      promptName: "Current name",
      versionNumber: 1,
    }]));
    expect(callbacks.onChange).not.toHaveBeenCalled();
  });

  it("detaches an archived selected version without changing its snapshot", async () => {
    const selected = formPrompt();
    const callbacks = callbackProps();
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [libraryPrompt()] })),
      getPromptVersion: vi.fn(async () => version({ archived_at: "2026-08-29T12:00:00Z" })),
    });
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[selected]} {...callbacks} />);

    await waitFor(() => expect(callbacks.onMetadataChange).toHaveBeenCalledWith([{
      ...selected,
      libraryProjectId: null,
      promptId: null,
    }]));
    expect(callbacks.onChange).not.toHaveBeenCalled();
  });

  it("detaches a missing selected version without changing its snapshot", async () => {
    const selected = formPrompt();
    const callbacks = callbackProps();
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [libraryPrompt()] })),
      getPromptVersion: vi.fn(async () => {
        throw new ApiError("PromptVersion not found", "prompt_version_not_found", 404);
      }),
    });
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[selected]} {...callbacks} />);

    await waitFor(() => expect(callbacks.onMetadataChange).toHaveBeenCalledWith([{
      ...selected,
      libraryProjectId: null,
      promptId: null,
    }]));
    expect(callbacks.onChange).not.toHaveBeenCalled();
  });

  it("reports an integrity conflict without reconnecting", async () => {
    const detached = formPrompt({ libraryProjectId: null, promptId: null, text: "stored text" });
    const callbacks = callbackProps();
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [libraryPrompt()] })),
      getPromptVersion: vi.fn(async () => version({ text: "different library text" })),
    });
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[detached]} {...callbacks} />);

    expect(await screen.findByText("PromptVersion integrity check failed: stored content differs from the library.")).toBeInTheDocument();
    expect(callbacks.onMetadataChange).not.toHaveBeenCalled();
  });
});

function callbackProps() {
  return {
    onChange: vi.fn<(prompts: PromptForm[]) => void>(),
    onMetadataChange: vi.fn<(prompts: PromptForm[]) => void>(),
  };
}

function formPrompt(overrides: Partial<PromptForm> = {}): PromptForm {
  return {
    key: 10,
    libraryProjectId: "project-1",
    promptId: "prompt-1",
    promptName: "Current name",
    versionId: "version-1",
    versionNumber: 1,
    snapshotName: "Saved name",
    text: "saved text",
    ...overrides,
  };
}

function version(overrides: Partial<LibraryPromptVersion> = {}): LibraryPromptVersion {
  return {
    id: "version-1",
    prompt_id: "prompt-1",
    version_number: 1,
    name_snapshot: "Saved name",
    text: "saved text",
    note: null,
    created_at: "2026-08-28T12:00:00Z",
    archived_at: null,
    ...overrides,
  };
}

function prompt(id = "prompt-1", name = "Current name"): Prompt {
  return {
    id,
    project_id: "project-1",
    name,
    description: null,
    created_at: "2026-08-27T12:00:00Z",
    updated_at: "2026-08-28T12:00:00Z",
    archived_at: null,
  };
}

function libraryPrompt(
  id = "prompt-1",
  name = "Current name",
  latest = version({ prompt_id: id }),
): ProjectPrompt {
  return { ...prompt(id, name), latest_active_version: latest };
}

function makeApi(overrides: Partial<BatchcraftApi> = {}): BatchcraftApi {
  return {
    getComfyUIStatus: vi.fn(async () => ({ reachable: true, version: null, devices: [], diagnostic: null })),
    listProjects: vi.fn(async () => ({ projects: [] })),
    createProject: vi.fn(),
    getProject: vi.fn(),
    updateProject: vi.fn(),
    adoptProject: vi.fn(),
    listAdoptableProjects: vi.fn(async () => ({ projects: [] })),
    listSavedBatches: vi.fn(async () => ({ batches: [] })),
    createSavedBatch: vi.fn(),
    getSavedBatch: vi.fn(),
    updateSavedBatch: vi.fn(),
    archiveSavedBatch: vi.fn(),
    listAdoptableSavedBatches: vi.fn(async () => ({ batches: [] })),
    adoptSavedBatch: vi.fn(),
    listProjectAssets: vi.fn(async () => ({ assets: [] })),
    uploadProjectAssets: vi.fn(async () => ({ assets: [] })),
    listPrompts: vi.fn(async () => ({ prompts: [] })),
    createPrompt: vi.fn(async () => ({ prompt: prompt(), version: version() })),
    getPrompt: vi.fn(async () => prompt()),
    updatePrompt: vi.fn(async () => prompt()),
    listPromptVersions: vi.fn(async () => ({ prompt_versions: [] })),
    createPromptVersion: vi.fn(async () => version()),
    getPromptVersion: vi.fn(async () => version()),
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
    previewBatch: vi.fn(async () => ({ job_count: 0, warnings: [], jobs: [] })),
    createRun: vi.fn(async () => ({
      run_id: "run-1",
      run_number: 1,
      project_id: "project-1",
      project_name: "Project",
      batch_id: "batch-1",
      batch_name: "Batch",
      job_count: 0,
      durable_status: "created",
    })),
    getRun: vi.fn(async () => { throw new Error("unused"); }),
    startRun: vi.fn(async () => ({ run_id: "run-1", status: "accepted" })),
    getExecution: vi.fn(async () => { throw new Error("unused"); }),
    getResults: vi.fn(async () => ({ run_id: "run-1", results: [] })),
    resultUrl: (url) => url,
    assetUrl: (url) => url,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
