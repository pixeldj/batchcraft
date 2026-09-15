import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import type { LibraryApi } from "../../api/client";
import type { GlobalCatalogItem, GlobalProfile, GlobalProfileFamily, GlobalProfileVersion, GlobalWorkflowVersion, LibraryPage, GlobalWorkflowHistoryItem, GlobalProfileHistoryItem } from "../../api/types";
import { errorMessage } from "../../utils/errors";
import type { GlobalAuthoringOperation } from "./useGlobalWorkflowAuthoring";
import { LibraryMenu } from "./LibraryMenu";
import { LibrarySearch } from "./LibrarySearch";
import { profileMappingCount, ReadonlyProfileSummary } from "./ReadonlyProfileSummary";

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
  onChooseProject?(): void;
  onEdit(operation: GlobalAuthoringOperation): void;
  onBeginAuthoringRead(): AbortController;
  confirmation?: ReactNode;
  onUse(root: GlobalCatalogItem, version: GlobalWorkflowVersion, profile?: { family: GlobalProfileFamily; version: GlobalProfileVersion }, selectionSupplied?: boolean): void;
}

export function GlobalWorkflowDetail({ api, id, active, refresh, preserveExact, updatedProfile, showArchived, disabled, projectId, projectName, onChooseProject, onEdit, onBeginAuthoringRead, onUse, confirmation }: Props) {
  const [root, setRoot] = useState<GlobalCatalogItem | null>(null);
  const [workflow, setWorkflow] = useState<GlobalWorkflowVersion | null>(null);
  const [exactId, setExactId] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [profileHistory, setProfileHistory] = useState(false);
  const [selection, setSelection] = useState<{ family: GlobalProfileFamily; version: GlobalProfileVersion } | null>(null);
  const [selectionSupplied, setSelectionSupplied] = useState(false);
  const [familyPage, setFamilyPage] = useState<LibraryPage<GlobalProfileFamily> | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [profileRequest, setProfileRequest] = useState<{ family: GlobalProfileFamily; id: string; edit: AbortController | false } | null>(null);
  const summaryCache = useRef(new Map<string, GlobalProfileVersion>());
  const [summaries, setSummaries] = useState<Record<string, GlobalProfileVersion | null>>({});
  if (profileRequest?.edit && (!active || profileRequest.edit.signal.aborted)) setProfileRequest(null);
  const editLoadedProfile = useEffectEvent((family: GlobalProfileFamily, profile: GlobalProfileVersion) => {
    if (root && workflow) onEdit({ kind: "profile", root, workflow, family, profile });
  });
  const scope = JSON.stringify([refresh, showArchived]);
  const [previousScope, setPreviousScope] = useState(scope);
  if (scope !== previousScope) {
    setPreviousScope(scope); setExactId(preserveExact ? workflow?.id ?? exactId : null);
    if (!preserveExact) { setSelection(null); setSelectionSupplied(false); setProfileRequest(null); setWorkflow(null); }
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
  const targetId = workflow?.id;
  useEffect(() => {
    if (!active || !targetId) return;
    const controller = new AbortController();
    void api.listGlobalProfileFamilies(id, { workflow_version_id: targetId, q: query, cursor, limit: 20, include_archived: showArchived }, controller.signal)
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
  }, [api, active, id, targetId, query, cursor, showArchived, refresh]);
  useEffect(() => {
    if (!active || !familyPage) return;
    const controller = new AbortController();
    const candidates = familyPage.items.slice(0, 20).flatMap((family) => {
      const versionId = family.latest_compatible_version_id ?? family.latest_active_version_id;
      return versionId ? [{ family, versionId }] : [];
    });
    let index = 0;
    async function read() {
      while (index < candidates.length && !controller.signal.aborted) {
        const { family, versionId } = candidates[index++];
        try {
          const version = summaryCache.current.get(versionId) ?? await api.getGlobalProfileVersion(versionId, controller.signal);
          if (controller.signal.aborted) return;
          if (version.id !== versionId || version.workflow_id !== id || version.workflow_profile_id !== family.id) throw new Error("Unexpected Profile owner");
          summaryCache.current.delete(versionId);
          summaryCache.current.set(versionId, version);
          while (summaryCache.current.size > 20) summaryCache.current.delete(summaryCache.current.keys().next().value!);
          setSummaries((rows) => ({ ...rows, [versionId]: version }));
        } catch {
          if (!controller.signal.aborted) setSummaries((rows) => ({ ...rows, [versionId]: null }));
        }
      }
    }
    void read(); void read();
    return () => controller.abort();
  }, [api, active, familyPage, id]);
  const summaryScope = JSON.stringify([active, workflow?.id, query, cursor, refresh, showArchived]);
  const [previousSummaryScope, setPreviousSummaryScope] = useState(summaryScope);
  if (summaryScope !== previousSummaryScope) { setPreviousSummaryScope(summaryScope); setSummaries({}); }
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
    setExactId(versionId); setWorkflow(null); setSelection(null); setSelectionSupplied(false); setProfileRequest(null);
    setFamilyPage(null); setCursor(undefined); setBookmarks([]); setProfileHistory(false); setError(null);
  }
  function inspect(family: GlobalProfileFamily, versionId: string) {
    setSelectionSupplied(true);
    setSelection(null); setProfileHistory(false); setProfileRequest({ family, id: versionId, edit: false });
  }
  const selectedCompatible = selection?.version.workflow_version_id === workflow?.id && !selection?.version.archived_at && !selection?.family.archived_at;
  const selectionLoading = Boolean(profileRequest?.id && !selection);
  return <div className="global-workflow-detail">
    {error && <p role="alert">{error}</p>}
    {!root ? <p role="status">Loading Workflow...</p> : <>
      <header className="global-library-detail-header"><div className="global-library-detail-title"><h3>{root.name}</h3>{workflow && <small className="global-library-meta">Revision {workflow.version_number}</small>}</div>
        <div className="global-library-actions">
          <button type="button" className="button-secondary compact" disabled={disabled || selectionLoading || !workflow || Boolean(root.archived_at)} onClick={() => onEdit({ kind: "workflow", root, workflow: workflow!, family: selection?.family, profile: selection?.version })}>Edit Workflow</button>
          <LibraryMenu key={String(active)} label={`Actions for Workflow ${root.name}`} disabled={disabled} items={[
            { label: "Rename / description", accessibleLabel: "Edit Workflow metadata", onSelect: () => onEdit({ kind: "metadata", root }) },
            { label: "History", accessibleLabel: "Workflow History", onSelect: () => setHistory(!history) },
            { label: root.archived_at ? "Unarchive" : "Archive", accessibleLabel: root.archived_at ? "Unarchive Workflow" : "Archive Workflow", onSelect: () => onEdit({ kind: "archive", root, archive: { kind: "workflows", id: root.id, archived: !root.archived_at } }) },
          ]} />
        </div>
      </header>
      {root.description && <p>{root.description}</p>}
      {root.archived_at && <p>Archived Workflow</p>}
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
        <div className="global-library-detail-header"><h4>Profiles</h4><button type="button" className="button-secondary compact" disabled={disabled || Boolean(root.archived_at || workflow.archived_at)} onClick={() => onEdit({ kind: "profile", create: true, root, workflow })}>New Profile</button></div>
        <LibrarySearch label="Search Profiles" query={query} scope={JSON.stringify([workflow.id, cursor, refresh, showArchived])} active={active} onChange={(value) => { setQuery(value); setCursor(undefined); setBookmarks([]); setFamilyPage(null); }} />
        {!familyPage && <p role="status">Loading Profiles...</p>}
        {familyPage?.items.length === 0 && <p>No Profiles found.</p>}
        <div className="global-library-profile-list" role="group" aria-label="Profile entries">
        {familyPage?.items.map((family) => {
          const versionId = family.latest_compatible_version_id ?? family.latest_active_version_id;
          const selected = selection?.family.id === family.id;
          const summary = selected ? selection.version : versionId ? summaries[versionId] : null;
          const revision = summary?.version_number ?? family.latest_compatible_version?.version_number;
          return <div className="global-profile-row" key={family.id}>
            <button type="button" className="button-secondary global-profile-select" aria-label={family.name} title={family.name} disabled={!versionId} aria-pressed={selected} onClick={() => { if (versionId && !selected) inspect(family, versionId); }}><span>{family.name}</span><small className="global-library-meta">{selected ? "Selected" : "Inspect"}{revision !== undefined ? ` / revision ${revision}` : ""}</small><small>{summary ? profileMappingCount(summary.profile) : summary === null ? "Summary unavailable" : "Loading mappings..."}</small></button>
            <div className="global-library-actions">
            <button type="button" className="button-secondary compact" aria-label={family.latest_compatible_version_id ? `Edit ${family.name}` : `Review mappings for ${family.name}`} disabled={disabled || !versionId || Boolean(root.archived_at || family.archived_at || workflow.archived_at)} onClick={() => {
              if (selection?.family.id === family.id) onEdit({ kind: "profile", root, workflow, family, profile: selection.version });
              else if (versionId) { inspect(family, versionId); setProfileRequest({ family, id: versionId, edit: onBeginAuthoringRead() }); }
            }}>{family.latest_compatible_version_id ? "Edit" : "Review mappings"}</button>
            <LibraryMenu key={String(active)} label={`Actions for Profile ${family.name}`} disabled={disabled} items={[
              { label: "Rename / description", accessibleLabel: `Metadata for ${family.name}`, onSelect: () => onEdit({ kind: "metadata", root, family }) },
              { label: "History", accessibleLabel: `History for ${family.name}`, onSelect: () => { const target = selected ? selection.version.id : versionId; if (target && !selected) inspect(family, target); else if (!target) setSelection(null); setProfileRequest({ family, id: target ?? "", edit: false }); setProfileHistory(true); } },
              { label: family.archived_at ? "Unarchive" : "Archive", accessibleLabel: `${family.archived_at ? "Unarchive" : "Archive"} ${family.name}`, onSelect: () => onEdit({ kind: "archive", root, family, archive: { kind: "workflow-profiles", id: family.id, archived: !family.archived_at } }) },
            ]} />
            </div>
            {family.description && <p className="global-profile-row-note">{family.description}</p>}
            {!family.latest_compatible_version_id && <p className="global-profile-row-note">Profile mappings need review</p>}
            {family.archived_at && <p className="global-profile-row-note">Archived Profile</p>}
          </div>;
        })}
        </div>
        {familyPage && <p className="global-library-meta">{familyPage.items.length} Profile families on this page</p>}
        <div className="global-library-pager">
          <button type="button" className="button-secondary compact" aria-label="Previous Profile families" title="Previous Profile families (up to 20 previous pages)" disabled={!familyPage || !bookmarks.length} onClick={() => { setCursor(bookmarks.at(-1) || undefined); setBookmarks(bookmarks.slice(0, -1)); setFamilyPage(null); }}>Previous</button>
          <button type="button" className="button-secondary compact" aria-label="Next Profile families" disabled={!familyPage?.next_cursor} onClick={() => { setBookmarks([...bookmarks, cursor ?? ""].slice(-20)); setCursor(familyPage?.next_cursor ?? undefined); setFamilyPage(null); }}>Next</button>
        </div>
        {selection && <section aria-label="Selected Profile">
          <h4>{selection.family.name}</h4>
          <p className="global-library-meta">Selected revision {selection.version.version_number}</p>
          {!selectedCompatible && <p>{selection.version.workflow_version_id !== workflow.id ? "This Profile targets a different Workflow revision. Review its mappings for this Workflow, or clear the selection to add only the Workflow." : "This Profile or its revision is archived. Review History to unarchive it, or clear the selection to add only the Workflow."}</p>}
          <button type="button" className="button-secondary" disabled={disabled || Boolean(selection.family.archived_at || root.archived_at || workflow.archived_at)} onClick={() => onEdit({ kind: "profile", root, workflow, family: selection.family, profile: selection.version })}>{selectedCompatible ? "Edit selected Profile" : "Review selected mappings"}</button>
          <ReadonlyProfileSummary profile={selection.version.profile} workflow={selection.version.workflow_version_id === workflow.id ? workflow.workflow : {}} />
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
        <details className="global-library-technical"><summary>Workflow JSON</summary><pre>{JSON.stringify(workflow.workflow, null, 2)}</pre></details>
        <footer className="global-library-copy-footer">
          <div>{projectId ? <><span className="global-library-meta">Destination Project</span><p>Creates an independent copy in <strong>{projectName}</strong>. Your Batch stays unchanged.</p></> : <><p>Select and verify a Project in Batch to add this setup.</p>{onChooseProject && <button type="button" className="button-link" onClick={onChooseProject}>Choose Project</button>}</>}</div>
          <div className="global-library-actions"><button className="button-primary" type="button" disabled={disabled || selectionLoading || !projectId || Boolean(root.archived_at || workflow.archived_at) || Boolean(selection && !selectedCompatible)} onClick={() => onUse(root, workflow, selection ?? undefined, selectionSupplied)}>Add to Project</button>
          {(selection || profileRequest) && <button className="button-link" type="button" onClick={() => { setSelection(null); setSelectionSupplied(true); setProfileRequest(null); setProfileHistory(false); setError(null); }}>Clear Profile selection</button>}
          </div>
        </footer>
        {confirmation}
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
  const scope = `${kind}:${id}`;
  const [previousScope, setPreviousScope] = useState(scope);
  if (scope !== previousScope) { setPreviousScope(scope); setQuery(""); setCursor(undefined); setBookmarks([]); }
  const requestKey = JSON.stringify([scope, active, query, archived, cursor, refresh]);
  const [previousRequest, setPreviousRequest] = useState(requestKey);
  if (previousRequest !== requestKey) { setPreviousRequest(requestKey); setPage(null); setError(null); }
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
    <LibrarySearch label={`Search ${kind} history`} query={query} scope={JSON.stringify([scope, archived, cursor, refresh])} active={active} onChange={(value) => { setQuery(value); reset(); }} />
    <label className="checkbox-row"><input type="checkbox" checked={archived} onChange={(event) => { setArchived(event.target.checked); reset(); }} />Show archived {kind} revisions</label>
    {error && <p role="alert">{error}</p>}
    {!page && !error && <p role="status">Loading history...</p>}
    {page?.items.length === 0 && <p>No revisions found.</p>}
    {page?.items.map((item) => <button key={item.id} type="button" className="global-library-item button-secondary" onClick={() => onSelect(item.id)}>Revision {item.version_number} / {item.name_snapshot}{item.archived_at ? " (archived)" : ""}<small>{item.note} {new Date(item.created_at).toLocaleString()}</small></button>)}
    {page && <p className="global-library-meta">{page.items.length} {kind} revisions on this page</p>}
    <div className="global-library-pager">
      <button className="button-secondary compact" type="button" aria-label={`Previous ${kind} revisions`} title="Up to 20 previous pages" disabled={!page || !bookmarks.length} onClick={() => { setCursor(bookmarks.at(-1) || undefined); setBookmarks(bookmarks.slice(0, -1)); setPage(null); }}>Previous</button>
      <button className="button-secondary compact" type="button" aria-label={`Next ${kind} revisions`} disabled={!page?.next_cursor} onClick={() => { setBookmarks([...bookmarks, cursor ?? ""].slice(-20)); setCursor(page?.next_cursor ?? undefined); setPage(null); }}>Next</button>
      <button className="button-link" type="button" onClick={() => { reset(); setRefresh((n) => n + 1); }}>Reload {kind} history</button>
    </div>
  </>;
}
