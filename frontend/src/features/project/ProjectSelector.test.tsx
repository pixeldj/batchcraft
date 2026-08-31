import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BatchcraftApi } from "../../api/client";
import type {
  AdoptableProjectsResponse,
  ProjectResponse,
  ProjectsResponse,
} from "../../api/types";
import { ProjectSelector } from "./ProjectSelector";

describe("ProjectSelector active Projects", () => {
  it("loads only active Projects, disambiguates duplicate names, and reconnects exactly", async () => {
    const first = project("one", "first", "Shared");
    const second = project("two", "second", "Shared");
    const api = makeApi({ listProjects: vi.fn(async () => ({ projects: [first, second] })) });
    const callbacks = callbackProps();
    renderSelector(api, callbacks, {
      selectedProjectId: "one",
      draftIdentity: { id: "one", filesystemKey: "first", name: "Old name" },
    });

    expect(await screen.findByRole("option", { name: "Shared — first" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Shared — second" })).toBeInTheDocument();
    expect(api.listProjects).toHaveBeenCalledWith(false, expect.any(AbortSignal));
    expect(callbacks.onReconnect).toHaveBeenCalledWith(first);
    const details = screen.getByText("Project details").closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(within(details as HTMLElement).getByText("first")).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText("one")).toBeInTheDocument();
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();
  });

  it("ignores stale list responses and retries a separate list error", async () => {
    const stale = deferred<ProjectsResponse>();
    const listProjects = vi.fn<BatchcraftApi["listProjects"]>()
      .mockReturnValueOnce(stale.promise)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ projects: [] });
    const api = makeApi({ listProjects });
    const callbacks = callbackProps();
    const view = renderSelector(api, callbacks, {
      selectedProjectId: "old",
      draftIdentity: { id: "old", filesystemKey: "old-key", name: "Old" },
    });

    view.rerender(selector(api, callbacks, {
      selectedProjectId: "new",
      draftIdentity: { id: "new", filesystemKey: "new-key", name: "New" },
    }));
    expect(await screen.findByText("Could not load Projects: offline")).toBeInTheDocument();
    await act(async () => stale.resolve({ projects: [project("old", "old-key", "Stale")] }));
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/Select an active Project/)).toBeInTheDocument();
    expect(listProjects).toHaveBeenCalledTimes(3);
  });

  it("marks a blank or mismatched candidate unresolved without matching its name", async () => {
    const registered = project("registered-id", "registered-key", "Same name");
    const api = makeApi({ listProjects: vi.fn(async () => ({ projects: [registered] })) });
    const callbacks = callbackProps();
    renderSelector(api, callbacks, {
      selectedProjectId: "wrong-id",
      draftIdentity: { id: "wrong-id", filesystemKey: "registered-key", name: "Same name" },
    });

    expect(await screen.findByText(/does not exactly match/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Active Project" })).toHaveValue("");
    expect(callbacks.onUnresolved).toHaveBeenCalledTimes(1);
    expect(callbacks.onReconnect).not.toHaveBeenCalled();
  });
});

describe("ProjectSelector transitions", () => {
  it("confirms a selector change with scoped state and returns to the selector on cancel", async () => {
    const current = project("current", "current-key", "Current");
    const next = project("next", "next-key", "Next");
    const api = makeApi({ listProjects: vi.fn(async () => ({ projects: [current, next] })) });
    const callbacks = callbackProps();
    renderSelector(api, callbacks, {
      selectedProjectId: current.id,
      projectVerified: true,
      draftIdentity: { id: current.id, filesystemKey: current.filesystem_key, name: current.name },
      hasProjectScopedSelections: true,
    });

    const picker = await screen.findByRole("combobox", { name: "Active Project" });
    fireEvent.change(picker, { target: { value: next.id } });
    expect(screen.getByRole("dialog", { name: "Change Project?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(callbacks.onSelect).not.toHaveBeenCalled();

    fireEvent.change(picker, { target: { value: next.id } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(callbacks.onSelect).toHaveBeenCalledWith(next);
  });

  it("auto-slugs until manual key editing, sends no ID, and preserves a failed create draft", async () => {
    const created = project("server-id", "custom-key", "New Project");
    const createProject = vi.fn<BatchcraftApi["createProject"]>()
      .mockRejectedValueOnce(new Error("key exists"))
      .mockResolvedValueOnce(created);
    const api = makeApi({ createProject });
    const callbacks = callbackProps();
    renderSelector(api, callbacks);
    fireEvent.click(await screen.findByRole("button", { name: "New Project" }));

    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "New Project" } });
    expect(screen.getByLabelText("Filesystem key")).toHaveValue("new-project");
    fireEvent.change(screen.getByLabelText("Filesystem key"), { target: { value: "custom-key" } });
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Renamed" } });
    expect(screen.getByLabelText("Filesystem key")).toHaveValue("custom-key");
    fireEvent.click(screen.getByRole("button", { name: "Create Project" }));

    expect(await screen.findByText("key exists")).toBeInTheDocument();
    expect(screen.getByLabelText("Project name")).toHaveValue("Renamed");
    fireEvent.click(screen.getByRole("button", { name: "Create Project" }));
    await waitFor(() => expect(callbacks.onSelect).toHaveBeenCalledWith(created));
    expect(createProject).toHaveBeenLastCalledWith({
      name: "Renamed",
      filesystem_key: "custom-key",
      description: null,
    });
    expect(createProject.mock.calls[0][0]).not.toHaveProperty("id");
  });

  it("adopts an owned directory with its stored ID omitted from the request", async () => {
    const adopted = project("stored-id", "owned-key", "Current name");
    const adoptProject = vi.fn(async () => adopted);
    const api = makeApi({
      adoptProject,
      listAdoptableProjects: vi.fn<BatchcraftApi["listAdoptableProjects"]>(async () => ({ projects: [{
        filesystem_key: "owned-key",
        owner_state: "owned",
        project_id: "stored-id",
        initial_name: "Initial name",
      }] })),
    });
    const callbacks = callbackProps();
    renderSelector(api, callbacks);
    fireEvent.click(await screen.findByRole("button", { name: "Import from Folder" }));

    expect(await screen.findByLabelText("Stored Project ID")).toHaveValue("stored-id");
    expect(screen.getByLabelText("Initial label")).toHaveValue("Initial name");
    expect(screen.getByLabelText("Current Project name")).toHaveValue("Initial name");
    fireEvent.change(screen.getByLabelText("Current Project name"), { target: { value: "Current name" } });
    fireEvent.click(screen.getByRole("button", { name: "Import Project" }));

    await waitFor(() => expect(callbacks.onSelect).toHaveBeenCalledWith(adopted));
    expect(adoptProject).toHaveBeenCalledWith({
      filesystem_key: "owned-key",
      name: "Current name",
      description: null,
    });
  });

  it("marks ownerless adoption as recovery and requires and sends an explicit ID", async () => {
    const adopted = project("recovered-id", "orphan", "Recovered");
    const adoptProject = vi.fn(async () => adopted);
    const api = makeApi({
      adoptProject,
      listAdoptableProjects: vi.fn<BatchcraftApi["listAdoptableProjects"]>(async () => ({ projects: [{
        filesystem_key: "orphan",
        owner_state: "ownerless",
        project_id: null,
        initial_name: null,
      }] })),
    });
    renderSelector(api, callbackProps());
    fireEvent.click(await screen.findByRole("button", { name: "Import from Folder" }));

    expect(await screen.findByText("Advanced recovery")).toBeInTheDocument();
    expect(screen.getByLabelText("Project ID")).toBeRequired();
    fireEvent.change(screen.getByLabelText("Project ID"), { target: { value: "recovered-id" } });
    fireEvent.change(screen.getByLabelText("Current Project name"), { target: { value: "Recovered" } });
    fireEvent.click(screen.getByRole("button", { name: "Import Project" }));

    await waitFor(() => expect(adoptProject).toHaveBeenCalledWith({
      filesystem_key: "orphan",
      project_id: "recovered-id",
      name: "Recovered",
      description: null,
    }));
  });

  it("keeps adopt discovery errors in the dialog and retries", async () => {
    const listAdoptableProjects = vi.fn<BatchcraftApi["listAdoptableProjects"]>()
      .mockRejectedValueOnce(new Error("scan failed"))
      .mockResolvedValueOnce({ projects: [] });
    const api = makeApi({ listAdoptableProjects });
    renderSelector(api, callbackProps());
    fireEvent.click(await screen.findByRole("button", { name: "Import from Folder" }));

    const dialog = await screen.findByRole("dialog", { name: "Import Project from Folder" });
    expect(within(dialog).getByText(/scan failed/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByText("No Project folders are available to import.")).toBeInTheDocument();
  });

  it("disables switching and actions while a Run is active", async () => {
    const api = makeApi();
    renderSelector(api, callbackProps(), { switchingBlocked: true });

    expect(await screen.findByRole("combobox", { name: "Active Project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New Project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Import from Folder" })).toBeDisabled();
    expect(screen.getByText("Project changes are unavailable while a Run is active.")).toBeInTheDocument();
  });
});

function renderSelector(
  api: BatchcraftApi,
  callbacks = callbackProps(),
  overrides: Partial<Parameters<typeof ProjectSelector>[0]> = {},
) {
  return render(selector(api, callbacks, overrides));
}

function selector(
  api: BatchcraftApi,
  callbacks: ReturnType<typeof callbackProps>,
  overrides: Partial<Parameters<typeof ProjectSelector>[0]> = {},
) {
  return (
    <ProjectSelector
      api={api}
      selectedProjectId={null}
      projectVerified={false}
      draftIdentity={{ id: "", filesystemKey: "", name: "" }}
      hasProjectScopedSelections={false}
      switchingBlocked={false}
      {...callbacks}
      {...overrides}
    />
  );
}

function callbackProps() {
  return {
    onReconnect: vi.fn(),
    onUnresolved: vi.fn(),
    onSelect: vi.fn(),
  };
}

function makeApi(overrides: Partial<BatchcraftApi> = {}): BatchcraftApi {
  return {
    listProjects: vi.fn(async () => ({ projects: [] })),
    createProject: vi.fn(),
    adoptProject: vi.fn(),
    listAdoptableProjects: vi.fn(async (): Promise<AdoptableProjectsResponse> => ({ projects: [] })),
    ...overrides,
  } as BatchcraftApi;
}

function project(id: string, filesystemKey: string, name: string): ProjectResponse {
  return {
    id,
    filesystem_key: filesystemKey,
    name,
    description: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    archived_at: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
