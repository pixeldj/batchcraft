import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BatchcraftApi } from "../../api/client";
import type { CreateWorkflowResponse, LibraryWorkflowProfileVersion, LibraryWorkflowVersion, ProjectWorkflow, ProjectWorkflowProfile, WorkflowsResponse } from "../../api/types";
import { initialBatchForm, type BatchFormState } from "./form";
import { WorkflowLibraryEditor } from "./WorkflowLibraryEditor";

describe("WorkflowLibraryEditor", () => {
  it("ignores an A-B-A stale Workflow response", async () => {
    const stale = deferred<WorkflowsResponse>();
    let firstProjectLoads = 0;
    const api = makeApi({
      listWorkflows: vi.fn((projectId: string) => {
        if (projectId === "project-a") {
          firstProjectLoads += 1;
          return firstProjectLoads === 1 ? stale.promise : Promise.resolve({ workflows: [workflow("workflow-fresh", "Fresh")] });
        }
        return Promise.resolve({ workflows: [workflow("workflow-b", "Project B")] });
      }),
    });
    const view = renderEditor(api, "project-a");
    view.rerender(editor(api, "project-b"));
    expect(await screen.findByRole("option", { name: "Project B" })).toBeInTheDocument();
    view.rerender(editor(api, "project-a"));
    expect(await screen.findByRole("option", { name: "Fresh" })).toBeInTheDocument();
    await act(async () => stale.resolve({ workflows: [workflow("workflow-stale", "Stale")] }));
    expect(screen.queryByRole("option", { name: "Stale" })).not.toBeInTheDocument();
  });

  it("ignores an A-B-A stale Workflow import mutation", async () => {
    const stale = deferred<CreateWorkflowResponse>();
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [] })),
      createWorkflow: vi.fn(() => stale.promise),
    });
    const onChange = vi.fn();
    const form = initialBatchForm();
    const view = render(<WorkflowLibraryEditor api={api} projectId="project-a" form={form} onChange={onChange} onMetadataChange={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "Import Workflow" }));
    const dialog = screen.getByRole("dialog", { name: "Import Workflow" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Stale import" } });
    fireEvent.change(within(dialog).getByLabelText("Workflow JSON"), { target: { value: '{"node":"stale"}' } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Import Workflow" }));
    await waitFor(() => expect(api.createWorkflow).toHaveBeenCalledOnce());

    view.rerender(<WorkflowLibraryEditor api={api} projectId="project-b" form={form} onChange={onChange} onMetadataChange={() => undefined} />);
    view.rerender(<WorkflowLibraryEditor api={api} projectId="project-a" form={form} onChange={onChange} onMetadataChange={() => undefined} />);
    const createdVersion = workflowVersion({ workflow: { node: "stale" } });
    await act(async () => stale.resolve({
      workflow: { id: "workflow-stale", project_id: "project-a", name: "Stale import", description: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", archived_at: null },
      version: createdVersion,
    }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("option", { name: "Stale import" })).not.toBeInTheDocument();
  });

  it("selects only a ProfileVersion targeting the exact WorkflowVersion", async () => {
    const v1 = workflowVersion({ id: "workflow-v1", version_number: 1 });
    const v2 = workflowVersion({ id: "workflow-v2", version_number: 2, workflow: { node: "two" } });
    const compatible = profileVersion({ id: "profile-v1", workflow_version_id: v1.id, profile: workflowProfileSnapshot({ prompt: "v1" }) });
    const incompatibleLatest = profileVersion({ id: "profile-v2", workflow_version_id: v2.id, version_number: 2, profile: workflowProfileSnapshot({ prompt: "v2" }) });
    const profile = workflowProfile("profile-1", "Mapping", compatible);
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [workflow("workflow-1", "Portrait", v1)] })),
      listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [v2, v1] })),
      listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [profile] })),
      listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [incompatibleLatest, compatible] })),
    });
    let current = initialBatchForm();
    current.linkedParameterSets = [{
      setKey: "stale_preset",
      setLabel: "Stale preset",
      members: [
        { parameterKey: "width", valueType: "integer" },
        { parameterKey: "height", valueType: "integer" },
      ],
      rows: [{ rowLabel: "", values: { width: { kind: "base" }, height: { kind: "base" } } }],
    }];
    const view = render(<WorkflowLibraryEditor api={api} projectId="project-a" form={current} onChange={(form) => { current = form; view.rerender(component()); }} onMetadataChange={() => undefined} />);
    function component() { return <WorkflowLibraryEditor api={api} projectId="project-a" form={current} onChange={(form) => { current = form; view.rerender(component()); }} onMetadataChange={() => undefined} />; }

    fireEvent.change(await screen.findByRole("combobox", { name: "Workflow" }), { target: { value: "workflow-1" } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Workflow Profile" })).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "Workflow Profile" }), { target: { value: "profile-1" } });

    expect(current.workflowVersionId).toBe("workflow-v1");
    expect(current.workflowProfileVersionId).toBe("profile-v1");
    expect(current.linkedParameterSets).toEqual([]);
    expect(JSON.parse(current.workflowJson)).toEqual({ node: "one" });
    expect(JSON.parse(current.workflowProfileJson)).toEqual(workflowProfileSnapshot({ prompt: "v1" }));
  });

  it("keeps the logical Profile selected when a new WorkflowVersion has no compatible version", async () => {
    const first = workflowVersion();
    const next = workflowVersion({ id: "workflow-v2", version_number: 2, workflow: { node: "changed" } });
    const source = profileVersion({ profile: visualProfileSnapshot() });
    const logicalProfile = workflowProfile("profile-1", "Mapping", source);
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [workflow("workflow-1", "Portrait", first)] })),
      listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [first, next] })),
      listWorkflowProfiles: vi.fn(async (_workflowId, workflowVersionId) => ({
        workflow_profiles: [workflowProfile(
          logicalProfile.id,
          logicalProfile.name,
          workflowVersionId === first.id ? source : null,
        )],
      })),
      listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [source] })),
      getWorkflowVersion: vi.fn(async () => first),
      getWorkflowProfileVersion: vi.fn(async () => source),
      createWorkflowVersion: vi.fn(async () => next),
    });
    let current = linkedForm(first, source);
    current.imageBindings = [
      { slot_key: "style", values: [null, "asset-style-b", "asset-style-a"] },
      { slot_key: "pose", values: ["asset-pose-b", "asset-pose-a"] },
    ];
    const onChange = vi.fn((form: BatchFormState) => { current = form; view.rerender(rendered()); });
    const rendered = () => <WorkflowLibraryEditor api={api} projectId="project-a" form={current} onChange={onChange} onMetadataChange={() => undefined} />;
    const view = render(rendered());
    await waitFor(() => expect(api.listWorkflowProfileVersions).toHaveBeenCalled());
    const section = screen.getByRole("group", { name: "Workflow and Profile" });
    const change = await within(section).findByRole("button", { name: "Change" });
    expect(section).toHaveTextContent("Portrait · Workflow v1");
    expect(section).toHaveTextContent("Mapping · Profile v1");
    expect(change).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(change);
    fireEvent.click(screen.getByRole("button", { name: "New WorkflowVersion" }));
    fireEvent.change(screen.getByLabelText("Workflow JSON", { selector: "textarea.json-editor" }), { target: { value: '{"node":"changed"}' } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "New WorkflowVersion" })).getByRole("button", { name: "New WorkflowVersion" }));

    await waitFor(() => expect(api.createWorkflowVersion).toHaveBeenCalled());
    expect(current.workflowVersionId).toBe("workflow-v2");
    expect(current.workflowProfileId).toBe(logicalProfile.id);
    expect(current.workflowProfileVersionId).toBeNull();
    expect(current.workflowProfileJson).toBe("{}");
    expect(current.imageBindings).toEqual([
      { slot_key: "style", values: [null, "asset-style-b", "asset-style-a"] },
      { slot_key: "pose", values: ["asset-pose-b", "asset-pose-a"] },
    ]);
    expect(screen.getByText("Profile required")).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Mapping (no compatible version)" })).toBeInTheDocument();
    expect(screen.getByTestId("no-compatible-profile-version")).toHaveTextContent(
      "No compatible ProfileVersion exists for WorkflowVersion v2.",
    );
  });

  it("restores the existing compatible ProfileVersion when switching back", async () => {
    const v1 = workflowVersion();
    const v2 = workflowVersion({ id: "workflow-v2", version_number: 2 });
    const profile = profileVersion();
    const logicalProfile = workflowProfile("profile-1", "Mapping", profile);
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [workflow("workflow-1", "Portrait", v2)] })),
      listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [v1, v2] })),
      listWorkflowProfiles: vi.fn(async (_workflowId, workflowVersionId) => ({
        workflow_profiles: [workflowProfile(
          logicalProfile.id,
          logicalProfile.name,
          workflowVersionId === v1.id ? profile : null,
        )],
      })),
      listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [profile] })),
      getWorkflowVersion: vi.fn(async () => v1),
      getWorkflowProfileVersion: vi.fn(async () => profile),
    });
    let current = linkedForm(v1, profile);
    const view = render(rendered());
    function rendered() {
      return <WorkflowLibraryEditor api={api} projectId="project-a" form={current} onChange={(form) => { current = form; view.rerender(rendered()); }} onMetadataChange={() => undefined} />;
    }

    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Workflow version" })).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "Workflow version" }), { target: { value: v2.id } });
    expect(current.workflowProfileVersionId).toBeNull();
    expect(current.workflowProfileId).toBe(logicalProfile.id);
    expect(current.workflowProfileJson).toBe("{}");
    await waitFor(() => expect(api.listWorkflowProfiles).toHaveBeenLastCalledWith("workflow-1", v2.id, expect.any(AbortSignal)));
    expect(await screen.findByRole("option", { name: "Mapping (no compatible version)" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Workflow version" }), { target: { value: v1.id } });
    expect(current.workflowProfileVersionId).toBe(profile.id);
    expect(JSON.parse(current.workflowProfileJson)).toEqual(profile.profile);
  });

  it("copies the latest active mappings into a new version under the same logical Profile", async () => {
    const v1 = workflowVersion({ workflow: visualWorkflow() });
    const v2 = workflowVersion({ id: "workflow-v2", version_number: 2, workflow: visualWorkflow() });
    const source = profileVersion({ profile: visualProfileSnapshot() });
    const created = profileVersion({
      id: "profile-v2",
      workflow_version_id: v2.id,
      version_number: 2,
      profile: visualProfileSnapshot(),
    });
    const logicalProfile = workflowProfile("profile-1", "Mapping", null);
    const createProfile = vi.fn();
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [workflow("workflow-1", "Portrait", v2)] })),
      listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [v1, v2] })),
      listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [logicalProfile] })),
      listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [source] })),
      createWorkflowProfile: createProfile,
      createWorkflowProfileVersion: vi.fn(async () => created),
    });
    let current = selectProfileForm(v2, logicalProfile);
    const view = render(rendered());
    function rendered() {
      return <WorkflowLibraryEditor api={api} projectId="project-a" form={current} onChange={(form) => { current = form; view.rerender(rendered()); }} onMetadataChange={() => undefined} />;
    }

    fireEvent.click(await screen.findByRole("button", { name: "Review mappings for this Workflow version" }));
    const dialog = await screen.findByRole("dialog", { name: "New ProfileVersion" });
    expect(within(dialog).getByLabelText("Prompt node")).toHaveValue("34");
    expect(within(dialog).getByLabelText("Image Input 1 label")).toHaveValue("Style image");
    expect(within(dialog).getByLabelText("Image Input 2 label")).toHaveValue("Pose image");
    expect(api.createWorkflowProfileVersion).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "New ProfileVersion" }));
    await waitFor(() => expect(api.createWorkflowProfileVersion).toHaveBeenCalledWith(
      logicalProfile.id,
      {
        workflow_version_id: v2.id,
        mappings: visualProfileSnapshot().mappings,
        image_inputs: visualProfileSnapshot().image_inputs,
        parameters: visualProfileSnapshot().parameters,
        note: null,
      },
    ));

    expect(createProfile).not.toHaveBeenCalled();
    expect(current.workflowProfileId).toBe(logicalProfile.id);
    expect(current.workflowProfileVersionId).toBe(created.id);
    expect(JSON.parse(current.workflowProfileJson)).toEqual(created.profile);
  });

  it("opens a prepopulated repair editor when copied mappings are incompatible", async () => {
    const v2 = workflowVersion({ id: "workflow-v2", version_number: 2, workflow: visualWorkflow("35") });
    const source = profileVersion({ profile: visualProfileSnapshot("34") });
    const repaired = profileVersion({
      id: "profile-v2",
      workflow_version_id: v2.id,
      version_number: 2,
      profile: visualProfileSnapshot("35"),
    });
    const logicalProfile = workflowProfile("profile-1", "Mapping", null);
    const createVersion = vi.fn(async () => repaired);
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [workflow("workflow-1", "Portrait", v2)] })),
      listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [v2] })),
      listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [logicalProfile] })),
      listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [source] })),
      createWorkflowProfileVersion: createVersion,
    });
    let current = selectProfileForm(v2, logicalProfile);
    const view = render(rendered());
    function rendered() {
      return <WorkflowLibraryEditor api={api} projectId="project-a" form={current} onChange={(form) => { current = form; view.rerender(rendered()); }} onMetadataChange={() => undefined} />;
    }

    fireEvent.click(await screen.findByRole("button", { name: "Review mappings for this Workflow version" }));
    const dialog = await screen.findByRole("dialog", { name: "New ProfileVersion" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Node 34 is missing from this WorkflowVersion.");
    expect(within(dialog).getByLabelText("Seed node")).toHaveValue("7");
    fireEvent.change(within(dialog).getByLabelText("Prompt node"), { target: { value: "35" } });
    fireEvent.change(within(dialog).getByLabelText("Prompt input"), { target: { value: "text" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "New ProfileVersion" }));

    await waitFor(() => expect(createVersion).toHaveBeenLastCalledWith(
      logicalProfile.id,
      {
        workflow_version_id: v2.id,
        mappings: visualProfileSnapshot("35").mappings,
        image_inputs: visualProfileSnapshot("35").image_inputs,
        parameters: visualProfileSnapshot("35").parameters,
        note: null,
      },
    ));
    expect(current.workflowProfileVersionId).toBe(repaired.id);
  });

  it("renames a logical Workflow as metadata without changing either snapshot", async () => {
    const version = workflowVersion();
    const logical = workflow("workflow-1", "Portrait", version);
    const form = { ...initialBatchForm(), workflowLibraryProjectId: "project-a", workflowId: logical.id, workflowName: logical.name, workflowVersionId: version.id, workflowVersionNumber: version.version_number, workflowJson: '{"node":"local formatting"}', workflowProfileJson: '{"mapping":"unchanged"}' };
    const renamed = { ...logical, name: "Renamed portrait", updated_at: "2026-02-01T00:00:00Z" };
    const metadataChange = vi.fn();
    const onChange = vi.fn();
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [logical] })),
      updateWorkflow: vi.fn(async () => renamed),
    });
    render(<WorkflowLibraryEditor api={api} projectId="project-a" form={form} onChange={onChange} onMetadataChange={metadataChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename Workflow" }));
    const dialog = screen.getByRole("dialog", { name: "Rename Workflow" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Renamed portrait" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename Workflow" }));

    await waitFor(() => expect(metadataChange).toHaveBeenCalled());
    const updated = metadataChange.mock.calls.at(-1)?.[0] as BatchFormState;
    expect(updated.workflowName).toBe("Renamed portrait");
    expect(updated.workflowJson).toBe(form.workflowJson);
    expect(updated.workflowProfileJson).toBe(form.workflowProfileJson);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("preserves exact snapshots when the library reports an integrity conflict", async () => {
    const storedWorkflow = workflowVersion({ workflow: { node: "library" } });
    const storedProfile = profileVersion({ profile: workflowProfileSnapshot({ prompt: "library" }) });
    const form = linkedForm(storedWorkflow, storedProfile);
    form.workflowJson = '{ "node": "local" }';
    form.workflowProfileJson = '{ "prompt": "local" }';
    const metadataChange = vi.fn();
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [workflow("workflow-1", "Portrait", storedWorkflow)] })),
      listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [storedWorkflow] })),
      listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [workflowProfile("profile-1", "Mapping", storedProfile)] })),
      listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [storedProfile] })),
      getWorkflowVersion: vi.fn(async () => storedWorkflow),
      getWorkflowProfileVersion: vi.fn(async () => storedProfile),
    });
    render(<WorkflowLibraryEditor api={api} projectId="project-a" form={form} onChange={() => undefined} onMetadataChange={metadataChange} />);

    expect(await screen.findByText("Integrity conflict")).toBeInTheDocument();
    expect(screen.getByLabelText("Workflow JSON")).toHaveValue('{ "node": "local" }');
    expect(screen.getByLabelText("Workflow Profile JSON")).toHaveValue('{ "prompt": "local" }');
    expect(metadataChange).not.toHaveBeenCalled();
  });
});

function renderEditor(api: BatchcraftApi, projectId: string) {
  return render(editor(api, projectId));
}

function editor(api: BatchcraftApi, projectId: string) {
  return <WorkflowLibraryEditor api={api} projectId={projectId} form={initialBatchForm()} onChange={() => undefined} onMetadataChange={() => undefined} />;
}

function linkedForm(version: LibraryWorkflowVersion, profile: LibraryWorkflowProfileVersion): BatchFormState {
  return { ...initialBatchForm(), workflowLibraryProjectId: "project-a", workflowId: "workflow-1", workflowName: "Portrait", workflowVersionId: version.id, workflowVersionNumber: version.version_number, workflowJson: JSON.stringify(version.workflow), workflowProfileId: "profile-1", workflowProfileName: "Mapping", workflowProfileVersionId: profile.id, workflowProfileVersionNumber: profile.version_number, workflowProfileWorkflowVersionId: profile.workflow_version_id, workflowProfileJson: JSON.stringify(profile.profile) };
}

function selectProfileForm(
  version: LibraryWorkflowVersion,
  profile: ProjectWorkflowProfile,
): BatchFormState {
  return {
    ...initialBatchForm(),
    workflowLibraryProjectId: "project-a",
    workflowId: version.workflow_id,
    workflowName: "Portrait",
    workflowVersionId: version.id,
    workflowVersionNumber: version.version_number,
    workflowJson: JSON.stringify(version.workflow),
    workflowProfileId: profile.id,
    workflowProfileName: profile.name,
    workflowProfileJson: "{}",
  };
}

function workflow(id: string, name: string, latest = workflowVersion({ workflow_id: id })): ProjectWorkflow {
  return { id, project_id: "project-a", name, description: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", archived_at: null, latest_active_version: latest };
}

function workflowVersion(overrides: Partial<LibraryWorkflowVersion> = {}): LibraryWorkflowVersion {
  return { id: "workflow-v1", workflow_id: "workflow-1", project_id: "project-a", version_number: 1, name_snapshot: "Portrait", workflow: { node: "one" }, content_sha256: "sha", note: null, created_at: "2026-01-01T00:00:00Z", archived_at: null, ...overrides };
}

function workflowProfile(id: string, name: string, latest: LibraryWorkflowProfileVersion | null): ProjectWorkflowProfile {
  return { id, workflow_id: "workflow-1", project_id: "project-a", name, description: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", archived_at: null, latest_compatible_version: latest };
}

function profileVersion(overrides: Partial<LibraryWorkflowProfileVersion> = {}): LibraryWorkflowProfileVersion {
  return { id: "profile-v1", workflow_profile_id: "profile-1", workflow_id: "workflow-1", project_id: "project-a", workflow_version_id: "workflow-v1", version_number: 1, name_snapshot: "Mapping", profile: workflowProfileSnapshot({ prompt: "v1" }), content_sha256: "sha", note: null, created_at: "2026-01-01T00:00:00Z", archived_at: null, ...overrides };
}

function workflowProfileSnapshot(mappings: Record<string, unknown>) {
  return { id: "profile-1", name: "Mapping", mappings, image_inputs: [], parameters: [] };
}

function visualWorkflow(promptNodeId = "34") {
  return {
    "7": { class_type: "KSampler", inputs: { model: ["2", 0], seed: 1 } },
    "25": { class_type: "LoadImage", inputs: { image: "style.png" } },
    "26": { class_type: "LoadImage", inputs: { image: "pose.png" } },
    [promptNodeId]: { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: "base prompt" } },
    "41": { class_type: "SaveImage", inputs: { filename_prefix: "output", images: ["8", 0] } },
  };
}

function visualProfileSnapshot(promptNodeId = "34") {
  return {
    ...workflowProfileSnapshot({
      prompt: { node_id: promptNodeId, input_name: "text", value_type: "string" },
      seed: { node_id: "7", input_name: "seed", value_type: "integer" },
      output_prefix: { node_id: "41", input_name: "filename_prefix", value_type: "string" },
    }),
    image_inputs: [
      { key: "style", label: "Style image", node_id: "25", input_name: "image" },
      { key: "pose", label: "Pose image", node_id: "26", input_name: "image" },
    ],
  };
}

function makeApi(overrides: Partial<BatchcraftApi> = {}): BatchcraftApi {
  return {
    listWorkflows: vi.fn(async () => ({ workflows: [] })),
    listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [] })),
    listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [] })),
    listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [] })),
    getWorkflowVersion: vi.fn(async () => workflowVersion()),
    getWorkflowProfileVersion: vi.fn(async () => profileVersion()),
    ...overrides,
  } as BatchcraftApi;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
