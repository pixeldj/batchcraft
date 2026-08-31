import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";

import { ApiError, type BatchcraftApi } from "../../api/client";
import type {
  JsonObject,
  LibraryWorkflowProfileVersion,
  LibraryWorkflowVersion,
  ProjectWorkflow,
  ProjectWorkflowProfile,
} from "../../api/types";
import { errorMessage } from "../../utils/errors";
import { ConfigurationSection } from "./ConfigurationSection";
import type { BatchFormState } from "./form";

interface Props {
  api: BatchcraftApi;
  projectId: string;
  form: BatchFormState;
  onChange(form: BatchFormState): void;
  onMetadataChange(form: BatchFormState): void;
}

type DialogKind = "import" | "workflow-version" | "profile" | "profile-version" | "rename-workflow" | "rename-profile" | "raw";

interface DialogState {
  kind: DialogKind;
  name: string;
  workflowJson: string;
  profileJson: string;
  note: string;
  saving: boolean;
  error: string | null;
}

interface LibraryState {
  projectId: string;
  workflows: ProjectWorkflow[];
  loading: boolean;
  error: string | null;
}

interface DetailState {
  workflowId: string;
  versions: LibraryWorkflowVersion[];
  profiles: ProjectWorkflowProfile[];
  profileVersions: Record<string, LibraryWorkflowProfileVersion[]>;
  loading: boolean;
  error: string | null;
}

type LinkStatus = "linked" | "detached" | "incomplete" | "checking" | "integrity";

const EMPTY_DETAIL: DetailState = {
  workflowId: "",
  versions: [],
  profiles: [],
  profileVersions: {},
  loading: false,
  error: null,
};

export function WorkflowLibraryEditor({ api, projectId, form, onChange, onMetadataChange }: Props) {
  const [library, setLibrary] = useState<LibraryState>({ projectId: "", workflows: [], loading: false, error: null });
  const [detail, setDetail] = useState<DetailState>(EMPTY_DETAIL);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [linkStatus, setLinkStatus] = useState<LinkStatus>(linkedStatus(form));
  const [copyingProfileVersion, setCopyingProfileVersion] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const loadTag = useRef(0);
  const detailTag = useRef(0);
  const integrityTag = useRef(0);
  const mutationContext = useRef({ key: "", tag: 0 });
  const formRef = useRef(form);
  const currentForm = useEffectEvent(() => form);
  const metadataChange = useEffectEvent(onMetadataChange);
  const normalizedProjectId = projectId.trim();
  formRef.current = form;
  const mutationKey = [normalizedProjectId, form.workflowId, form.workflowVersionId, form.workflowProfileId].join("\0");
  if (mutationContext.current.key !== mutationKey) {
    mutationContext.current = { key: mutationKey, tag: mutationContext.current.tag + 1 };
  }

  const activeLibrary = library.projectId === normalizedProjectId
    ? library
    : { projectId: normalizedProjectId, workflows: [], loading: Boolean(normalizedProjectId), error: null };
  const selectedWorkflow = activeLibrary.workflows.find((workflow) => workflow.id === form.workflowId) ?? null;
  const activeDetail = detail.workflowId === form.workflowId ? detail : EMPTY_DETAIL;
  const selectedVersion = activeDetail.versions.find((version) => version.id === form.workflowVersionId) ?? null;
  const selectedProfile = activeDetail.profiles.find((profile) => profile.id === form.workflowProfileId) ?? null;
  const profileVersions = form.workflowProfileId ? activeDetail.profileVersions[form.workflowProfileId] ?? [] : [];
  const compatibleProfileVersion = latestProfileVersion(
    profileVersions.filter(activeProfileVersionFor(form.workflowVersionId)),
  );
  const sourceProfileVersion = latestProfileVersion(
    profileVersions.filter((version) => !version.archived_at),
  ) ?? latestProfileVersion(profileVersions);
  const collapsible = linkStatus === "linked"
    && Boolean(
      form.workflowId
      && form.workflowVersionId
      && form.workflowProfileId
      && form.workflowProfileVersionId,
    )
    && !activeLibrary.loading
    && !activeLibrary.error
    && !activeDetail.loading
    && !activeDetail.error;

  useEffect(() => {
    const requestedProjectId = normalizedProjectId;
    const tag = ++loadTag.current;
    const controller = new AbortController();
    setDialog(null);
    setCopyingProfileVersion(false);
    setDetail(EMPTY_DETAIL);
    setLinkStatus(linkedStatus(currentForm()));
    if (!requestedProjectId) {
      setLibrary({ projectId: "", workflows: [], loading: false, error: null });
      return () => controller.abort();
    }
    setLibrary({ projectId: requestedProjectId, workflows: [], loading: true, error: null });
    void api.listWorkflows(requestedProjectId, controller.signal).then(
      (response) => {
        if (tag !== loadTag.current || controller.signal.aborted) return;
        setLibrary({ projectId: requestedProjectId, workflows: response.workflows, loading: false, error: null });
      },
      (caught: unknown) => {
        if (tag !== loadTag.current || isAbort(caught)) return;
        setLibrary({ projectId: requestedProjectId, workflows: [], loading: false, error: errorMessage(caught) });
      },
    );
    return () => controller.abort();
  }, [api, loadAttempt, normalizedProjectId]);

  useEffect(() => {
    const workflowId = form.workflowId;
    const workflowVersionId = form.workflowVersionId;
    if (!workflowId || !normalizedProjectId) {
      setDetail(EMPTY_DETAIL);
      return;
    }
    const tag = ++detailTag.current;
    const controller = new AbortController();
    setDetail((current) => current.workflowId === workflowId
      ? { ...current, loading: true, error: null }
      : { ...EMPTY_DETAIL, workflowId, loading: true });
    void Promise.all([
      api.listWorkflowVersions(workflowId, true, controller.signal),
      api.listWorkflowProfiles(workflowId, workflowVersionId ?? undefined, controller.signal),
    ]).then(([versionResponse, profileResponse]) => {
      if (tag !== detailTag.current || controller.signal.aborted) return;
      setDetail({
        workflowId,
        versions: versionResponse.workflow_versions,
        profiles: profileResponse.workflow_profiles,
        profileVersions: Object.fromEntries(
          profileResponse.workflow_profiles.flatMap((profile) =>
            profile.latest_compatible_version
              ? [[profile.id, [profile.latest_compatible_version]]]
              : [],
          ),
        ),
        loading: false,
        error: null,
      });
    }).catch((caught: unknown) => {
      if (tag !== detailTag.current || isAbort(caught)) return;
      setDetail({ ...EMPTY_DETAIL, workflowId, error: errorMessage(caught) });
    });
    return () => controller.abort();
  }, [api, form.workflowId, form.workflowVersionId, normalizedProjectId]);

  useEffect(() => {
    const profileId = form.workflowProfileId;
    if (!profileId || detail.workflowId !== form.workflowId || detail.loading) return;
    const tag = detailTag.current;
    const controller = new AbortController();
    void api.listWorkflowProfileVersions(profileId, true, controller.signal).then(
      (response) => {
        if (tag !== detailTag.current || controller.signal.aborted) return;
        setDetail((current) => current.workflowId === form.workflowId
          ? {
            ...current,
            profileVersions: {
              ...current.profileVersions,
              [profileId]: response.workflow_profile_versions,
            },
          }
          : current);
      },
      (caught: unknown) => {
        if (tag !== detailTag.current || isAbort(caught)) return;
        setDetail((current) => current.workflowId === form.workflowId
          ? { ...current, error: errorMessage(caught) }
          : current);
      },
    );
    return () => controller.abort();
  }, [api, detail.loading, detail.workflowId, form.workflowId, form.workflowProfileId]);

  useEffect(() => {
    const snapshot = currentForm();
    const workflowVersionId = snapshot.workflowVersionId;
    const profileVersionId = snapshot.workflowProfileVersionId;
    if (!normalizedProjectId || !workflowVersionId || !profileVersionId) {
      setLinkStatus(linkedStatus(snapshot));
      return;
    }
    if (activeLibrary.loading || activeLibrary.error || activeDetail.workflowId !== snapshot.workflowId || activeDetail.loading || activeDetail.error) {
      return;
    }
    const tag = ++integrityTag.current;
    const controller = new AbortController();
    setLinkStatus("checking");
    void Promise.all([
      api.getWorkflowVersion(workflowVersionId, controller.signal),
      api.getWorkflowProfileVersion(profileVersionId, controller.signal),
    ]).then(([workflowVersion, profileVersion]) => {
      if (tag !== integrityTag.current || controller.signal.aborted) return;
      const latestForm = currentForm();
      const exact = objectsEqual(workflowVersion.workflow, parseObjectOrNull(latestForm.workflowJson))
        && objectsEqual(profileVersion.profile, parseObjectOrNull(latestForm.workflowProfileJson));
      const coherent = workflowVersion.id === latestForm.workflowVersionId
        && profileVersion.id === latestForm.workflowProfileVersionId
        && workflowVersion.project_id === normalizedProjectId
        && profileVersion.project_id === normalizedProjectId
        && workflowVersion.workflow_id === latestForm.workflowId
        && profileVersion.workflow_id === latestForm.workflowId
        && profileVersion.workflow_profile_id === latestForm.workflowProfileId
        && profileVersion.workflow_version_id === workflowVersion.id;
      if (!exact || !coherent) {
        setLinkStatus("integrity");
        return;
      }
      const workflow = activeLibrary.workflows.find((item) => item.id === workflowVersion.workflow_id);
      const profile = activeDetail.profiles.find((item) => item.id === profileVersion.workflow_profile_id);
      if (!workflow || !profile || workflow.archived_at || profile.archived_at || workflowVersion.archived_at || profileVersion.archived_at) {
        metadataChange(detach(latestForm));
        setLinkStatus("detached");
        return;
      }
      metadataChange({
        ...latestForm,
        workflowLibraryProjectId: normalizedProjectId,
        workflowId: workflow.id,
        workflowName: workflow.name,
        workflowVersionNumber: workflowVersion.version_number,
        workflowContentSha256: workflowVersion.content_sha256,
        workflowProfileId: profile.id,
        workflowProfileName: profile.name,
        workflowProfileVersionNumber: profileVersion.version_number,
        workflowProfileWorkflowVersionId: profileVersion.workflow_version_id,
        workflowProfileContentSha256: profileVersion.content_sha256,
      });
      setLinkStatus("linked");
    }).catch((caught: unknown) => {
      if (tag !== integrityTag.current || isAbort(caught)) return;
      if (caught instanceof ApiError && (caught.code === "workflow_version_not_found" || caught.code === "workflow_profile_version_not_found")) {
        metadataChange(detach(currentForm()));
      }
      setLinkStatus("detached");
    });
    return () => controller.abort();
  }, [activeDetail.error, activeDetail.loading, activeDetail.profiles, activeDetail.workflowId, activeLibrary.error, activeLibrary.loading, activeLibrary.workflows, api, form.workflowProfileVersionId, form.workflowVersionId, normalizedProjectId]);

  function chooseWorkflow(workflowId: string) {
    const workflow = activeLibrary.workflows.find((item) => item.id === workflowId);
    const version = workflow?.latest_active_version;
    if (!workflow || !version) return;
    onChange({
      ...clearProfileSelectionAndSnapshot(detach(form)),
      workflowLibraryProjectId: normalizedProjectId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      workflowVersionId: version.id,
      workflowVersionNumber: version.version_number,
      workflowContentSha256: version.content_sha256,
      workflowJson: pretty(version.workflow),
    });
  }

  function chooseWorkflowVersion(versionId: string) {
    const version = activeDetail.versions.find((item) => item.id === versionId && !item.archived_at);
    if (!version) return;
    const workflowSelection = {
      ...form,
      workflowVersionId: version.id,
      workflowVersionNumber: version.version_number,
      workflowContentSha256: version.content_sha256,
      workflowJson: pretty(version.workflow),
    };
    const profile = activeDetail.profiles.find((item) => item.id === form.workflowProfileId);
    if (!profile) {
      onChange(clearProfileSelectionAndSnapshot(workflowSelection));
      return;
    }
    const compatible = latestProfileVersion(
      (activeDetail.profileVersions[profile.id] ?? []).filter(
        activeProfileVersionFor(version.id),
      ),
    );
    onChange(
      compatible
        ? applyProfile(workflowSelection, profile, compatible)
        : selectProfileWithoutVersion(workflowSelection, profile),
    );
  }

  function chooseProfile(profileId: string) {
    const profile = activeDetail.profiles.find((item) => item.id === profileId);
    if (!profile) return;
    const version = latestProfileVersion(
      (activeDetail.profileVersions[profileId] ?? []).filter(
        activeProfileVersionFor(form.workflowVersionId),
      ),
    );
    onChange(
      version
        ? applyProfile(form, profile, version)
        : selectProfileWithoutVersion(form, profile),
    );
  }

  function chooseProfileVersion(versionId: string) {
    const version = (activeDetail.profileVersions[form.workflowProfileId ?? ""] ?? [])
      .find((item) => item.id === versionId && !item.archived_at && item.workflow_version_id === form.workflowVersionId);
    if (!version || !selectedProfile) return;
    onChange(applyProfile(form, selectedProfile, version));
  }

  function openDialog(kind: DialogKind) {
    const copiedProfileJson = kind === "profile-version" && !form.workflowProfileVersionId
      ? sourceProfileVersion?.profile
      : null;
    setDialog({
      kind,
      name: kind === "rename-workflow" ? form.workflowName : kind === "rename-profile" ? form.workflowProfileName : "",
      workflowJson: form.workflowJson,
      profileJson: copiedProfileJson ? pretty(copiedProfileJson) : form.workflowProfileJson,
      note: "",
      saving: false,
      error: null,
    });
  }

  async function createProfileVersionFromSource() {
    if (
      copyingProfileVersion ||
      !selectedProfile ||
      !sourceProfileVersion ||
      !form.workflowVersionId
    ) return;
    const requestedMutationTag = mutationContext.current.tag;
    setCopyingProfileVersion(true);
    try {
      const version = await api.createWorkflowProfileVersion(selectedProfile.id, {
        workflow_version_id: form.workflowVersionId,
        mappings: profileMappings(sourceProfileVersion.profile),
      });
      if (mutationContext.current.tag !== requestedMutationTag) return;
      setDetail((current) => ({
        ...current,
        profiles: current.profiles.map((profile) => profile.id === selectedProfile.id
          ? { ...profile, latest_compatible_version: version }
          : profile),
        profileVersions: {
          ...current.profileVersions,
          [selectedProfile.id]: [
            version,
            ...(current.profileVersions[selectedProfile.id] ?? []),
          ],
        },
      }));
      onChange(applyProfile(formRef.current, selectedProfile, version));
    } catch (caught) {
      if (mutationContext.current.tag !== requestedMutationTag) return;
      setDialog({
        kind: "profile-version",
        name: "",
        workflowJson: formRef.current.workflowJson,
        profileJson: pretty(sourceProfileVersion.profile),
        note: "",
        saving: false,
        error: errorMessage(caught),
      });
    } finally {
      if (mutationContext.current.tag === requestedMutationTag) {
        setCopyingProfileVersion(false);
      }
    }
  }

  async function submitDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog || dialog.saving) return;
    setDialog({ ...dialog, saving: true, error: null });
    const requestedProjectId = normalizedProjectId;
    const requestedMutationTag = mutationContext.current.tag;
    const contextIsCurrent = () => mutationContext.current.tag === requestedMutationTag;
    try {
      if (dialog.kind === "import") {
        const workflowObject = parseRequiredObject(dialog.workflowJson, "Workflow");
        const created = await api.createWorkflow(requestedProjectId, { name: dialog.name, workflow: workflowObject, note: nullable(dialog.note) });
        if (!contextIsCurrent()) return;
        const workflow: ProjectWorkflow = { ...created.workflow, latest_active_version: created.version };
        setLibrary((current) => current.projectId === requestedProjectId ? { ...current, workflows: [...current.workflows, workflow] } : current);
        onChange({ ...clearProfileSelectionAndSnapshot(detach(formRef.current)), workflowLibraryProjectId: requestedProjectId, workflowId: workflow.id, workflowName: workflow.name, workflowVersionId: created.version.id, workflowVersionNumber: created.version.version_number, workflowContentSha256: created.version.content_sha256, workflowJson: pretty(created.version.workflow) });
      } else if (dialog.kind === "workflow-version" && form.workflowId) {
        const workflowObject = parseRequiredObject(dialog.workflowJson, "Workflow");
        const version = await api.createWorkflowVersion(form.workflowId, { workflow: workflowObject, note: nullable(dialog.note) });
        if (!contextIsCurrent()) return;
        setDetail((current) => current.workflowId === form.workflowId ? { ...current, versions: [version, ...current.versions] } : current);
        const latestForm = formRef.current;
        const workflowSelection = {
          ...latestForm,
          workflowVersionId: version.id,
          workflowVersionNumber: version.version_number,
          workflowContentSha256: version.content_sha256,
          workflowJson: pretty(version.workflow),
        };
        const profile = activeDetail.profiles.find(
          (item) => item.id === latestForm.workflowProfileId,
        );
        onChange(
          profile
            ? selectProfileWithoutVersion(workflowSelection, profile)
            : clearProfileSelectionAndSnapshot(workflowSelection),
        );
      } else if (dialog.kind === "profile" && form.workflowId && form.workflowVersionId) {
        const mappings = parseProfileMappings(dialog.profileJson);
        const created = await api.createWorkflowProfile(form.workflowId, { name: dialog.name, workflow_version_id: form.workflowVersionId, mappings, note: nullable(dialog.note) });
        if (!contextIsCurrent()) return;
        const profile: ProjectWorkflowProfile = { ...created.workflow_profile, latest_compatible_version: created.version };
        setDetail((current) => current.workflowId === form.workflowId ? { ...current, profiles: [...current.profiles, profile], profileVersions: { ...current.profileVersions, [profile.id]: [created.version] } } : current);
        onChange(applyProfile(formRef.current, profile, created.version));
      } else if (dialog.kind === "profile-version" && form.workflowProfileId && form.workflowVersionId && selectedProfile) {
        const mappings = parseProfileMappings(dialog.profileJson);
        const version = await api.createWorkflowProfileVersion(form.workflowProfileId, { workflow_version_id: form.workflowVersionId, mappings, note: nullable(dialog.note) });
        if (!contextIsCurrent()) return;
        setDetail((current) => ({
          ...current,
          profiles: current.profiles.map((profile) => profile.id === form.workflowProfileId
            ? { ...profile, latest_compatible_version: version }
            : profile),
          profileVersions: { ...current.profileVersions, [form.workflowProfileId as string]: [version, ...(current.profileVersions[form.workflowProfileId as string] ?? [])] },
        }));
        onChange(applyProfile(formRef.current, selectedProfile, version));
      } else if (dialog.kind === "rename-workflow" && form.workflowId) {
        const updated = await api.updateWorkflow(form.workflowId, { name: dialog.name });
        if (!contextIsCurrent()) return;
        setLibrary((current) => ({ ...current, workflows: current.workflows.map((item) => item.id === updated.id ? { ...item, name: updated.name, updated_at: updated.updated_at } : item) }));
        onMetadataChange({ ...formRef.current, workflowName: updated.name });
      } else if (dialog.kind === "rename-profile" && form.workflowProfileId) {
        const updated = await api.updateWorkflowProfile(form.workflowProfileId, { name: dialog.name });
        if (!contextIsCurrent()) return;
        setDetail((current) => ({ ...current, profiles: current.profiles.map((item) => item.id === updated.id ? { ...item, name: updated.name, updated_at: updated.updated_at } : item) }));
        onMetadataChange({ ...formRef.current, workflowProfileName: updated.name });
      } else if (dialog.kind === "raw") {
        onChange({ ...detach(form), workflowJson: dialog.workflowJson, workflowProfileJson: dialog.profileJson });
      }
      setDialog(null);
    } catch (caught) {
      if (!contextIsCurrent()) return;
      setDialog((current) => current ? { ...current, saving: false, error: errorMessage(caught) } : current);
    }
  }

  return (
    <ConfigurationSection
      title="Workflow and Profile"
      summary={workflowSummary(form)}
      expanded={expanded}
      collapsible={collapsible}
      controlsId="workflow-profile-controls"
      actionLabel="Change"
      className="workflow-library"
      onExpandedChange={setExpanded}
    >
      {!normalizedProjectId ? <p className="empty-note">Select a Project to load its Workflow library.</p> : null}
      {activeLibrary.loading ? <p role="status">Loading Workflow library...</p> : null}
      {activeLibrary.error ? <div className="operation-error" role="alert"><p>{activeLibrary.error}</p><button className="button-link" type="button" onClick={() => setLoadAttempt((value) => value + 1)}>Retry</button></div> : null}
      {!activeLibrary.loading && !activeLibrary.error && normalizedProjectId && activeLibrary.workflows.length === 0 ? (
        <div className="workflow-empty"><p className="empty-note">This Project has no active Workflows.</p><button className="button-primary" type="button" onClick={() => openDialog("import")}>Import Workflow</button></div>
      ) : null}
      {activeLibrary.workflows.length > 0 ? (
        <div className="workflow-library-grid">
          <label className="field"><span className="field-label">Workflow</span><select aria-label="Workflow" value={selectedWorkflow?.id ?? ""} onChange={(event) => chooseWorkflow(event.target.value)}><option value="">Choose a Workflow</option>{activeLibrary.workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select></label>
          <label className="field"><span className="field-label">Workflow version</span><select aria-label="Workflow version" value={selectedVersion?.id ?? form.workflowVersionId ?? ""} disabled={!form.workflowId || activeDetail.loading} onChange={(event) => chooseWorkflowVersion(event.target.value)}><option value="">Choose a version</option>{activeDetail.versions.map((version) => <option key={version.id} value={version.id} disabled={Boolean(version.archived_at)}>v{version.version_number}{version.archived_at ? " (archived)" : ""}</option>)}</select></label>
          <label className="field"><span className="field-label">Workflow Profile</span><select aria-label="Workflow Profile" value={selectedProfile?.id ?? ""} disabled={!form.workflowVersionId || activeDetail.loading} onChange={(event) => chooseProfile(event.target.value)}><option value="">Choose a Profile</option>{activeDetail.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.latest_compatible_version ? "" : " (no compatible version)"}</option>)}</select></label>
          <label className="field"><span className="field-label">Profile version</span><select aria-label="Profile version" value={form.workflowProfileVersionId ?? ""} disabled={!form.workflowProfileId} onChange={(event) => chooseProfileVersion(event.target.value)}><option value="">Choose a version</option>{profileVersions.map((version) => <option key={version.id} value={version.id} disabled={Boolean(version.archived_at) || version.workflow_version_id !== form.workflowVersionId}>v{version.version_number}{version.workflow_version_id !== form.workflowVersionId ? " (different WorkflowVersion)" : version.archived_at ? " (archived)" : ""}</option>)}</select></label>
        </div>
      ) : null}
      {activeDetail.loading ? <p role="status">Loading Workflow and Profile history...</p> : null}
      {activeDetail.error ? <p className="operation-error" role="alert">{activeDetail.error}</p> : null}
      {selectedProfile && !compatibleProfileVersion ? (
        <div className="workflow-empty" data-testid="no-compatible-profile-version">
          <p className="empty-note">No compatible ProfileVersion exists for WorkflowVersion v{form.workflowVersionNumber}.</p>
          {sourceProfileVersion ? (
            <button className="button-primary compact" type="button" disabled={copyingProfileVersion} onClick={() => void createProfileVersionFromSource()}>
              {copyingProfileVersion ? "Creating ProfileVersion..." : "Create version for this Workflow version"}
            </button>
          ) : <p className="empty-note">No existing ProfileVersion is available to copy.</p>}
        </div>
      ) : null}
      <div className={`workflow-link-status ${linkStatus}`}>
        <strong>{linkStatus === "linked" ? "Library linked" : linkStatus === "checking" ? "Checking library linkage" : linkStatus === "integrity" ? "Integrity conflict" : linkStatus === "incomplete" ? "Profile required" : "Detached snapshots"}</strong>
        <span>{linkStatus === "linked" ? `${form.workflowName} v${form.workflowVersionNumber} / ${form.workflowProfileName} v${form.workflowProfileVersionNumber}` : linkStatus === "integrity" ? "The stored snapshots differ from the library. Your exact snapshots are preserved." : linkStatus === "incomplete" ? "Choose a compatible ProfileVersion for the selected WorkflowVersion." : "The exact Workflow and Profile snapshots remain usable without a library link."}</span>
      </div>
      <textarea className="visually-hidden" aria-label="Workflow JSON" value={form.workflowJson} onChange={(event) => onChange({ ...detach(form), workflowJson: event.target.value, workflowProfileJson: form.workflowProfileJson })} />
      <textarea className="visually-hidden" aria-label="Workflow Profile JSON" value={form.workflowProfileJson} onChange={(event) => onChange({ ...detach(form), workflowJson: form.workflowJson, workflowProfileJson: event.target.value })} />
      <div className="repeater-actions workflow-actions">
        {activeLibrary.workflows.length > 0 ? <button className="button-secondary compact" type="button" onClick={() => openDialog("import")}>Import Workflow</button> : null}
        <button className="button-link" type="button" onClick={() => openDialog("raw")}>Edit raw snapshots</button>
        {form.workflowId ? <button className="button-link" type="button" onClick={() => openDialog("workflow-version")}>New WorkflowVersion</button> : null}
        {form.workflowId && form.workflowVersionId ? <button className="button-link" type="button" onClick={() => openDialog("profile")}>Create Profile</button> : null}
        {form.workflowProfileId && compatibleProfileVersion ? <button className="button-link" type="button" onClick={() => openDialog("profile-version")}>New ProfileVersion</button> : null}
        {form.workflowId ? <button className="button-link" type="button" onClick={() => openDialog("rename-workflow")}>Rename Workflow</button> : null}
        {form.workflowProfileId ? <button className="button-link" type="button" onClick={() => openDialog("rename-profile")}>Rename Profile</button> : null}
      </div>
      {dialog ? <WorkflowDialog state={dialog} setState={setDialog} onSubmit={submitDialog} onCancel={() => setDialog(null)} /> : null}
    </ConfigurationSection>
  );
}

function workflowSummary(form: BatchFormState) {
  if (!form.workflowId) return <span>No Workflow selected</span>;
  return (
    <div className="configuration-summary-list">
      <span>
        <strong>{form.workflowName || "Workflow"}</strong>
        {form.workflowVersionNumber === null ? " · version required" : ` · Workflow v${form.workflowVersionNumber}`}
      </span>
      <span>
        <strong>{form.workflowProfileName || "Profile required"}</strong>
        {form.workflowProfileVersionNumber === null ? " · version required" : ` · Profile v${form.workflowProfileVersionNumber}`}
      </span>
    </div>
  );
}

function WorkflowDialog({ state, setState, onSubmit, onCancel }: { state: DialogState; setState(value: DialogState): void; onSubmit(event: FormEvent<HTMLFormElement>): void; onCancel(): void }) {
  const title = ({ import: "Import Workflow", "workflow-version": "New WorkflowVersion", profile: "Create Profile", "profile-version": "New ProfileVersion", "rename-workflow": "Rename Workflow", "rename-profile": "Rename Profile", raw: "Edit raw snapshots" } satisfies Record<DialogKind, string>)[state.kind];
  const showsWorkflow = state.kind === "import" || state.kind === "workflow-version" || state.kind === "raw";
  const showsProfile = state.kind === "profile" || state.kind === "profile-version" || state.kind === "raw";
  const showsName = state.kind === "import" || state.kind === "profile" || state.kind.startsWith("rename-");
  return <dialog className="prompt-dialog" open aria-label={title}><h2>{title}</h2><form onSubmit={onSubmit}>
    {showsName ? <label className="field"><span className="field-label">Name</span><input autoFocus required value={state.name} onChange={(event) => setState({ ...state, name: event.target.value })} /></label> : null}
    {showsWorkflow ? <label className="field"><span className="field-label">Workflow JSON</span><textarea className="json-editor" spellCheck={false} value={state.workflowJson} onChange={(event) => setState({ ...state, workflowJson: event.target.value })} /></label> : null}
    {showsProfile ? <label className="field"><span className="field-label">Workflow Profile JSON</span><textarea className="json-editor" spellCheck={false} value={state.profileJson} onChange={(event) => setState({ ...state, profileJson: event.target.value })} /></label> : null}
    {state.kind !== "raw" && !state.kind.startsWith("rename-") ? <label className="field"><span className="field-label">Version note (optional)</span><textarea value={state.note} onChange={(event) => setState({ ...state, note: event.target.value })} /></label> : null}
    {state.error ? <p className="operation-error" role="alert">{state.error}</p> : null}
    <button className="button-primary" type="submit" disabled={state.saving}>{state.saving ? "Saving..." : title}</button>
  </form><button className="button-link" type="button" onClick={onCancel}>Cancel</button></dialog>;
}

function applyProfile(form: BatchFormState, profile: ProjectWorkflowProfile, version: LibraryWorkflowProfileVersion): BatchFormState {
  return { ...form, workflowProfileId: profile.id, workflowProfileName: profile.name, workflowProfileVersionId: version.id, workflowProfileVersionNumber: version.version_number, workflowProfileWorkflowVersionId: version.workflow_version_id, workflowProfileContentSha256: version.content_sha256, workflowProfileJson: pretty(version.profile) };
}

function selectProfileWithoutVersion(
  form: BatchFormState,
  profile: ProjectWorkflowProfile,
): BatchFormState {
  return {
    ...form,
    workflowProfileId: profile.id,
    workflowProfileName: profile.name,
    workflowProfileVersionId: null,
    workflowProfileVersionNumber: null,
    workflowProfileWorkflowVersionId: null,
    workflowProfileContentSha256: null,
    workflowProfileJson: "{}",
  };
}

function clearProfileLink(form: BatchFormState): BatchFormState {
  return { ...form, workflowProfileId: null, workflowProfileName: "", workflowProfileVersionId: null, workflowProfileVersionNumber: null, workflowProfileWorkflowVersionId: null, workflowProfileContentSha256: null };
}

function clearProfileSelectionAndSnapshot(form: BatchFormState): BatchFormState {
  return { ...clearProfileLink(form), workflowProfileJson: "{}" };
}

function detach(form: BatchFormState): BatchFormState {
  return { ...clearProfileLink(form), workflowLibraryProjectId: null, workflowId: null, workflowName: "", workflowVersionId: null, workflowVersionNumber: null, workflowContentSha256: null };
}

function linkedStatus(form: BatchFormState): LinkStatus {
  if (form.workflowVersionId && form.workflowProfileVersionId) return "checking";
  return form.workflowLibraryProjectId && form.workflowVersionId ? "incomplete" : "detached";
}

function activeProfileVersionFor(workflowVersionId: string | null) {
  return (version: LibraryWorkflowProfileVersion) => !version.archived_at && version.workflow_version_id === workflowVersionId;
}

function latestProfileVersion(
  versions: LibraryWorkflowProfileVersion[],
): LibraryWorkflowProfileVersion | null {
  return versions.reduce<LibraryWorkflowProfileVersion | null>(
    (latest, version) => !latest || version.version_number > latest.version_number
      ? version
      : latest,
    null,
  );
}

function parseRequiredObject(value: string, label: string): JsonObject {
  const parsed = parseObjectOrNull(value);
  if (!parsed) throw new Error(`${label} JSON must contain an object.`);
  return parsed;
}

function parseProfileMappings(value: string): JsonObject {
  const profile = parseRequiredObject(value, "Workflow Profile");
  return profileMappings(profile);
}

function profileMappings(profile: JsonObject): JsonObject {
  const mappings = profile.mappings;
  if (typeof mappings !== "object" || mappings === null || Array.isArray(mappings)) {
    throw new Error("Workflow Profile JSON must define a mappings object.");
  }
  return mappings as JsonObject;
}

function parseObjectOrNull(value: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch {
    return null;
  }
}

function objectsEqual(left: JsonObject, right: JsonObject | null): boolean {
  return right !== null && canonical(left) === canonical(right);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pretty(value: JsonObject): string {
  return JSON.stringify(value, null, 2);
}

function nullable(value: string): string | null {
  return value.trim() || null;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
