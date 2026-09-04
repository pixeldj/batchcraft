import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BatchcraftApi } from "../../api/client";
import type { CreateWorkflowResponse, LibraryWorkflowProfileVersion, LibraryWorkflowVersion, ProjectWorkflow, ProjectWorkflowProfile, Workflow, WorkflowProfile, WorkflowsResponse } from "../../api/types";
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

    fireEvent.click(await screen.findByRole("button", { name: "New Workflow" }));
    const dialog = screen.getByRole("dialog", { name: "New Workflow" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Stale import" } });
    fireEvent.change(within(dialog).getByLabelText("Workflow JSON"), { target: { value: '{"node":"stale"}' } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Workflow" }));
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
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Profile" })).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "Profile" }), { target: { value: "profile-1" } });

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
    const section = screen.getByRole("group", { name: "Workflow Setup" });
    const change = await within(section).findByRole("button", { name: "Change" });
    expect(section).toHaveTextContent("Portrait");
    expect(section).toHaveTextContent("Mapping");
    expect(section).toHaveTextContent("v1 / v1");
    expect(change).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(change);
    fireEvent.click(screen.getByRole("button", { name: "Edit Workflow" }));
    fireEvent.change(screen.getByLabelText("Workflow JSON", { selector: "textarea.json-editor" }), { target: { value: '{"node":"changed"}' } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Edit Workflow" })).getByRole("button", { name: "Save Workflow" }));

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
    expect(await screen.findByRole("option", { name: "Mapping (needs review)" })).toBeInTheDocument();
    expect(screen.getByTestId("no-compatible-profile-version")).toHaveTextContent(
      "This Profile needs a compatible revision for Workflow v2.",
    );
    const repair = screen.getByRole("dialog", { name: "Edit Profile" });
    expect(repair).toHaveTextContent(
      "Workflow v2 was saved. Review the copied mappings before saving the next Profile revision.",
    );
    expect(within(repair).getByLabelText("Image Input 1 label")).toHaveValue("Style image");
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
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Workflow revision" })).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "Workflow revision" }), { target: { value: v2.id } });
    expect(current.workflowProfileVersionId).toBeNull();
    expect(current.workflowProfileId).toBe(logicalProfile.id);
    expect(current.workflowProfileJson).toBe("{}");
    await waitFor(() => expect(api.listWorkflowProfiles).toHaveBeenLastCalledWith("workflow-1", v2.id, expect.any(AbortSignal)));
    expect(await screen.findByRole("option", { name: "Mapping (needs review)" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Workflow revision" }), { target: { value: v1.id } });
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

    fireEvent.click(await screen.findByRole("button", { name: "Review Profile mappings" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Profile" });
    expect(within(dialog).getByLabelText("Prompt node")).toHaveValue("34");
    expect(within(dialog).getByLabelText("Image Input 1 label")).toHaveValue("Style image");
    expect(within(dialog).getByLabelText("Image Input 2 label")).toHaveValue("Pose image");
    expect(api.createWorkflowProfileVersion).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Profile" }));
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

    fireEvent.click(await screen.findByRole("button", { name: "Review Profile mappings" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Profile" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Node 34 is missing from this WorkflowVersion.");
    expect(within(dialog).getByLabelText("Seed node")).toHaveValue("7");
    fireEvent.change(within(dialog).getByLabelText("Prompt node"), { target: { value: "35" } });
    fireEvent.change(within(dialog).getByLabelText("Prompt input"), { target: { value: "text" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Profile" }));

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

  it("prefills a collision-safe Profile name and allows an override", async () => {
    const workflowV1 = workflowVersion({ workflow: visualWorkflow() });
    const selectedProfileV1 = profileVersion({ profile: visualProfileSnapshot() });
    const selected = workflowProfile("profile-1", "Mapping", selectedProfileV1);
    const collisions = [
      workflowProfile("profile-2", "Portrait-profile", null),
      workflowProfile("profile-3", "Portrait-profile-2", null),
    ];
    const createdVersion = profileVersion({
      id: "profile-v1-new",
      workflow_profile_id: "profile-new",
      profile: { ...visualProfileSnapshot(), id: "profile-new", name: "Custom Profile" },
    });
    const createProfile = vi.fn(async () => ({
      workflow_profile: {
        ...workflowProfile("profile-new", "Custom Profile", createdVersion),
        latest_compatible_version: undefined,
      },
      version: createdVersion,
    }));
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [workflow("workflow-1", "Portrait", workflowV1)] })),
      listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [workflowV1] })),
      listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [selected, ...collisions] })),
      listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [selectedProfileV1] })),
      getWorkflowVersion: vi.fn(async () => workflowV1),
      getWorkflowProfileVersion: vi.fn(async () => selectedProfileV1),
      createWorkflowProfile: createProfile,
    });
    let current = linkedForm(workflowV1, selectedProfileV1);
    const view = render(rendered());
    function rendered() {
      return <WorkflowLibraryEditor api={api} projectId="project-a" form={current} onChange={(form) => { current = form; view.rerender(rendered()); }} onMetadataChange={() => undefined} />;
    }

    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: "New Profile" }));
    const dialog = screen.getByRole("dialog", { name: "New Profile" });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Portrait-profile-3");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Custom Profile" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Profile" }));

    await waitFor(() => expect(createProfile).toHaveBeenCalledWith("workflow-1", expect.objectContaining({
      name: "Custom Profile",
      workflow_version_id: workflowV1.id,
    })));
    expect(current.workflowProfileId).toBe("profile-new");
    expect(current.workflowProfileVersionId).toBe("profile-v1-new");
  });

  it("opens the selected compatible Profile for editing when requested from Parameters", async () => {
    const workflowV1 = workflowVersion();
    const profileV1 = profileVersion({ profile: visualProfileSnapshot() });
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [workflow("workflow-1", "Portrait", workflowV1)] })),
      listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [workflowV1] })),
      listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [workflowProfile("profile-1", "Mapping", profileV1)] })),
      listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [profileV1] })),
      getWorkflowVersion: vi.fn(async () => workflowV1),
      getWorkflowProfileVersion: vi.fn(async () => profileV1),
    });

    render(<WorkflowLibraryEditor
      api={api}
      projectId="project-a"
      form={linkedForm(workflowV1, profileV1)}
      profileEditorRequest={1}
      onChange={() => undefined}
      onMetadataChange={() => undefined}
    />);

    expect(await screen.findByRole("dialog", { name: "Edit Profile" })).toBeInTheDocument();
  });

  it("waits for Profile history before editing a selected Profile that needs a compatible revision", async () => {
    const workflowV2 = workflowVersion({ id: "workflow-v2", version_number: 2 });
    const sourceProfile = profileVersion({ workflow_version_id: "workflow-v1", profile: visualProfileSnapshot() });
    const form = {
      ...workflowOnlyForm(workflowV2),
      workflowProfileId: "profile-1",
      workflowProfileName: "Mapping",
    };
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [workflow("workflow-1", "Portrait", workflowV2)] })),
      listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [workflowV2] })),
      listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [workflowProfile("profile-1", "Mapping", null)] })),
      listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [sourceProfile] })),
    });

    render(<WorkflowLibraryEditor
      api={api}
      projectId="project-a"
      form={form}
      profileEditorRequest={1}
      onChange={() => undefined}
      onMetadataChange={() => undefined}
    />);

    const dialog = await screen.findByRole("dialog", { name: "Edit Profile" });
    expect(within(dialog).getByLabelText("Prompt node")).toHaveValue("34");
  });

  it("opens a new Profile when the selected Workflow has none", async () => {
    const workflowV1 = workflowVersion();
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [workflow("workflow-1", "Portrait", workflowV1)] })),
      listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [workflowV1] })),
      listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [] })),
    });

    render(<WorkflowLibraryEditor
      api={api}
      projectId="project-a"
      form={workflowOnlyForm(workflowV1)}
      profileEditorRequest={1}
      onChange={() => undefined}
      onMetadataChange={() => undefined}
    />);

    expect(await screen.findByRole("dialog", { name: "New Profile" })).toBeInTheDocument();
  });

  it("focuses the Profile chooser when Profiles exist but none is selected", async () => {
    const workflowV1 = workflowVersion();
    const profileV1 = profileVersion();
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [workflow("workflow-1", "Portrait", workflowV1)] })),
      listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [workflowV1] })),
      listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [workflowProfile("profile-1", "Mapping", profileV1)] })),
    });

    render(<WorkflowLibraryEditor
      api={api}
      projectId="project-a"
      form={workflowOnlyForm(workflowV1)}
      profileEditorRequest={1}
      onChange={() => undefined}
      onMetadataChange={() => undefined}
    />);

    const profileSelect = await screen.findByRole("combobox", { name: "Profile" });
    await waitFor(() => expect(profileSelect).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: /Profile/ })).not.toBeInTheDocument();
  });

  it("duplicates the exact selected Workflow revision and copies the current Profile into new v1 histories", async () => {
    const selectedWorkflowVersion = workflowVersion({
      id: "workflow-v2",
      version_number: 2,
      workflow: visualWorkflow(),
    });
    const latestWorkflowVersion = workflowVersion({
      id: "workflow-v4",
      version_number: 4,
      workflow: { latest: true },
    });
    const selectedProfileVersion = profileVersion({
      id: "profile-v3",
      version_number: 3,
      workflow_version_id: selectedWorkflowVersion.id,
      profile: visualProfileSnapshot(),
    });
    const duplicateVersion = workflowVersion({
      id: "workflow-copy-v1",
      workflow_id: "workflow-copy",
      version_number: 1,
      name_snapshot: "Custom copy",
      workflow: visualWorkflow(),
      content_sha256: "workflow-copy-sha",
    });
    const duplicateProfileVersion = profileVersion({
      id: "profile-copy-v1",
      workflow_profile_id: "profile-copy",
      workflow_id: "workflow-copy",
      workflow_version_id: duplicateVersion.id,
      version_number: 1,
      name_snapshot: "Custom mapping",
      profile: { ...visualProfileSnapshot(), id: "profile-copy", name: "Custom mapping" },
      content_sha256: "profile-copy-sha",
    });
    const duplicateWorkflow = workflow("workflow-copy", "Custom copy", duplicateVersion);
    const createWorkflow = vi.fn(async () => ({
      workflow: withoutLatest(duplicateWorkflow),
      version: duplicateVersion,
    }));
    const createProfile = vi.fn(async () => ({
      workflow_profile: withoutLatest(workflowProfile("profile-copy", "Custom mapping", duplicateProfileVersion)),
      version: duplicateProfileVersion,
    }));
    const sourceWorkflow = workflow("workflow-1", "Portrait", latestWorkflowVersion);
    const sourceProfile = workflowProfile("profile-1", "Mapping", selectedProfileVersion);
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({
        workflows: [sourceWorkflow, workflow("workflow-existing-copy", "Portrait copy")],
      })),
      listWorkflowVersions: vi.fn(async (workflowId) => ({
        workflow_versions: workflowId === "workflow-copy"
          ? [duplicateVersion]
          : [latestWorkflowVersion, selectedWorkflowVersion],
      })),
      listWorkflowProfiles: vi.fn(async (workflowId) => ({
        workflow_profiles: workflowId === "workflow-copy"
          ? [workflowProfile("profile-copy", "Custom mapping", duplicateProfileVersion)]
          : [sourceProfile],
      })),
      listWorkflowProfileVersions: vi.fn(async (profileId) => ({
        workflow_profile_versions: profileId === "profile-copy"
          ? [duplicateProfileVersion]
          : [selectedProfileVersion],
      })),
      getWorkflowVersion: vi.fn(async (versionId) => versionId === duplicateVersion.id ? duplicateVersion : selectedWorkflowVersion),
      getWorkflowProfileVersion: vi.fn(async (versionId) => versionId === duplicateProfileVersion.id ? duplicateProfileVersion : selectedProfileVersion),
      createWorkflow,
      createWorkflowProfile: createProfile,
    });
    let current = linkedForm(selectedWorkflowVersion, selectedProfileVersion);
    current.workflowJson = '{"stale":"editable workflow snapshot"}';
    current.workflowProfileJson = '{"stale":"editable profile snapshot"}';
    const view = render(rendered());
    function rendered() {
      return <WorkflowLibraryEditor api={api} projectId="project-a" form={current} onChange={(form) => { current = form; view.rerender(rendered()); }} onMetadataChange={() => undefined} />;
    }

    fireEvent.click(await screen.findByRole("button", { name: "Duplicate Workflow" }));
    const dialog = screen.getByRole("dialog", { name: "Duplicate Workflow" });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Portrait copy 2");
    expect(within(dialog).getByLabelText("Copy current Profile mappings")).toBeChecked();
    expect(within(dialog).getByLabelText("Copied Profile name")).toHaveValue("Portrait copy 2-profile");
    expect(JSON.parse((within(dialog).getByLabelText("Workflow JSON") as HTMLTextAreaElement).value)).toEqual(visualWorkflow());
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Custom copy" } });
    expect(within(dialog).getByLabelText("Copied Profile name")).toHaveValue("Custom copy-profile");
    fireEvent.change(within(dialog).getByLabelText("Copied Profile name"), { target: { value: "Custom mapping" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate Workflow" }));

    await waitFor(() => expect(createWorkflow).toHaveBeenCalledWith("project-a", {
      name: "Custom copy",
      workflow: visualWorkflow(),
      note: null,
    }));
    expect(createProfile).toHaveBeenCalledWith("workflow-copy", {
      name: "Custom mapping",
      workflow_version_id: "workflow-copy-v1",
      mappings: visualProfileSnapshot().mappings,
      image_inputs: visualProfileSnapshot().image_inputs,
      parameters: visualProfileSnapshot().parameters,
      note: null,
    });
    expect(current).toMatchObject({
      workflowId: "workflow-copy",
      workflowVersionId: "workflow-copy-v1",
      workflowVersionNumber: 1,
      workflowProfileId: "profile-copy",
      workflowProfileVersionId: "profile-copy-v1",
      workflowProfileVersionNumber: 1,
    });
    expect(createWorkflow).toHaveBeenCalledOnce();
    expect(createProfile).toHaveBeenCalledOnce();
  });

  it("preserves a duplicated Workflow and opens Profile repair when optional mapping copy fails", async () => {
    const sourceWorkflowVersion = workflowVersion({ workflow: visualWorkflow() });
    const sourceProfileVersion = profileVersion({ profile: visualProfileSnapshot() });
    const duplicateVersion = workflowVersion({
      id: "workflow-copy-v1",
      workflow_id: "workflow-copy",
      version_number: 1,
      name_snapshot: "Portrait copy",
      workflow: visualWorkflow(),
    });
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [workflow("workflow-1", "Portrait", sourceWorkflowVersion)] })),
      listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [sourceWorkflowVersion] })),
      listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [workflowProfile("profile-1", "Mapping", sourceProfileVersion)] })),
      listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [sourceProfileVersion] })),
      getWorkflowVersion: vi.fn(async () => sourceWorkflowVersion),
      getWorkflowProfileVersion: vi.fn(async () => sourceProfileVersion),
      createWorkflow: vi.fn(async () => ({
        workflow: withoutLatest(workflow("workflow-copy", "Portrait copy", duplicateVersion)),
        version: duplicateVersion,
      })),
      createWorkflowProfile: vi.fn(async () => { throw new Error("Mapping target is invalid"); }),
    });
    let current = linkedForm(sourceWorkflowVersion, sourceProfileVersion);
    const view = render(rendered());
    function rendered() {
      return <WorkflowLibraryEditor api={api} projectId="project-a" form={current} onChange={(form) => { current = form; view.rerender(rendered()); }} onMetadataChange={() => undefined} />;
    }

    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Workflow" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Duplicate Workflow" })).getByRole("button", { name: "Duplicate Workflow" }));

    const repair = await screen.findByRole("dialog", { name: "New Profile" });
    expect(within(repair).getByRole("status")).toHaveTextContent(
      "Portrait copy v1 was created. Review or repair the copied Profile mappings.",
    );
    expect(within(repair).getByRole("alert")).toHaveTextContent("Mapping target is invalid");
    expect(within(repair).getByLabelText("Prompt node")).toHaveValue("34");
    expect(current.workflowId).toBe("workflow-copy");
    expect(current.workflowVersionId).toBe("workflow-copy-v1");
    expect(current.workflowProfileId).toBeNull();
  });

  it("keeps exact older Saved Batch revisions selected while showing quiet current context", async () => {
    const selectedWorkflowVersion = workflowVersion({ id: "workflow-v3", version_number: 3 });
    const currentWorkflowVersion = workflowVersion({ id: "workflow-v5", version_number: 5 });
    const selectedProfileVersion = profileVersion({
      id: "profile-v2",
      version_number: 2,
      workflow_version_id: selectedWorkflowVersion.id,
    });
    const currentProfileVersion = profileVersion({
      id: "profile-v4",
      version_number: 4,
      workflow_version_id: selectedWorkflowVersion.id,
    });
    const onChange = vi.fn();
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [workflow("workflow-1", "Portrait", currentWorkflowVersion)] })),
      listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [currentWorkflowVersion, selectedWorkflowVersion] })),
      listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [workflowProfile("profile-1", "Mapping", currentProfileVersion)] })),
      listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [currentProfileVersion, selectedProfileVersion] })),
      getWorkflowVersion: vi.fn(async () => selectedWorkflowVersion),
      getWorkflowProfileVersion: vi.fn(async () => selectedProfileVersion),
    });
    render(<WorkflowLibraryEditor api={api} projectId="project-a" form={linkedForm(selectedWorkflowVersion, selectedProfileVersion)} onChange={onChange} onMetadataChange={() => undefined} />);

    const section = screen.getByRole("group", { name: "Workflow Setup" });
    expect(await within(section).findByText("v3 / v2")).toBeInTheDocument();
    fireEvent.click(await within(section).findByRole("button", { name: "Change" }));
    expect(await within(section).findByText(
      "Exact saved setup retained. Workflow v5 is current. Compatible Profile v4 is current.",
    )).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Workflow revision" })).toHaveValue("workflow-v3");
    expect(screen.getByRole("combobox", { name: "Profile revision" })).toHaveValue("profile-v2");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "New WorkflowVersion" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New ProfileVersion" })).not.toBeInTheDocument();
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

  it("does not relink an authoritative historical ownership conflict by matching content", async () => {
    const storedWorkflow = workflowVersion();
    const storedProfile = profileVersion();
    const form = linkedForm(storedWorkflow, storedProfile);
    form.workflowLibraryProjectId = null;
    form.historicalWorkflowVersionId = storedWorkflow.id;
    form.historicalWorkflowResourceStatus = "conflict";
    form.historicalWorkflowResourceReason = "WorkflowVersion ownership conflict.";
    form.historicalProfileVersionId = storedProfile.id;
    form.historicalProfileResourceStatus = "linked";
    const metadataChange = vi.fn();
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [workflow("workflow-1", "Portrait", storedWorkflow)] })),
      listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [storedWorkflow] })),
      listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [workflowProfile("profile-1", "Mapping", storedProfile)] })),
      listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [storedProfile] })),
      getWorkflowVersion: vi.fn(async () => storedWorkflow),
      getWorkflowProfileVersion: vi.fn(async () => storedProfile),
    });

    render(<WorkflowLibraryEditor api={api} projectId="project-a" form={form} sourceRunId="run-1" onChange={() => undefined} onMetadataChange={metadataChange} />);

    expect(await screen.findByText("Integrity conflict")).toBeInTheDocument();
    expect(api.getWorkflowVersion).not.toHaveBeenCalled();
    expect(api.getWorkflowProfileVersion).not.toHaveBeenCalled();
    expect(metadataChange).not.toHaveBeenCalled();
  });

  it("rechecks integrity when frozen JSON changes under the same version IDs", async () => {
    const storedWorkflow = workflowVersion();
    const storedProfile = profileVersion();
    const original = linkedForm(storedWorkflow, storedProfile);
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [workflow("workflow-1", "Portrait", storedWorkflow)] })),
      listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [storedWorkflow] })),
      listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [workflowProfile("profile-1", "Mapping", storedProfile)] })),
      listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [storedProfile] })),
      getWorkflowVersion: vi.fn(async () => storedWorkflow),
      getWorkflowProfileVersion: vi.fn(async () => storedProfile),
    });
    const view = render(<WorkflowLibraryEditor api={api} projectId="project-a" form={original} onChange={() => undefined} onMetadataChange={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    expect(await screen.findByText("Library linked")).toBeInTheDocument();

    view.rerender(<WorkflowLibraryEditor api={api} projectId="project-a" form={{ ...original, workflowJson: '{"node":"changed"}' }} onChange={() => undefined} onMetadataChange={() => undefined} />);

    expect(await screen.findByText("Integrity conflict")).toBeInTheDocument();
    expect(api.getWorkflowVersion).toHaveBeenCalledTimes(2);
  });

  it("keeps missing historical rows detached without clearing IDs or checking forever", async () => {
    const storedWorkflow = workflowVersion();
    const storedProfile = profileVersion();
    const form = linkedForm(storedWorkflow, storedProfile);
    const metadataChange = vi.fn();
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [] })),
      getWorkflowVersion: vi.fn(async () => storedWorkflow),
      getWorkflowProfileVersion: vi.fn(async () => storedProfile),
    });
    render(<WorkflowLibraryEditor api={api} projectId="project-a" form={form} onChange={vi.fn()} onMetadataChange={metadataChange} />);

    expect(await screen.findByText("Detached snapshots")).toBeInTheDocument();
    expect(screen.queryByText("Checking library linkage")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Workflow JSON")).toHaveValue(JSON.stringify(storedWorkflow.workflow));
    expect(screen.getByLabelText("Workflow Profile JSON")).toHaveValue(JSON.stringify(storedProfile.profile));
    expect(metadataChange).not.toHaveBeenCalled();
  });

  it("retries only the Profile after a partial historical snapshot import", async () => {
    const form = linkedForm(workflowVersion(), profileVersion());
    form.workflowLibraryProjectId = null;
    form.imageBindings = [{ slot_key: "style", values: [null, "asset-a"] }];
    form.parameterBindings = [{
      parameterKey: "steps",
      valueType: "integer",
      mode: "range",
      alternatives: [{ kind: "base" }],
      range: { start: "1.0", end: "3.0", step: "1.0", includeBase: true },
    }];
    form.linkedParameterSets = [];
    const createdWorkflowVersion = workflowVersion({
      id: "imported-workflow-v1",
      workflow_id: "imported-workflow",
      content_sha256: "imported-workflow-sha",
    });
    const createdWorkflow = workflow("imported-workflow", "Portrait", createdWorkflowVersion);
    const workflowResponse = {
      workflow: {
        id: createdWorkflow.id,
        project_id: createdWorkflow.project_id,
        name: createdWorkflow.name,
        description: createdWorkflow.description,
        created_at: createdWorkflow.created_at,
        updated_at: createdWorkflow.updated_at,
        archived_at: createdWorkflow.archived_at,
      },
      version: createdWorkflowVersion,
    };
    const createdProfileVersion = profileVersion({
      id: "imported-profile-v1",
      workflow_profile_id: "imported-profile",
      workflow_id: "imported-workflow",
      workflow_version_id: createdWorkflowVersion.id,
      content_sha256: "imported-profile-sha",
    });
    const createdProfile = workflowProfile("imported-profile", "Mapping", createdProfileVersion);
    const profileResponse = {
      workflow_profile: {
        id: createdProfile.id,
        workflow_id: createdProfile.workflow_id,
        project_id: createdProfile.project_id,
        name: createdProfile.name,
        description: createdProfile.description,
        created_at: createdProfile.created_at,
        updated_at: createdProfile.updated_at,
        archived_at: createdProfile.archived_at,
      },
      version: createdProfileVersion,
    };
    const importProfile = vi.fn<BatchcraftApi["importRunWorkflowProfileVersion"]>()
      .mockRejectedValueOnce(new Error("Profile write failed"))
      .mockResolvedValueOnce(profileResponse);
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: [] })),
      importRunWorkflowVersion: vi.fn(async () => workflowResponse),
      importRunWorkflowProfileVersion: importProfile,
    });
    const onHistoricalImport = vi.fn();
    render(
      <WorkflowLibraryEditor
        api={api}
        projectId="project-a"
        form={form}
        sourceRunId="run-1"
        onChange={vi.fn()}
        onHistoricalImport={onHistoricalImport}
        onMetadataChange={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Import historical snapshots" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Workflow snapshot was imported, but the Profile snapshot was not.",
    );
    expect(onHistoricalImport).toHaveBeenCalledOnce();
    expect(onHistoricalImport.mock.calls[0][0]).toMatchObject({
      historicalImportCopyResolutions: {
        workflowVersion: {
          historicalVersionId: "workflow-v1",
          copiedVersionId: "imported-workflow-v1",
        },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry Profile snapshot import" }));

    await waitFor(() => expect(onHistoricalImport).toHaveBeenCalledTimes(2));
    expect(api.importRunWorkflowVersion).toHaveBeenCalledOnce();
    expect(api.importRunWorkflowVersion).toHaveBeenCalledWith("run-1", {
      import_request_id: "workflow:workflow-v1",
      name: "Portrait",
      description: null,
      note: null,
    });
    expect(importProfile).toHaveBeenCalledTimes(2);
    expect(importProfile).toHaveBeenLastCalledWith("run-1", {
      import_request_id: "workflow-profile:profile-v1",
      name: "Mapping",
      description: null,
      note: null,
      workflow_version_id: "imported-workflow-v1",
    });
    const updated = onHistoricalImport.mock.calls[1][0] as BatchFormState;
    expect(updated).toMatchObject({
      workflowLibraryProjectId: "project-a",
      workflowId: "imported-workflow",
      workflowVersionId: "imported-workflow-v1",
      workflowContentSha256: "imported-workflow-sha",
      workflowProfileId: "imported-profile",
      workflowProfileVersionId: "imported-profile-v1",
      workflowProfileWorkflowVersionId: "imported-workflow-v1",
      workflowProfileContentSha256: "imported-profile-sha",
      imageBindings: form.imageBindings,
      parameterBindings: form.parameterBindings,
      linkedParameterSets: form.linkedParameterSets,
    });
    expect(JSON.parse(updated.workflowJson)).toEqual(createdWorkflowVersion.workflow);
    expect(JSON.parse(updated.workflowProfileJson)).toEqual(createdProfileVersion.profile);
  });

  it("resumes a Profile import after remount without copying the Workflow again", async () => {
    const form = detachedHistoricalForm();
    const workflowResponse = importedWorkflowResponse();
    const copiedWorkflow: ProjectWorkflow = {
      ...workflowResponse.workflow,
      latest_active_version: workflowResponse.version,
    };
    const importProfile = vi.fn<BatchcraftApi["importRunWorkflowProfileVersion"]>()
      .mockRejectedValueOnce(new Error("Profile write failed"))
      .mockResolvedValueOnce(importedProfileResponse());
    let workflowAvailable = false;
    const api = makeApi({
      listWorkflows: vi.fn(async () => ({ workflows: workflowAvailable ? [copiedWorkflow] : [] })),
      getWorkflowVersion: vi.fn(async () => workflowResponse.version),
      importRunWorkflowVersion: vi.fn(async () => {
        workflowAvailable = true;
        return workflowResponse;
      }),
      importRunWorkflowProfileVersion: importProfile,
    });
    let progress = form;
    const first = render(
      <WorkflowLibraryEditor
        api={api}
        projectId="project-a"
        form={form}
        sourceRunId="run-1"
        onChange={vi.fn()}
        onHistoricalImport={(updated) => { progress = updated; }}
        onMetadataChange={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Import historical snapshots" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Profile snapshot was not");
    first.unmount();

    const onHistoricalImport = vi.fn();
    render(
      <WorkflowLibraryEditor
        api={api}
        projectId="project-a"
        form={progress}
        sourceRunId="run-1"
        onChange={vi.fn()}
        onHistoricalImport={onHistoricalImport}
        onMetadataChange={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Retry Profile snapshot import" }));

    await waitFor(() => expect(onHistoricalImport).toHaveBeenCalledOnce());
    expect(api.importRunWorkflowVersion).toHaveBeenCalledOnce();
    expect(importProfile).toHaveBeenCalledTimes(2);
    expect(onHistoricalImport.mock.calls[0][0]).toMatchObject({
      workflowVersionId: "imported-workflow-v1",
      workflowProfileVersionId: "imported-profile-v1",
      historicalImportCopyResolutions: {
        workflowVersion: {
          historicalVersionId: "workflow-v1",
          copiedVersionId: "imported-workflow-v1",
        },
        workflowProfileVersion: {
          historicalVersionId: "profile-v1",
          copiedVersionId: "imported-profile-v1",
        },
      },
    });
  });

  it("ignores a historical import completion after the ProfileVersion changes", async () => {
    const pending = deferred<Awaited<ReturnType<BatchcraftApi["importRunWorkflowProfileVersion"]>>>();
    const form = detachedHistoricalForm();
    const api = makeApi({
      importRunWorkflowVersion: vi.fn(async () => importedWorkflowResponse()),
      importRunWorkflowProfileVersion: vi.fn(() => pending.promise),
    });
    const onHistoricalImport = vi.fn();
    const view = render(<WorkflowLibraryEditor api={api} projectId="project-a" form={form} sourceRunId="run-1" onChange={vi.fn()} onHistoricalImport={onHistoricalImport} onMetadataChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Import historical snapshots" }));
    await waitFor(() => expect(api.importRunWorkflowProfileVersion).toHaveBeenCalled());

    view.rerender(<WorkflowLibraryEditor api={api} projectId="project-a" form={{ ...form, workflowProfileVersionId: "profile-v2" }} sourceRunId="run-1" onChange={vi.fn()} onHistoricalImport={onHistoricalImport} onMetadataChange={vi.fn()} />);
    await act(async () => pending.resolve(importedProfileResponse()));

    expect(onHistoricalImport).toHaveBeenCalledOnce();
  });

  it("ignores a historical import completion after same-version snapshot content reloads", async () => {
    const pending = deferred<Awaited<ReturnType<BatchcraftApi["importRunWorkflowProfileVersion"]>>>();
    const form = detachedHistoricalForm();
    const api = makeApi({
      importRunWorkflowVersion: vi.fn(async () => importedWorkflowResponse()),
      importRunWorkflowProfileVersion: vi.fn(() => pending.promise),
    });
    const onHistoricalImport = vi.fn();
    const view = render(<WorkflowLibraryEditor api={api} projectId="project-a" form={form} sourceRunId="run-1" onChange={vi.fn()} onHistoricalImport={onHistoricalImport} onMetadataChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Import historical snapshots" }));
    await waitFor(() => expect(api.importRunWorkflowProfileVersion).toHaveBeenCalled());

    view.rerender(<WorkflowLibraryEditor api={api} projectId="project-a" form={{ ...form, workflowJson: '{"node":"reloaded"}' }} sourceRunId="run-1" onChange={vi.fn()} onHistoricalImport={onHistoricalImport} onMetadataChange={vi.fn()} />);
    await act(async () => pending.resolve(importedProfileResponse()));

    expect(onHistoricalImport).toHaveBeenCalledOnce();
  });
});

function detachedHistoricalForm(): BatchFormState {
  const form = linkedForm(workflowVersion(), profileVersion());
  return {
    ...form,
    workflowLibraryProjectId: null,
    historicalWorkflowVersionId: form.workflowVersionId,
    historicalWorkflowResourceStatus: "detached",
    historicalProfileVersionId: form.workflowProfileVersionId,
    historicalProfileResourceStatus: "detached",
  };
}

function importedWorkflowResponse(): CreateWorkflowResponse {
  const version = workflowVersion({ id: "imported-workflow-v1", workflow_id: "imported-workflow" });
  return {
    workflow: {
      id: "imported-workflow", project_id: "project-a", name: "Workflow",
      description: null, created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z", archived_at: null,
    },
    version,
  };
}

function importedProfileResponse(): Awaited<ReturnType<BatchcraftApi["importRunWorkflowProfileVersion"]>> {
  const version = profileVersion({
    id: "imported-profile-v1",
    workflow_profile_id: "imported-profile",
    workflow_id: "imported-workflow",
    workflow_version_id: "imported-workflow-v1",
  });
  return {
    workflow_profile: {
      id: "imported-profile", workflow_id: "imported-workflow", project_id: "project-a",
      name: "Profile", description: null, created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z", archived_at: null,
    },
    version,
  };
}

function renderEditor(api: BatchcraftApi, projectId: string) {
  return render(editor(api, projectId));
}

function editor(api: BatchcraftApi, projectId: string) {
  return <WorkflowLibraryEditor api={api} projectId={projectId} form={initialBatchForm()} onChange={() => undefined} onMetadataChange={() => undefined} />;
}

function linkedForm(version: LibraryWorkflowVersion, profile: LibraryWorkflowProfileVersion): BatchFormState {
  return { ...initialBatchForm(), workflowLibraryProjectId: "project-a", workflowId: "workflow-1", workflowName: "Portrait", workflowVersionId: version.id, workflowVersionNumber: version.version_number, workflowJson: JSON.stringify(version.workflow), workflowProfileId: "profile-1", workflowProfileName: "Mapping", workflowProfileVersionId: profile.id, workflowProfileVersionNumber: profile.version_number, workflowProfileWorkflowVersionId: profile.workflow_version_id, workflowProfileJson: JSON.stringify(profile.profile) };
}

function workflowOnlyForm(version: LibraryWorkflowVersion): BatchFormState {
  return {
    ...initialBatchForm(),
    workflowLibraryProjectId: "project-a",
    workflowId: version.workflow_id,
    workflowName: "Portrait",
    workflowVersionId: version.id,
    workflowVersionNumber: version.version_number,
    workflowJson: JSON.stringify(version.workflow),
  };
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

function withoutLatest(value: ProjectWorkflow): Workflow;
function withoutLatest(value: ProjectWorkflowProfile): WorkflowProfile;
function withoutLatest(value: ProjectWorkflow | ProjectWorkflowProfile): Workflow | WorkflowProfile {
  if ("latest_active_version" in value) {
    const { latest_active_version, ...workflowRecord } = value;
    void latest_active_version;
    return workflowRecord;
  }
  const { latest_compatible_version, ...profileRecord } = value;
  void latest_compatible_version;
  return profileRecord;
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
