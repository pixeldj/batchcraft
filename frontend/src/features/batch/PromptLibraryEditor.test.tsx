import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiError, type BatchcraftApi } from "../../api/client";
import type { LibraryPromptVersion, ProjectPrompt, Prompt, PromptsResponse } from "../../api/types";
import type { PromptForm } from "./form";
import { PromptLibraryEditor } from "./PromptLibraryEditor";

describe("PromptLibraryEditor workspace", () => {
  it("opens the portaled library directly, locks page scroll, closes on Escape, and restores trigger focus", async () => {
    const api = makeApi({ listPrompts: vi.fn(async () => ({ prompts: [libraryPrompt()] })) });
    const callbacks = callbackProps();
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[]} {...callbacks} />);

    const trigger = await openLibrary();
    const dialog = screen.getByRole("dialog", { name: "Prompts" });
    expect(dialog.parentElement).toHaveAttribute("data-overlay-level", "prompt-library");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.queryByRole("button", { name: "Choose existing" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    expect(callbacks.onChange).not.toHaveBeenCalled();

    const newPrompt = screen.getByRole("button", { name: "New Prompt" });
    const done = within(dialog).getByRole("button", { name: "Done" });
    done.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(newPrompt).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(done).toHaveFocus();
    screen.getByRole("button", { name: "Close" }).focus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Prompts" })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    expect(trigger).toHaveFocus();
  });

  it("keeps sidebar inspection and search separate from Batch selection", async () => {
    const portrait = {
      ...libraryPrompt("portrait", "Portrait", version({
        id: "portrait-v3",
        prompt_id: "portrait",
        version_number: 3,
        name_snapshot: "Portrait snapshot",
        text: "  first line\n\nlast line  ",
      })),
      description: "Portrait lighting study",
    };
    const editorial = libraryPrompt("editorial", "Editorial", version({
      id: "editorial-v1",
      prompt_id: "editorial",
      text: "editorial text",
    }));
    const selected = formPrompt({
      promptId: "portrait",
      promptName: "Portrait",
      versionId: "portrait-v2",
      versionNumber: 2,
    });
    const callbacks = callbackProps();
    const api = makeApi({ listPrompts: vi.fn(async () => ({ prompts: [portrait, editorial] })) });
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[selected]} {...callbacks} />);

    await openLibrary();
    const sidebar = screen.getByRole("complementary", { name: "Prompt library" });
    expect(within(sidebar).getByText("In Batch: v2")).toBeInTheDocument();
    expect(screen.getByText("Portrait lighting study")).toBeInTheDocument();
    expect(screen.getByText("v3", { selector: ".prompt-revision" })).toBeInTheDocument();
    expect(document.querySelector(".prompt-library-text")).toHaveTextContent("first line last line");
    expect(document.querySelector(".prompt-library-text")?.textContent).toBe("  first line\n\nlast line  ");

    fireEvent.change(screen.getByLabelText("Search Prompts"), { target: { value: "editor" } });
    expect(within(sidebar).queryByRole("button", { name: /Portrait/ })).not.toBeInTheDocument();
    expect(screen.getByText("Portrait lighting study")).toBeInTheDocument();
    fireEvent.click(within(sidebar).getByRole("button", { name: /Editorial/ }));
    expect(screen.getByText("editorial text")).toBeInTheDocument();
    expect(callbacks.onChange).not.toHaveBeenCalled();
  });

  it("opens an empty library with a useful New Prompt action", async () => {
    const api = makeApi({ listPrompts: vi.fn(async () => ({ prompts: [] })) });
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[]} {...callbackProps()} />);

    await openLibrary();
    expect(screen.getByRole("heading", { name: "Create your first Prompt" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New Prompt" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("heading", { name: "Create your first Prompt" }).parentElement!.querySelector("button")!);
    expect(screen.getByRole("heading", { name: "New Prompt" })).toBeInTheDocument();
    expect(screen.getByLabelText("Prompt name")).toHaveFocus();
  });
});

describe("PromptLibraryEditor Batch selection", () => {
  it("appends the exact latest revision, blocks only that exact ID, and allows another revision", async () => {
    const latest = version({ id: "portrait-v3", version_number: 3, text: "latest" });
    const older = formPrompt({ versionId: "portrait-v2", versionNumber: 2, text: "older" });
    const api = makeApi({ listPrompts: vi.fn(async () => ({ prompts: [libraryPrompt("prompt-1", "Portrait", latest)] })) });
    const onChange = vi.fn<(prompts: PromptForm[]) => void>();
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[older]} onChange={onChange} onMetadataChange={vi.fn()} />);

    await openLibrary();
    expect(screen.getByRole("button", { name: "Add to Batch" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Add to Batch" }));

    expect(onChange).toHaveBeenCalledWith([
      older,
      expect.objectContaining({ versionId: "portrait-v3", versionNumber: 3, text: "latest" }),
    ]);
  });

  it("shows and changes exact ordered selections in the stable footer", async () => {
    const first = formPrompt({ key: 1, promptId: "one", promptName: "One", versionId: "one-v1" });
    const second = formPrompt({ key: 2, promptId: "two", promptName: "Two", versionId: "two-v4", versionNumber: 4 });
    const changes = vi.fn<(prompts: PromptForm[]) => void>();
    const api = makeApi({ listPrompts: vi.fn(async () => ({
      prompts: [libraryPrompt("one", "One"), libraryPrompt("two", "Two")],
    })) });
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[first, second]} onChange={changes} onMetadataChange={vi.fn()} />);

    await openLibrary();
    const footer = screen.getByLabelText("Prompts selected for Batch");
    const items = within(footer).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("One v1");
    expect(items[1]).toHaveTextContent("Two v4");
    fireEvent.click(within(items[1]).getByRole("button", { name: "Move Two up" }));
    expect(changes).toHaveBeenLastCalledWith([second, first]);
    fireEvent.click(within(items[0]).getByRole("button", { name: "Remove One" }));
    expect(changes).toHaveBeenLastCalledWith([second]);
  });

  it("keeps an exact old Saved Batch snapshot visible outside the library", async () => {
    const saved = formPrompt({
      promptName: "Current logical name",
      snapshotName: "Saved revision name",
      versionId: "old-v2",
      versionNumber: 2,
      text: "frozen old revision text",
    });
    const api = makeApi({ listPrompts: vi.fn(async () => ({ prompts: [libraryPrompt("prompt-1", "Current logical name")] })) });
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[saved]} {...callbackProps()} />);

    await expandPrompts();
    expect(screen.getByText("frozen old revision text")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("Saved as Saved revision name")).toBeInTheDocument();
  });
});

describe("PromptLibraryEditor creation and revisions", () => {
  it("retains a failed New Prompt draft and on success stays open without changing the Batch", async () => {
    const createdVersion = version({ id: "created-v1", prompt_id: "created", text: "new text" });
    const createdPrompt = prompt("created", "Created Prompt");
    const createPrompt = vi.fn<BatchcraftApi["createPrompt"]>()
      .mockRejectedValueOnce(new ApiError("Name already exists", "prompt_name_conflict", 409))
      .mockResolvedValueOnce({ prompt: createdPrompt, version: createdVersion });
    const callbacks = callbackProps();
    const api = makeApi({ createPrompt, listPrompts: vi.fn(async () => ({ prompts: [] })) });
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[]} {...callbacks} />);

    await openLibrary();
    fireEvent.click(screen.getAllByRole("button", { name: "New Prompt" })[0]);
    fillPromptForm("Created Prompt", "new text", "description");
    fireEvent.click(screen.getByRole("button", { name: "Create Prompt" }));
    expect(await screen.findByText("Name already exists")).toBeInTheDocument();
    expect(screen.getByLabelText("Prompt template")).toHaveValue("new text");
    fireEvent.click(screen.getByRole("button", { name: "Create Prompt" }));

    expect(await screen.findByRole("heading", { name: "Created Prompt" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Prompts" })).toBeInTheDocument();
    expect(screen.getByText("new text")).toBeInTheDocument();
    expect(callbacks.onChange).not.toHaveBeenCalled();
  });

  it("edits from the viewed revision, creates a new current revision, and preserves selected older snapshots", async () => {
    const selected = formPrompt({ versionId: "portrait-v1", versionNumber: 1, text: "selected old text" });
    const latest = version({ id: "portrait-v2", version_number: 2, text: "viewed source" });
    const next = version({ id: "portrait-v3", version_number: 3, text: "edited text" });
    const createPromptVersion = vi.fn<BatchcraftApi["createPromptVersion"]>(async () => next);
    const callbacks = callbackProps();
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [libraryPrompt("prompt-1", "Portrait", latest)] })),
      createPromptVersion,
    });
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[selected]} {...callbacks} />);

    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Edit Prompt" }));
    expect(screen.getByLabelText("Prompt template")).toHaveValue("viewed source");
    expect(screen.getByText(/Saving creates a new revision/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Prompt template"), { target: { value: "edited text" } });
    fireEvent.change(screen.getByLabelText("Revision note (optional)"), { target: { value: "Shorter" } });
    fireEvent.click(screen.getByRole("button", { name: "Save revision" }));

    await waitFor(() => expect(document.querySelector(".prompt-library-text")?.textContent).toBe("edited text"));
    expect(screen.getByText("v3", { selector: ".prompt-revision" })).toBeInTheDocument();
    expect(createPromptVersion).toHaveBeenCalledWith("prompt-1", { text: "edited text", note: "Shorter" });
    expect(callbacks.onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Prompts selected for Batch")).toHaveTextContent("Portrait v1");
  });

  it("duplicates an old viewed history revision with collision-safe naming as a new v1 without changing the Batch", async () => {
    const current = version({ id: "portrait-v3", version_number: 3, text: "current text" });
    const old = version({ id: "portrait-v1", version_number: 1, text: "old exact text" });
    const source = { ...libraryPrompt("prompt-1", "Portrait", current), description: "source description" };
    const existingCopy = libraryPrompt("copy", "Portrait copy");
    const createdVersion = version({ id: "copy2-v1", prompt_id: "copy-2", version_number: 1, name_snapshot: "Portrait copy 2", text: "old exact text" });
    const createdPrompt = prompt("copy-2", "Portrait copy 2");
    const createPrompt = vi.fn<BatchcraftApi["createPrompt"]>(async () => ({ prompt: createdPrompt, version: createdVersion }));
    const callbacks = callbackProps();
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [source, existingCopy] })),
      listPromptVersions: vi.fn(async () => ({ prompt_versions: [current, old] })),
      createPrompt,
    });
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[]} {...callbacks} />);

    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const oldCard = (await screen.findByText("old exact text")).closest("article")!;
    fireEvent.click(within(oldCard).getByRole("button", { name: "Duplicate" }));
    expect(screen.getByLabelText("Prompt name")).toHaveValue("Portrait copy 2");
    expect(screen.getByLabelText("Prompt template")).toHaveValue("old exact text");
    expect(screen.getByLabelText("Prompt template")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Description (optional)")).toHaveValue("source description");
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Prompt" }));

    expect(await screen.findByRole("heading", { name: "Portrait copy 2" })).toBeInTheDocument();
    expect(screen.getByText("v1", { selector: ".prompt-revision" })).toBeInTheDocument();
    expect(createPrompt).toHaveBeenCalledWith("project-1", {
      name: "Portrait copy 2",
      text: "old exact text",
      description: "source description",
    });
    expect(callbacks.onChange).not.toHaveBeenCalled();
  });

  it("locks workspace navigation while an immutable revision save is in flight", async () => {
    const pending = deferred<LibraryPromptVersion>();
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [libraryPrompt()] })),
      createPromptVersion: vi.fn(() => pending.promise),
    });
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[]} {...callbackProps()} />);

    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Edit Prompt" }));
    fireEvent.change(screen.getByLabelText("Prompt template"), { target: { value: "pending text" } });
    fireEvent.click(screen.getByRole("button", { name: "Save revision" }));

    const dialog = screen.getByRole("dialog", { name: "Prompts" });
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Portrait/ })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(dialog).toBeInTheDocument();

    await act(async () => pending.resolve(version({ id: "version-2", version_number: 2, text: "pending text" })));
    await waitFor(() => expect(dialog).not.toHaveAttribute("aria-busy"));
    expect(document.querySelector(".prompt-library-text")?.textContent).toBe("pending text");
  });

  it("loads and caches History lazily and can add an exact active historical revision", async () => {
    const current = version({ id: "v2", version_number: 2, text: "current" });
    const older = version({ id: "v1", version_number: 1, text: "older", note: "Original" });
    const listPromptVersions = vi.fn(async () => ({ prompt_versions: [current, older] }));
    const callbacks = callbackProps();
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [libraryPrompt("prompt-1", "Portrait", current)] })),
      listPromptVersions,
    });
    render(<PromptLibraryEditor api={api} projectId="project-1" prompts={[]} {...callbacks} />);

    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const olderCard = (await screen.findByText("older")).closest("article")!;
    expect(within(olderCard).getByText("Original")).toBeInTheDocument();
    fireEvent.click(within(olderCard).getByRole("button", { name: "Inspect revision 1" }));
    expect(olderCard).toHaveClass("viewed");
    fireEvent.click(within(olderCard).getByRole("button", { name: "Add this revision" }));
    expect(callbacks.onChange).toHaveBeenCalledWith([
      expect.objectContaining({ versionId: "v1", versionNumber: 1, text: "older" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Back to Prompt" }));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(listPromptVersions).toHaveBeenCalledTimes(1);
  });
});

describe("PromptLibraryEditor loading and linkage", () => {
  it("clears old Project data and ignores a stale response", async () => {
    const oldRequest = deferred<PromptsResponse>();
    const api = makeApi({
      listPrompts: vi.fn((projectId: string) => projectId === "old" ? oldRequest.promise : Promise.resolve({
        prompts: [libraryPrompt("new-prompt", "New Project Prompt")],
      })),
    });
    const callbacks = callbackProps();
    const view = render(<PromptLibraryEditor api={api} projectId="old" prompts={[]} {...callbacks} />);
    await waitFor(() => expect(api.listPrompts).toHaveBeenCalledWith("old", expect.any(AbortSignal)));
    view.rerender(<PromptLibraryEditor api={api} projectId="new" prompts={[]} {...callbacks} />);
    await openLibrary();
    expect(screen.getAllByText("New Project Prompt")).toHaveLength(2);
    await act(async () => oldRequest.resolve({ prompts: [libraryPrompt("old-prompt", "Old Project Prompt")] }));
    expect(screen.queryByText("Old Project Prompt")).not.toBeInTheDocument();
  });

  it("shows a specific missing-Project error and retries", async () => {
    const listPrompts = vi.fn<BatchcraftApi["listPrompts"]>()
      .mockRejectedValueOnce(new ApiError("missing", "project_not_found", 404))
      .mockResolvedValueOnce({ prompts: [] });
    render(<PromptLibraryEditor api={makeApi({ listPrompts })} projectId="missing" prompts={[]} {...callbackProps()} />);
    expect(await screen.findByText(PROJECT_NOT_FOUND_MESSAGE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/This Project has no active Prompts/)).toBeInTheDocument();
  });

  it("reconnects an exact detached snapshot through metadata", async () => {
    const detached = formPrompt({ libraryProjectId: null, promptId: null, promptName: "Saved name" });
    const callbacks = callbackProps();
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [libraryPrompt("prompt-1", "Current name")] })),
      getPromptVersion: vi.fn(async () => version()),
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
      getPromptVersion: vi.fn(async () => { throw new ApiError("missing", "prompt_version_not_found", 404); }),
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

const PROJECT_NOT_FOUND_MESSAGE = "Project was not found. Check the Project ID and try again.";

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
    promptName: "Portrait",
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

function prompt(id = "prompt-1", name = "Portrait"): Prompt {
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
  name = "Portrait",
  latest = version({ prompt_id: id, name_snapshot: name }),
): ProjectPrompt {
  return { ...prompt(id, name), latest_active_version: latest };
}

function makeApi(overrides: Partial<BatchcraftApi> = {}): BatchcraftApi {
  return {
    getComfyUIStatus: vi.fn(async () => ({ reachable: true, version: null, devices: [], diagnostic: null })),
    listProjects: vi.fn(async () => ({ projects: [] })), createProject: vi.fn(), getProject: vi.fn(), updateProject: vi.fn(), adoptProject: vi.fn(), listAdoptableProjects: vi.fn(async () => ({ projects: [] })),
    listSavedBatches: vi.fn(async () => ({ batches: [] })), createSavedBatch: vi.fn(), getSavedBatch: vi.fn(), updateSavedBatch: vi.fn(), archiveSavedBatch: vi.fn(), listAdoptableSavedBatches: vi.fn(async () => ({ batches: [] })), adoptSavedBatch: vi.fn(),
    listProjectAssets: vi.fn(async () => ({ assets: [] })), uploadProjectAssets: vi.fn(async () => ({ assets: [] })),
    listPrompts: vi.fn(async () => ({ prompts: [] })), createPrompt: vi.fn(async () => ({ prompt: prompt(), version: version() })), getPrompt: vi.fn(async () => prompt()), updatePrompt: vi.fn(async () => prompt()), listPromptVersions: vi.fn(async () => ({ prompt_versions: [] })), createPromptVersion: vi.fn(async () => version()), getPromptVersion: vi.fn(async () => version()),
    listWorkflows: vi.fn(async () => ({ workflows: [] })), createWorkflow: vi.fn(), getWorkflow: vi.fn(), updateWorkflow: vi.fn(), archiveWorkflow: vi.fn(), listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [] })), createWorkflowVersion: vi.fn(), getWorkflowVersion: vi.fn(), archiveWorkflowVersion: vi.fn(),
    listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [] })), createWorkflowProfile: vi.fn(), getWorkflowProfile: vi.fn(), updateWorkflowProfile: vi.fn(), archiveWorkflowProfile: vi.fn(), listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [] })), createWorkflowProfileVersion: vi.fn(), getWorkflowProfileVersion: vi.fn(), archiveWorkflowProfileVersion: vi.fn(),
    previewBatch: vi.fn(async () => ({ job_count: 0, warnings: [], jobs: [] })), createRun: vi.fn(), getRun: vi.fn(), startRun: vi.fn(), getExecution: vi.fn(), getResults: vi.fn(async () => ({ run_id: "run-1", results: [] })), resultUrl: (url) => url, assetUrl: (url) => url,
    ...overrides,
  };
}

async function openLibrary(): Promise<HTMLButtonElement> {
  await waitFor(() => expect(screen.queryByText("Loading Prompt library...")).not.toBeInTheDocument());
  const section = screen.getByRole("group", { name: "Prompts" });
  const edit = within(section).queryByRole("button", { name: "Edit" });
  if (edit) fireEvent.click(edit);
  const trigger = await within(section).findByRole("button", { name: "Add Prompt" });
  await waitFor(() => expect(trigger).toBeEnabled());
  fireEvent.click(trigger);
  await screen.findByRole("dialog", { name: "Prompts" });
  return trigger as HTMLButtonElement;
}

async function expandPrompts() {
  await waitFor(() => expect(screen.queryByText("Loading Prompt library...")).not.toBeInTheDocument());
  const section = screen.getByRole("group", { name: "Prompts" });
  const edit = within(section).queryByRole("button", { name: "Edit" });
  if (edit) fireEvent.click(edit);
}

function fillPromptForm(name: string, text: string, description: string) {
  fireEvent.change(screen.getByLabelText("Prompt name"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Prompt template"), { target: { value: text } });
  fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: description } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
