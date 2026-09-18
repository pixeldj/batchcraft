import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BatchcraftApiClient, type BatchcraftApi } from "../../api/client";
import { copiedSetup, globalProfile, globalProfileFamily, globalVersion, globalWorkflow, workflowLibraryApi } from "../../test/workflowLibraryFixtures";
import { GlobalWorkflowLibrary } from "./GlobalWorkflowLibrary";
import { GlobalLibraryHistory } from "./GlobalWorkflowDetail";

function setup(overrides: Partial<BatchcraftApi> = {}) {
  const api = Object.assign(new BatchcraftApiClient(), workflowLibraryApi(), overrides);
  const props = { api, active: true, query: "", onQueryChange: vi.fn(), projectId: null as string | null, projectName: "", draftGuard: "untouched", applyDisabled: false, onApply: vi.fn(() => true), onCopied: vi.fn() };
  return { api, props };
}
async function selectWorkflow() {
  fireEvent.click(await screen.findByRole("button", { name: "Reusable portrait" }));
  await screen.findByRole("button", { name: "New Profile" });
}
async function menuAction(name: string, profile = false) {
  fireEvent.click(await screen.findByRole("button", { name: profile ? "Actions for Profile Portrait mapping" : /^Actions for Workflow / }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
}
function save() { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" })); }
function mapCore() {
  for (const [label, input] of [["Prompt", "text"], ["Seed", "seed"], ["Output Prefix", "filename_prefix"]]) {
    fireEvent.change(screen.getByLabelText(`${label} node`), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(`${label} input`), { target: { value: input } });
  }
}
function newWorkflow(name = "New setup") {
  fireEvent.click(screen.getByRole("button", { name: "New Workflow" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Workflow JSON"), { target: { value: JSON.stringify(globalVersion.workflow) } });
}
const profileVersion = { ...globalProfile, profile: copiedSetup.profiles[0].version.profile, note: null, archived_at: null };

describe("Global Workflow authoring", () => {
  it.each([
    ["New Profile", false], ["New Profile", true],
    ["New Workflow", false], ["New Workflow", true],
    ["Edit Workflow metadata", false], ["Edit Workflow metadata", true],
  ] as const)("invalidates a delayed Profile edit when %s opens (cancel before response: %s)", async (nextAction, cancel) => {
    let resolve!: (value: typeof profileVersion) => void;
    const { api, props } = setup({ getGlobalProfileVersion: vi.fn(() => new Promise<typeof profileVersion>((done) => { resolve = done; })) });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<GlobalWorkflowLibrary {...props} />); await selectWorkflow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Portrait mapping" }));
    await waitFor(() => expect(api.getGlobalProfileVersion).toHaveBeenCalledTimes(2));
    const signal = vi.mocked(api.getGlobalProfileVersion).mock.calls[1][1];
    if (nextAction === "Edit Workflow metadata") await menuAction(nextAction);
    else fireEvent.click(screen.getByRole("button", { name: nextAction }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Keep this newer draft" } });
    expect(signal?.aborted).toBe(true);
    if (cancel) fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await act(async () => resolve(profileVersion));
    if (cancel) expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    else {
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(within(dialog).getByLabelText("Name")).toHaveValue("Keep this newer draft");
      expect(window.confirm).not.toHaveBeenCalled();
    }
    expect(screen.queryByRole("region", { name: "Selected Profile" })).not.toBeInTheDocument();
    expect(api.appendGlobalProfile).not.toHaveBeenCalled();
  });

  it.each(["view", "Workflow"] as const)("invalidates pending Profile authoring across a %s change without reopening on return", async (change) => {
    let resolve!: (value: typeof profileVersion) => void;
    const older = { ...globalVersion, id: "old-workflow", version_number: 0 };
    const { api, props } = setup({
      getGlobalProfileVersion: vi.fn(() => new Promise<typeof profileVersion>((done) => { resolve = done; })),
      listGlobalWorkflowVersions: vi.fn(async () => ({ items: [older], next_cursor: null })),
      getGlobalWorkflowVersion: vi.fn(async (id) => id === older.id ? older : globalVersion),
    });
    const view = render(<GlobalWorkflowLibrary {...props} />); await selectWorkflow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Portrait mapping" }));
    await waitFor(() => expect(api.getGlobalProfileVersion).toHaveBeenCalledTimes(2));
    const resolveEdit = resolve;
    if (change === "view") {
      view.rerender(<GlobalWorkflowLibrary {...props} active={false} />);
      view.rerender(<GlobalWorkflowLibrary {...props} />);
    } else {
      await menuAction("Workflow History");
      fireEvent.click(await screen.findByRole("button", { name: /Revision 0/ }));
      await screen.findByText(/Viewing revision 0/);
    }
    expect(vi.mocked(api.getGlobalProfileVersion).mock.calls[1][1]?.aborted).toBe(true);
    await act(async () => resolveEdit(profileVersion));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Selected Profile" })).not.toBeInTheDocument();
    expect(api.appendGlobalProfile).not.toHaveBeenCalled();
  });

  it.each(["Workflow", "Profile", "metadata", "archive", "restore"] as const)("retains the same %s mutation payload and request ID after an ambiguous response", async (kind) => {
    const method = kind === "Profile" ? "appendGlobalProfile" : kind === "metadata" ? "updateGlobalWorkflow" : kind === "archive" ? "archiveGlobalEntry" : "appendGlobalWorkflow";
    const { api, props } = setup({ [method]: vi.fn().mockRejectedValue(new Error("Ambiguous response")) });
    render(<GlobalWorkflowLibrary {...props} />); await selectWorkflow();
    if (kind === "restore") {
      await menuAction("Workflow History");
      fireEvent.click(screen.getByRole("button", { name: "Restore Workflow content" }));
    } else {
      const name = kind === "Profile" ? "Edit Portrait mapping" : kind === "metadata" ? "Edit Workflow metadata" : kind === "archive" ? "Archive Workflow" : "Edit Workflow";
      if (kind === "metadata" || kind === "archive") await menuAction(name);
      else fireEvent.click(await screen.findByRole("button", { name }));
    }
    const dialog = await screen.findByRole("dialog");
    const saveLabel = kind === "archive" ? "Archive" : kind === "restore" ? "Restore" : "Save";
    fireEvent.click(within(dialog).getByRole("button", { name: saveLabel }));
    await within(dialog).findByText(/Ambiguous response/);
    const first = vi.mocked(api[method]).mock.calls[0];
    fireEvent.click(within(dialog).getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(api[method]).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api[method]).mock.calls[1]).toEqual(first);
    await within(dialog).findByText(/Ambiguous response/);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("uses HTTP receipt replay after a committed create loses its response, without duplicating the Workflow", async () => {
    const bodies: unknown[] = [];
    const records = new Map<string, { workflow: typeof globalWorkflow; version: typeof globalVersion }>();
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { request_id: string; name: string };
      bodies.push(body);
      if (!records.has(body.request_id)) {
        records.set(body.request_id, { workflow: { ...globalWorkflow, name: body.name }, version: globalVersion });
        throw new TypeError("Response lost after commit");
      }
      return new Response(JSON.stringify(records.get(body.request_id)));
    });
    const client = new BatchcraftApiClient("");
    const { props } = setup({ createGlobalWorkflow: client.createGlobalWorkflow.bind(client) });
    render(<GlobalWorkflowLibrary {...props} />); newWorkflow("HTTP setup"); save();
    await screen.findByRole("alert"); save();
    await screen.findByRole("dialog", { name: "New Profile" });
    expect(bodies[1]).toEqual(bodies[0]); expect(records.size).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["workflow", "profile"] as const)("scopes %s history search/archive cursors, cancels stale reads, and pages beyond twenty bookmarks", async (kind) => {
    const method = kind === "workflow" ? "listGlobalWorkflowVersions" : "listGlobalProfileVersions";
    const pageReader = vi.fn(async (_id: string, query?: import("../../api/types").LibraryPageQuery) => {
      const page = Number(query?.cursor ?? 0);
      return { items: [{ ...profileVersion, name_snapshot: `Page ${page}` }], next_cursor: String(page + 1) };
    });
    const { api } = setup({ [method]: pageReader });
    const selected = vi.fn();
    const view = render(<GlobalLibraryHistory api={api} id="family" kind={kind} active onSelect={selected} />);
    for (let page = 0; page <= 22; page++) {
      await screen.findByRole("button", { name: new RegExp(`Revision 1 / Page ${page}`) });
      if (page < 22) fireEvent.click(screen.getByRole("button", { name: `Next ${kind} revisions` }));
    }
    for (let page = 21; page >= 2; page--) {
      fireEvent.click(screen.getByRole("button", { name: `Previous ${kind} revisions` }));
      await screen.findByRole("button", { name: new RegExp(`Revision 1 / Page ${page}`) });
    }
    expect(screen.getByRole("button", { name: `Previous ${kind} revisions` })).toBeDisabled();
    expect(screen.getByRole("button", { name: `Next ${kind} revisions` })).toBeEnabled();
    fireEvent.change(screen.getByLabelText(`Search ${kind} history`), { target: { value: "old & scoped" } });
    await waitFor(() => expect(api[method]).toHaveBeenLastCalledWith("family", { q: "old & scoped", limit: 20, cursor: undefined, include_archived: false }, expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole("checkbox", { name: `Show archived ${kind} revisions` }));
    await waitFor(() => expect(api[method]).toHaveBeenLastCalledWith("family", { q: "old & scoped", limit: 20, cursor: undefined, include_archived: true }, expect.any(AbortSignal)));
    view.rerender(<GlobalLibraryHistory api={api} id="family" kind={kind} active={false} onSelect={selected} />);
    expect(vi.mocked(api[method]).mock.calls.at(-1)?.[2]?.aborted).toBe(true);
    expect(selected).not.toHaveBeenCalled();
  });

  it("has one Save, hands off to the shared Profile builder, and retains a created Workflow on Cancel even outside search results", async () => {
    const { api, props } = setup({ browseGlobalWorkflows: vi.fn(async () => ({ items: [], next_cursor: null })), getGlobalWorkflow: vi.fn(async () => ({ ...globalWorkflow, name: "Named workflow" })) });
    render(<GlobalWorkflowLibrary {...props} query="unrelated filter" />);
    newWorkflow("Named workflow");
    expect(within(screen.getByRole("dialog")).getAllByRole("button", { name: /^Save/ })).toHaveLength(1);
    save();
    const dialog = await screen.findByRole("dialog", { name: "New Profile" });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Named workflow-profile");
    expect(within(dialog).getByLabelText("Prompt node")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("heading", { name: "Named workflow" })).toBeVisible();
    expect(api.createGlobalWorkflow).toHaveBeenCalledOnce();
    expect(api.createGlobalProfile).not.toHaveBeenCalled();
    expect(api.listProjects).not.toHaveBeenCalled();
    expect(props.onQueryChange).not.toHaveBeenCalled();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("retains the Profile name and exact target on failure and retries without creating another Workflow", async () => {
    const { api, props } = setup({ createGlobalProfile: vi.fn().mockRejectedValueOnce(new Error("Mapping rejected")).mockResolvedValue({ workflow_profile: globalProfileFamily, version: profileVersion }) });
    render(<GlobalWorkflowLibrary {...props} />); newWorkflow(); save();
    await screen.findByRole("dialog", { name: "New Profile" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My retained mapping" } });
    mapCore();
    save(); await screen.findByText(/Mapping rejected/);
    expect(screen.getByLabelText("Name")).toHaveValue("My retained mapping");
    const first = vi.mocked(api.createGlobalProfile).mock.calls[0];
    expect(first).toEqual(["global-w", expect.objectContaining({ name: "My retained mapping", workflow_version_id: "global-w-v1", mappings: expect.objectContaining({ prompt: { node_id: "1", input_name: "text", value_type: "string" } }), image_inputs: [], parameters: [] })]);
    save(); await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(vi.mocked(api.createGlobalProfile).mock.calls[1]).toEqual(first);
    expect(api.createGlobalWorkflow).toHaveBeenCalledOnce();
  });

  it("recovers a lost Workflow response with the same ID and payload, then performs only the Profile save", async () => {
    const { api, props } = setup({ createGlobalWorkflow: vi.fn().mockRejectedValueOnce(new Error("Response lost")).mockResolvedValue({ workflow: globalWorkflow, version: globalVersion }) });
    render(<GlobalWorkflowLibrary {...props} />); newWorkflow(); save();
    await screen.findByText(/Response lost/);
    save(); await screen.findByRole("dialog", { name: "New Profile" });
    expect(vi.mocked(api.createGlobalWorkflow).mock.calls[1][0]).toEqual(vi.mocked(api.createGlobalWorkflow).mock.calls[0][0]);
    mapCore();
    save(); await waitFor(() => expect(api.createGlobalProfile).toHaveBeenCalledOnce());
    expect(api.createGlobalWorkflow).toHaveBeenCalledTimes(2);
  });

  it("allocates a new ID for changed payload but not unchanged retry, and invalid JSON sends nothing", async () => {
    const { api, props } = setup({ createGlobalWorkflow: vi.fn().mockRejectedValue(new Error("Unavailable")) });
    render(<GlobalWorkflowLibrary {...props} />); newWorkflow();
    fireEvent.change(screen.getByLabelText("Workflow JSON"), { target: { value: "[" } }); save();
    await screen.findByRole("alert"); expect(api.createGlobalWorkflow).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Workflow JSON"), { target: { value: JSON.stringify(globalVersion.workflow) } }); save();
    await screen.findByText(/Unavailable/); save();
    await waitFor(() => expect(api.createGlobalWorkflow).toHaveBeenCalledTimes(2));
    await screen.findByText(/Unavailable/);
    fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: "Changed" } }); save();
    await waitFor(() => expect(api.createGlobalWorkflow).toHaveBeenCalledTimes(3));
    const calls = vi.mocked(api.createGlobalWorkflow).mock.calls;
    expect(calls[1][0]).toEqual(calls[0][0]);
    expect(calls[2][0].request_id).not.toEqual(calls[0][0].request_id);
    expect(calls[0][0].description).toBeNull(); expect(calls[2][0].description).toBe("Changed");
  });

  it("retains a pending operation and dirty draft across inactive navigation, blocking duplicate saves and cancel", async () => {
    let reject!: (error: Error) => void;
    const { api, props } = setup({ createGlobalWorkflow: vi.fn(() => new Promise<Awaited<ReturnType<BatchcraftApi["createGlobalWorkflow"]>>>((_resolve, fail) => { reject = fail; })) });
    const view = render(<GlobalWorkflowLibrary {...props} />); newWorkflow("Retained draft"); save();
    await waitFor(() => expect(api.createGlobalWorkflow).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByText(/Navigation retains this draft/)).toBeVisible();
    view.rerender(<GlobalWorkflowLibrary {...props} active={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => reject(new Error("Outcome unknown")));
    view.rerender(<GlobalWorkflowLibrary {...props} />);
    expect(screen.getByLabelText("Name")).toHaveValue("Retained draft");
    expect(screen.getByText(/Outcome unknown/)).toBeVisible();
    expect(api.createGlobalWorkflow).toHaveBeenCalledOnce();
  });

  it("uses dirty confirmation on explicit Cancel and preserves rejected cancellation", () => {
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    const { props } = setup(); render(<GlobalWorkflowLibrary {...props} />); newWorkflow();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Name")).toHaveValue("New setup");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows incompatible families once and repairs latest active mappings against the viewed exact Workflow", async () => {
    const old = { ...profileVersion, workflow_version_id: "old-target", profile: { ...profileVersion.profile, parameters: [{ key: "stable", label: "Strength", node_id: "missing", input_name: "strength", value_type: "float" }] } };
    const { api, props } = setup({ listGlobalProfileFamilies: vi.fn(async () => ({ items: [{ ...globalProfileFamily, latest_compatible_version_id: null, latest_compatible_version: null }], next_cursor: null })), getGlobalProfileVersion: vi.fn(async () => old) });
    render(<GlobalWorkflowLibrary {...props} />); await selectWorkflow();
    expect(await screen.findByText("Profile mappings need review")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Portrait mapping" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Review mappings for Portrait mapping" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Profile" });
    expect(within(dialog).getByText(/Repair missing targets/)).toBeVisible();
    expect(api.getGlobalProfileVersion).toHaveBeenCalledWith("global-p-v1", expect.any(AbortSignal));
    save(); await waitFor(() => expect(api.appendGlobalProfile).toHaveBeenCalledOnce());
    expect(api.appendGlobalProfile).toHaveBeenCalledWith("global-p", expect.objectContaining({ workflow_version_id: "global-w-v1", image_inputs: profileVersion.profile.image_inputs, parameters: old.profile.parameters, mappings: profileVersion.profile.mappings }));
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("edits the selected Profile after Workflow Save, retaining its source mappings without retargeting siblings", async () => {
    const { api, props } = setup(); render(<GlobalWorkflowLibrary {...props} />); await selectWorkflow();
    fireEvent.click(await screen.findByRole("button", { name: "Portrait mapping" }));
    await screen.findByRole("region", { name: "Selected Profile" });
    fireEvent.click(screen.getByRole("button", { name: "Edit Workflow" })); save();
    const dialog = await screen.findByRole("dialog", { name: "Edit Profile" });
    expect(within(dialog).getByText(/Workflow saved/)).toBeVisible();
    save(); await waitFor(() => expect(api.appendGlobalProfile).toHaveBeenCalledOnce());
    expect(api.appendGlobalWorkflow).toHaveBeenCalledWith("global-w", expect.objectContaining({ workflow: globalVersion.workflow }));
    expect(api.appendGlobalProfile).toHaveBeenCalledWith("global-p", expect.objectContaining({ workflow_version_id: "global-w-v2", mappings: profileVersion.profile.mappings, image_inputs: profileVersion.profile.image_inputs }));
    expect(api.createGlobalWorkflow).not.toHaveBeenCalled(); expect(api.createGlobalProfile).not.toHaveBeenCalled();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("does not choose or retarget arbitrary Profiles when editing a Workflow with no selected Profile", async () => {
    const { api, props } = setup({ listGlobalProfileFamilies: vi.fn(async () => ({ items: [globalProfileFamily, { ...globalProfileFamily, id: "sibling", name: "Sibling" }], next_cursor: null })) });
    render(<GlobalWorkflowLibrary {...props} />); await selectWorkflow();
    await screen.findByRole("button", { name: "Sibling" });
    fireEvent.click(screen.getByRole("button", { name: "Edit Workflow" })); save();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.appendGlobalProfile).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Selected Profile" })).not.toBeInTheDocument();
  });

  it("selects old Workflow content explicitly, restores by append after confirmation, and reloads the authoritative latest root", async () => {
    const older = { ...globalVersion, id: "old", version_number: 1, workflow: { old: { inputs: {} } } };
    const latest = { ...globalVersion, id: "latest", version_number: 3 };
    const { api, props } = setup({ getGlobalWorkflow: vi.fn(async () => ({ ...globalWorkflow, latest_version_id: "latest" })), getGlobalWorkflowVersion: vi.fn(async (id) => id === "old" ? older : latest), listGlobalWorkflowVersions: vi.fn(async () => ({ items: [latest, older], next_cursor: null })) });
    render(<GlobalWorkflowLibrary {...props} />); await selectWorkflow();
    expect(screen.queryByText(/Viewing revision/)).not.toBeInTheDocument();
    await menuAction("Workflow History");
    fireEvent.click(await screen.findByRole("button", { name: /Revision 1 \/ Reusable portrait/ }));
    await screen.findByText(/Viewing revision 1/);
    fireEvent.click(screen.getByRole("button", { name: "Restore Workflow content" }));
    expect(screen.getByText(/new immutable revision/)).toBeVisible();
    expect(api.appendGlobalWorkflow).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(api.appendGlobalWorkflow).toHaveBeenCalledWith("global-w", expect.objectContaining({ workflow: older.workflow })));
    await screen.findByText(/Viewing revision 3/);
    expect(api.getGlobalWorkflowVersion).toHaveBeenLastCalledWith("latest", expect.any(AbortSignal));
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("uses exact Profile history for edit/copy, blocks mismatched targets, and restores old content without overwriting", async () => {
    const old = { ...profileVersion, id: "old-p", workflow_version_id: "old-w", version_number: 1 };
    const latest = { ...profileVersion, version_number: 2 };
    const { api, props } = setup({ listGlobalProfileVersions: vi.fn(async () => ({ items: [latest, old], next_cursor: null })), getGlobalProfileVersion: vi.fn(async (id) => id === "old-p" ? old : latest) });
    render(<GlobalWorkflowLibrary {...props} projectId="project-1" />); await selectWorkflow();
    await menuAction("History for Portrait mapping", true);
    fireEvent.click(await screen.findByRole("button", { name: /Revision 1 \/ Portrait mapping/ }));
    await screen.findByText(/Viewing Profile revision 1/);
    expect(screen.getByRole("button", { name: "Add to Project" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Review selected mappings" })); save();
    await waitFor(() => expect(api.appendGlobalProfile).toHaveBeenCalledWith("global-p", expect.objectContaining({ workflow_version_id: "global-w-v1", mappings: old.profile.mappings })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await menuAction("History for Portrait mapping", true);
    fireEvent.click(await screen.findByRole("button", { name: /Revision 1 \/ Portrait mapping/ }));
    await screen.findByText(/Viewing Profile revision 1/);
    fireEvent.click(screen.getByRole("button", { name: "Restore Profile content" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(api.appendGlobalProfile).toHaveBeenLastCalledWith("global-p", expect.objectContaining({ workflow_version_id: "old-w", mappings: old.profile.mappings })));
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("renames current metadata without changing the selected immutable Workflow JSON", async () => {
    const { api, props } = setup(); render(<GlobalWorkflowLibrary {...props} />); await selectWorkflow();
    await menuAction("Edit Workflow metadata");
    expect(screen.queryByLabelText("Workflow JSON")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Current friendly name" } });
    fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: "Current description" } });
    vi.mocked(api.getGlobalWorkflow).mockResolvedValue({ ...globalWorkflow, name: "Current friendly name", description: "Current description", latest_version_id: "newer" });
    save();
    expect(await screen.findByRole("heading", { name: "Current friendly name" })).toBeVisible();
    expect(screen.getByText("Current description")).toBeVisible();
    expect(api.updateGlobalWorkflow).toHaveBeenCalledWith("global-w", { request_id: expect.any(String), name: "Current friendly name", description: "Current description" });
    expect(api.getGlobalWorkflowVersion).toHaveBeenLastCalledWith("global-w-v1", expect.any(AbortSignal));
    expect(api.appendGlobalWorkflow).not.toHaveBeenCalled();
  });

  it("updates Profile metadata rather than its frozen name even when the renamed family leaves the current search", async () => {
    const { api, props } = setup(); render(<GlobalWorkflowLibrary {...props} />); await selectWorkflow();
    fireEvent.change(screen.getByLabelText("Search Profiles"), { target: { value: "Portrait" } });
    fireEvent.click(await screen.findByRole("button", { name: "Portrait mapping" }));
    await screen.findByRole("region", { name: "Selected Profile" });
    await menuAction("Metadata for Portrait mapping", true);
    expect(screen.queryByLabelText("Prompt node")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed mapping" } });
    vi.mocked(api.listGlobalProfileFamilies).mockResolvedValue({ items: [], next_cursor: null });
    save();
    await screen.findByRole("heading", { name: "Renamed mapping" });
    expect(api.updateGlobalProfile).toHaveBeenCalledWith("global-p", { request_id: expect.any(String), name: "Renamed mapping", description: null });
    expect(api.appendGlobalProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit selected Profile" }));
    expect(screen.getByText(/Renamed mapping for Reusable portrait/)).toBeVisible();
    save(); await waitFor(() => expect(api.appendGlobalProfile).toHaveBeenCalledWith("global-p", expect.objectContaining({ mappings: profileVersion.profile.mappings })));
  });

  it("exposes archived-only Workflow content through explicit History without fetching a nonexistent latest version", async () => {
    const archived = { ...globalVersion, archived_at: "2026-09-09T12:00:00Z" };
    const { api, props } = setup({ getGlobalWorkflow: vi.fn(async () => ({ ...globalWorkflow, latest_version_id: null })), listGlobalWorkflowVersions: vi.fn(async (_id, query) => ({ items: query?.include_archived ? [archived] : [], next_cursor: null })), getGlobalWorkflowVersion: vi.fn(async () => archived) });
    render(<GlobalWorkflowLibrary {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reusable portrait" }));
    await screen.findByText(/No active Workflow content/);
    expect(api.getGlobalWorkflowVersion).not.toHaveBeenCalled();
    await menuAction("Workflow History");
    await screen.findByText("No revisions found.");
    fireEvent.click(screen.getByRole("checkbox", { name: "Show archived workflow revisions" }));
    fireEvent.click(await screen.findByRole("button", { name: /Revision 1.*archived/ }));
    await screen.findByRole("button", { name: "Unarchive Workflow revision" });
    expect(screen.getByRole("button", { name: "Add to Project" })).toBeDisabled();
    expect(api.getGlobalWorkflowVersion).toHaveBeenCalledWith("global-w-v1", expect.any(AbortSignal));
  });

  it.each(["Workflow", "Profile", "Workflow revision", "Profile revision"] as const)("confirms archive and unarchive of a %s without deleting copies", async (kind) => {
    const { api, props } = setup(); render(<GlobalWorkflowLibrary {...props} />); await selectWorkflow();
    const isProfile = kind.startsWith("Profile");
    const isRevision = kind.endsWith("revision");
    const archiveKind = isProfile ? (isRevision ? "workflow-profile-versions" : "workflow-profiles") : (isRevision ? "workflow-versions" : "workflows");
    const id = isProfile ? (isRevision ? "global-p-v1" : "global-p") : (isRevision ? "global-w-v1" : "global-w");
    if (isRevision) {
      await menuAction(isProfile ? "History for Portrait mapping" : "Workflow History", isProfile);
      await screen.findByText(isProfile ? /Viewing Profile revision/ : /Viewing revision/);
    }
    if (!isRevision) await menuAction(kind === "Profile" ? "Archive Portrait mapping" : `Archive ${kind}`, isProfile);
    else fireEvent.click(await screen.findByRole("button", { name: `Archive ${kind}` }));
    expect(api.archiveGlobalEntry).not.toHaveBeenCalled();
    expect(screen.getByText(/names remain reserved/)).toBeVisible();
    const archived_at = "2026-09-09T12:00:00Z";
    if (isProfile) {
      vi.mocked(api.listGlobalProfileFamilies).mockResolvedValue({ items: [{ ...globalProfileFamily, ...(isRevision ? {} : { archived_at }) }], next_cursor: null });
      vi.mocked(api.getGlobalProfileVersion).mockResolvedValue({ ...profileVersion, ...(isRevision ? { archived_at } : {}) });
    } else if (isRevision) vi.mocked(api.getGlobalWorkflowVersion).mockResolvedValue({ ...globalVersion, archived_at });
    else vi.mocked(api.getGlobalWorkflow).mockResolvedValue({ ...globalWorkflow, archived_at });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: "Show archived entries" }));
    if (isProfile && isRevision) {
      await menuAction("History for Portrait mapping", true);
      await screen.findByText(/Viewing Profile revision/);
    }
    if (!isRevision) await menuAction(kind === "Profile" ? "Unarchive Portrait mapping" : `Unarchive ${kind}`, isProfile);
    else fireEvent.click(await screen.findByRole("button", { name: `Unarchive ${kind}` }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Unarchive" }));
    await waitFor(() => expect(api.archiveGlobalEntry).toHaveBeenCalledTimes(2));
    expect(api.archiveGlobalEntry).toHaveBeenNthCalledWith(1, archiveKind, id, { request_id: expect.any(String), archived: true });
    expect(api.archiveGlobalEntry).toHaveBeenNthCalledWith(2, archiveKind, id, { request_id: expect.any(String), archived: false });
    expect(props.onApply).not.toHaveBeenCalled(); expect(props.onCopied).not.toHaveBeenCalled();
  });
});
