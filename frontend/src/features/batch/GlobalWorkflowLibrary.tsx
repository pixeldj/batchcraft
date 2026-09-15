import { useEffect, useRef, useState } from "react";
import type { BatchcraftApi } from "../../api/client";
import type { GlobalCatalogItem, GlobalProfile, GlobalWorkflowVersion, JsonObject, LibraryPage, LibraryWorkflowVersion, LibraryWorkflowProfileVersion, ProjectCopyResponse, ProjectResponse, ProjectWorkflow, SetupCopyRequest } from "../../api/types";
import { useModalDialog } from "../../components/useModalDialog";
import { errorMessage } from "../../utils/errors";
import { GlobalWorkflowDetail, GlobalLibraryHistory } from "./GlobalWorkflowDetail";
import { useGlobalWorkflowAuthoring } from "./useGlobalWorkflowAuthoring";
import { LibrarySearch } from "./LibrarySearch";
import "./globalWorkflowLibrary.css";

interface Props {
  api: BatchcraftApi;
  active: boolean;
  query: string;
  onQueryChange(value: string): void;
  projectId: string | null;
  projectName: string;
  onChooseProject?(): void;
  draftGuard: string;
  applyDisabled: boolean;
  onCopied(projectId: string): void;
  onApply(copy: ProjectCopyResponse, profileId: string | null, guard: string): boolean;
}
type Receipt = { fingerprint: string; request: SetupCopyRequest; guard: string };
type Review = { direction: "import" | "use"; version: GlobalWorkflowVersion | LibraryWorkflowVersion; projectId: string; name: string; restored?: SetupCopyRequest; preferred?: { version_id: string; name: string; familyId: string; version: number } };

export function GlobalWorkflowLibrary(props: Props) {
  const { api, active, query, onQueryChange, projectId, projectName } = props;
  const [page, setPage] = useState<LibraryPage<GlobalCatalogItem> | null>(null);
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [preserveExact, setPreserveExact] = useState(false);
  const [updatedProfile, setUpdatedProfile] = useState<GlobalProfile>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GlobalCatalogItem | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [importing, setImporting] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const receipt = useRef<Receipt | null>(null);
  const authoring = useGlobalWorkflowAuthoring(api, active, (root, preserve, profile) => { if (root) setSelected(root); setUpdatedProfile(profile); reload(preserve); });
  // Query changes from Back/Forward reset cursors before a new read can use them.
  const [previousQuery, setPreviousQuery] = useState(query);
  if (query !== previousQuery) {
    setPreviousQuery(query); setCursor(undefined); setBookmarks([]); setPage(null);
  }
  const requestKey = JSON.stringify([active, query, cursor, refresh, showArchived]);
  const [previousRequest, setPreviousRequest] = useState(requestKey);
  if (requestKey !== previousRequest) {
    setPreviousRequest(requestKey); setLoading(true); setError(null); setPage(null);
  }
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void api.browseGlobalWorkflows({ q: query, limit: 20, cursor, ...(showArchived ? { include_archived: true } : {}) }, controller.signal).then((result) => {
      if (!controller.signal.aborted) setPage(result);
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(caught));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, api, query, cursor, refresh, showArchived]);
  function reload(preserve = false) { setPreserveExact(preserve); setCursor(undefined); setBookmarks([]); setRefresh((value) => value + 1); }
  function openReview(value: Review) {
    const previous = receipt.current;
    setReview({ ...value, restored: previous?.request.project_id === value.projectId && previous.request.workflow_version_id === value.version.id ? previous.request : undefined });
  }
  return <section hidden={!active} className="global-library section-card" aria-label="Global Workflow Library">
    <header className="global-library-header"><div><h2>Workflow Library</h2><p className="field-help">Reusable setups across Projects. Browsing never changes your Batch.</p></div><div className="global-library-actions"><button type="button" className="button-secondary compact" disabled={authoring.occupied} onClick={() => setImporting(true)}>Import to Library</button><button type="button" className="button-primary compact" disabled={authoring.occupied} onClick={() => authoring.open({ kind: "workflow", create: true })}>New Workflow</button></div></header>
    <div className="global-library-grid">
      <aside className="global-library-sidebar" aria-label="Workflows">
        <LibrarySearch label="Search Workflow Library" query={query} scope={JSON.stringify([showArchived, cursor, refresh])} active={active} onChange={onQueryChange} />
        <div className="global-library-actions"><label className="checkbox-row"><input type="checkbox" checked={showArchived} onChange={(event) => { setShowArchived(event.target.checked); setCursor(undefined); setBookmarks([]); }} />Show archived entries</label><button type="button" className="button-link compact" aria-label="Reload library" title="Refresh Workflows; return to the first page" onClick={() => { setUpdatedProfile(undefined); reload(true); }}>Refresh</button></div>
        {error && <p role="alert">{error}</p>}
        {loading && <p role="status">Loading library...</p>}
        {page && <p className="global-library-meta">{page.items.length} Workflows on this page</p>}
        {page?.items.length === 0 && <p>No Workflows found. Create a Workflow or import a Project setup.</p>}
        <div className="global-library-workflow-list" role="group" aria-label="Workflow entries">
          {page?.items.map((item) => <button key={item.id} type="button" className="global-library-item button-secondary" aria-label={item.name} title={item.name} aria-pressed={selected?.id === item.id} disabled={authoring.occupied} onClick={() => setSelected({ ...item })}><span>{item.name}</span>{selected?.id === item.id && <small className="global-library-selected">Selected</small>}<small>{item.description}{item.archived_at ? " (archived)" : ""}</small></button>)}
        </div>
        <div className="global-library-pager">
          <button type="button" className="button-secondary compact" aria-label="Previous Workflows" title="Previous Workflows (up to 20 previous pages)" disabled={loading || !bookmarks.length} onClick={() => { setCursor(bookmarks.at(-1) || undefined); setBookmarks(bookmarks.slice(0, -1)); }}>Previous</button>
          <button type="button" className="button-secondary compact" aria-label="Next Workflows" disabled={loading || !page?.next_cursor} onClick={() => { setBookmarks([...bookmarks, cursor ?? ""].slice(-20)); setCursor(page?.next_cursor ?? undefined); }}>Next</button>
        </div>
      </aside>
      {selected ? <GlobalWorkflowDetail key={selected.id} api={api} id={selected.id} active={active} refresh={refresh} preserveExact={preserveExact} updatedProfile={updatedProfile} showArchived={showArchived} disabled={authoring.occupied}
        projectId={projectId} projectName={projectName} onChooseProject={props.onChooseProject} onEdit={authoring.open} onBeginAuthoringRead={authoring.beginRead}
        onUse={(root, version, profile) => openReview({ direction: "use", version, projectId: projectId ?? "", name: root.name, preferred: profile ? { version_id: profile.version.id, name: profile.family.name, familyId: profile.family.id, version: profile.version.version_number } : undefined })} /> : <p>Select a Workflow to inspect its exact catalog version.</p>}
    </div>
    {active && importing && <ProjectImport api={api} onClose={() => setImporting(false)} onReview={(value) => { setImporting(false); openReview(value); }} />}
    {active && review && <SetupReview key={`${review.direction}:${review.projectId}:${review.version.id}`} {...props} review={review} receiptRef={receipt} onClose={() => setReview(null)} onImported={reload} />}
    {authoring.dialog}
  </section>;
}

function ProjectImport({ api, onClose, onReview }: { api: BatchcraftApi; onClose(): void; onReview(review: Review): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const handlers = useModalDialog(dialog, onClose, opener, close);
  const [projects, setProjects] = useState<ProjectResponse[]>([]);
  const [projectId, setProjectId] = useState("");
  const [workflows, setWorkflows] = useState<ProjectWorkflow[]>([]);
  const [workflowId, setWorkflowId] = useState("");
  const [versions, setVersions] = useState<LibraryWorkflowVersion[]>([]);
  const [versionId, setVersionId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api.listProjects(true, controller.signal).then((result) => { if (!controller.signal.aborted) setProjects(result.projects); }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(errorMessage(caught)); });
    return () => controller.abort();
  }, [api, refresh]);
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    void api.listWorkflows(projectId, controller.signal).then((result) => { if (!controller.signal.aborted) setWorkflows(result.workflows); }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(errorMessage(caught)); });
    return () => controller.abort();
  }, [api, projectId, refresh]);
  useEffect(() => {
    if (!workflowId) return;
    const controller = new AbortController();
    void api.listWorkflowVersions(workflowId, false, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      const available = result.workflow_versions.filter((item) => !item.archived_at);
      setVersions(available);
      setVersionId(available.reduce<LibraryWorkflowVersion | null>((latest, item) => !latest || item.version_number > latest.version_number ? item : latest, null)?.id ?? "");
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(errorMessage(caught)); });
    return () => controller.abort();
  }, [api, workflowId, refresh]);
  const version = versions.find((item) => item.id === versionId);
  return <dialog ref={dialog} {...handlers} className="global-library-dialog" aria-label="Import Project setup">
    <h2>Import to Library</h2><p>Choose a source Project without switching your Batch draft.</p>
    <label className="field"><span className="field-label">Source Project</span><select value={projectId} onChange={(event) => { setProjectId(event.target.value); setWorkflows([]); setWorkflowId(""); setVersions([]); setVersionId(""); setError(null); }}><option value="">Choose source Project</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label className="field"><span className="field-label">Source Workflow</span><select value={workflowId} onChange={(event) => { setWorkflowId(event.target.value); setVersions([]); setVersionId(""); setError(null); }}><option value="">Choose source Workflow</option>{workflows.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label className="field"><span className="field-label">Source Workflow revision</span><select value={versionId} onChange={(event) => setVersionId(event.target.value)}><option value="">Choose exact revision</option>{versions.map((item) => <option key={item.id} value={item.id}>v{item.version_number} / {item.name_snapshot}</option>)}</select></label>
    {error && <p role="alert">{error}</p>}
    <div className="global-library-actions"><button ref={close} type="button" className="button-secondary" onClick={onClose}>Cancel</button><button type="button" className="button-secondary" onClick={() => { setError(null); setWorkflows([]); setVersions([]); setVersionId(""); setRefresh((value) => value + 1); }}>Reload sources</button><button type="button" className="button-primary" disabled={!version} onClick={() => version && onReview({ direction: "import", version, projectId, name: workflows.find((item) => item.id === workflowId)?.name ?? version.name_snapshot })}>Review import</button></div>
  </dialog>;
}

function SetupReview({ api, review, receiptRef, onClose, onImported, onCopied, projectId, draftGuard, applyDisabled, onApply }: Props & { review: Review; receiptRef: React.RefObject<Receipt | null>; onClose(): void; onImported(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const handlers = useModalDialog(dialog, onClose, opener, close);
  const restored = review.restored;
  const [name, setName] = useState(restored ? restored.name ?? "" : review.name);
  const [profiles, setProfiles] = useState<Array<{ id: string; familyId: string; name: string; version: number; incompatible?: boolean }>>([]);
  const [choices, setChoices] = useState<Array<{ version_id: string; name: string }>>(restored?.profiles.map((item) => ({ ...item, name: item.name ?? "" })) ?? (review.preferred ? [{ version_id: review.preferred.version_id, name: review.preferred.name }] : []));
  const [historyFamily, setHistoryFamily] = useState<string | null>(null);
  const [historySelection, setHistorySelection] = useState<{ id: string; familyId: string; previousId: string } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyInvalid, setHistoryInvalid] = useState(false);
  const exactChoices = useRef(new Map<string, { id: string; version: number }>(!restored && review.preferred ? [[review.preferred.familyId, { id: review.preferred.version_id, version: review.preferred.version }]] : []));
  const restoredChoicesHydrated = useRef(false);
  const [cursor, setCursor] = useState<string>();
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  const [profileQuery, setProfileQuery] = useState("");
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState(false);
  const [copied, setCopied] = useState<{ result: ProjectCopyResponse; guard: string } | null>(null);
  const [applyProfileId, setApplyProfileId] = useState("");
  const [inspectSelection, setInspectSelection] = useState<{ id: string } | null>(null);
  const [inspection, setInspection] = useState<JsonObject | null>(null);
  const write = useRef<AbortController | null>(null);
  const requestKey = JSON.stringify([cursor, refresh, profileQuery]);
  const [previousRequest, setPreviousRequest] = useState(requestKey);
  if (requestKey !== previousRequest) {
    setPreviousRequest(requestKey); setLoading(true); setReady(false); setError(null);
    if (review.direction === "use") setProfiles([]);
  }
  useEffect(() => () => write.current?.abort(), []);
  useEffect(() => {
    if (!historySelection) return;
    const controller = new AbortController();
    void api.getGlobalProfileVersion(historySelection.id, controller.signal).then((version) => {
      if (controller.signal.aborted) return;
      setInspection(version.profile);
      if (version.workflow_version_id !== review.version.id || version.archived_at) {
        setHistoryInvalid(true);
        setError("Profile mappings need review before this revision can be copied with the viewed Workflow.");
        return;
      }
      receiptRef.current = null; setError(null); setHistoryInvalid(false);
      exactChoices.current.set(historySelection.familyId, { id: version.id, version: version.version_number });
      setProfiles((rows) => rows.map((row) => row.familyId === historySelection.familyId ? { ...row, id: version.id, version: version.version_number, incompatible: false } : row));
      setChoices((rows) => rows.map((row) => row.version_id === historySelection.previousId ? { ...row, version_id: version.id } : row));
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) { setHistoryInvalid(true); setError(errorMessage(caught)); }
    }).finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => controller.abort();
  }, [api, historySelection, receiptRef, review.version.id]);
  useEffect(() => {
    if (!inspectSelection) return;
    const controller = new AbortController();
    const request = review.direction === "use" ? api.getGlobalProfileVersion(inspectSelection.id, controller.signal) : api.getWorkflowProfileVersion(inspectSelection.id, controller.signal);
    void request.then((result) => { if (!controller.signal.aborted) setInspection(result.profile); }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(errorMessage(caught)); });
    return () => controller.abort();
  }, [api, inspectSelection, review.direction]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      if (review.direction === "import") {
        const result = await api.listWorkflowProfiles(review.version.workflow_id, review.version.id, controller.signal);
        if (controller.signal.aborted) return;
        const items = result.workflow_profiles.flatMap((item) => item.latest_compatible_version ? [{ id: item.latest_compatible_version.id, familyId: item.id, name: item.name, version: item.latest_compatible_version.version_number }] : []);
        if (restored) {
          for (const selection of restored.profiles) {
            if (items.some((item) => item.id === selection.version_id)) continue;
            const version = await api.getWorkflowProfileVersion(selection.version_id, controller.signal);
            if (controller.signal.aborted) return;
            const row = items.find((item) => item.familyId === version.workflow_profile_id);
            if (row) { row.id = version.id; row.version = version.version_number; }
          }
        }
        setProfiles((previous) => items.map((item) => previous.find((row) => row.familyId === item.familyId) ?? item)); setNext(null);
        if (!restored && refresh === 0) setChoices(items.slice(0, 50).map((item) => ({ version_id: item.id, name: item.name })));
      } else {
        const result = await api.listGlobalProfileFamilies(review.version.workflow_id, { workflow_version_id: review.version.id, q: profileQuery, limit: 20, cursor }, controller.signal);
        if (controller.signal.aborted) return;
        if (restored && !restoredChoicesHydrated.current) {
          const restoredVersions = new Map<string, { id: string; version: number }>();
          for (const choice of restored.profiles) {
            const version = await api.getGlobalProfileVersion(choice.version_id, controller.signal);
            if (controller.signal.aborted) return;
            restoredVersions.set(version.workflow_profile_id, { id: version.id, version: version.version_number });
          }
          // Publish only a complete hydration; explicit choices made in flight take precedence.
          for (const [familyId, version] of restoredVersions) {
            if (!exactChoices.current.has(familyId)) exactChoices.current.set(familyId, version);
          }
          restoredChoicesHydrated.current = true;
        }
        setProfiles(result.items.map((item) => ({ id: item.latest_compatible_version_id ?? item.latest_active_version_id ?? "", familyId: item.id, name: item.name, version: item.latest_compatible_version?.version_number ?? 0, incompatible: !item.latest_compatible_version_id, ...exactChoices.current.get(item.id) }))); setNext(result.next_cursor);
      }
      setReady(true);
    })().catch((caught: unknown) => { if (!controller.signal.aborted) setError(errorMessage(caught)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, review, cursor, refresh, restored, profileQuery]);
  function fieldsChanged() { receiptRef.current = null; setError(null); }
  async function submit() {
    if (busy || !ready || loading || historyLoading || historyInvalid || choices.length > 50 || (review.direction === "use" && projectId !== review.projectId)) return;
    const payload = { project_id: review.projectId, workflow_version_id: review.version.id, profiles: choices, name: name.trim() || null };
    const fingerprint = JSON.stringify([review.direction, payload]);
    if (receiptRef.current?.fingerprint !== fingerprint) receiptRef.current = { fingerprint, request: { ...payload, request_id: crypto.randomUUID() }, guard: draftGuard };
    const request = receiptRef.current.request;
    const guard = receiptRef.current.guard;
    const controller = new AbortController(); write.current = controller;
    setBusy(true); setError(null);
    try {
      if (review.direction === "import") {
        await api.importProjectSetup(request, controller.signal);
        if (!controller.signal.aborted) { receiptRef.current = null; setImported(true); onImported(); }
      } else {
        const result = await api.useGlobalSetup(request, controller.signal);
        if (!controller.signal.aborted) { receiptRef.current = null; setCopied({ result, guard }); setApplyProfileId(result.profiles.length === 1 ? result.profiles[0].version.id : ""); onCopied(result.workflow.workflow.project_id); }
      }
    } catch (caught) {
      if (!controller.signal.aborted) setError(`${errorMessage(caught)} The copy may have completed. Retry unchanged to recover the same receipt; changing fields starts a new operation.`);
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  const stale = projectId !== review.projectId || copied?.guard !== draftGuard;
  return <dialog ref={dialog} {...handlers} className="global-library-dialog" aria-label={review.direction === "import" ? "Review library import" : "Review Project copy"}>
    <h2>{review.direction === "import" ? "Review library import" : "Review Project copy"}</h2>
    <p>{review.name}</p>
    <details><summary>Inspect exact Workflow JSON</summary><pre>{JSON.stringify(review.version.workflow, null, 2)}</pre></details>
    {copied ? <>
      <p role="status">Copied to Project. Your Batch has not changed.</p>
      {copied.result.profiles.length > 0 ? <label className="field"><span className="field-label">Copied Profile to apply</span><select value={applyProfileId} onChange={(event) => setApplyProfileId(event.target.value)}><option value="">Choose one copied Profile</option>{copied.result.profiles.map((item) => <option key={item.version.id} value={item.version.id}>{item.workflow_profile.name}</option>)}</select></label> : <p>No Profiles copied. Apply the Workflow, then configure mappings in Batch.</p>}
      {stale && <p role="alert">The destination Project or Batch draft changed. Copies are saved; select them from Workflow Setup in Batch instead.</p>}
      {applyDisabled && <p>Finish or release the current Run before applying a copied setup.</p>}
      <button type="button" className="button-primary" disabled={stale || applyDisabled || (copied.result.profiles.length > 0 && !applyProfileId)} onClick={() => { try { if (onApply(copied.result, applyProfileId || null, copied.guard)) onClose(); } catch (caught) { setError(errorMessage(caught)); } }}>Apply to Batch</button>
    </> : imported ? <p role="status">Imported into Workflow Library. Your Batch and Preview are unchanged.</p> : <>
      <fieldset disabled={busy}>
        <label className="field"><span className="field-label">New Workflow name (optional)</span><input maxLength={200} value={name} onChange={(event) => { fieldsChanged(); setName(event.target.value); }} /></label>
        <p>Compatible Profiles: {choices.length}/50 selected.</p>
        {review.direction === "use" && <LibrarySearch label="Search compatible Profiles" query={profileQuery} scope={JSON.stringify([review.version.id, cursor, refresh])} onChange={(value) => { setProfileQuery(value); setCursor(undefined); setBookmarks([]); }} />}
        {loading && <p role="status">Loading compatible Profiles...</p>}
        {!loading && !profiles.length && <p>No compatible Profiles on this page. Workflow-only copies are allowed.</p>}
        {profiles.map((item) => {
          const chosen = choices.find((choice) => choice.version_id === item.id);
          return <div className="global-profile-choice" key={item.familyId}>
            <label className="checkbox-row"><input type="checkbox" checked={Boolean(chosen)} disabled={item.incompatible || (!chosen && choices.length >= 50)} onChange={(event) => { fieldsChanged(); setChoices(event.target.checked ? [...choices, { version_id: item.id, name: item.name }] : choices.filter((choice) => choice.version_id !== item.id)); }} /> {item.name}{review.direction === "import" ? ` / v${item.version}` : ""}</label>
            {item.incompatible && <p>Profile mappings need review</p>}
            <button type="button" className="button-link" disabled={!item.id} onClick={() => { setInspection(null); setInspectSelection({ id: item.id }); }}>Inspect {item.name}</button>
            {review.direction === "use" && <button type="button" className="button-link" onClick={() => setHistoryFamily(historyFamily === item.familyId ? null : item.familyId)}>Copy History for {item.name}</button>}
            {review.direction === "use" && historyFamily === item.familyId && <GlobalLibraryHistory api={api} id={item.familyId} kind="profile" active onSelect={(id) => { setHistoryLoading(true); setHistorySelection({ id, familyId: item.familyId, previousId: item.id }); }} />}
            {review.direction === "import" && <ProjectProfileRevision api={api} familyId={item.familyId} workflowVersionId={review.version.id} selectedId={item.id} name={item.name} onChange={(version) => {
              fieldsChanged();
              setProfiles(profiles.map((row) => row.familyId === item.familyId ? { ...row, id: version.id, version: version.version_number } : row));
              setChoices(choices.map((choice) => choice.version_id === item.id ? { ...choice, version_id: version.id } : choice));
            }} />}
            {chosen && <label className="field"><span className="field-label">Copy name for {item.name}</span><input maxLength={200} required value={chosen.name} onChange={(event) => { fieldsChanged(); setChoices(choices.map((choice) => choice.version_id === item.id ? { ...choice, name: event.target.value } : choice)); }} /></label>}
          </div>;
        })}
        {inspection && <details open><summary>Selected Profile JSON (detached inspection)</summary><pre>{JSON.stringify(inspection, null, 2)}</pre></details>}
        {choices.length > 0 && <details><summary>Review all selected Profile copies ({choices.length})</summary><ul>{choices.map((choice) => <li key={choice.version_id}>{choice.name} <code>{choice.version_id}</code> <button type="button" className="button-link" onClick={() => { fieldsChanged(); setChoices(choices.filter((item) => item.version_id !== choice.version_id)); }}>Remove {choice.name}</button></li>)}</ul></details>}
        {review.direction === "use" && <div className="global-library-pager"><button type="button" className="button-secondary compact" aria-label="Previous Profiles" title="Previous Profiles (up to 20 previous pages)" disabled={loading || !bookmarks.length} onClick={() => { setCursor(bookmarks.at(-1) || undefined); setBookmarks(bookmarks.slice(0, -1)); }}>Previous</button><button type="button" className="button-secondary compact" aria-label="Next Profiles" disabled={loading || !next} onClick={() => { setBookmarks([...bookmarks, cursor ?? ""].slice(-20)); setCursor(next ?? undefined); }}>Next</button></div>}
      </fieldset>
      {review.direction === "use" && projectId !== review.projectId && <p role="alert">Select and verify the destination Project in Batch before copying.</p>}
      {historyLoading && <p role="status">Loading exact Profile revision...</p>}
      {historyInvalid && <button type="button" className="button-link" onClick={() => { setHistorySelection(null); setHistoryInvalid(false); setHistoryLoading(false); setInspection(null); setError(null); }}>Keep previous compatible selection</button>}
      <div className="global-library-actions"><button type="button" className="button-primary" disabled={busy || loading || historyLoading || historyInvalid || !ready || choices.some((item) => !item.name.trim()) || (review.direction === "use" && projectId !== review.projectId)} onClick={() => void submit()}>{busy ? "Copying..." : "Confirm copy"}</button>
      <button type="button" className="button-secondary" disabled={busy} onClick={() => { setCursor(undefined); setBookmarks([]); setRefresh((value) => value + 1); }}>Reload Profiles</button></div>
    </>}
    {error && <p role="alert">{error}</p>}
    {busy && <p>Closing stops waiting, not the server transaction. Reopen with the same fields to retry the receipt.</p>}
    <button ref={close} type="button" className="button-secondary" onClick={onClose}>{busy ? "Stop waiting" : "Close"}</button>
  </dialog>;
}

function ProjectProfileRevision({ api, familyId, workflowVersionId, selectedId, name, onChange }: { api: BatchcraftApi; familyId: string; workflowVersionId: string; selectedId: string; name: string; onChange(version: LibraryWorkflowProfileVersion): void }) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<LibraryWorkflowProfileVersion[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api.listWorkflowProfileVersions(familyId, false, controller.signal).then((result) => {
      if (!controller.signal.aborted) setVersions(result.workflow_profile_versions.filter((version) => !version.archived_at && version.workflow_version_id === workflowVersionId));
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(errorMessage(caught)); });
    return () => controller.abort();
  }, [api, familyId, workflowVersionId, open]);
  return <>
    <button className="button-link" type="button" onClick={() => setOpen(!open)}>Revisions for {name}</button>
    {open && <label className="field"><span className="field-label">Exact revision for {name}</span><select value={selectedId} onChange={(event) => { const version = versions.find((item) => item.id === event.target.value); if (version) onChange(version); }}>{!versions.length && <option value={selectedId}>Loading revisions...</option>}{versions.map((version) => <option key={version.id} value={version.id}>v{version.version_number} / {version.id}</option>)}</select></label>}
    {error && <p role="alert">{error}</p>}
  </>;
}
