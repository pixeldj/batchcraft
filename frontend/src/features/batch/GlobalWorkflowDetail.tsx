import { useEffect, useEffectEvent, useState } from "react";
import type { LibraryApi } from "../../api/client";
import type { GlobalCatalogItem, GlobalProfile, GlobalProfileFamily, GlobalProfileVersion, GlobalWorkflowVersion, LibraryPage, GlobalWorkflowHistoryItem, GlobalProfileHistoryItem } from "../../api/types";
import { errorMessage } from "../../utils/errors";
import type { GlobalAuthoringOperation } from "./useGlobalWorkflowAuthoring";

interface Props {
  api: LibraryApi;
  id: string;
  active: boolean;
  refresh: number;
  preserveExact: boolean;
  updatedProfile?: GlobalProfile;
  showArchived: boolean;
  disabled: boolean;
  projectId: string | null;
  projectName: string;
  onEdit(operation: GlobalAuthoringOperation): void;
  onBeginAuthoringRead(): AbortController;
  onUse(root: GlobalCatalogItem, version: GlobalWorkflowVersion, profile?: { family: GlobalProfileFamily; version: GlobalProfileVersion }): void;
}

export function GlobalWorkflowDetail({ api, id, active, refresh, preserveExact, updatedProfile, showArchived, disabled, projectId, projectName, onEdit, onBeginAuthoringRead, onUse }: Props) {
  const [root, setRoot] = useState<GlobalCatalogItem | null>(null);
  const [workflow, setWorkflow] = useState<GlobalWorkflowVersion | null>(null);
  const [exactId, setExactId] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [profileHistory, setProfileHistory] = useState(false);
  const [selection, setSelection] = useState<{ family: GlobalProfileFamily; version: GlobalProfileVersion } | null>(null);
  const [familyPage, setFamilyPage] = useState<LibraryPage<GlobalProfileFamily> | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [profileRequest, setProfileRequest] = useState<{ family: GlobalProfileFamily; id: string; edit: AbortController | false } | null>(null);
  if (profileRequest?.edit && (!active || profileRequest.edit.signal.aborted)) setProfileRequest(null);
  const editLoadedProfile = useEffectEvent((family: GlobalProfileFamily, profile: GlobalProfileVersion) => {
    if (root && workflow) onEdit({ kind: "profile", root, workflow, family, profile });
  });
  const scope = JSON.stringify([refresh, showArchived]);
  const [previousScope, setPreviousScope] = useState(scope);
  if (scope !== previousScope) {
    setPreviousScope(scope); setExactId(preserveExact ? workflow?.id ?? exactId : null);
    if (!preserveExact) { setSelection(null); setProfileRequest(null); setWorkflow(null); }
    else if (updatedProfile) {
      if (selection?.family.id === updatedProfile.id) setSelection({ ...selection, family: { ...selection.family, ...updatedProfile } });
      if (profileRequest?.family.id === updatedProfile.id) setProfileRequest({ ...profileRequest, family: { ...profileRequest.family, ...updatedProfile } });
    }
    setRoot(null); setCursor(undefined); setBookmarks([]); setFamilyPage(null); setError(null);
  }
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void (async () => {
      const current = await api.getGlobalWorkflow(id, controller.signal);
      if (controller.signal.aborted) return;
      setRoot(current);
      const versionId = exactId ?? current.latest_version_id;
      const version = versionId ? await api.getGlobalWorkflowVersion(versionId, controller.signal) : null;
      if (!controller.signal.aborted) setWorkflow(version);
    })().catch((caught: unknown) => { if (!controller.signal.aborted) setError(errorMessage(caught)); });
    return () => controller.abort();
  }, [api, active, id, exactId, refresh, showArchived]);
  useEffect(() => {
    if (!active || !workflow) return;
    const controller = new AbortController();
    void api.listGlobalProfileFamilies(id, { workflow_version_id: workflow.id, q: query, cursor, limit: 20, include_archived: showArchived }, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setFamilyPage(page);
          setSelection((selected) => {
            const family = page.items.find((item) => item.id === selected?.family.id);
            return selected && family ? { ...selected, family } : selected;
          });
        }
      })
      .catch((caught: unknown) => { if (!controller.signal.aborted) setError(errorMessage(caught)); });
    return () => controller.abort();
  }, [api, active, id, workflow, query, cursor, showArchived, refresh]);
  useEffect(() => {
    if (!active || !profileRequest?.id) return;
    const controller = new AbortController();
    const signal = profileRequest.edit ? AbortSignal.any([controller.signal, profileRequest.edit.signal]) : controller.signal;
    if (signal.aborted) return;
    void api.getGlobalProfileVersion(profileRequest.id, signal).then((version) => {
      if (!signal.aborted) {
        setSelection({ family: profileRequest.family, version });
        if (profileRequest.edit) {
          editLoadedProfile(profileRequest.family, version);
          setProfileRequest(null);
        }
      }
    }).catch((caught: unknown) => { if (!signal.aborted) setError(errorMessage(caught)); });
    return () => { controller.abort(); if (profileRequest.edit) profileRequest.edit.abort(); };
  }, [api, active, profileRequest]);

  function selectWorkflow(versionId: string) {
    if (versionId === exactId && workflow) return;
    setExactId(versionId); setWorkflow(null); setSelection(null); setProfileRequest(null);
    setFamilyPage(null); setCursor(undefined); setBookmarks([]); setProfileHistory(false); setError(null);
  }
  function inspect(family: GlobalProfileFamily, versionId: string) {
    setSelection(null); setProfileHistory(false); setProfileRequest({ family, id: versionId, edit: false });
  }
  const selectedCompatible = selection?.version.workflow_version_id === workflow?.id && !selection?.version.archived_at && !selection?.family.archived_at;
  const selectionLoading = Boolean(profileRequest?.id && !selection);
  return <div className="global-workflow-detail">
    {error && <p role="alert">{error}</p>}
    {!root ? <p role="status">Loading Workflow...</p> : <>
      <h3>{root.name}</h3>
      {root.description && <p>{root.description}</p>}
      {root.archived_at && <p>Archived Workflow</p>}
      <div className="action-row">
        <button type="button" className="button-secondary" disabled={disabled || selectionLoading || !workflow || Boolean(root.archived_at)} onClick={() => onEdit({ kind: "workflow", root, workflow: workflow!, family: selection?.family, profile: selection?.version })}>Edit Workflow</button>
        <button type="button" className="button-secondary" disabled={disabled} onClick={() => onEdit({ kind: "metadata", root })}>Edit Workflow metadata</button>
        <button type="button" className="button-link" disabled={disabled} onClick={() => onEdit({ kind: "archive", root, archive: { kind: "workflows", id: root.id, archived: !root.archived_at } })}>{root.archived_at ? "Unarchive Workflow" : "Archive Workflow"}</button>
        <button type="button" className="button-link" onClick={() => setHistory(!history)}>Workflow History</button>
      </div>
      {history && <section aria-label="Workflow History">
        <GlobalLibraryHistory key={`workflow:${id}:${refresh}`} api={api} id={id} kind="workflow" active={active} onSelect={selectWorkflow} />
        {workflow && <>
          <p>Viewing revision {workflow.version_number}{workflow.archived_at ? " (archived)" : ""}. Selection does not change your Batch.</p>
          <button type="button" className="button-secondary" disabled={disabled || Boolean(root.archived_at)} onClick={() => onEdit({ kind: "restore", root, workflow })}>Restore Workflow content</button>
          <button type="button" className="button-link" disabled={disabled} onClick={() => onEdit({ kind: "archive", root, workflow, archive: { kind: "workflow-versions", id: workflow.id, archived: !workflow.archived_at } })}>{workflow.archived_at ? "Unarchive Workflow revision" : "Archive Workflow revision"}</button>
          <details><summary>Exact Workflow revision metadata</summary><pre>{JSON.stringify(workflow, null, 2)}</pre></details>
        </>}
      </section>}
      {workflow ? <>
        <details><summary>Workflow JSON</summary><pre>{JSON.stringify(workflow.workflow, null, 2)}</pre></details>
        <h4>Profiles</h4>
        <button type="button" className="button-secondary" disabled={disabled || Boolean(root.archived_at || workflow.archived_at)} onClick={() => onEdit({ kind: "profile", create: true, root, workflow })}>New Profile</button>
        <label className="field"><span className="field-label">Search Profiles</span><input maxLength={200} value={query} onChange={(event) => { setQuery(event.target.value); setCursor(undefined); setBookmarks([]); setFamilyPage(null); }} /></label>
        {!familyPage && <p role="status">Loading Profiles...</p>}
        {familyPage?.items.length === 0 && <p>No Profiles found.</p>}
        {familyPage?.items.map((family) => {
          const versionId = family.latest_compatible_version_id ?? family.latest_active_version_id;
          return <div className="global-profile-choice" key={family.id}>
            <button type="button" className="button-link" disabled={!versionId} aria-pressed={selection?.family.id === family.id} onClick={() => versionId && inspect(family, versionId)}>{family.name}</button>
            {family.description && <p>{family.description}</p>}
            {!family.latest_compatible_version_id && <p>Profile mappings need review</p>}
            {family.archived_at && <p>Archived Profile</p>}
            <button type="button" className="button-secondary compact" disabled={disabled || !versionId || Boolean(root.archived_at || family.archived_at || workflow.archived_at)} onClick={() => {
              if (selection?.family.id === family.id) onEdit({ kind: "profile", root, workflow, family, profile: selection.version });
              else if (versionId) { inspect(family, versionId); setProfileRequest({ family, id: versionId, edit: onBeginAuthoringRead() }); }
            }}>{family.latest_compatible_version_id ? `Edit ${family.name}` : `Review mappings for ${family.name}`}</button>
            <button type="button" className="button-link" disabled={disabled} onClick={() => onEdit({ kind: "metadata", root, family })}>Metadata for {family.name}</button>
            <button type="button" className="button-link" onClick={() => { if (versionId) inspect(family, versionId); else setSelection(null); setProfileRequest({ family, id: versionId ?? "", edit: false }); setProfileHistory(true); }}>History for {family.name}</button>
            <button type="button" className="button-link" disabled={disabled} onClick={() => onEdit({ kind: "archive", root, family, archive: { kind: "workflow-profiles", id: family.id, archived: !family.archived_at } })}>{family.archived_at ? "Unarchive" : "Archive"} {family.name}</button>
          </div>;
        })}
        <div className="action-row">
          <button type="button" className="button-secondary compact" disabled={!familyPage || !bookmarks.length} onClick={() => { setCursor(bookmarks.at(-1) || undefined); setBookmarks(bookmarks.slice(0, -1)); setFamilyPage(null); }}>Previous Profile families</button>
          <button type="button" className="button-secondary compact" disabled={!familyPage?.next_cursor} onClick={() => { setBookmarks([...bookmarks, cursor ?? ""].slice(-20)); setCursor(familyPage?.next_cursor ?? undefined); setFamilyPage(null); }}>Next Profile families</button>
        </div>
        {selection && <section aria-label="Selected Profile">
          <h4>{selection.family.name}</h4>
          {!selectedCompatible && <p>Profile mappings need review</p>}
          <button type="button" className="button-secondary" disabled={disabled || Boolean(selection.family.archived_at || root.archived_at || workflow.archived_at)} onClick={() => onEdit({ kind: "profile", root, workflow, family: selection.family, profile: selection.version })}>{selectedCompatible ? "Edit selected Profile" : "Review selected mappings"}</button>
          <details><summary>Selected Profile JSON</summary><pre>{JSON.stringify(selection.version.profile, null, 2)}</pre></details>
        </section>}
        {selectionLoading && !error && <p role="status">Loading selected Profile...</p>}
        {profileHistory && profileRequest && <section aria-label="Profile History">
          <GlobalLibraryHistory key={`profile:${profileRequest.family.id}:${refresh}`} api={api} id={profileRequest.family.id} kind="profile" active={active} onSelect={(versionId) => { setSelection(null); setProfileRequest({ family: profileRequest.family, id: versionId, edit: false }); }} />
          {selection && <>
            <p>Viewing Profile revision {selection.version.version_number}. {selectedCompatible ? "Compatible with the viewed Workflow." : "This revision needs review before use with the viewed Workflow."}</p>
            <button type="button" className="button-secondary" disabled={disabled || Boolean(selection.family.archived_at || root.archived_at)} onClick={() => onEdit({ kind: "restore", root, workflow, family: selection.family, profile: selection.version })}>Restore Profile content</button>
            <button type="button" className="button-link" disabled={disabled} onClick={() => onEdit({ kind: "archive", root, family: selection.family, archive: { kind: "workflow-profile-versions", id: selection.version.id, archived: !selection.version.archived_at } })}>{selection.version.archived_at ? "Unarchive Profile revision" : "Archive Profile revision"}</button>
            <details><summary>Exact Profile revision metadata</summary><pre>{JSON.stringify(selection.version, null, 2)}</pre></details>
          </>}
        </section>}
        <div className="action-row">
          <button className="button-secondary" type="button" disabled={disabled || selectionLoading || Boolean(root.archived_at || workflow.archived_at) || Boolean(selection && !selectedCompatible)} onClick={() => onUse(root, workflow, selection ?? undefined)}>Inspect compatible Profiles</button>
          <button className="button-primary" type="button" disabled={disabled || selectionLoading || !projectId || Boolean(root.archived_at || workflow.archived_at) || Boolean(selection && !selectedCompatible)} onClick={() => onUse(root, workflow, selection ?? undefined)}>Use in this Project</button>
          {(selection || profileRequest) && <button className="button-link" type="button" onClick={() => { setSelection(null); setProfileRequest(null); setProfileHistory(false); setError(null); }}>Clear Profile selection</button>}
        </div>
        <p className="field-help">{projectId ? `Copy into ${projectName}, then explicitly apply to Batch.` : "Select and verify a Project in Batch to use this setup."}</p>
      </> : <p>No active Workflow content. Explore History to inspect or unarchive previous content.</p>}
    </>}
  </div>;
}

export function GlobalLibraryHistory({ api, id, kind, active, onSelect }: { api: LibraryApi; id: string; kind: "workflow" | "profile"; active: boolean; onSelect(id: string): void }) {
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  const [page, setPage] = useState<LibraryPage<GlobalWorkflowHistoryItem | GlobalProfileHistoryItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const request = kind === "workflow" ? api.listGlobalWorkflowVersions.bind(api) : api.listGlobalProfileVersions.bind(api);
    void request(id, { q: query, limit: 20, cursor, include_archived: archived }, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setPage(result); })
      .catch((caught: unknown) => { if (!controller.signal.aborted) setError(errorMessage(caught)); });
    return () => controller.abort();
  }, [api, id, kind, active, query, archived, cursor, refresh]);
  function reset() { setCursor(undefined); setBookmarks([]); setPage(null); setError(null); }
  return <>
    <label className="field"><span className="field-label">Search {kind} history</span><input maxLength={200} value={query} onChange={(event) => { setQuery(event.target.value); reset(); }} /></label>
    <label><input type="checkbox" checked={archived} onChange={(event) => { setArchived(event.target.checked); reset(); }} />Show archived {kind} revisions</label>
    {error && <p role="alert">{error}</p>}
    {!page && !error && <p role="status">Loading history...</p>}
    {page?.items.length === 0 && <p>No revisions found.</p>}
    {page?.items.map((item) => <button key={item.id} type="button" className="global-library-item button-secondary" onClick={() => onSelect(item.id)}>Revision {item.version_number} / {item.name_snapshot}{item.archived_at ? " (archived)" : ""}<small>{item.note} {new Date(item.created_at).toLocaleString()}</small></button>)}
    <div className="action-row">
      <button className="button-secondary compact" type="button" disabled={!page || !bookmarks.length} onClick={() => { setCursor(bookmarks.at(-1) || undefined); setBookmarks(bookmarks.slice(0, -1)); setPage(null); }}>Previous {kind} revisions</button>
      <button className="button-secondary compact" type="button" disabled={!page?.next_cursor} onClick={() => { setBookmarks([...bookmarks, cursor ?? ""].slice(-20)); setCursor(page?.next_cursor ?? undefined); setPage(null); }}>Next {kind} revisions</button>
      <button className="button-link" type="button" onClick={() => { reset(); setRefresh((n) => n + 1); }}>Reload {kind} history</button>
    </div>
  </>;
}
