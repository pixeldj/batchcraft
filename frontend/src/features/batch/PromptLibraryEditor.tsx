import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import { ApiError, type BatchcraftApi } from "../../api/client";
import type { LibraryPromptVersion, ProjectPrompt } from "../../api/types";
import { OverlayPortal } from "../../components/OverlayPortal";
import { errorMessage } from "../../utils/errors";
import { ConfigurationSection } from "./ConfigurationSection";
import type { HistoricalImportCopyResolutions, PromptForm } from "./form";

interface Props {
  api: BatchcraftApi;
  projectId: string;
  prompts: PromptForm[];
  historicalImportCopyResolutions?: HistoricalImportCopyResolutions;
  sourceRunId?: string | null;
  onChange(prompts: PromptForm[]): void;
  onHistoricalImport?(
    prompts: PromptForm[],
    resolutions: HistoricalImportCopyResolutions,
  ): void;
  onMetadataChange(prompts: PromptForm[]): void;
}

type WorkspacePanel = "browse" | "create" | "edit" | "duplicate" | "history";

interface PromptDraft {
  text: string;
  note: string;
  error: string | null;
  saving: boolean;
}

interface CreateDraft {
  name: string;
  text: string;
  description: string;
  error: string | null;
  saving: boolean;
}

const PROJECT_NOT_FOUND_MESSAGE = "Project was not found. Check the Project ID and try again.";
const EMPTY_CREATE_DRAFT: CreateDraft = {
  name: "",
  text: "",
  description: "",
  error: null,
  saving: false,
};
let nextLocalKey = 1;

export function PromptLibraryEditor({
  api,
  projectId,
  prompts,
  historicalImportCopyResolutions = {
    promptVersions: [],
    workflowVersion: null,
    workflowProfileVersion: null,
  },
  sourceRunId = null,
  onChange,
  onHistoricalImport = onChange,
  onMetadataChange,
}: Props) {
  const [library, setLibrary] = useState<{
    projectId: string;
    prompts: ProjectPrompt[];
    loading: boolean;
    error: string | null;
  }>({ projectId: "", prompts: [], loading: false, error: null });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspacePanel, setWorkspacePanel] = useState<WorkspacePanel>("browse");
  const [search, setSearch] = useState("");
  const [inspectedPromptId, setInspectedPromptId] = useState<string | null>(null);
  const [viewedVersion, setViewedVersion] = useState<LibraryPromptVersion | null>(null);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(EMPTY_CREATE_DRAFT);
  const [editDraft, setEditDraft] = useState<PromptDraft | null>(null);
  const [duplicateDraft, setDuplicateDraft] = useState<CreateDraft | null>(null);
  const [historyCache, setHistoryCache] = useState<Record<string, LibraryPromptVersion[]>>({});
  const [historyState, setHistoryState] = useState<{
    promptId: string;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [detachedState, setDetachedState] = useState<Record<number, "checking" | "detached" | "integrity">>({});
  const [importState, setImportState] = useState<Record<number, { saving: boolean; error: string | null }>>({});
  const loadTag = useRef(0);
  const historyTag = useRef(0);
  const detachedTag = useRef(0);
  const projectIdRef = useRef(projectId.trim());
  const workspaceTrigger = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceDialogRef = useRef<HTMLDialogElement>(null);
  const checkedDetached = useRef(new Set<string>());
  const reconnectPatches = useRef(new Map<number, Partial<Pick<
    PromptForm,
    "libraryProjectId" | "promptId" | "promptName" | "versionNumber" | "placeholders"
  >>>());
  const historicalPositions = useRef<{ runId: string | null; positions: Map<number, number> }>({
    runId: null,
    positions: new Map(),
  });
  const promptMutationContexts = useRef(new Map<number, { signature: string; generation: number }>());
  const notifyMetadataChange = useEffectEvent(onMetadataChange);
  const promptsRef = useRef(prompts);
  const resolutionsRef = useRef(historicalImportCopyResolutions);
  const historicalImportRef = useRef(onHistoricalImport);
  promptsRef.current = prompts;
  resolutionsRef.current = historicalImportCopyResolutions;
  historicalImportRef.current = onHistoricalImport;
  const applyReconnectPatches = useEffectEvent(() => {
    let changed = false;
    const updated = prompts.map((prompt) => {
      const patch = reconnectPatches.current.get(prompt.key);
      if (!patch) return prompt;
      if (Object.entries(patch).every(([key, value]) => prompt[key as keyof PromptForm] === value)) {
        return prompt;
      }
      changed = true;
      return { ...prompt, ...patch };
    });
    if (changed) notifyMetadataChange(updated);
  });
  const selectedVersionsSignature = prompts
    .map((prompt) => detachedSignature(projectId, prompt))
    .join("\u0001");
  const normalizedProjectId = projectId.trim();
  projectIdRef.current = normalizedProjectId;
  const historicalKeysChanged = prompts.length > 0
    && prompts.every((prompt) => prompt.historicalVersionId !== null)
    && prompts.every((prompt) => !historicalPositions.current.positions.has(prompt.key));
  if (historicalPositions.current.runId !== sourceRunId || historicalKeysChanged) {
    historicalPositions.current = {
      runId: sourceRunId,
      positions: new Map(prompts.map((prompt, index) => [
        prompt.key,
        prompt.historicalPosition ?? index,
      ])),
    };
  }
  for (const prompt of prompts) {
    const signature = historicalPromptSignature(sourceRunId, normalizedProjectId, prompt);
    const context = promptMutationContexts.current.get(prompt.key);
    if (!context || context.signature !== signature) {
      promptMutationContexts.current.set(prompt.key, {
        signature,
        generation: (context?.generation ?? 0) + 1,
      });
    }
  }

  const activeLibrary = library.projectId === normalizedProjectId ? library : {
    projectId: normalizedProjectId,
    prompts: [],
    loading: Boolean(normalizedProjectId),
    error: null,
  };
  const inspectedPrompt = activeLibrary.prompts.find((prompt) => prompt.id === inspectedPromptId) ?? null;
  const workspaceSaving = createDraft.saving || Boolean(editDraft?.saving) || Boolean(duplicateDraft?.saving);
  const selectionHasIssue = prompts.some((prompt) => {
    const projectMismatch = Boolean(
      prompt.libraryProjectId && prompt.libraryProjectId !== normalizedProjectId,
    );
    const missingLogicalPrompt = !activeLibrary.loading
      && !activeLibrary.error
      && Boolean(prompt.promptId)
      && !activeLibrary.prompts.some((item) => item.id === prompt.promptId);
    return projectMismatch
      || !prompt.promptId
      || !prompt.libraryProjectId
      || missingLogicalPrompt
      || Boolean(detachedState[prompt.key]);
  });
  const collapsible = Boolean(
    normalizedProjectId
    && prompts.length > 0
    && !activeLibrary.loading
    && !activeLibrary.error
    && !selectionHasIssue,
  );

  useEffect(() => {
    const requestedProjectId = projectId.trim();
    const tag = ++loadTag.current;
    const controller = new AbortController();
    checkedDetached.current.clear();
    reconnectPatches.current.clear();
    setDetachedState({});
    setWorkspaceOpen(false);
    setWorkspacePanel("browse");
    setSearch("");
    setInspectedPromptId(null);
    setViewedVersion(null);
    setCreateDraft(EMPTY_CREATE_DRAFT);
    setEditDraft(null);
    setDuplicateDraft(null);
    setHistoryCache({});
    setHistoryState(null);

    if (!requestedProjectId) {
      setLibrary({ projectId, prompts: [], loading: false, error: null });
      return () => controller.abort();
    }

    setLibrary({ projectId, prompts: [], loading: true, error: null });
    void api.listPrompts(requestedProjectId, controller.signal).then(
      (response) => {
        if (tag !== loadTag.current || controller.signal.aborted) return;
        setLibrary({ projectId, prompts: response.prompts, loading: false, error: null });
      },
      (caught: unknown) => {
        if (tag !== loadTag.current || isAbortError(caught)) return;
        const message = caught instanceof ApiError && caught.code === "project_not_found"
          ? PROJECT_NOT_FOUND_MESSAGE
          : errorMessage(caught);
        setLibrary({ projectId, prompts: [], loading: false, error: message });
      },
    );

    return () => controller.abort();
  }, [api, projectId, loadAttempt]);

  useEffect(() => {
    if (activeLibrary.loading || activeLibrary.error || !normalizedProjectId) return;
    const currentPrompts = promptsRef.current;
    const namesUpdated = currentPrompts.map((prompt) => {
      if (prompt.libraryProjectId !== normalizedProjectId || !prompt.promptId) return prompt;
      const currentPrompt = activeLibrary.prompts.find((item) => item.id === prompt.promptId);
      return currentPrompt && currentPrompt.name !== prompt.promptName
        ? { ...prompt, promptName: currentPrompt.name }
        : prompt;
    });
    if (namesUpdated.some((prompt, index) => prompt !== currentPrompts[index])) {
      notifyMetadataChange(namesUpdated);
    }
    const candidates = currentPrompts.filter((prompt) =>
      (!prompt.libraryProjectId || prompt.libraryProjectId === normalizedProjectId)
      && Boolean(prompt.versionId),
    );
    if (candidates.length === 0) return;

    const tag = ++detachedTag.current;
    const controller = new AbortController();
    const checked = checkedDetached.current;
    for (const prompt of candidates) {
      if (
        prompt.historicalResourceStatus
        && prompt.historicalResourceStatus !== "linked"
        && prompt.versionId === prompt.historicalVersionId
      ) {
        setDetachedState((current) => ({
          ...current,
          [prompt.key]: prompt.historicalResourceStatus === "conflict" ? "integrity" : "detached",
        }));
        continue;
      }
      const signature = detachedSignature(normalizedProjectId, prompt);
      if (checked.has(signature)) continue;
      checked.add(signature);
      setDetachedState((current) => ({ ...current, [prompt.key]: "checking" }));
      void api.getPromptVersion(prompt.versionId, controller.signal).then(
        (version) => {
          if (tag !== detachedTag.current || controller.signal.aborted) return;
          const logicalPrompt = activeLibrary.prompts.find((item) => item.id === version.prompt_id);
          const exact = version.id === prompt.versionId
            && version.name_snapshot === prompt.snapshotName
            && version.text === prompt.text;
          if (exact && logicalPrompt && !version.archived_at) {
            reconnectPatches.current.set(prompt.key, {
              libraryProjectId: normalizedProjectId,
              promptId: logicalPrompt.id,
              promptName: logicalPrompt.name,
              versionNumber: version.version_number,
              placeholders: version.placeholders,
            });
            applyReconnectPatches();
            setDetachedState((current) => omitKey(current, prompt.key));
          } else if (exact && (!logicalPrompt || version.archived_at)) {
            reconnectPatches.current.set(prompt.key, {
              libraryProjectId: null,
              promptId: null,
              placeholders: version.placeholders,
            });
            applyReconnectPatches();
            setDetachedState((current) => omitKey(current, prompt.key));
          } else if (version.id === prompt.versionId && !exact) {
            setDetachedState((current) => ({ ...current, [prompt.key]: "integrity" }));
          } else {
            setDetachedState((current) => omitKey(current, prompt.key));
          }
        },
        (caught: unknown) => {
          if (tag !== detachedTag.current || isAbortError(caught)) return;
          if (
            caught instanceof ApiError
            && caught.code === "prompt_version_not_found"
            && prompt.libraryProjectId === normalizedProjectId
          ) {
            reconnectPatches.current.set(prompt.key, { libraryProjectId: null, promptId: null });
            applyReconnectPatches();
          }
          setDetachedState((current) => omitKey(current, prompt.key));
        },
      );
    }
    return () => {
      controller.abort();
      for (const prompt of candidates) checked.delete(detachedSignature(normalizedProjectId, prompt));
    };
  }, [activeLibrary.error, activeLibrary.loading, activeLibrary.prompts, api, normalizedProjectId, selectedVersionsSignature]);

  useEffect(() => {
    if (!workspaceOpen) return;
    closeButtonRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const trigger = workspaceTrigger.current;
    return () => {
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [workspaceOpen]);

  useEffect(() => {
    if (!workspaceOpen || workspacePanel !== "history" || !inspectedPromptId) return;
    if (historyCache[inspectedPromptId]) {
      setHistoryState({ promptId: inspectedPromptId, loading: false, error: null });
      return;
    }
    const tag = ++historyTag.current;
    const controller = new AbortController();
    setHistoryState({ promptId: inspectedPromptId, loading: true, error: null });
    void api.listPromptVersions(inspectedPromptId, true, controller.signal).then(
      (response) => {
        if (tag !== historyTag.current || controller.signal.aborted) return;
        setHistoryCache((current) => ({ ...current, [inspectedPromptId]: response.prompt_versions }));
        setHistoryState({ promptId: inspectedPromptId, loading: false, error: null });
      },
      (caught: unknown) => {
        if (tag !== historyTag.current || isAbortError(caught)) return;
        setHistoryState({ promptId: inspectedPromptId, loading: false, error: errorMessage(caught) });
      },
    );
    return () => controller.abort();
  }, [api, historyCache, historyRetry, inspectedPromptId, workspaceOpen, workspacePanel]);

  function freshKey(): number {
    const used = new Set(prompts.map((prompt) => prompt.key));
    while (used.has(nextLocalKey)) nextLocalKey += 1;
    return nextLocalKey++;
  }

  function inspectPrompt(logicalPrompt: ProjectPrompt) {
    setInspectedPromptId(logicalPrompt.id);
    setViewedVersion(logicalPrompt.latest_active_version);
    setWorkspacePanel("browse");
  }

  function openWorkspace(trigger: HTMLButtonElement) {
    workspaceTrigger.current = trigger;
    setExpanded(true);
    const initial = activeLibrary.prompts.find((logicalPrompt) =>
      logicalPrompt.id === inspectedPromptId,
    ) ?? activeLibrary.prompts[0] ?? null;
    if (initial) {
      setInspectedPromptId(initial.id);
      setViewedVersion(initial.latest_active_version);
    }
    setWorkspacePanel("browse");
    setWorkspaceOpen(true);
  }

  function closeWorkspace() {
    setWorkspaceOpen(false);
    setWorkspacePanel("browse");
  }

  function appendViewedVersion() {
    if (!inspectedPrompt || !viewedVersion || viewedVersion.archived_at) return;
    if (prompts.some((prompt) => prompt.versionId === viewedVersion.id)) return;
    onChange([
      ...prompts,
      promptForm(freshKey(), normalizedProjectId, inspectedPrompt.name, viewedVersion),
    ]);
  }

  async function createPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createDraft.saving) return;
    setCreateDraft((current) => ({ ...current, saving: true, error: null }));
    const requestedProjectId = normalizedProjectId;
    try {
      const response = await api.createPrompt(requestedProjectId, {
        name: createDraft.name,
        text: createDraft.text,
        description: createDraft.description.trim() || null,
      });
      if (projectIdRef.current !== requestedProjectId) return;
      const logicalPrompt: ProjectPrompt = { ...response.prompt, latest_active_version: response.version };
      setLibrary((current) => current.projectId === projectId
        ? { ...current, prompts: [...current.prompts, logicalPrompt] }
        : current);
      setCreateDraft(EMPTY_CREATE_DRAFT);
      setInspectedPromptId(logicalPrompt.id);
      setViewedVersion(response.version);
      setWorkspacePanel("browse");
    } catch (caught) {
      if (projectIdRef.current !== requestedProjectId) return;
      setCreateDraft((current) => ({ ...current, saving: false, error: errorMessage(caught) }));
    }
  }

  function openEdit() {
    if (!viewedVersion) return;
    setEditDraft({ text: viewedVersion.text, note: "", error: null, saving: false });
    setWorkspacePanel("edit");
  }

  async function createVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inspectedPrompt || !editDraft || editDraft.saving) return;
    setEditDraft((current) => current && ({ ...current, saving: true, error: null }));
    const requestedProjectId = normalizedProjectId;
    try {
      const version = await api.createPromptVersion(inspectedPrompt.id, {
        text: editDraft.text,
        note: editDraft.note.trim() || null,
      });
      if (projectIdRef.current !== requestedProjectId) return;
      setHistoryCache((current) => {
        const cached = current[inspectedPrompt.id];
        return cached ? { ...current, [inspectedPrompt.id]: [version, ...cached] } : current;
      });
      setLibrary((current) => current.projectId === projectId ? {
        ...current,
        prompts: current.prompts.map((prompt) => prompt.id === inspectedPrompt.id
          ? { ...prompt, latest_active_version: version }
          : prompt),
      } : current);
      setViewedVersion(version);
      setEditDraft(null);
      setWorkspacePanel("browse");
    } catch (caught) {
      if (projectIdRef.current !== requestedProjectId) return;
      setEditDraft((current) => current && ({ ...current, saving: false, error: errorMessage(caught) }));
    }
  }

  function openDuplicate() {
    if (!inspectedPrompt || !viewedVersion) return;
    setDuplicateDraft({
      name: suggestCopyName(inspectedPrompt.name, activeLibrary.prompts),
      text: viewedVersion.text,
      description: inspectedPrompt.description ?? "",
      error: null,
      saving: false,
    });
    setWorkspacePanel("duplicate");
  }

  async function duplicatePrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!duplicateDraft || duplicateDraft.saving) return;
    setDuplicateDraft((current) => current && ({ ...current, saving: true, error: null }));
    const requestedProjectId = normalizedProjectId;
    try {
      const response = await api.createPrompt(requestedProjectId, {
        name: duplicateDraft.name,
        text: duplicateDraft.text,
        description: duplicateDraft.description.trim() || null,
      });
      if (projectIdRef.current !== requestedProjectId) return;
      const logicalPrompt: ProjectPrompt = { ...response.prompt, latest_active_version: response.version };
      setLibrary((current) => current.projectId === projectId
        ? { ...current, prompts: [...current.prompts, logicalPrompt] }
        : current);
      setDuplicateDraft(null);
      setInspectedPromptId(logicalPrompt.id);
      setViewedVersion(response.version);
      setWorkspacePanel("browse");
    } catch (caught) {
      if (projectIdRef.current !== requestedProjectId) return;
      setDuplicateDraft((current) => current && ({
        ...current,
        saving: false,
        error: errorMessage(caught),
      }));
    }
  }

  function move(index: number, offset: -1 | 1) {
    const updated = [...prompts];
    const [prompt] = updated.splice(index, 1);
    updated.splice(index + offset, 0, prompt);
    onChange(updated);
  }

  async function importHistoricalPrompt(prompt: PromptForm) {
    const position = historicalPositions.current.positions.get(prompt.key);
    if (!sourceRunId || position === undefined || importState[prompt.key]?.saving) return;
    const requestedRunId = sourceRunId;
    const requestedContext = promptMutationContexts.current.get(prompt.key);
    if (!requestedContext) return;
    const contextIsCurrent = () => {
      const current = promptMutationContexts.current.get(prompt.key);
      const currentPrompt = promptsRef.current.find((item) => item.key === prompt.key);
      return historicalPositions.current.runId === requestedRunId
        && currentPrompt !== undefined
        && current?.generation === requestedContext.generation
        && current.signature === requestedContext.signature;
    };
    setImportState((current) => ({ ...current, [prompt.key]: { saving: true, error: null } }));
    try {
      const response = await api.importRunPromptVersion(requestedRunId, position, {
        import_request_id: `prompt:${position}:${prompt.historicalVersionId ?? prompt.versionId}`,
        name: prompt.snapshotName || prompt.promptName || "Prompt",
        description: null,
        note: null,
      });
      if (!contextIsCurrent()) {
        setImportState((current) => omitKey(current, prompt.key));
        return;
      }
      const logicalPrompt: ProjectPrompt = { ...response.prompt, latest_active_version: response.version };
      setLibrary((current) => current.projectId === normalizedProjectId
        ? { ...current, prompts: [...current.prompts, logicalPrompt] }
        : current);
      const latestPrompts = promptsRef.current;
      const importedPrompts = latestPrompts.map((item) => item.key === prompt.key
        ? {
          ...promptForm(item.key, normalizedProjectId, response.prompt.name, response.version),
          historicalPosition: position,
          historicalVersionId: prompt.historicalVersionId ?? prompt.versionId,
          historicalResourceStatus: prompt.historicalResourceStatus,
          historicalResourceReason: prompt.historicalResourceReason,
        }
        : item);
      const resolutions = resolutionsRef.current;
      const importedResolutions = {
        ...resolutions,
        promptVersions: [
          ...resolutions.promptVersions.filter((item) => item.position !== position),
          {
            position,
            historicalVersionId: prompt.historicalVersionId ?? prompt.versionId,
            copiedVersionId: response.version.id,
          },
        ].sort((left, right) => left.position - right.position),
      };
      promptsRef.current = importedPrompts;
      resolutionsRef.current = importedResolutions;
      historicalImportRef.current(importedPrompts, importedResolutions);
      setImportState((current) => omitKey(current, prompt.key));
    } catch (caught) {
      if (!contextIsCurrent()) {
        setImportState((current) => omitKey(current, prompt.key));
        return;
      }
      setImportState((current) => ({
        ...current,
        [prompt.key]: { saving: false, error: errorMessage(caught) },
      }));
    }
  }

  function handleWorkspaceKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (workspaceSaving) return;
      closeWorkspace();
      return;
    }
    if (event.key !== "Tab") return;

    const dialog = workspaceDialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hidden);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const filteredLibrary = activeLibrary.prompts.filter((prompt) =>
    prompt.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );

  return (
    <ConfigurationSection
      title="Prompts"
      summary={`${prompts.length} ${prompts.length === 1 ? "prompt" : "prompts"}`}
      expanded={expanded}
      collapsible={collapsible}
      controlsId="prompt-controls"
      action={(
        <button
          className="button-secondary compact"
          type="button"
          disabled={!projectId.trim() || activeLibrary.loading || Boolean(activeLibrary.error)}
          onClick={(event) => openWorkspace(event.currentTarget)}
        >
          Add Prompt
        </button>
      )}
      onExpandedChange={setExpanded}
    >
      {!projectId.trim() ? <p className="empty-note">Select a Project to load its Prompt library.</p> : null}
      {activeLibrary.loading ? <p role="status">Loading Prompt library...</p> : null}
      {activeLibrary.error ? (
        <div className="operation-error" role="alert">
          <p>{activeLibrary.error}</p>
          <button className="button-link" type="button" onClick={() => setLoadAttempt((value) => value + 1)}>
            Retry
          </button>
        </div>
      ) : null}
      {!activeLibrary.loading && !activeLibrary.error && projectId.trim() && activeLibrary.prompts.length === 0 ? (
        <p className="empty-note">This Project has no active Prompts. Open the library to create one.</p>
      ) : null}

      <div className="repeater-stack">
        {prompts.map((prompt, index) => {
          const currentPrompt = activeLibrary.prompts.find((item) => item.id === prompt.promptId);
          const projectMismatch = Boolean(
            prompt.libraryProjectId && prompt.libraryProjectId !== normalizedProjectId,
          );
          const authoritativeDetached = prompt.historicalResourceStatus === "detached"
            && prompt.versionId === prompt.historicalVersionId;
          const authoritativeConflict = prompt.historicalResourceStatus === "conflict"
            && prompt.versionId === prompt.historicalVersionId;
          const detached = !authoritativeConflict && (
            authoritativeDetached || (Boolean(prompt.promptId) && !projectMismatch && !currentPrompt)
          );
          const importable = Boolean(sourceRunId)
            && historicalPositions.current.positions.has(prompt.key)
            && (
              projectMismatch
              || !prompt.promptId
              || !prompt.libraryProjectId
              || detached
              || detachedState[prompt.key] === "integrity"
              || authoritativeConflict
            );
          const logicalName = currentPrompt?.name ?? prompt.promptName ?? prompt.snapshotName;
          return (
            <article className="repeater-card prompt-card" key={prompt.key}>
              <div className="repeater-title">
                <div>
                  <strong>{logicalName}</strong>{" "}
                  {prompt.versionNumber !== null ? <span className="prompt-revision">v{prompt.versionNumber}</span> : null}
                </div>
                <div className="repeater-actions">
                  <button className="button-link" type="button" disabled={index === 0} onClick={() => move(index, -1)}>Move up</button>
                  <button className="button-link" type="button" disabled={index === prompts.length - 1} onClick={() => move(index, 1)}>Move down</button>
                  <button className="button-link danger" type="button" onClick={() => onChange(prompts.filter((item) => item.key !== prompt.key))}>Remove</button>
                </div>
              </div>
              {logicalName !== prompt.snapshotName ? <p className="section-note">Saved as {prompt.snapshotName}</p> : null}
              <pre className="prompt-editor">{prompt.text}</pre>
              {projectMismatch ? <p className="blocked-note" role="alert">This Prompt belongs to another Project.</p> : null}
              {!authoritativeConflict && (!prompt.promptId || !prompt.libraryProjectId) ? <p className="blocked-note" role="alert">This PromptVersion is detached from the Prompt library.</p> : null}
              {detached ? <p className="blocked-note" role="alert">{prompt.historicalResourceReason ?? "The linked Prompt is not registered in this Project."}</p> : null}
              {detachedState[prompt.key] === "checking" ? <p role="status">Checking library linkage...</p> : null}
              {detachedState[prompt.key] === "integrity" || authoritativeConflict ? (
                <p className="blocked-note" role="alert">PromptVersion integrity check failed: {prompt.historicalResourceReason ?? "stored content differs from the library."}</p>
              ) : null}
              {importable ? (
                <div className="repeater-actions">
                  <button
                    className="button-secondary compact"
                    type="button"
                    disabled={importState[prompt.key]?.saving}
                    onClick={() => void importHistoricalPrompt(prompt)}
                  >
                    {importState[prompt.key]?.saving ? "Importing snapshot..." : "Import historical snapshot"}
                  </button>
                </div>
              ) : null}
              {importState[prompt.key]?.error ? (
                <p className="operation-error" role="alert">Prompt snapshot import failed. {importState[prompt.key].error}</p>
              ) : null}
            </article>
          );
        })}
      </div>

      {workspaceOpen ? (
        <OverlayPortal level="prompt-library">
          <dialog
            ref={workspaceDialogRef}
            className="prompt-library-dialog"
            open
            aria-modal="true"
            aria-busy={workspaceSaving || undefined}
            aria-labelledby="prompt-library-title"
            onCancel={closeWorkspace}
            onKeyDown={handleWorkspaceKeyDown}
          >
            <header className="prompt-library-header">
              <div>
                <p className="prompt-library-kicker">Project library</p>
                <h2 id="prompt-library-title">Prompts</h2>
              </div>
              <div className="prompt-library-header-actions">
                <button
                  className="button-primary"
                  type="button"
                  disabled={workspaceSaving}
                  onClick={() => {
                    setCreateDraft(EMPTY_CREATE_DRAFT);
                    setWorkspacePanel("create");
                  }}
                >
                  New Prompt
                </button>
                <button className="button-link" type="button" disabled={workspaceSaving} onClick={closeWorkspace} ref={closeButtonRef}>Close</button>
              </div>
            </header>

            <div className="prompt-library-workspace">
              <aside className="prompt-library-sidebar" aria-label="Prompt library">
                <label className="field">
                  <span className="field-label">Search Prompts</span>
                  <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
                </label>
                <div className="prompt-library-list">
                  {filteredLibrary.map((logicalPrompt) => {
                    const selectedRevisions = prompts
                      .filter((prompt) => prompt.promptId === logicalPrompt.id)
                      .map((prompt) => prompt.versionNumber === null ? "unknown revision" : `v${prompt.versionNumber}`);
                    return (
                      <button
                        className={`prompt-library-item${logicalPrompt.id === inspectedPromptId ? " inspected" : ""}`}
                        type="button"
                        key={logicalPrompt.id}
                        disabled={workspaceSaving}
                        aria-current={logicalPrompt.id === inspectedPromptId ? "true" : undefined}
                        onClick={() => inspectPrompt(logicalPrompt)}
                      >
                        <strong>{logicalPrompt.name}</strong>
                        <span>{logicalPrompt.latest_active_version ? `v${logicalPrompt.latest_active_version.version_number}` : "No active revision"}</span>
                        {selectedRevisions.length ? (
                          <span className="prompt-library-selected">In Batch: {selectedRevisions.join(", ")}</span>
                        ) : null}
                      </button>
                    );
                  })}
                  {activeLibrary.prompts.length > 0 && filteredLibrary.length === 0 ? (
                    <p className="empty-note">No Prompts match this search.</p>
                  ) : null}
                </div>
              </aside>

              <main className="prompt-library-main">
                {activeLibrary.prompts.length === 0 && workspacePanel === "browse" ? (
                  <section className="prompt-library-empty" aria-labelledby="empty-prompt-library-title">
                    <h3 id="empty-prompt-library-title">Create your first Prompt</h3>
                    <p>Prompts keep reusable template text and its revision history together.</p>
                    <button className="button-primary" type="button" onClick={() => setWorkspacePanel("create")}>New Prompt</button>
                  </section>
                ) : null}

                {workspacePanel === "browse" && inspectedPrompt && viewedVersion ? (
                  <PromptInspection
                    prompt={inspectedPrompt}
                    version={viewedVersion}
                    selected={prompts.some((prompt) => prompt.versionId === viewedVersion.id)}
                    onAdd={appendViewedVersion}
                    onEdit={openEdit}
                    onDuplicate={openDuplicate}
                    onHistory={() => setWorkspacePanel("history")}
                  />
                ) : null}

                {workspacePanel === "create" ? (
                  <PromptCreateForm
                    title="New Prompt"
                    draft={createDraft}
                    submitLabel="Create Prompt"
                    onDraftChange={setCreateDraft}
                    onSubmit={createPrompt}
                    onCancel={() => setWorkspacePanel("browse")}
                  />
                ) : null}

                {workspacePanel === "edit" && editDraft && inspectedPrompt && viewedVersion ? (
                  <section aria-labelledby="edit-prompt-title">
                    <h3 id="edit-prompt-title">Edit Prompt</h3>
                    <p className="prompt-library-helper">Saving creates a new revision and preserves v{viewedVersion.version_number} and every Batch selection.</p>
                    <form onSubmit={createVersion}>
                      <label className="field">
                        <span className="field-label">Prompt template</span>
                        <textarea autoFocus required value={editDraft.text} onChange={(event) => setEditDraft((current) => current && ({ ...current, text: event.target.value }))} />
                      </label>
                      <label className="field">
                        <span className="field-label">Revision note (optional)</span>
                        <textarea value={editDraft.note} onChange={(event) => setEditDraft((current) => current && ({ ...current, note: event.target.value }))} />
                      </label>
                      {editDraft.error ? <p className="operation-error" role="alert">{editDraft.error}</p> : null}
                      <div className="prompt-library-form-actions">
                        <button className="button-secondary" type="button" disabled={editDraft.saving} onClick={() => setWorkspacePanel("browse")}>Cancel</button>
                        <button className="button-primary" type="submit" disabled={editDraft.saving}>{editDraft.saving ? "Saving..." : "Save revision"}</button>
                      </div>
                    </form>
                  </section>
                ) : null}

                {workspacePanel === "duplicate" && duplicateDraft ? (
                  <PromptCreateForm
                    title="Duplicate Prompt"
                    draft={duplicateDraft}
                    submitLabel="Duplicate Prompt"
                    onDraftChange={(value) => setDuplicateDraft((current) => {
                      if (!current) return current;
                      return typeof value === "function" ? value(current) : value;
                    })}
                    onSubmit={duplicatePrompt}
                    onCancel={() => setWorkspacePanel("browse")}
                  />
                ) : null}

                {workspacePanel === "history" && inspectedPrompt ? (
                  <section aria-labelledby="prompt-history-title">
                    <div className="prompt-library-panel-heading">
                      <div>
                        <h3 id="prompt-history-title">History</h3>
                        <p>{inspectedPrompt.name}</p>
                      </div>
                      <button className="button-link" type="button" onClick={() => setWorkspacePanel("browse")}>Back to Prompt</button>
                    </div>
                    {historyState?.loading ? <p role="status">Loading history...</p> : null}
                    {historyState?.error ? (
                      <div className="operation-error" role="alert">
                        <p>{historyState.error}</p>
                        <button className="button-link" type="button" onClick={() => {
                          setHistoryCache((current) => omitStringKey(current, inspectedPrompt.id));
                          setHistoryRetry((current) => current + 1);
                        }}>Retry</button>
                      </div>
                    ) : null}
                    <div className="prompt-history-list">
                      {(historyCache[inspectedPrompt.id] ?? []).map((version) => {
                        const exactSelected = prompts.some((prompt) => prompt.versionId === version.id);
                        return (
                          <article className={`prompt-history-item${viewedVersion?.id === version.id ? " viewed" : ""}`} key={version.id}>
                            <button
                              className="prompt-history-inspect"
                              type="button"
                              aria-label={`Inspect revision ${version.version_number}`}
                              onClick={() => setViewedVersion(version)}
                            >
                              <strong>v{version.version_number}</strong>
                              <time dateTime={version.created_at}>{formatDate(version.created_at)}</time>
                              {version.archived_at ? <span>Archived</span> : null}
                            </button>
                            <pre className="prompt-editor">{version.text}</pre>
                            {version.note ? <p>{version.note}</p> : null}
                            <div className="repeater-actions">
                              <button
                                className="button-secondary compact"
                                type="button"
                                disabled={Boolean(version.archived_at) || exactSelected}
                                onClick={() => {
                                  setViewedVersion(version);
                                  if (!version.archived_at && !exactSelected) {
                                    onChange([...prompts, promptForm(freshKey(), normalizedProjectId, inspectedPrompt.name, version)]);
                                  }
                                }}
                              >
                                {version.archived_at ? "Archived" : exactSelected ? "Selected in Batch" : "Add this revision"}
                              </button>
                              <button className="button-link" type="button" onClick={() => {
                                setViewedVersion(version);
                                setDuplicateDraft({
                                  name: suggestCopyName(inspectedPrompt.name, activeLibrary.prompts),
                                  text: version.text,
                                  description: inspectedPrompt.description ?? "",
                                  error: null,
                                  saving: false,
                                });
                                setWorkspacePanel("duplicate");
                              }}>Duplicate</button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                ) : null}
              </main>
            </div>

            <footer className="prompt-library-footer">
              <div className="prompt-library-batch-selection" aria-label="Prompts selected for Batch">
                <strong>Batch order</strong>
                {prompts.length === 0 ? <span>No Prompts selected</span> : (
                  <ol>
                    {prompts.map((prompt, index) => (
                      <li key={prompt.key}>
                        <span>{prompt.promptName ?? prompt.snapshotName} {prompt.versionNumber === null ? "" : `v${prompt.versionNumber}`}</span>
                        <div className="repeater-actions">
                          <button className="button-link" type="button" disabled={index === 0} aria-label={`Move ${prompt.promptName ?? prompt.snapshotName} up`} onClick={() => move(index, -1)}>Up</button>
                          <button className="button-link" type="button" disabled={index === prompts.length - 1} aria-label={`Move ${prompt.promptName ?? prompt.snapshotName} down`} onClick={() => move(index, 1)}>Down</button>
                          <button className="button-link danger" type="button" aria-label={`Remove ${prompt.promptName ?? prompt.snapshotName}`} onClick={() => onChange(prompts.filter((item) => item.key !== prompt.key))}>Remove</button>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              <button className="button-primary" type="button" disabled={workspaceSaving} onClick={closeWorkspace}>Done</button>
            </footer>
          </dialog>
        </OverlayPortal>
      ) : null}
    </ConfigurationSection>
  );
}

function PromptInspection({
  prompt,
  version,
  selected,
  onAdd,
  onEdit,
  onDuplicate,
  onHistory,
}: {
  prompt: ProjectPrompt;
  version: LibraryPromptVersion;
  selected: boolean;
  onAdd(): void;
  onEdit(): void;
  onDuplicate(): void;
  onHistory(): void;
}) {
  return (
    <article className="prompt-library-inspection">
      <div className="prompt-library-panel-heading">
        <div>
          <p className="prompt-revision">v{version.version_number}</p>
          <h3>{prompt.name}</h3>
          {prompt.description ? <p className="prompt-library-description">{prompt.description}</p> : null}
        </div>
        <div className="prompt-library-inspection-actions">
          <button className="button-primary" type="button" disabled={selected || Boolean(version.archived_at)} onClick={onAdd}>
            {version.archived_at ? "Archived" : selected ? "Selected in Batch" : "Add to Batch"}
          </button>
          <button className="button-secondary" type="button" onClick={onEdit}>Edit Prompt</button>
          <button className="button-secondary" type="button" onClick={onDuplicate}>Duplicate</button>
          <button className="button-link" type="button" onClick={onHistory}>History</button>
        </div>
      </div>
      <pre className="prompt-library-text">{version.text}</pre>
    </article>
  );
}

function PromptCreateForm({
  title,
  draft,
  submitLabel,
  onDraftChange,
  onSubmit,
  onCancel,
}: {
  title: string;
  draft: CreateDraft;
  submitLabel: string;
  onDraftChange(value: CreateDraft | ((current: CreateDraft) => CreateDraft)): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  onCancel(): void;
}) {
  return (
    <section aria-labelledby="prompt-form-title">
      <h3 id="prompt-form-title">{title}</h3>
      <form onSubmit={onSubmit}>
        <label className="field">
          <span className="field-label">Prompt name</span>
          <input autoFocus required value={draft.name} onChange={(event) => onDraftChange((current) => ({ ...current, name: event.target.value }))} />
        </label>
        <label className="field">
          <span className="field-label">Prompt template</span>
          <textarea
            required
            value={draft.text}
            onChange={(event) => onDraftChange((current) => ({ ...current, text: event.target.value }))}
          />
        </label>
        <label className="field">
          <span className="field-label">Description (optional)</span>
          <textarea value={draft.description} onChange={(event) => onDraftChange((current) => ({ ...current, description: event.target.value }))} />
        </label>
        {draft.error ? <p className="operation-error" role="alert">{draft.error}</p> : null}
        <div className="prompt-library-form-actions">
          <button className="button-secondary" type="button" disabled={draft.saving} onClick={onCancel}>Cancel</button>
          <button className="button-primary" type="submit" disabled={draft.saving}>{draft.saving ? "Saving..." : submitLabel}</button>
        </div>
      </form>
    </section>
  );
}

function promptForm(
  key: number,
  libraryProjectId: string,
  promptName: string,
  version: LibraryPromptVersion,
): PromptForm {
  return {
    key,
    libraryProjectId,
    promptId: version.prompt_id,
    promptName,
    versionId: version.id,
    versionNumber: version.version_number,
    snapshotName: version.name_snapshot,
    text: version.text,
    placeholders: version.placeholders,
    historicalVersionId: null,
    historicalResourceStatus: null,
    historicalResourceReason: null,
  };
}

function historicalPromptSignature(
  sourceRunId: string | null,
  projectId: string,
  prompt: PromptForm,
): string {
  return JSON.stringify([
    sourceRunId,
    projectId,
    prompt.versionId,
    prompt.snapshotName,
    prompt.text,
    prompt.historicalVersionId,
    prompt.historicalResourceStatus,
  ]);
}

function suggestCopyName(sourceName: string, library: ProjectPrompt[]): string {
  const names = new Set(library.map((prompt) => prompt.name.trim().toLocaleLowerCase()));
  let suffix = 1;
  while (true) {
    const candidate = `${sourceName} copy${suffix === 1 ? "" : ` ${suffix}`}`;
    if (!names.has(candidate.toLocaleLowerCase())) return candidate;
    suffix += 1;
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function detachedSignature(projectId: string, prompt: PromptForm): string {
  return [projectId, prompt.key, prompt.versionId, prompt.snapshotName, prompt.text].join("\u0000");
}

function omitKey<T>(record: Record<number, T>, key: number): Record<number, T> {
  const updated = { ...record };
  delete updated[key];
  return updated;
}

function omitStringKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const updated = { ...record };
  delete updated[key];
  return updated;
}
