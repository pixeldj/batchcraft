import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ApiError, type BatchcraftApi } from "../../api/client";
import type { GlobalCatalogItem, GlobalProfile, GlobalProfileFamily, GlobalProfileHistoryItem, GlobalWorkflowVersion, JsonObject, LibraryPage, LibraryWorkflowVersion, LibraryWorkflowProfileVersion, ProjectCopyResponse, ProjectResponse, ProjectWorkflow, SetupCopyRequest } from "../../api/types";
import { useModalDialog } from "../../components/useModalDialog";
import { errorMessage } from "../../utils/errors";
import { GlobalWorkflowDetail, GlobalLibraryHistory } from "./GlobalWorkflowDetail";
import { useGlobalWorkflowAuthoring } from "./useGlobalWorkflowAuthoring";
import { LibrarySearch } from "./LibrarySearch";
import { LibraryMenu } from "./LibraryMenu";
import { ReadonlyProfileSummary } from "./ReadonlyProfileSummary";
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
type Review = { direction: "import" | "use"; version: GlobalWorkflowVersion | LibraryWorkflowVersion; projectId: string; destinationName?: string; name: string; restored?: SetupCopyRequest; selectionSupplied?: boolean; preferred?: { version_id: string; name: string; familyId: string; family: GlobalProfileFamily; version: number } };
type AddedSetup = { result: ProjectCopyResponse; guard: string; sourceWorkflowId: string; destinationName: string; applyProfileId: string };

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
  const [added, setAdded] = useState<AddedSetup | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
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
  const staleAdded = added && (projectId !== added.result.workflow.workflow.project_id || props.draftGuard !== added.guard);
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
        confirmation={added?.sourceWorkflowId === selected.id && <section className="project-add-confirmation" aria-label="Added to Project">
          <p role="status">Copied to Project <strong>{added.destinationName}</strong>: <strong>{added.result.workflow.workflow.name}</strong>. Your Batch has not changed.</p>
          {added.result.profiles.length > 1 ? <label className="field"><span className="field-label">Copied Profile to apply</span><select value={added.applyProfileId} onChange={(event) => setAdded({ ...added, applyProfileId: event.target.value })}><option value="">Choose one copied Profile</option>{added.result.profiles.map((item) => <option key={item.version.id} value={item.version.id}>{item.workflow_profile.name}</option>)}</select></label> : added.result.profiles.length === 1 ? <p>{added.result.profiles[0].workflow_profile.name}</p> : <p>No Profiles copied. Apply the Workflow, then configure mappings in Batch.</p>}
          {staleAdded && <p role="alert">The destination Project or Batch draft changed. Copies are saved; select them from Workflow Setup in Batch instead.</p>}
          {props.applyDisabled && <p>Finish or release the current Run before applying a copied setup.</p>}
          {applyError && <p role="alert">{applyError}</p>}
          <button type="button" className="button-primary" disabled={Boolean(staleAdded) || props.applyDisabled || (added.result.profiles.length > 0 && !added.applyProfileId)} onClick={() => { try { if (props.onApply(added.result, added.applyProfileId || null, added.guard)) { setAdded(null); setApplyError(null); } } catch (caught) { setApplyError(errorMessage(caught)); } }}>Apply to Batch</button>
        </section>}
        onUse={(root, version, profile, selectionSupplied) => openReview({ direction: "use", version, projectId: projectId ?? "", destinationName: projectName, name: root.name, selectionSupplied, preferred: profile ? { version_id: profile.version.id, name: profile.family.name, familyId: profile.family.id, family: profile.family, version: profile.version.version_number } : undefined })} /> : <p>Select a Workflow to inspect its exact catalog version.</p>}
    </div>
    {active && importing && <ProjectImport api={api} onClose={() => setImporting(false)} onReview={(value) => { setImporting(false); openReview(value); }} />}
    {active && review && <SetupReview key={`${review.direction}:${review.projectId}:${review.version.id}`} {...props} review={review} receiptRef={receipt} onClose={() => setReview(null)} onImported={reload} onAdded={(value) => { setAdded(value); setApplyError(null); setReview(null); }} />}
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

function SetupReview({ api, review, receiptRef, onClose, onImported, onCopied, projectId, draftGuard, onAdded }: Props & { review: Review; receiptRef: React.RefObject<Receipt | null>; onClose(): void; onImported(): void; onAdded(value: AddedSetup): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const handlers = useModalDialog(dialog, cancelReview, opener, close);
  const restored = review.restored;
  const [replay, setReplay] = useState(Boolean(restored));
  const [name, setName] = useState(restored ? restored.name ?? "" : review.name);
  const [profiles, setProfiles] = useState<Array<{ id: string; familyId: string; name: string; version: number; incompatible?: boolean }>>([]);
  const [choices, setChoices] = useState<Array<{ version_id: string; name: string }>>(restored?.profiles.map((item) => ({ ...item, name: item.name ?? "" })) ?? (review.preferred ? [{ version_id: review.preferred.version_id, name: review.preferred.name }] : []));
  const [historyFamily, setHistoryFamily] = useState<{ familyId: string; previousId: string } | null>(null);
  const [historySelection, setHistorySelection] = useState<{ id: string; familyId: string; previousId: string } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyInvalid, setHistoryInvalid] = useState(false);
  const historyRead = useRef<AbortController | null>(null);
  const exactChoices = useRef(new Map<string, { id: string; version: number }>(!restored && review.preferred ? [[review.preferred.familyId, { id: review.preferred.version_id, version: review.preferred.version }]] : []));
  // Receipt presence includes an explicitly empty selection; discovery gets only one decision.
  const defaultSettled = useRef(Boolean(restored || review.preferred || review.selectionSupplied));
  const [families, setFamilies] = useState<LibraryPage<GlobalProfileFamily> | null>(null);
  const [completeCount, setCompleteCount] = useState<number | null>(null);
  const [validation, setValidation] = useState<Record<string, string | null>>({});
  const knownFamilies = useRef(new Map<string, GlobalProfileFamily>(review.preferred ? [[review.preferred.familyId, review.preferred.family]] : []));
  const refreshRead = useRef(false);
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
  const [workflowRename, setWorkflowRename] = useState(false);
  const [renaming, setRenaming] = useState<Set<string>>(new Set());
  const [selectedReview, setSelectedReview] = useState(false);
  const [searchNeeded, setSearchNeeded] = useState(false);
  const [invalidNames, setInvalidNames] = useState<Set<string>>(new Set());
  const [sourceNames, setSourceNames] = useState<Record<string, string>>(review.preferred ? { [review.preferred.version_id]: review.preferred.name } : {});
  const subviewOpener = useRef<HTMLElement | null>(null);
  const [inspectSelection, setInspectSelection] = useState<{ id: string } | null>(null);
  const [inspection, setInspection] = useState<JsonObject | null>(null);
  const write = useRef<AbortController | null>(null);
  const requestKey = JSON.stringify([cursor, refresh, profileQuery]);
  const [previousRequest, setPreviousRequest] = useState(requestKey);
  const [previousRefresh, setPreviousRefresh] = useState(refresh);
  if (requestKey !== previousRequest) {
    setPreviousRequest(requestKey); setLoading(true); setReady(false); setError(null);
    setPreviousRefresh(refresh);
    if (review.direction === "use" && refresh === previousRefresh) setProfiles([]);
  }
  useEffect(() => () => write.current?.abort(), []);
  useEffect(() => {
    if (!historySelection) return;
    const controller = new AbortController();
    historyRead.current = controller;
    void api.getGlobalProfileVersion(historySelection.id, controller.signal).then((version) => {
      if (controller.signal.aborted) return;
      setInspection(version.profile);
      if (version.id !== historySelection.id || version.workflow_profile_id !== historySelection.familyId || version.workflow_id !== review.version.workflow_id || version.workflow_version_id !== review.version.id || version.archived_at !== null) {
        setHistoryInvalid(true);
        setError("Profile mappings need review before this revision can be copied with the viewed Workflow.");
        return;
      }
      receiptRef.current = null; setReplay(false); setError(null); setHistoryInvalid(false);
      exactChoices.current.set(historySelection.familyId, { id: version.id, version: version.version_number });
      setSourceNames((names) => ({ ...names, [version.id]: names[historySelection.previousId] ?? version.name_snapshot }));
      setRenaming((ids) => ids.has(historySelection.previousId) ? new Set([...ids, version.id]) : ids);
      setProfiles((rows) => rows.map((row) => row.familyId === historySelection.familyId ? { ...row, id: version.id, version: version.version_number, incompatible: false } : row));
      setChoices((rows) => rows.map((row) => row.version_id === historySelection.previousId ? { ...row, version_id: version.id } : row));
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) { setHistoryInvalid(true); setError(errorMessage(caught)); }
    }).finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => { controller.abort(); if (historyRead.current === controller) historyRead.current = null; };
  }, [api, historySelection, receiptRef, review.version.id, review.version.workflow_id]);
  useEffect(() => {
    if (!inspectSelection) return;
    const controller = new AbortController();
    const request = review.direction === "use" ? api.getGlobalProfileVersion(inspectSelection.id, controller.signal) : api.getWorkflowProfileVersion(inspectSelection.id, controller.signal);
    void request.then((result) => { if (!controller.signal.aborted) setInspection(result.profile); }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(errorMessage(caught)); });
    return () => controller.abort();
  }, [api, inspectSelection, review.direction]);
  const eligibility = useEffectEvent((family: GlobalProfileFamily): boolean | null => {
    const version = family.latest_compatible_version;
    if (family.workflow_id !== review.version.workflow_id || family.archived_at === undefined) return null;
    if (family.archived_at !== null) return false;
    if (version === undefined) return null;
    if (!version) return family.latest_compatible_version_id === null ? false : null;
    if (!family.latest_active_version_id) return null;
    if (version.id !== family.latest_compatible_version_id || version.workflow_profile_id !== family.id || version.workflow_id !== family.workflow_id || version.workflow_version_id !== review.version.id || version.archived_at === undefined) return null;
    return version.archived_at === null;
  });
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
        if ((!profileQuery && !cursor && result.items.length > 5) || result.next_cursor || cursor) setSearchNeeded(true);
        setFamilies(result);
        if (!profileQuery && !cursor) setCompleteCount(result.next_cursor ? null : result.items.length);
        if (!profileQuery && !cursor && !result.next_cursor) {
          for (const familyId of knownFamilies.current.keys()) {
            if (!result.items.some((family) => family.id === familyId)) knownFamilies.current.delete(familyId);
          }
        }
        if (!defaultSettled.current) {
          defaultSettled.current = true;
          const eligible = result.items.filter((item) => eligibility(item) === true);
          if (!profileQuery && !cursor && !result.next_cursor && eligible.length === 1 && result.items.every((item) => eligibility(item) !== null)) {
            const item = eligible[0];
            const version = item.latest_compatible_version!;
            exactChoices.current.set(item.id, { id: version.id, version: version.version_number });
            setChoices([{ version_id: version.id, name: item.name }]);
            setSourceNames((names) => ({ ...names, [version.id]: item.name }));
          }
        }
        const rows = result.items.map((item) => ({ id: item.latest_compatible_version_id ?? item.latest_active_version_id ?? "", familyId: item.id, name: item.name, version: item.latest_compatible_version?.version_number ?? 0, incompatible: eligibility(item) === false, ...exactChoices.current.get(item.id) }));
        setProfiles(rows); setNext(result.next_cursor);
      }
      setReady(true);
    })().catch((caught: unknown) => { if (!controller.signal.aborted) setError(errorMessage(caught)); }).finally(() => { if (!controller.signal.aborted) { setLoading(false); refreshRead.current = false; } });
    return () => controller.abort();
  }, [api, review, cursor, refresh, restored, profileQuery]);
  const selectedIds = JSON.stringify(choices.map((choice) => choice.version_id));
  const [validatedFamilies, setValidatedFamilies] = useState(families);
  const [validatedIds, setValidatedIds] = useState(selectedIds);
  if (validatedFamilies !== families || validatedIds !== selectedIds) {
    setValidatedFamilies(families); setValidatedIds(selectedIds); setValidation({});
  }
  const currentChoices = useEffectEvent(() => choices);
  useEffect(() => {
    if (review.direction !== "use" || !families || loading) return;
    const controller = new AbortController();
    const ids: string[] = JSON.parse(selectedIds);
    for (const family of families.items) knownFamilies.current.set(family.id, family);
    for (const familyId of knownFamilies.current.keys()) {
      if (!families.items.some((family) => family.id === familyId) && !ids.includes(exactChoices.current.get(familyId)?.id ?? "")) knownFamilies.current.delete(familyId);
    }
    void (async () => {
      for (const id of ids.slice(0, 50)) {
        try {
          const pinnedFamily = [...exactChoices.current].find(([, value]) => value.id === id)?.[0];
          let family = [...knownFamilies.current.values()].find((item) => item.id === pinnedFamily || item.latest_compatible_version_id === id);
          const metadata = family?.latest_compatible_version;
          const version: GlobalProfileHistoryItem = metadata?.id === id && family?.latest_compatible_version_id === id ? metadata : await api.getGlobalProfileVersion(id, controller.signal);
          if (controller.signal.aborted) return;
          family ??= knownFamilies.current.get(version.workflow_profile_id);
          if (!family) throw new Error("Profile family metadata is unavailable. Find its family in the list to validate ownership and archive status.");
          if (version.id !== id || version.workflow_id !== review.version.workflow_id || (pinnedFamily && version.workflow_profile_id !== pinnedFamily) || family.id !== version.workflow_profile_id || family.workflow_id !== version.workflow_id || family.archived_at !== null || version.workflow_version_id !== review.version.id || version.archived_at !== null) throw new Error("Profile revision is incompatible, archived, or has an unexpected owner. Remove it or choose a valid revision.");
          exactChoices.current.set(version.workflow_profile_id, { id, version: version.version_number });
          setProfiles((rows) => rows.map((row) => row.familyId === version.workflow_profile_id ? { ...row, id, version: version.version_number, incompatible: false } : row));
          setSourceNames((names) => ({ ...names, [id]: names[id] ?? version.name_snapshot }));
          setValidation((values) => ({ ...values, [id]: null }));
        } catch (caught) {
          if (controller.signal.aborted) return;
          const message = `Cannot validate ${currentChoices().find((choice) => choice.version_id === id)?.name ?? id}: ${errorMessage(caught)} Retry Profiles or remove this selection.`;
          setValidation((values) => ({ ...values, [id]: message }));
        }
      }
    })();
    return () => controller.abort();
  }, [api, families, loading, selectedIds, review.direction, review.version.id, review.version.workflow_id]);
  const selectionUnresolved = choices.some((choice) => validation[choice.version_id] !== null);
  function fieldsChanged() { defaultSettled.current = true; receiptRef.current = null; setReplay(false); setError(null); setInvalidNames(new Set()); }
  function revealNames() {
    setWorkflowRename(true); setRenaming(new Set(choices.map((item) => item.version_id)));
    if (choices.some((choice) => !profiles.some((row) => row.id === choice.version_id))) setSelectedReview(true);
  }
  async function submit() {
    if (write.current || busy || !ready || loading || historyLoading || historyInvalid || choices.length > 50 || (review.direction === "use" && (projectId !== review.projectId || (selectionUnresolved && !receiptRef.current)))) return;
    if (review.direction === "use") {
      const invalid = choices.filter((choice) => !choice.name.trim() || choice.name.length > 200 || choices.some((other) => other.version_id !== choice.version_id && other.name === choice.name));
      if (invalid.length || name.trim().length > 200) {
        const ids = invalid.map((choice) => choice.version_id);
        setInvalidNames(new Set(ids)); revealNames();
        setError("Selected Profile names must be nonblank, at most 200 characters, and distinct (case-sensitive). Workflow names must be at most 200 characters.");
        return;
      }
    }
    const payload = { project_id: review.projectId, workflow_version_id: review.version.id, profiles: choices, name: name.trim() || null };
    const fingerprint = JSON.stringify([review.direction, payload]);
    if (receiptRef.current?.fingerprint !== fingerprint) receiptRef.current = { fingerprint, request: { ...payload, request_id: crypto.randomUUID() }, guard: draftGuard };
    const request = receiptRef.current.request;
    const guard = receiptRef.current.guard;
    const controller = new AbortController(); write.current = controller;
    setBusy(true); setReplay(true); setError(null);
    try {
      if (review.direction === "import") {
        await api.importProjectSetup(request, controller.signal);
        if (!controller.signal.aborted) { receiptRef.current = null; setImported(true); onImported(); }
      } else {
        const result = await api.useGlobalSetup(request, controller.signal);
        if (!controller.signal.aborted) { receiptRef.current = null; onCopied(result.workflow.workflow.project_id); onAdded({ result, guard, sourceWorkflowId: review.version.workflow_id, destinationName: review.destinationName ?? "", applyProfileId: result.profiles.length === 1 ? result.profiles[0].version.id : "" }); }
      }
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(`${errorMessage(caught)} The copy may have completed. Retry unchanged to recover the same receipt; changing fields starts a new operation.`);
        if (review.direction === "use" && caught instanceof ApiError && caught.status === 409 && caught.code === "library_conflict") revealNames();
      }
    } finally { if (write.current === controller) write.current = null; if (!controller.signal.aborted) setBusy(false); }
  }
  const hiddenChoices = choices.some((choice) => !profiles.some((item) => item.id === choice.version_id));
  function renameInput(choice: (typeof choices)[number], label: string) {
    return <label className="field"><span className="field-label">Copy name for {label}</span><input autoFocus maxLength={200} required aria-invalid={invalidNames.has(choice.version_id)} value={choice.name} onChange={(event) => { fieldsChanged(); setChoices(choices.map((row) => row.version_id === choice.version_id ? { ...row, name: event.target.value } : row)); }} /></label>;
  }
  function toggleRename(id: string) { setRenaming((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function refreshProfiles() { if (busy || loading || refreshRead.current) return; refreshRead.current = true; setCursor(undefined); setBookmarks([]); setRefresh((value) => value + 1); }
  function cancelRevisionRead() {
    // Only validated responses commit choices. Closing cancels an unresolved choice,
    // but a known invalid choice still requires explicit acceptance of the previous one.
    historyRead.current?.abort(); setHistorySelection(null); setHistoryLoading(false);
  }
  function closeSubview() { cancelRevisionRead(); setHistoryFamily(null); setInspectSelection(null); setInspection(null); (subviewOpener.current?.isConnected ? subviewOpener.current : close.current)?.focus(); }
  function cancelReview() {
    if (review.direction === "use" && (historyFamily || inspectSelection)) closeSubview();
    else onClose();
  }
  if (review.direction === "use") return <dialog ref={dialog} {...handlers} className="global-library-dialog project-add-dialog" aria-label="Add workflow to Project">
    <header className="project-add-header"><h2>Add workflow to Project</h2><button type="button" className="button-link compact" aria-label="Close Add workflow to Project" onClick={onClose}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></header>
    <form noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="project-add-body">
        <p className="project-add-destination"><span className="field-label">Destination Project</span><strong>{review.destinationName}</strong></p>
        <fieldset disabled={busy}>
          <div className="project-add-workflow"><div><span className="field-label">Workflow</span>{!workflowRename && <p>{name.trim() || review.version.name_snapshot}</p>}</div><button type="button" className="button-link compact" aria-label={workflowRename ? "Hide Workflow rename" : "Rename Workflow"} aria-expanded={workflowRename} onClick={() => setWorkflowRename(!workflowRename)}>{workflowRename ? "Hide rename" : "Rename"}</button></div>
          {workflowRename && <label className="field"><span className="field-label">New Workflow name (optional)</span><input autoFocus maxLength={200} value={name} onChange={(event) => { fieldsChanged(); setName(event.target.value); }} /></label>}
          <div className="project-add-profile-heading"><h3>Include Profiles</h3>{completeCount !== 1 && <span className="global-library-meta">{choices.length} selected</span>}<button type="button" className="button-link compact project-add-refresh" disabled={busy || loading} onClick={refreshProfiles}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></svg>Refresh</button></div>
          {choices.length >= 45 && <p className="field-help">Select up to 50 Profiles ({choices.length}/50 selected).</p>}
          {(searchNeeded || profileQuery) && <div><LibrarySearch label="Search compatible Profiles" query={profileQuery} scope={JSON.stringify([review.version.id, cursor, refresh])} onChange={(value) => { setProfileQuery(value); setCursor(undefined); setBookmarks([]); }} />{profileQuery && <button className="button-link compact" type="button" onClick={() => { setProfileQuery(""); setCursor(undefined); setBookmarks([]); }}>Clear search</button>}</div>}
          {loading && <p role="status">Loading compatible Profiles...</p>}
          {ready && !loading && !profiles.length && <p>{profileQuery ? "No Profiles match this search." : "No compatible Profiles on this page. You can add just the Workflow."}</p>}
          {profiles.map((item) => {
            const chosen = choices.find((choice) => choice.version_id === item.id);
            return <div className="project-add-profile" key={item.familyId}>
              <label className="checkbox-row"><input type="checkbox" checked={Boolean(chosen)} disabled={busy || (!chosen && (item.incompatible || choices.length >= 50))} onChange={(event) => { fieldsChanged(); exactChoices.current.set(item.familyId, { id: item.id, version: item.version }); const updated = event.target.checked ? [...choices, { version_id: item.id, name: item.name }] : choices.filter((choice) => choice.version_id !== item.id); setChoices(updated); setSourceNames(Object.fromEntries(updated.map((choice) => [choice.version_id, choice.version_id === item.id ? item.name : sourceNames[choice.version_id] ?? choice.name]))); }} /><span>{item.name}</span></label>
              <LibraryMenu label={`Copy actions for ${item.name}`} disabled={busy} items={[
                { label: "Inspect mappings", disabled: !item.id, onSelect: () => { cancelRevisionRead(); subviewOpener.current = document.activeElement as HTMLElement; setHistoryFamily(null); setInspection(null); if (!historyInvalid) setError(null); setInspectSelection({ id: item.id }); } },
                { label: renaming.has(item.id) ? "Hide rename" : "Rename", disabled: !chosen, onSelect: () => toggleRename(item.id) },
                { label: "Choose revision", onSelect: () => { defaultSettled.current = true; cancelRevisionRead(); subviewOpener.current = document.activeElement as HTMLElement; setInspectSelection(null); setInspection(null); setHistoryFamily({ familyId: item.familyId, previousId: item.id }); } },
              ]} />
              {!chosen && item.incompatible && <p>Profile mappings need review</p>}
              {chosen && renaming.has(item.id) && !(hiddenChoices && selectedReview) && renameInput(chosen, item.name)}
            </div>;
          })}
          {(bookmarks.length > 0 || next) && <div className="global-library-pager"><button type="button" className="button-secondary compact" aria-label="Previous Profiles" title="Previous Profiles (up to 20 previous pages)" disabled={loading || !bookmarks.length} onClick={() => { setCursor(bookmarks.at(-1) || undefined); setBookmarks(bookmarks.slice(0, -1)); }}>Previous</button><button type="button" className="button-secondary compact" aria-label="Next Profiles" disabled={loading || !next} onClick={() => { setBookmarks([...bookmarks, cursor ?? ""].slice(-20)); setCursor(next ?? undefined); }}>Next</button></div>}
          {hiddenChoices && <section className="project-add-selected"><button type="button" className="button-link" aria-expanded={selectedReview} onClick={() => setSelectedReview(!selectedReview)}>Review all selected Profiles ({choices.length})</button>{selectedReview && choices.map((choice) => {
            const label = sourceNames[choice.version_id] ?? choice.name;
            return <div className="project-add-selected-row" key={choice.version_id}><span>{choice.name}</span><div className="global-library-actions"><button type="button" className="button-link compact" aria-label={`Rename selected ${label}`} onClick={() => toggleRename(choice.version_id)}>{renaming.has(choice.version_id) ? "Hide rename" : "Rename"}</button><button type="button" className="button-link compact" aria-label={`Remove ${label}`} onClick={() => { fieldsChanged(); setChoices(choices.filter((row) => row.version_id !== choice.version_id)); }}>Remove</button></div>{renaming.has(choice.version_id) && renameInput(choice, label)}</div>;
          })}</section>}
          {families && !choices.length && <p className="global-library-meta">Only the Workflow will be added</p>}
          {(historyFamily || inspectSelection) && <section className="project-add-subview" aria-label={historyFamily ? "Choose Profile revision" : "Inspect Profile mappings"}>
            <div className="project-add-profile-heading"><h3>{historyFamily ? "Choose revision" : "Inspect mappings"}</h3><button type="button" className="button-link compact" onClick={closeSubview}>Close {historyFamily ? "revision chooser" : "mappings"}</button></div>
            {historyFamily && <GlobalLibraryHistory api={api} id={historyFamily.familyId} kind="profile" active onSelect={(id) => { setHistoryLoading(true); setHistorySelection({ id, familyId: historyFamily.familyId, previousId: exactChoices.current.get(historyFamily.familyId)?.id ?? historyFamily.previousId }); }} />}
            {inspectSelection && !inspection && !error && <p role="status">Loading mappings...</p>}
            {inspection && <ReadonlyProfileSummary profile={inspection} workflow={review.version.workflow} />}
            {error && inspectSelection && <button type="button" className="button-link" onClick={() => { setError(null); setInspectSelection({ ...inspectSelection }); }}>Retry mappings</button>}
          </section>}
          <details className="global-library-technical"><summary>Inspect Workflow</summary><pre>{JSON.stringify(review.version.workflow, null, 2)}</pre></details>
          <p className="field-help project-add-note">Adds independent copies. Your Batch stays unchanged.</p>
        </fieldset>
        {projectId !== review.projectId && <p role="alert">Select and verify the destination Project in Batch before copying.</p>}
        {historyLoading && <p role="status">Loading exact Profile revision...</p>}
        {historyInvalid && <><button type="button" className="button-link" onClick={() => { cancelRevisionRead(); setHistoryInvalid(false); setInspection(null); setError(null); }}>Keep previous compatible selection</button>{historySelection && historyFamily && <button type="button" className="button-link" onClick={() => { setHistoryLoading(true); setError(null); setHistorySelection({ ...historySelection }); }}>Retry revision</button>}</>}
        {error && <p role="alert">{error}</p>}
        {choices.map((choice) => validation[choice.version_id] && <p role="alert" key={choice.version_id}>{validation[choice.version_id]}</p>)}
        {ready && !loading && choices.some((choice) => validation[choice.version_id] === undefined) && <p role="status">Validating selected Profile revisions...</p>}
        {((error && !ready && !loading) || choices.some((choice) => validation[choice.version_id])) && <button type="button" className="button-link" disabled={busy || loading} onClick={refreshProfiles}>Retry Profiles</button>}
        {busy && <p>Closing stops waiting, not the server transaction. Reopen with the same fields to retry the receipt.</p>}
      </div>
      <footer className="project-add-footer"><button ref={close} type="button" className="button-secondary" onClick={onClose}>{busy ? "Stop waiting" : "Cancel"}</button><button type="submit" className="button-primary" disabled={busy || loading || historyLoading || historyInvalid || !ready || (selectionUnresolved && !replay) || choices.length > 50 || projectId !== review.projectId}>{busy ? "Adding..." : "Add to Project"}</button></footer>
    </form>
  </dialog>;
  return <dialog ref={dialog} {...handlers} className="global-library-dialog" aria-label="Review library import">
    <h2>Review library import</h2>
    <p>{review.name}</p>
    <details><summary>Inspect exact Workflow JSON</summary><pre>{JSON.stringify(review.version.workflow, null, 2)}</pre></details>
    {imported ? <p role="status">Imported into Workflow Library. Your Batch and Preview are unchanged.</p> : <>
      <fieldset disabled={busy}>
        <label className="field"><span className="field-label">New Workflow name (optional)</span><input maxLength={200} value={name} onChange={(event) => { fieldsChanged(); setName(event.target.value); }} /></label>
        <p>Compatible Profiles: {choices.length}/50 selected.</p>
        {loading && <p role="status">Loading compatible Profiles...</p>}
        {!loading && !profiles.length && <p>No compatible Profiles on this page. Workflow-only copies are allowed.</p>}
        {profiles.map((item) => {
          const chosen = choices.find((choice) => choice.version_id === item.id);
          return <div className="global-profile-choice" key={item.familyId}>
            <label className="checkbox-row"><input type="checkbox" checked={Boolean(chosen)} disabled={item.incompatible || (!chosen && choices.length >= 50)} onChange={(event) => { fieldsChanged(); setChoices(event.target.checked ? [...choices, { version_id: item.id, name: item.name }] : choices.filter((choice) => choice.version_id !== item.id)); }} /> {item.name}{review.direction === "import" ? ` / v${item.version}` : ""}</label>
            {item.incompatible && <p>Profile mappings need review</p>}
            <button type="button" className="button-link" disabled={!item.id} onClick={() => { setInspection(null); setInspectSelection({ id: item.id }); }}>Inspect {item.name}</button>
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
      </fieldset>
      {historyLoading && <p role="status">Loading exact Profile revision...</p>}
      {historyInvalid && <button type="button" className="button-link" onClick={() => { setHistorySelection(null); setHistoryInvalid(false); setHistoryLoading(false); setInspection(null); setError(null); }}>Keep previous compatible selection</button>}
      <div className="global-library-actions"><button type="button" className="button-primary" disabled={busy || loading || historyLoading || historyInvalid || !ready || choices.some((item) => !item.name.trim())} onClick={() => void submit()}>{busy ? "Copying..." : "Confirm copy"}</button>
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
