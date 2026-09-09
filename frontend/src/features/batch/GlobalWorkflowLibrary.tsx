import { useEffect, useRef, useState } from "react";
import type { BatchcraftApi } from "../../api/client";
import type { GlobalCatalogItem, GlobalWorkflowVersion, GlobalProfileMetadata, JsonObject, LibraryPage, LibraryWorkflowVersion, LibraryWorkflowProfileVersion, ProjectCopyResponse, ProjectResponse, ProjectWorkflow, SetupCopyRequest } from "../../api/types";
import { useModalDialog } from "../../components/useModalDialog";
import { errorMessage } from "../../utils/errors";
import "./globalWorkflowLibrary.css";

interface Props {
  api: BatchcraftApi;
  active: boolean;
  query: string;
  onQueryChange(value: string): void;
  projectId: string | null;
  projectName: string;
  draftGuard: string;
  applyDisabled: boolean;
  onCopied(projectId: string): void;
  onApply(copy: ProjectCopyResponse, profileId: string | null, guard: string): boolean;
}
type Receipt = { fingerprint: string; request: SetupCopyRequest; guard: string };
type Review = { direction: "import" | "use"; version: GlobalWorkflowVersion | LibraryWorkflowVersion; projectId: string; name: string; restored?: SetupCopyRequest };

export function GlobalWorkflowLibrary(props: Props) {
  const { api, active, query, onQueryChange, projectId, projectName } = props;
  const [page, setPage] = useState<LibraryPage<GlobalCatalogItem> | null>(null);
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GlobalCatalogItem | null>(null);
  const [version, setVersion] = useState<GlobalWorkflowVersion | null>(null);
  const [importing, setImporting] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const receipt = useRef<Receipt | null>(null);
  const [search, setSearch] = useState(query);
  // Query changes from Back/Forward reset cursors before a new read can use them.
  const [previousQuery, setPreviousQuery] = useState(query);
  if (query !== previousQuery) {
    setPreviousQuery(query); setSearch(query); setCursor(undefined); setBookmarks([]); setPage(null);
  }
  const requestKey = JSON.stringify([active, query, cursor, refresh]);
  const [previousRequest, setPreviousRequest] = useState(requestKey);
  if (requestKey !== previousRequest) {
    setPreviousRequest(requestKey); setLoading(true); setError(null); setPage(null);
  }
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void api.browseGlobalWorkflows({ q: query, limit: 20, cursor }, controller.signal).then((result) => {
      if (!controller.signal.aborted) setPage(result);
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(caught));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, api, query, cursor, refresh]);
  useEffect(() => {
    if (!active || !selected?.latest_version_id) return;
    const controller = new AbortController();
    void api.getGlobalWorkflowVersion(selected.latest_version_id, controller.signal).then((result) => {
      if (!controller.signal.aborted) setVersion(result);
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(errorMessage(caught)); });
    return () => controller.abort();
  }, [active, api, selected, refresh]);
  function reload() { setCursor(undefined); setBookmarks([]); setRefresh((value) => value + 1); }
  function openReview(value: Review) {
    const previous = receipt.current;
    setReview({ ...value, restored: previous?.request.project_id === value.projectId && previous.request.workflow_version_id === value.version.id ? previous.request : undefined });
  }
  return <section hidden={!active} className="global-library section-card" aria-label="Global Workflow Library">
    <div className="action-row"><h2>Workflow Library</h2><button type="button" className="button-secondary compact" onClick={() => setImporting(true)}>Import to Library</button></div>
    <p className="field-help">Reusable setups across Projects. Copies are independent; browsing never changes your Batch.</p>
    <form className="action-row" onSubmit={(event) => { event.preventDefault(); onQueryChange(search); }}>
      <label className="field"><span className="field-label">Search Workflow Library</span><input maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <button type="submit" className="button-secondary">Search library</button>
      <button type="button" className="button-secondary" onClick={reload}>Reload library</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">Loading library...</p>}
    <div className="global-library-grid">
      <div>
        {page?.items.length === 0 && <p>No Workflows found. Import a Project setup to start.</p>}
        {page?.items.map((item) => <button key={item.id} type="button" className="global-library-item button-secondary" aria-pressed={selected?.id === item.id} onClick={() => { setSelected({ ...item }); setVersion(null); }}>{item.name}<small>{item.description}</small></button>)}
        <div className="action-row">
          <button type="button" className="button-secondary compact" disabled={loading || !bookmarks.length} onClick={() => { setCursor(bookmarks.at(-1) || undefined); setBookmarks(bookmarks.slice(0, -1)); }}>Previous Workflows</button>
          <button type="button" className="button-secondary compact" disabled={loading || !page?.next_cursor} onClick={() => { setBookmarks([...bookmarks, cursor ?? ""].slice(-20)); setCursor(page?.next_cursor ?? undefined); }}>Next Workflows</button>
        </div>
        <p>Previous keeps up to 20 pages. Reload library returns to the first page.</p>
      </div>
      <div>{version ? <>
        <h3>{version.name_snapshot} / v{version.version_number}</h3>
        <p className="field-help">Created {new Date(version.created_at).toLocaleString()}</p>
        {version.note && <p>{version.note}</p>}
        <details><summary>Workflow JSON and metadata</summary><pre>{JSON.stringify(version, null, 2)}</pre></details>
        <button className="button-secondary" type="button" onClick={() => openReview({ direction: "use", version, projectId: projectId ?? "", name: selected?.name ?? version.name_snapshot })}>Inspect compatible Profiles</button>
        <button className="button-primary" type="button" disabled={!projectId} onClick={() => projectId && openReview({ direction: "use", version, projectId, name: selected?.name ?? version.name_snapshot })}>Use in this Project</button>
        <p className="field-help">{projectId ? `Copy into ${projectName}, then explicitly apply to Batch.` : "Select and verify a Project in Batch to use this setup."}</p>
      </> : <p>Select a Workflow to inspect its exact catalog version.</p>}</div>
    </div>
    {active && importing && <ProjectImport api={api} onClose={() => setImporting(false)} onReview={(value) => { setImporting(false); openReview(value); }} />}
    {active && review && <SetupReview key={`${review.direction}:${review.projectId}:${review.version.id}`} {...props} review={review} receiptRef={receipt} onClose={() => setReview(null)} onImported={reload} />}
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
    <div className="action-row"><button ref={close} type="button" className="button-secondary" onClick={onClose}>Cancel</button><button type="button" className="button-secondary" onClick={() => { setError(null); setWorkflows([]); setVersions([]); setVersionId(""); setRefresh((value) => value + 1); }}>Reload sources</button><button type="button" className="button-primary" disabled={!version} onClick={() => version && onReview({ direction: "import", version, projectId, name: workflows.find((item) => item.id === workflowId)?.name ?? version.name_snapshot })}>Review import</button></div>
  </dialog>;
}

function SetupReview({ api, review, receiptRef, onClose, onImported, onCopied, projectId, draftGuard, applyDisabled, onApply }: Props & { review: Review; receiptRef: React.RefObject<Receipt | null>; onClose(): void; onImported(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const handlers = useModalDialog(dialog, onClose, opener, close);
  const restored = review.restored;
  const [name, setName] = useState(restored ? restored.name ?? "" : review.name);
  const [profiles, setProfiles] = useState<Array<{ id: string; familyId: string; name: string; version: number }>>([]);
  const [choices, setChoices] = useState<Array<{ version_id: string; name: string }>>(restored?.profiles.map((item) => ({ ...item, name: item.name ?? "" })) ?? []);
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
        const result: LibraryPage<GlobalProfileMetadata> = await api.browseGlobalProfiles(review.version.id, { q: profileQuery, limit: 20, cursor }, controller.signal);
        if (controller.signal.aborted) return;
        setProfiles(result.items.map((item) => ({ id: item.id, familyId: item.workflow_profile_id, name: item.name, version: item.version_number }))); setNext(result.next_cursor);
      }
      setReady(true);
    })().catch((caught: unknown) => { if (!controller.signal.aborted) setError(errorMessage(caught)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, review, cursor, refresh, restored, profileQuery]);
  function fieldsChanged() { receiptRef.current = null; setError(null); }
  async function submit() {
    if (busy || !ready || loading || choices.length > 50 || (review.direction === "use" && projectId !== review.projectId)) return;
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
    <p>{review.version.name_snapshot} / v{review.version.version_number}</p>
    <details><summary>Inspect exact Workflow JSON</summary><pre>{JSON.stringify(review.version.workflow, null, 2)}</pre></details>
    {copied ? <>
      <p role="status">Copied to Project. Your Batch has not changed.</p>
      {copied.result.profiles.length > 0 ? <label className="field"><span className="field-label">Copied Profile to apply</span><select value={applyProfileId} onChange={(event) => setApplyProfileId(event.target.value)}><option value="">Choose one copied Profile</option>{copied.result.profiles.map((item) => <option key={item.version.id} value={item.version.id}>{item.workflow_profile.name} / v{item.version.version_number}</option>)}</select></label> : <p>No Profiles copied. Apply the Workflow, then configure mappings in Batch.</p>}
      {stale && <p role="alert">The destination Project or Batch draft changed. Copies are saved; select them from Workflow Setup in Batch instead.</p>}
      {applyDisabled && <p>Finish or release the current Run before applying a copied setup.</p>}
      <button type="button" className="button-primary" disabled={stale || applyDisabled || (copied.result.profiles.length > 0 && !applyProfileId)} onClick={() => { try { if (onApply(copied.result, applyProfileId || null, copied.guard)) onClose(); } catch (caught) { setError(errorMessage(caught)); } }}>Use copied setup</button>
    </> : imported ? <p role="status">Imported into Workflow Library. Your Batch and Preview are unchanged.</p> : <>
      <fieldset disabled={busy}>
        <label className="field"><span className="field-label">New Workflow name (optional)</span><input maxLength={200} value={name} onChange={(event) => { fieldsChanged(); setName(event.target.value); }} /></label>
        <p>Compatible Profiles: {choices.length}/50 selected. Each selection copies this exact revision into a new family.</p>
        {review.direction === "use" && <label className="field"><span className="field-label">Search compatible Profiles</span><input maxLength={200} value={profileQuery} onChange={(event) => { setProfileQuery(event.target.value); setCursor(undefined); setBookmarks([]); }} /></label>}
        {loading && <p role="status">Loading compatible Profiles...</p>}
        {!loading && !profiles.length && <p>No compatible Profiles on this page. Workflow-only copies are allowed.</p>}
        {profiles.map((item) => {
          const chosen = choices.find((choice) => choice.version_id === item.id);
          return <div className="global-profile-choice" key={item.id}>
            <label><input type="checkbox" checked={Boolean(chosen)} disabled={!chosen && choices.length >= 50} onChange={(event) => { fieldsChanged(); setChoices(event.target.checked ? [...choices, { version_id: item.id, name: item.name }] : choices.filter((choice) => choice.version_id !== item.id)); }} /> {item.name} / v{item.version}</label>
            <button type="button" className="button-link" onClick={() => { setInspection(null); setInspectSelection({ id: item.id }); }}>Inspect {item.name}</button>
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
        {review.direction === "use" && <div className="action-row"><button type="button" className="button-secondary compact" disabled={loading || !bookmarks.length} onClick={() => { setCursor(bookmarks.at(-1) || undefined); setBookmarks(bookmarks.slice(0, -1)); }}>Previous Profiles</button><button type="button" className="button-secondary compact" disabled={loading || !next} onClick={() => { setBookmarks([...bookmarks, cursor ?? ""].slice(-20)); setCursor(next ?? undefined); }}>Next Profiles</button></div>}
        {review.direction === "use" && <p>Previous keeps up to 20 pages. Reload Profiles returns to the first page.</p>}
      </fieldset>
      {review.direction === "use" && projectId !== review.projectId && <p role="alert">Select and verify the destination Project in Batch before copying.</p>}
      <button type="button" className="button-primary" disabled={busy || loading || !ready || choices.some((item) => !item.name.trim()) || (review.direction === "use" && projectId !== review.projectId)} onClick={() => void submit()}>{busy ? "Copying..." : "Confirm copy"}</button>
      <button type="button" className="button-secondary" disabled={busy} onClick={() => { setCursor(undefined); setBookmarks([]); setRefresh((value) => value + 1); }}>Reload Profiles</button>
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
