import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BatchcraftApiClient, type BatchcraftApi } from "../../api/client";
import { copiedSetup, globalProfile, globalProfileFamily, globalVersion, globalWorkflow, workflowLibraryApi } from "../../test/workflowLibraryFixtures";
import { GlobalWorkflowLibrary } from "./GlobalWorkflowLibrary";

function setup(overrides: Partial<BatchcraftApi> = {}) {
  const api = Object.assign(new BatchcraftApiClient(), workflowLibraryApi(), overrides);
  const props = { api, active: true, query: "", onQueryChange: vi.fn(), projectId: "project-1" as string | null, projectName: "Destination", draftGuard: "draft-1", applyDisabled: false, onApply: vi.fn(() => true), onCopied: vi.fn() };
  return { api, props };
}
async function openCopy() {
  fireEvent.click(await screen.findByRole("button", { name: "Reusable portrait" }));
  fireEvent.click(await screen.findByRole("button", { name: "Add to Project" }));
  await screen.findByRole("checkbox", { name: "Portrait mapping" });
}

describe("Global Workflow Library", () => {
  it("isolates scrolling to entry lists while keeping controls, inspection, and copy actions outside", async () => {
    const { props } = setup({
      browseGlobalWorkflows: vi.fn(async () => ({ items: Array.from({ length: 20 }, (_, index) => ({ ...globalWorkflow, id: `workflow-${index}`, name: `Workflow ${index}` })), next_cursor: "next-workflows" })),
      listGlobalProfileFamilies: vi.fn(async () => ({ items: Array.from({ length: 20 }, (_, index) => ({ ...globalProfileFamily, id: `profile-${index}`, name: `Profile ${index}` })), next_cursor: "next-profiles" })),
    });
    render(<GlobalWorkflowLibrary {...props} />);
    const workflows = screen.getByRole("group", { name: "Workflow entries" });
    expect(workflows).toHaveClass("global-library-workflow-list");
    fireEvent.click(await within(workflows).findByRole("button", { name: "Workflow 0" }));
    expect(within(workflows).getAllByRole("button")).toHaveLength(20);
    expect(within(workflows).getByRole("button", { name: "Workflow 0" })).toHaveAttribute("aria-pressed", "true");
    const sidebar = screen.getByRole("complementary", { name: "Workflows" });
    for (const control of [screen.getByLabelText("Search Workflow Library"), screen.getByRole("checkbox", { name: "Show archived entries" }), screen.getByRole("button", { name: "Next Workflows" })]) {
      expect(sidebar).toContainElement(control);
      expect(workflows).not.toContainElement(control);
    }

    const profiles = await screen.findByRole("group", { name: "Profile entries" });
    expect(profiles).toHaveClass("global-library-profile-list");
    await within(profiles).findByRole("button", { name: "Profile 19" });
    expect(profiles.querySelectorAll(".global-profile-row")).toHaveLength(20);
    for (const control of [screen.getByLabelText("Search Profiles"), screen.getByRole("button", { name: "Next Profile families" }), screen.getByRole("button", { name: "Add to Project" })]) expect(profiles).not.toContainElement(control);
    fireEvent.click(within(profiles).getByRole("button", { name: "Profile 0" }));
    const selected = await screen.findByRole("region", { name: "Selected Profile" });
    expect(profiles).not.toContainElement(selected);
    expect(within(profiles).getByRole("button", { name: "Profile 0" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(profiles).getByRole("button", { name: "Actions for Profile Profile 0" }));
    const menu = screen.getByRole("menu", { name: "Actions for Profile Profile 0" });
    expect(profiles).not.toContainElement(menu);
    expect(menu.parentElement).toBe(document.body);
    const edit = screen.getByRole("button", { name: "Edit Workflow" });
    expect(edit.parentElement).toContainElement(screen.getByRole("button", { name: "Actions for Workflow Reusable portrait" }));
    expect(edit.closest("header")?.querySelector(".global-library-detail-title")).toContainElement(screen.getByRole("heading", { name: "Reusable portrait" }));
    expect(screen.getByRole("button", { name: "Add to Project" }).closest("footer")).toHaveClass("global-library-copy-footer");
  });

  it("refreshes families and retries a failed summary only once while the same exact Workflow snapshot reloads", async () => {
    const cached = { ...globalProfile, profile: copiedSetup.profiles[0].version.profile, note: null, archived_at: null };
    const failed = { ...cached, id: "retry-version", workflow_profile_id: "retry-family" };
    let resolveWorkflow!: (value: typeof globalVersion) => void;
    let resolveSummary!: (value: typeof failed) => void;
    const { api, props } = setup({
      listGlobalProfileFamilies: vi.fn(async () => ({ items: [globalProfileFamily, { ...globalProfileFamily, id: failed.workflow_profile_id, name: "Retry mapping", latest_compatible_version_id: failed.id }], next_cursor: null })),
      getGlobalWorkflowVersion: vi.fn().mockResolvedValueOnce(globalVersion).mockImplementation(() => new Promise<typeof globalVersion>((resolve) => { resolveWorkflow = resolve; })),
      getGlobalProfileVersion: vi.fn().mockResolvedValueOnce(cached).mockRejectedValueOnce(new Error("Summary failed")).mockImplementation(() => new Promise<typeof failed>((resolve) => { resolveSummary = resolve; })),
    });
    render(<GlobalWorkflowLibrary {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reusable portrait" }));
    await screen.findByText("Summary unavailable");
    expect(screen.getByRole("button", { name: "Portrait mapping" })).toHaveTextContent("1 named inputs / 0 parameters");
    expect(api.listGlobalProfileFamilies).toHaveBeenCalledOnce();
    expect(api.getGlobalProfileVersion).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Reload library" }));
    await waitFor(() => expect(api.getGlobalWorkflowVersion).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.getGlobalProfileVersion).toHaveBeenCalledTimes(3));
    const retry = vi.mocked(api.getGlobalProfileVersion).mock.calls[2];
    const familyRead = vi.mocked(api.listGlobalProfileFamilies).mock.calls[1];
    expect(retry[0]).toBe(failed.id);
    expect(familyRead[1]?.workflow_version_id).toBe(globalVersion.id);
    expect(screen.getByRole("button", { name: "Retry mapping" })).toHaveTextContent("Loading mappings...");
    expect(screen.getByRole("button", { name: "Portrait mapping" })).toHaveTextContent("1 named inputs / 0 parameters");

    await act(async () => resolveWorkflow({ ...globalVersion }));
    expect(api.listGlobalProfileFamilies).toHaveBeenCalledTimes(2);
    expect(api.getGlobalProfileVersion).toHaveBeenCalledTimes(3);
    expect(familyRead[2]?.aborted).toBe(false);
    expect(retry[1]?.aborted).toBe(false);
    await act(async () => resolveSummary(failed));
    expect(screen.getByRole("button", { name: "Retry mapping" })).toHaveTextContent("1 named inputs / 0 parameters");
    expect(vi.mocked(api.getGlobalProfileVersion).mock.calls.map(([id]) => id)).toEqual([cached.id, failed.id, failed.id]);
  });

  it("clears the previous family page and waits for a newly selected exact Workflow before reading its families", async () => {
    const older = { ...globalVersion, id: "older-workflow", version_number: 0 };
    let resolveWorkflow!: (value: typeof older) => void;
    const { api, props } = setup({
      listGlobalWorkflowVersions: vi.fn(async () => ({ items: [older], next_cursor: null })),
      getGlobalWorkflowVersion: vi.fn().mockResolvedValueOnce(globalVersion).mockImplementation(() => new Promise<typeof older>((resolve) => { resolveWorkflow = resolve; })),
      listGlobalProfileFamilies: vi.fn(async (_id, query) => ({ items: query?.workflow_version_id === older.id ? [] : [globalProfileFamily], next_cursor: null })),
    });
    render(<GlobalWorkflowLibrary {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reusable portrait" }));
    await screen.findByText("1 named inputs / 0 parameters");
    fireEvent.click(screen.getByRole("button", { name: "Actions for Workflow Reusable portrait" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Workflow History" }));
    fireEvent.click(await screen.findByRole("button", { name: /Revision 0 \/ Reusable portrait/ }));
    await waitFor(() => expect(api.getGlobalWorkflowVersion).toHaveBeenLastCalledWith(older.id, expect.any(AbortSignal)));
    expect(screen.queryByRole("button", { name: "Portrait mapping" })).not.toBeInTheDocument();
    expect(api.listGlobalProfileFamilies).toHaveBeenCalledOnce();
    expect(vi.mocked(api.listGlobalProfileFamilies).mock.calls[0][2]?.aborted).toBe(true);
    await act(async () => resolveWorkflow({ ...older }));
    await screen.findByText("No Profiles found.");
    expect(api.listGlobalProfileFamilies).toHaveBeenCalledTimes(2);
    expect(api.listGlobalProfileFamilies).toHaveBeenLastCalledWith(globalWorkflow.id, expect.objectContaining({ workflow_version_id: older.id, cursor: undefined }), expect.any(AbortSignal));
    expect(api.getGlobalProfileVersion).toHaveBeenCalledOnce();
  });

  it("refreshes current metadata without replacing explicit historical Workflow and Profile selections", async () => {
    const olderWorkflow = { ...globalVersion, id: "old-workflow", version_number: 0 };
    const olderProfile = { ...globalProfile, id: "old-profile", workflow_version_id: olderWorkflow.id, version_number: 0, note: null, archived_at: null, profile: { ...copiedSetup.profiles[0].version.profile, image_inputs: [], parameters: [{ key: "old", label: "Historical strength", value_type: "float", node_id: "1", input_name: "strength" }] } };
    const { api, props } = setup({
      listGlobalWorkflowVersions: vi.fn(async () => ({ items: [olderWorkflow], next_cursor: null })),
      getGlobalWorkflowVersion: vi.fn(async (id) => id === olderWorkflow.id ? olderWorkflow : globalVersion),
      listGlobalProfileVersions: vi.fn(async () => ({ items: [olderProfile], next_cursor: null })),
      getGlobalProfileVersion: vi.fn(async (id) => id === olderProfile.id ? olderProfile : { ...olderProfile, id: globalProfile.id, version_number: 1, profile: copiedSetup.profiles[0].version.profile }),
    });
    const view = render(<GlobalWorkflowLibrary {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reusable portrait" }));
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Workflow Reusable portrait" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Workflow History" }));
    fireEvent.click(await screen.findByRole("button", { name: /Revision 0 \/ Reusable portrait/ }));
    await screen.findByText(/Viewing revision 0/);
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Profile Portrait mapping" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "History for Portrait mapping" }));
    fireEvent.click(await screen.findByRole("button", { name: /Revision 0 \/ Portrait mapping/ }));
    await screen.findByText("Historical strength");
    expect(screen.getByRole("button", { name: "Portrait mapping" })).toHaveTextContent("Selected / revision 0");
    expect(screen.getByRole("button", { name: "Portrait mapping" })).toHaveTextContent("0 named inputs / 1 parameters");
    vi.mocked(api.getGlobalWorkflow).mockResolvedValue({ ...globalWorkflow, name: "Renamed source", latest_version_id: "brand-new-workflow" });
    fireEvent.click(screen.getByRole("button", { name: "Reload library" }));
    await screen.findByRole("heading", { name: "Renamed source" });
    await waitFor(() => expect(api.getGlobalWorkflowVersion).toHaveBeenLastCalledWith("old-workflow", expect.any(AbortSignal)));
    expect(screen.getByRole("button", { name: "Portrait mapping" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Historical strength")).toBeVisible();
    view.rerender(<GlobalWorkflowLibrary {...props} query="back-forward" />);
    expect(screen.getByText("Historical strength")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add to Project" }));
    expect(await screen.findByRole("checkbox", { name: "Portrait mapping" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    await waitFor(() => expect(api.useGlobalSetup).toHaveBeenCalledWith(expect.objectContaining({ workflow_version_id: "old-workflow", profiles: [{ version_id: "old-profile", name: "Portrait mapping" }] }), expect.any(AbortSignal)));
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("reads only the visible Profile page with two summary requests at a time and ignores aborted results", async () => {
    const families = Array.from({ length: 20 }, (_, index) => ({ ...globalProfileFamily, id: `family-${index}`, name: `Mapping ${index}`, latest_compatible_version_id: `version-${index}` }));
    const pending: { id: string; signal?: AbortSignal; resolve(value: (typeof copiedSetup.profiles)[0]["version"]): void }[] = [];
    const { api, props } = setup({
      listGlobalProfileFamilies: vi.fn(async (_id, query) => ({ items: query?.cursor ? [] : families, next_cursor: query?.cursor ? null : "next" })),
      getGlobalProfileVersion: vi.fn((id, signal) => new Promise<Awaited<ReturnType<BatchcraftApi["getGlobalProfileVersion"]>>>((resolve) => pending.push({ id, signal, resolve }))),
    });
    render(<GlobalWorkflowLibrary {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reusable portrait" }));
    await screen.findByRole("button", { name: "Mapping 19" });
    expect(api.getGlobalProfileVersion).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("Loading mappings...")).toHaveLength(20);
    expect(screen.queryByText(/0 named inputs/)).not.toBeInTheDocument();
    await act(async () => pending[0].resolve({ ...copiedSetup.profiles[0].version, id: "version-0", workflow_profile_id: "family-0", workflow_id: globalWorkflow.id }));
    expect(api.getGlobalProfileVersion).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "Mapping 0" })).toHaveTextContent("1 named inputs / 0 parameters");
    fireEvent.click(screen.getByRole("button", { name: "Next Profile families" }));
    await screen.findByText("No Profiles found.");
    expect(pending[1].signal?.aborted).toBe(true); expect(pending[2].signal?.aborted).toBe(true);
    await act(async () => { for (const request of pending.slice(1)) request.resolve({ ...copiedSetup.profiles[0].version, id: request.id, workflow_profile_id: request.id.replace("version", "family"), workflow_id: globalWorkflow.id }); });
    expect(api.getGlobalProfileVersion).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/named inputs/)).not.toBeInTheDocument();
    expect(api.useGlobalSetup).not.toHaveBeenCalled();
  });

  it("bounds the exact-version summary cache to twenty and reuses revisited pages", async () => {
    const { api, props } = setup({
      listGlobalProfileFamilies: vi.fn(async (_id, query) => {
        const page = Number(query?.cursor ?? 0);
        return { items: [{ ...globalProfileFamily, id: `family-${page}`, name: `Mapping ${page}`, latest_compatible_version_id: `version-${page}` }], next_cursor: String(page + 1) };
      }),
      getGlobalProfileVersion: vi.fn(async (id) => ({ ...globalProfile, id, workflow_profile_id: id.replace("version", "family"), profile: copiedSetup.profiles[0].version.profile, note: null, archived_at: null })),
    });
    render(<GlobalWorkflowLibrary {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reusable portrait" }));
    for (let page = 0; page <= 20; page++) {
      await waitFor(() => expect(screen.getByRole("button", { name: `Mapping ${page}` })).toHaveTextContent("1 named inputs / 0 parameters"));
      if (page < 20) fireEvent.click(screen.getByRole("button", { name: "Next Profile families" }));
    }
    expect(api.getGlobalProfileVersion).toHaveBeenCalledTimes(21);
    for (let page = 19; page >= 1; page--) {
      fireEvent.click(screen.getByRole("button", { name: "Previous Profile families" }));
      await waitFor(() => expect(screen.getByRole("button", { name: `Mapping ${page}` })).toHaveTextContent("1 named inputs / 0 parameters"));
    }
    expect(api.getGlobalProfileVersion).toHaveBeenCalledTimes(21);
    fireEvent.click(screen.getByRole("button", { name: "Previous Profile families" }));
    await waitFor(() => expect(api.getGlobalProfileVersion).toHaveBeenCalledTimes(22));
    expect(api.getGlobalProfileVersion).toHaveBeenLastCalledWith("version-0", expect.any(AbortSignal));
  });

  it("keeps failed mapping summaries distinct from zero and offers Project navigation only via its callback", async () => {
    const { api, props } = setup({ getGlobalProfileVersion: vi.fn().mockRejectedValue(new Error("Unavailable")) });
    const choose = vi.fn(); render(<GlobalWorkflowLibrary {...props} projectId={null} onChooseProject={choose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reusable portrait" }));
    await screen.findByText("Summary unavailable");
    expect(screen.getByRole("button", { name: "Add to Project" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Choose Project" })); expect(choose).toHaveBeenCalledOnce();
    expect(api.useGlobalSetup).not.toHaveBeenCalled(); expect(props.onApply).not.toHaveBeenCalled();
  });

  it("hydrates a failed copy once and keeps replacement B checked across reload, search, and paging without copying A", async () => {
    const a = { ...globalProfile, profile: copiedSetup.profiles[0].version.profile, archived_at: null, note: null };
    const b = { ...a, id: "profile-b", version_number: 2 };
    const { api, props } = setup({
      useGlobalSetup: vi.fn().mockRejectedValueOnce(new Error("Lost response")).mockResolvedValue(copiedSetup),
      listGlobalProfileFamilies: vi.fn(async () => ({ items: [globalProfileFamily], next_cursor: "next" })),
      listGlobalProfileVersions: vi.fn(async () => ({ items: [a, b], next_cursor: null })),
      getGlobalProfileVersion: vi.fn(async (id) => id === b.id ? b : a),
    });
    render(<GlobalWorkflowLibrary {...props} />); await openCopy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Portrait mapping" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    await screen.findByText(/copy may have completed/);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to Project" }));
    expect(await screen.findByRole("checkbox", { name: "Portrait mapping" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Copy History for Portrait mapping" }));
    fireEvent.click(await within(screen.getByRole("dialog")).findByRole("button", { name: /Revision 2/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm copy" })).toBeEnabled());
    for (const action of ["reload", "search", "page"] as const) {
      if (action === "reload") fireEvent.click(screen.getByRole("button", { name: "Reload Profiles" }));
      else if (action === "search") fireEvent.change(screen.getByLabelText("Search compatible Profiles"), { target: { value: "Portrait" } });
      else fireEvent.click(screen.getByRole("button", { name: "Next Profiles" }));
      expect(await screen.findByRole("checkbox", { name: "Portrait mapping" })).toBeChecked();
      expect(within(screen.getByRole("dialog")).getAllByRole("checkbox", { name: "Portrait mapping" })).toHaveLength(1);
      expect(screen.getByText(/Compatible Profiles: 1\/50 selected/)).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Inspect Portrait mapping" }));
      await waitFor(() => expect(api.getGlobalProfileVersion).toHaveBeenLastCalledWith(b.id, expect.any(AbortSignal)));
    }
    expect(vi.mocked(api.getGlobalProfileVersion).mock.calls.filter(([id]) => id === a.id)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    await screen.findByText(/Copied to Project/);
    expect(vi.mocked(api.useGlobalSetup).mock.calls[1][0].profiles).toEqual([{ version_id: b.id, name: "Portrait mapping" }]);
    expect(vi.mocked(api.useGlobalSetup).mock.calls[1][0].request_id).not.toBe(vi.mocked(api.useGlobalSetup).mock.calls[0][0].request_id);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to Project" }));
    expect(await screen.findByRole("checkbox", { name: "Portrait mapping" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Inspect Portrait mapping" }));
    await waitFor(() => expect(api.getGlobalProfileVersion).toHaveBeenLastCalledWith(a.id, expect.any(AbortSignal)));
  });

  it("restarts interrupted receipt hydration without publishing partially resolved choices", async () => {
    const a = { ...globalProfile, profile: copiedSetup.profiles[0].version.profile, archived_at: null, note: null };
    const second = { ...a, id: "second-version", workflow_profile_id: "second-family" };
    let resolve!: (value: typeof second) => void;
    const { api, props } = setup({
      useGlobalSetup: vi.fn().mockRejectedValue(new Error("Lost response")),
      listGlobalProfileFamilies: vi.fn(async () => ({ items: [globalProfileFamily, { ...globalProfileFamily, id: second.workflow_profile_id, name: "Second Profile", latest_compatible_version_id: second.id }], next_cursor: null })),
      getGlobalProfileVersion: vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(second).mockResolvedValueOnce(a).mockImplementationOnce(() => new Promise<typeof second>((done) => { resolve = done; })).mockImplementation(async (id) => id === a.id ? a : second),
    });
    render(<GlobalWorkflowLibrary {...props} />); await openCopy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Portrait mapping" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Second Profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    await screen.findByText(/copy may have completed/);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to Project" }));
    await waitFor(() => expect(api.getGlobalProfileVersion).toHaveBeenCalledTimes(4));
    expect(screen.queryByRole("checkbox", { name: "Portrait mapping" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search compatible Profiles"), { target: { value: "new scope" } });
    expect(await screen.findByRole("checkbox", { name: "Portrait mapping" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Second Profile" })).toBeChecked();
    expect(vi.mocked(api.getGlobalProfileVersion).mock.calls[3][1]?.aborted).toBe(true);
    expect(vi.mocked(api.getGlobalProfileVersion).mock.calls.map(([id]) => id)).toEqual([a.id, second.id, a.id, second.id, a.id, second.id]);
    await act(async () => resolve(second));
    fireEvent.click(screen.getByRole("button", { name: "Reload Profiles" }));
    expect(await screen.findByRole("checkbox", { name: "Portrait mapping" })).toBeChecked();
    expect(api.getGlobalProfileVersion).toHaveBeenCalledTimes(6);
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    await waitFor(() => expect(api.useGlobalSetup).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.useGlobalSetup).mock.calls[1][0]).toEqual(vi.mocked(api.useGlobalSetup).mock.calls[0][0]);
  });

  it("copies the explicitly selected compatible Profile history revision instead of the family's latest", async () => {
    const old = { ...globalProfile, id: "old-profile", profile: copiedSetup.profiles[0].version.profile, archived_at: null, note: null };
    const { api, props } = setup({ listGlobalProfileVersions: vi.fn(async () => ({ items: [old], next_cursor: null })), getGlobalProfileVersion: vi.fn(async (id) => ({ ...old, id })) });
    render(<GlobalWorkflowLibrary {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reusable portrait" }));
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Profile Portrait mapping" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "History for Portrait mapping" }));
    fireEvent.click(await screen.findByRole("button", { name: /Revision 1 \/ Portrait mapping/ }));
    await waitFor(() => expect(api.getGlobalProfileVersion).toHaveBeenLastCalledWith("old-profile", expect.any(AbortSignal)));
    await screen.findByText(/Viewing Profile revision 1/);
    fireEvent.click(screen.getByRole("button", { name: "Add to Project" }));
    expect(await screen.findByRole("checkbox", { name: "Portrait mapping" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    await waitFor(() => expect(api.useGlobalSetup).toHaveBeenCalledWith(expect.objectContaining({ workflow_version_id: "global-w-v1", profiles: [{ version_id: "old-profile", name: "Portrait mapping" }] }), expect.any(AbortSignal)));
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("blocks copy while an incompatible exact Profile history selection is under review", async () => {
    const old = { ...globalProfile, id: "old-profile", workflow_version_id: "old-workflow", profile: copiedSetup.profiles[0].version.profile, archived_at: null, note: null };
    const { api, props } = setup({ listGlobalProfileVersions: vi.fn(async () => ({ items: [old], next_cursor: null })), getGlobalProfileVersion: vi.fn(async () => old) });
    render(<GlobalWorkflowLibrary {...props} />); await openCopy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Portrait mapping" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy History for Portrait mapping" }));
    fireEvent.click(await within(screen.getByRole("dialog")).findByRole("button", { name: /Revision 1 \/ Portrait mapping/ }));
    await screen.findByText(/before this revision can be copied/);
    expect(screen.getByRole("button", { name: "Confirm copy" })).toBeDisabled();
    expect(api.useGlobalSetup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep previous compatible selection" }));
    expect(screen.getByRole("button", { name: "Confirm copy" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Portrait mapping" })).toBeChecked();
  });

  it("browses and inspects exact Profiles without a Project or writes", async () => {
    const { api, props } = setup();
    render(<GlobalWorkflowLibrary {...props} projectId={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reusable portrait" }));
    expect(await screen.findByRole("button", { name: "Add to Project" })).toBeDisabled();
    fireEvent.click(await screen.findByRole("button", { name: "Portrait mapping" }));
    await screen.findByRole("region", { name: "Selected Profile" });
    expect(screen.getByText("Source image")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.getGlobalProfileVersion).toHaveBeenCalledWith("global-p-v1", expect.any(AbortSignal));
    expect(screen.queryByRole("button", { name: "Confirm copy" })).not.toBeInTheDocument();
    expect(api.useGlobalSetup).not.toHaveBeenCalled();
    expect(api.importProjectSetup).not.toHaveBeenCalled();
    expect(api.listProjects).not.toHaveBeenCalled();
  });

  it("pages with bounded bookmarks, resets on search, and cancels obsolete reads", async () => {
    const { api, props } = setup({ browseGlobalWorkflows: vi.fn(async () => ({ items: [globalWorkflow], next_cursor: "next" })) });
    const view = render(<GlobalWorkflowLibrary {...props} />);
    await screen.findByRole("button", { name: "Reusable portrait" });
    fireEvent.click(screen.getByRole("button", { name: "Next Workflows" }));
    await waitFor(() => expect(api.browseGlobalWorkflows).toHaveBeenLastCalledWith({ q: "", limit: 20, cursor: "next" }, expect.any(AbortSignal)));
    expect(vi.mocked(api.browseGlobalWorkflows).mock.calls[0][1]?.aborted).toBe(true);
    view.rerender(<GlobalWorkflowLibrary {...props} query="new" />);
    await waitFor(() => expect(api.browseGlobalWorkflows).toHaveBeenLastCalledWith({ q: "new", limit: 20, cursor: undefined }, expect.any(AbortSignal)));
    view.rerender(<GlobalWorkflowLibrary {...props} active={false} query="new" />);
    expect(vi.mocked(api.browseGlobalWorkflows).mock.calls.at(-1)?.[1]?.aborted).toBe(true);
  });

  it.each(["Workflows", "Profiles"] as const)("browses %s beyond 20 Next pages while retaining only 20 Previous bookmarks", async (kind) => {
    const { props } = setup(kind === "Workflows" ? {
      browseGlobalWorkflows: vi.fn(async (query) => {
        const page = Number(query?.cursor ?? 0);
        return { items: [{ ...globalWorkflow, name: `Workflow page ${page}` }], next_cursor: String(page + 1) };
      }),
    } : {
      listGlobalProfileFamilies: vi.fn(async (_id, query) => {
        const page = Number(query?.cursor ?? 0);
        return { items: [{ ...globalProfileFamily, name: `Profile page ${page}` }], next_cursor: String(page + 1) };
      }),
    });
    render(<GlobalWorkflowLibrary {...props} />);
    if (kind === "Profiles") {
      fireEvent.click(await screen.findByRole("button", { name: "Reusable portrait" }));
      fireEvent.click(await screen.findByRole("button", { name: "Add to Project" }));
    }
    async function expectPage(page: number) {
      expect(await screen.findByRole(kind === "Workflows" ? "button" : "checkbox", {
        name: kind === "Workflows" ? `Workflow page ${page}` : `Profile page ${page}`,
      })).toBeVisible();
    }
    await expectPage(0);
    for (let page = 1; page <= 23; page++) {
      expect(screen.getByRole("button", { name: `Next ${kind}` })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: `Next ${kind}` }));
      await expectPage(page);
    }
    expect(screen.getByRole("button", { name: `Next ${kind}` })).toBeEnabled();
    for (let page = 22; page >= 3; page--) {
      expect(screen.getByRole("button", { name: `Previous ${kind}` })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: `Previous ${kind}` }));
      await expectPage(page);
    }
    expect(screen.getByRole("button", { name: `Previous ${kind}` })).toBeDisabled();
    expect(screen.getByRole("button", { name: `Next ${kind}` })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: `Next ${kind}` }));
    await expectPage(4);
    fireEvent.click(screen.getByRole("button", { name: kind === "Workflows" ? "Reload library" : "Reload Profiles" }));
    await expectPage(0);
    expect(screen.getByRole("button", { name: `Previous ${kind}` })).toBeDisabled();
    expect(screen.getByRole("button", { name: `Next ${kind}` })).toBeEnabled();
  });

  it("retries an ambiguous copy with the same receipt and creates a new ID after a field edit", async () => {
    const { api, props } = setup({ useGlobalSetup: vi.fn().mockRejectedValue(new Error("Connection lost")) });
    render(<GlobalWorkflowLibrary {...props} />); await openCopy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Portrait mapping" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    await screen.findByText(/copy may have completed/);
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    await waitFor(() => expect(api.useGlobalSetup).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.useGlobalSetup).mock.calls[0][0]).toEqual(vi.mocked(api.useGlobalSetup).mock.calls[1][0]);
    await screen.findByText(/copy may have completed/);
    fireEvent.change(screen.getByLabelText("New Workflow name (optional)"), { target: { value: "A new family" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    await waitFor(() => expect(api.useGlobalSetup).toHaveBeenCalledTimes(3));
    const calls = vi.mocked(api.useGlobalSetup).mock.calls;
    expect(calls[2][0].request_id).not.toBe(calls[0][0].request_id);
    expect(calls[0][0]).toMatchObject({ workflow_version_id: "global-w-v1", project_id: "project-1", profiles: [{ version_id: "global-p-v1", name: "Portrait mapping" }] });
  });

  it.each(["Project", "draft"])("does not apply a copy after the %s changes in flight", async (change) => {
    let resolve!: (value: typeof copiedSetup) => void;
    const { api, props } = setup({ useGlobalSetup: vi.fn(() => new Promise<typeof copiedSetup>((done) => { resolve = done; })) });
    const view = render(<GlobalWorkflowLibrary {...props} />); await openCopy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    await waitFor(() => expect(api.useGlobalSetup).toHaveBeenCalledOnce());
    view.rerender(<GlobalWorkflowLibrary {...props} projectId={change === "Project" ? "project-2" : "project-1"} draftGuard={change === "draft" ? "draft-2" : "draft-1"} />);
    await act(async () => resolve({ ...copiedSetup, profiles: [] }));
    expect(screen.getByRole("button", { name: "Apply to Batch" })).toBeDisabled();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("copies multiple Profiles but requires an explicit single Profile before applying", async () => {
    const second = { ...copiedSetup.profiles[0], version: { ...copiedSetup.profiles[0].version, id: "copied-p-v2" } };
    const { props } = setup({ useGlobalSetup: vi.fn(async () => ({ ...copiedSetup, profiles: [...copiedSetup.profiles, second] })) });
    render(<GlobalWorkflowLibrary {...props} />); await openCopy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    expect(await screen.findByRole("button", { name: "Apply to Batch" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Copied Profile to apply"), { target: { value: "copied-p-v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply to Batch" }));
    expect(props.onApply).toHaveBeenCalledWith(expect.any(Object), "copied-p-v2", "draft-1");
  });

  it("allows a Workflow-only copy and applies only on explicit action", async () => {
    const { api, props } = setup({ useGlobalSetup: vi.fn(async () => ({ ...copiedSetup, profiles: [] })) });
    render(<GlobalWorkflowLibrary {...props} />); await openCopy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    await screen.findByText(/No Profiles copied/);
    expect(api.useGlobalSetup).toHaveBeenCalledWith(expect.objectContaining({ profiles: [] }), expect.any(AbortSignal));
    expect(props.onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply to Batch" }));
    expect(props.onApply).toHaveBeenCalledWith(expect.any(Object), null, "draft-1");
  });

  it.each(["Reviewed name", ""])("retains a cancelled write receipt with name %j when reopening and ignores its late success", async (name) => {
    let resolve!: (value: typeof copiedSetup) => void;
    const { api, props } = setup({ useGlobalSetup: vi.fn().mockImplementationOnce(() => new Promise<typeof copiedSetup>((done) => { resolve = done; })).mockResolvedValue(copiedSetup) });
    render(<GlobalWorkflowLibrary {...props} />); await openCopy();
    fireEvent.change(screen.getByLabelText("New Workflow name (optional)"), { target: { value: name } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Portrait mapping" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    await waitFor(() => expect(api.useGlobalSetup).toHaveBeenCalledOnce());
    const first = vi.mocked(api.useGlobalSetup).mock.calls[0];
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    expect(first[1]?.aborted).toBe(true);
    await act(async () => resolve(copiedSetup));
    expect(screen.queryByText(/Copied to Project/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add to Project" }));
    await screen.findByRole("checkbox", { name: "Portrait mapping" });
    expect(screen.getByLabelText("New Workflow name (optional)")).toHaveValue(name);
    expect(screen.getByRole("checkbox", { name: "Portrait mapping" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    await screen.findByText(/Copied to Project/);
    expect(vi.mocked(api.useGlobalSetup).mock.calls[1][0]).toEqual(first[0]);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("uses a fresh operation ID for a new submission after a successful copy", async () => {
    const { api, props } = setup(); render(<GlobalWorkflowLibrary {...props} />); await openCopy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    await screen.findByText(/Copied to Project/);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to Project" }));
    await screen.findByRole("checkbox", { name: "Portrait mapping" });
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    await screen.findByText(/Copied to Project/);
    expect(vi.mocked(api.useGlobalSetup).mock.calls[0][0].request_id).not.toBe(vi.mocked(api.useGlobalSetup).mock.calls[1][0].request_id);
  });

  it("keeps Apply disabled while Run control blocks setup changes", async () => {
    const { props } = setup(); render(<GlobalWorkflowLibrary {...props} applyDisabled />); await openCopy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    expect(await screen.findByRole("button", { name: "Apply to Batch" })).toBeDisabled();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("does not treat a failed compatible-Profile read as an empty successful list", async () => {
    const { api, props } = setup({ listGlobalProfileFamilies: vi.fn().mockRejectedValue(new Error("Unavailable")) });
    render(<GlobalWorkflowLibrary {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reusable portrait" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add to Project" }));
    await within(screen.getByRole("dialog")).findByText("Unavailable");
    expect(screen.getByRole("button", { name: "Confirm copy" })).toBeDisabled();
    vi.mocked(api.listGlobalProfileFamilies).mockResolvedValue({ items: [], next_cursor: null });
    fireEvent.click(screen.getByRole("button", { name: "Reload Profiles" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm copy" })).toBeEnabled());
    expect(api.useGlobalSetup).not.toHaveBeenCalled();
  });

  it("cancels source Project reads and ignores a stale source response", async () => {
    let resolve!: (value: { workflows: [] }) => void;
    const { api, props } = setup({ listWorkflows: vi.fn().mockImplementationOnce(() => new Promise<{ workflows: [] }>((done) => { resolve = done; })).mockResolvedValue({ workflows: [{ ...copiedSetup.workflow.workflow, latest_active_version: copiedSetup.workflow.version }] }) });
    render(<GlobalWorkflowLibrary {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Import to Library" }));
    await screen.findByRole("option", { name: "Source Project" });
    fireEvent.change(screen.getByLabelText("Source Project"), { target: { value: "project-1" } });
    await waitFor(() => expect(api.listWorkflows).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Source Project"), { target: { value: "project-2" } });
    await screen.findByRole("option", { name: "Reusable portrait" });
    expect(vi.mocked(api.listWorkflows).mock.calls[0][1]?.aborted).toBe(true);
    await act(async () => resolve({ workflows: [] }));
    expect(screen.getByRole("option", { name: "Reusable portrait" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review import" })).toBeDisabled();
  });

  it("imports exact Project versions and compatible Profile revisions without applying", async () => {
    const older = { ...copiedSetup.profiles[0].version, id: "older-p", version_number: 1 };
    const latest = { ...copiedSetup.profiles[0].version, version_number: 2 };
    const { api, props } = setup({ listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [{ ...copiedSetup.profiles[0].workflow_profile, latest_compatible_version: latest }] })), listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [older, latest] })) });
    render(<GlobalWorkflowLibrary {...props} projectId={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Import to Library" }));
    await screen.findByRole("option", { name: "Source Project" });
    fireEvent.change(screen.getByLabelText("Source Project"), { target: { value: "project-1" } });
    await screen.findByRole("option", { name: "Reusable portrait" });
    fireEvent.change(screen.getByLabelText("Source Workflow"), { target: { value: "copied-w" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Review import" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Review import" }));
    expect(await screen.findByRole("checkbox", { name: "Portrait mapping / v2" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Revisions for Portrait mapping" }));
    await screen.findByRole("option", { name: "v1 / older-p" });
    fireEvent.change(screen.getByLabelText("Exact revision for Portrait mapping"), { target: { value: "older-p" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm copy" }));
    await screen.findByText(/Imported into Workflow Library/);
    expect(api.importProjectSetup).toHaveBeenCalledWith(expect.objectContaining({ project_id: "project-1", workflow_version_id: "copied-w-v1", profiles: [{ version_id: "older-p", name: "Portrait mapping" }] }), expect.any(AbortSignal));
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("limits selected Profiles to 50 across bounded pages", async () => {
    const { props } = setup({ listGlobalProfileFamilies: vi.fn(async (_id, query) => ({ items: Array.from({ length: 20 }, (_, index) => ({ ...globalProfileFamily, id: `${query?.cursor ?? "first"}-${index}`, latest_compatible_version_id: `${query?.cursor ?? "first"}-${index}`, name: `Profile ${query?.cursor ?? "first"}-${index}` })), next_cursor: query?.cursor === "second" ? "third" : "second" })) });
    render(<GlobalWorkflowLibrary {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reusable portrait" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add to Project" }));
    for (let page = 0; page < 3; page++) {
      await screen.findByRole("checkbox", { name: `Profile ${page === 0 ? "first" : page === 1 ? "second" : "third"}-0` });
      const boxes = within(screen.getByRole("dialog")).getAllByRole("checkbox");
      boxes.slice(0, page === 2 ? 10 : 20).forEach((box) => fireEvent.click(box));
      if (page < 2) fireEvent.click(screen.getByRole("button", { name: "Next Profiles" }));
    }
    expect(screen.getByText(/50\/50 selected/)).toBeVisible();
    expect(within(screen.getByRole("dialog")).getAllByRole("checkbox").filter((box) => (box as HTMLInputElement).disabled)).toHaveLength(10);
  });

  it("ignores late detail responses after selecting a different Workflow", async () => {
    let resolve!: (value: typeof globalVersion) => void;
    const { props } = setup({ getGlobalWorkflow: vi.fn(async (id) => id === "other" ? { ...globalWorkflow, id, name: "Other", latest_version_id: "other-v" } : globalWorkflow), browseGlobalWorkflows: vi.fn(async () => ({ items: [globalWorkflow, { ...globalWorkflow, id: "other", name: "Other", latest_version_id: "other-v" }], next_cursor: null })), getGlobalWorkflowVersion: vi.fn((id) => id === "other-v" ? Promise.resolve({ ...globalVersion, id, name_snapshot: "Other" }) : new Promise<typeof globalVersion>((done) => { resolve = done; })) });
    render(<GlobalWorkflowLibrary {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reusable portrait" }));
    await waitFor(() => expect(resolve).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    await screen.findByRole("heading", { name: "Other" });
    await act(async () => resolve(globalVersion));
    expect(screen.queryByRole("heading", { name: "Reusable portrait" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Global Workflow Library" })).getByRole("heading", { name: "Other" })).toBeVisible();
  });
});
