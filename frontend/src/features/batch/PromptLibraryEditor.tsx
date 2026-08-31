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
import { errorMessage } from "../../utils/errors";
import { ConfigurationSection } from "./ConfigurationSection";
import type { PromptForm } from "./form";

interface Props {
  api: BatchcraftApi;
  projectId: string;
  prompts: PromptForm[];
  onChange(prompts: PromptForm[]): void;
  onMetadataChange(prompts: PromptForm[]): void;
}

type AddView = "choice" | "existing" | "create";
type PromptDialog =
  | { kind: "history"; key: number; promptId: string }
  | { kind: "edit"; key: number; promptId: string }
  | { kind: "rename"; promptId: string }
  | { kind: "duplicate" };

interface DraftState {
  text: string;
  note: string;
  error: string | null;
  saving: boolean;
}

interface DuplicateDraft {
  name: string;
  text: string;
  description: string;
  error: string | null;
  saving: boolean;
}

const PROJECT_NOT_FOUND_MESSAGE = "Project was not found. Check the Project ID and try again.";
let nextLocalKey = 1;

export function PromptLibraryEditor({
  api,
  projectId,
  prompts,
  onChange,
  onMetadataChange,
}: Props) {
  const [library, setLibrary] = useState<{
    projectId: string;
    prompts: ProjectPrompt[];
    loading: boolean;
    error: string | null;
  }>({ projectId: "", prompts: [], loading: false, error: null });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [addView, setAddView] = useState<AddView | null>(null);
  const [createDraft, setCreateDraft] = useState({
    name: "",
    text: "",
    description: "",
    error: null as string | null,
    saving: false,
  });
  const [promptDialog, setPromptDialog] = useState<PromptDialog | null>(null);
  const [historyCache, setHistoryCache] = useState<Record<string, LibraryPromptVersion[]>>({});
  const [historyState, setHistoryState] = useState<{
    promptId: string;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [editDraft, setEditDraft] = useState<DraftState | null>(null);
  const [renameDraft, setRenameDraft] = useState({
    name: "",
    error: null as string | null,
    saving: false,
  });
  const [duplicateDraft, setDuplicateDraft] = useState<DuplicateDraft | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [detachedState, setDetachedState] = useState<Record<number, "checking" | "integrity">>({});
  const loadTag = useRef(0);
  const historyTag = useRef(0);
  const detachedTag = useRef(0);
  const projectIdRef = useRef(projectId.trim());
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  const checkedDetached = useRef(new Set<string>());
  const reconnectPatches = useRef(new Map<number, Partial<Pick<
    PromptForm,
    "libraryProjectId" | "promptId" | "promptName" | "versionNumber"
  >>>());
  const notifyMetadataChange = useEffectEvent(onMetadataChange);
  const getCurrentPrompts = useEffectEvent(() => prompts);
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

  const activeLibrary = library.projectId === projectId ? library : {
    projectId,
    prompts: [],
    loading: Boolean(projectId.trim()),
    error: null,
  };
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
    setAddView(null);
    setPromptDialog(null);
    setCreateDraft({ name: "", text: "", description: "", error: null, saving: false });
    setEditDraft(null);
    setRenameDraft({ name: "", error: null, saving: false });
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
    const currentPrompts = getCurrentPrompts();
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
            });
            applyReconnectPatches();
            setDetachedState((current) => omitKey(current, prompt.key));
          } else if (exact && (!logicalPrompt || version.archived_at)) {
            reconnectPatches.current.set(prompt.key, {
              libraryProjectId: null,
              promptId: null,
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
            reconnectPatches.current.set(prompt.key, {
              libraryProjectId: null,
              promptId: null,
            });
            applyReconnectPatches();
          }
          setDetachedState((current) => omitKey(current, prompt.key));
        },
      );
    }
    return () => {
      controller.abort();
      for (const prompt of candidates) {
        checked.delete(detachedSignature(normalizedProjectId, prompt));
      }
    };
  }, [activeLibrary.error, activeLibrary.loading, activeLibrary.prompts, api, normalizedProjectId, selectedVersionsSignature]);

  useEffect(() => {
    if (promptDialog?.kind !== "history") return;
    const { promptId } = promptDialog;
    if (historyCache[promptId]) {
      setHistoryState({ promptId, loading: false, error: null });
      return;
    }
    const tag = ++historyTag.current;
    const controller = new AbortController();
    setHistoryState({ promptId, loading: true, error: null });
    void api.listPromptVersions(promptId, true, controller.signal).then(
      (response) => {
        if (tag !== historyTag.current || controller.signal.aborted) return;
        setHistoryCache((current) => ({ ...current, [promptId]: response.prompt_versions }));
        setHistoryState({ promptId, loading: false, error: null });
      },
      (caught: unknown) => {
        if (tag !== historyTag.current || isAbortError(caught)) return;
        setHistoryState({ promptId, loading: false, error: errorMessage(caught) });
      },
    );
    return () => controller.abort();
  }, [api, historyCache, historyRetry, promptDialog]);

  function freshKey(): number {
    const used = new Set(prompts.map((prompt) => prompt.key));
    while (used.has(nextLocalKey)) nextLocalKey += 1;
    return nextLocalKey++;
  }

  function appendVersion(logicalPrompt: ProjectPrompt, version: LibraryPromptVersion) {
    setExpanded(true);
    onChange([...prompts, promptForm(freshKey(), normalizedProjectId, logicalPrompt.name, version)]);
  }

  function chooseExisting(logicalPrompt: ProjectPrompt) {
    const version = logicalPrompt.latest_active_version;
    if (!version || prompts.some((prompt) => prompt.versionId === version.id)) return;
    appendVersion(logicalPrompt, version);
    setAddView(null);
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
      appendVersion(logicalPrompt, response.version);
      setCreateDraft({ name: "", text: "", description: "", error: null, saving: false });
      closeDialogs();
    } catch (caught) {
      if (projectIdRef.current !== requestedProjectId) return;
      setCreateDraft((current) => ({ ...current, saving: false, error: errorMessage(caught) }));
    }
  }

  function selectVersion(key: number, promptId: string, version: LibraryPromptVersion) {
    if (
      version.archived_at
      || prompts.some((prompt) => prompt.key !== key && prompt.versionId === version.id)
    ) return;
    const logicalPrompt = activeLibrary.prompts.find((prompt) => prompt.id === promptId);
    if (!logicalPrompt) return;
    onChange(prompts.map((prompt) => prompt.key === key
      ? promptForm(prompt.key, normalizedProjectId, logicalPrompt.name, version)
      : prompt));
    closeDialogs();
  }

  function openEdit(prompt: PromptForm, trigger: HTMLButtonElement) {
    if (!prompt.promptId) return;
    dialogTrigger.current = trigger;
    setEditDraft({ text: prompt.text, note: "", error: null, saving: false });
    setPromptDialog({ kind: "edit", key: prompt.key, promptId: prompt.promptId });
  }

  async function createVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (promptDialog?.kind !== "edit" || !editDraft || editDraft.saving) return;
    setEditDraft((current) => current && ({ ...current, saving: true, error: null }));
    const requestedProjectId = normalizedProjectId;
    try {
      const version = await api.createPromptVersion(promptDialog.promptId, {
        text: editDraft.text,
        note: editDraft.note.trim() || null,
      });
      if (projectIdRef.current !== requestedProjectId) return;
      const logicalPrompt = activeLibrary.prompts.find((prompt) => prompt.id === promptDialog.promptId);
      if (!logicalPrompt) throw new Error("This Prompt is no longer available in the current Project.");
      onChange(prompts.map((prompt) => prompt.key === promptDialog.key
        ? promptForm(prompt.key, normalizedProjectId, logicalPrompt.name, version)
        : prompt));
      setHistoryCache((current) => {
        const cached = current[promptDialog.promptId];
        return cached ? { ...current, [promptDialog.promptId]: [version, ...cached] } : current;
      });
      setLibrary((current) => current.projectId === projectId ? {
        ...current,
        prompts: current.prompts.map((prompt) => prompt.id === promptDialog.promptId
          ? { ...prompt, latest_active_version: version }
          : prompt),
      } : current);
      closeDialogs();
      setEditDraft(null);
    } catch (caught) {
      if (projectIdRef.current !== requestedProjectId) return;
      setEditDraft((current) => current && ({ ...current, saving: false, error: errorMessage(caught) }));
    }
  }

  function openRename(promptId: string, currentName: string, trigger: HTMLButtonElement) {
    dialogTrigger.current = trigger;
    setRenameDraft({ name: currentName, error: null, saving: false });
    setPromptDialog({ kind: "rename", promptId });
  }

  async function renamePrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (promptDialog?.kind !== "rename" || renameDraft.saving) return;
    setRenameDraft((current) => ({ ...current, saving: true, error: null }));
    const requestedProjectId = normalizedProjectId;
    try {
      const updated = await api.updatePrompt(promptDialog.promptId, { name: renameDraft.name });
      if (projectIdRef.current !== requestedProjectId) return;
      setLibrary((current) => current.projectId === projectId ? {
        ...current,
        prompts: current.prompts.map((prompt) => prompt.id === updated.id
          ? { ...prompt, name: updated.name, updated_at: updated.updated_at }
          : prompt),
      } : current);
      onMetadataChange(prompts.map((prompt) => prompt.promptId === updated.id
        ? { ...prompt, promptName: updated.name }
        : prompt));
      closeDialogs();
    } catch (caught) {
      if (projectIdRef.current !== requestedProjectId) return;
      setRenameDraft((current) => ({ ...current, saving: false, error: errorMessage(caught) }));
    }
  }

  function openDuplicate(
    selectedVersion: PromptForm,
    logicalPrompt: ProjectPrompt,
    trigger: HTMLButtonElement,
  ) {
    dialogTrigger.current = trigger;
    setDuplicateDraft({
      name: `${logicalPrompt.name} copy`,
      text: selectedVersion.text,
      description: logicalPrompt.description ?? "",
      error: null,
      saving: false,
    });
    setPromptDialog({ kind: "duplicate" });
  }

  async function duplicatePrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (promptDialog?.kind !== "duplicate" || !duplicateDraft || duplicateDraft.saving) return;
    setDuplicateDraft((current) => current && ({ ...current, saving: true, error: null }));
    const requestedProjectId = normalizedProjectId;
    try {
      await api.createPrompt(requestedProjectId, {
        name: duplicateDraft.name,
        text: duplicateDraft.text,
        description: duplicateDraft.description.trim() || null,
      });
      if (projectIdRef.current !== requestedProjectId) return;
      closeDialogs();
      setDuplicateDraft(null);
      setLoadAttempt((current) => current + 1);
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

  function cancelDialog(event?: { preventDefault(): void }) {
    event?.preventDefault();
    closeDialogs();
  }

  function closeDialogs() {
    setAddView(null);
    setPromptDialog(null);
    dialogTrigger.current?.focus();
  }

  function cancelOnEscape(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") cancelDialog(event);
  }

  return (
    <ConfigurationSection
      title="Prompt Versions"
      summary={`${prompts.length} ${prompts.length === 1 ? "prompt" : "prompts"}`}
      expanded={expanded}
      collapsible={collapsible}
      controlsId="prompt-version-controls"
      action={(
        <button
          className="button-secondary compact"
          type="button"
          disabled={!projectId.trim() || activeLibrary.loading || Boolean(activeLibrary.error)}
          onClick={(event) => {
            dialogTrigger.current = event.currentTarget;
            setExpanded(true);
            setAddView("choice");
          }}
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
        <p className="empty-note">This Project has no active Prompts.</p>
      ) : null}

      <div className="repeater-stack">
        {prompts.map((prompt, index) => {
          const currentPrompt = activeLibrary.prompts.find((item) => item.id === prompt.promptId);
          const projectMismatch = Boolean(
            prompt.libraryProjectId && prompt.libraryProjectId !== normalizedProjectId
          );
          const detached = Boolean(prompt.promptId) && !projectMismatch && !currentPrompt;
          const logicalName = currentPrompt?.name ?? prompt.promptName ?? prompt.snapshotName;
          return (
            <article className="repeater-card prompt-card" key={prompt.key}>
              <div className="repeater-title">
                <div>
                  <strong>{logicalName}</strong>{" "}
                  {prompt.versionNumber !== null ? <span>v{prompt.versionNumber}</span> : null}
                </div>
                <div className="repeater-actions">
                  <button className="button-link" type="button" disabled={index === 0} onClick={() => move(index, -1)}>
                    Move up
                  </button>
                  <button className="button-link" type="button" disabled={index === prompts.length - 1} onClick={() => move(index, 1)}>
                    Move down
                  </button>
                   <button
                     className="button-link danger"
                     type="button"
                     onClick={() => onChange(prompts.filter((item) => item.key !== prompt.key))}
                   >
                    Remove
                  </button>
                </div>
              </div>
              {logicalName !== prompt.snapshotName ? (
                <p className="section-note">Saved as {prompt.snapshotName}</p>
              ) : null}
              <pre className="prompt-editor">{prompt.text}</pre>
              {projectMismatch ? <p className="blocked-note" role="alert">This Prompt belongs to another Project.</p> : null}
              {!prompt.promptId || !prompt.libraryProjectId ? <p className="blocked-note" role="alert">This PromptVersion is detached from the Prompt library.</p> : null}
              {detached ? <p className="blocked-note" role="alert">The linked Prompt is not registered in this Project.</p> : null}
              {detachedState[prompt.key] === "checking" ? <p role="status">Checking library linkage...</p> : null}
              {detachedState[prompt.key] === "integrity" ? (
                <p className="blocked-note" role="alert">PromptVersion integrity check failed: stored content differs from the library.</p>
              ) : null}
              {currentPrompt && !projectMismatch ? (
                <div className="repeater-actions">
                  <button
                    className="button-link"
                    type="button"
                    onClick={(event) => {
                      dialogTrigger.current = event.currentTarget;
                      setPromptDialog({ kind: "history", key: prompt.key, promptId: currentPrompt.id });
                    }}
                  >
                    History / change version
                  </button>
                  <button className="button-link" type="button" onClick={(event) => openEdit(prompt, event.currentTarget)}>Edit as new version</button>
                  <button className="button-link" type="button" onClick={(event) => openDuplicate(prompt, currentPrompt, event.currentTarget)}>Duplicate Prompt</button>
                  <button className="button-link" type="button" onClick={(event) => openRename(currentPrompt.id, currentPrompt.name, event.currentTarget)}>Rename Prompt</button>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      {addView ? (
        <dialog className="prompt-dialog" open aria-labelledby="add-prompt-title" onCancel={cancelDialog} onKeyDown={cancelOnEscape}>
          <h2 id="add-prompt-title">Add Prompt</h2>
          {addView === "choice" ? (
            <div className="action-row">
              <button autoFocus className="button-primary" type="button" onClick={() => setAddView("existing")}>Choose existing</button>
              <button className="button-secondary" type="button" onClick={() => setAddView("create")}>Create new</button>
            </div>
          ) : null}
          {addView === "existing" ? (
            <div>
              <h3>Choose an active Prompt</h3>
              {activeLibrary.prompts.length === 0 ? <p className="empty-note">No active Prompts are available.</p> : null}
              <div className="repeater-stack">
                {activeLibrary.prompts.map((logicalPrompt, index) => {
                  const version = logicalPrompt.latest_active_version;
                  const duplicate = Boolean(version && prompts.some((prompt) => prompt.versionId === version.id));
                  return (
                    <div className="repeater-card" key={logicalPrompt.id}>
                      <strong>{logicalPrompt.name}</strong>
                      {version ? <p>Latest active version: v{version.version_number}</p> : <p>No active version</p>}
                      <button
                        className="button-secondary compact"
                        autoFocus={index === 0}
                        type="button"
                        disabled={!version || duplicate}
                        onClick={() => chooseExisting(logicalPrompt)}
                      >
                        {duplicate ? "Already added" : "Use latest version"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          {addView === "create" ? (
            <form onSubmit={createPrompt}>
              <label className="field">
                <span className="field-label">Prompt name</span>
                <input autoFocus required value={createDraft.name} onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label className="field">
                <span className="field-label">Prompt template</span>
                <textarea required value={createDraft.text} onChange={(event) => setCreateDraft((current) => ({ ...current, text: event.target.value }))} />
              </label>
              <label className="field">
                <span className="field-label">Description (optional)</span>
                <textarea value={createDraft.description} onChange={(event) => setCreateDraft((current) => ({ ...current, description: event.target.value }))} />
              </label>
              {createDraft.error ? <p className="operation-error" role="alert">{createDraft.error}</p> : null}
              <button className="button-primary" type="submit" disabled={createDraft.saving}>{createDraft.saving ? "Creating..." : "Create Prompt"}</button>
            </form>
          ) : null}
          <button className="button-link" type="button" onClick={() => cancelDialog()}>Cancel</button>
        </dialog>
      ) : null}

      {promptDialog?.kind === "history" ? (
        <dialog className="prompt-dialog" open aria-labelledby="prompt-history-title" onCancel={cancelDialog} onKeyDown={cancelOnEscape}>
          <h2 id="prompt-history-title">Prompt history</h2>
          {historyState?.loading ? <p role="status">Loading version history...</p> : null}
          {historyState?.error ? (
            <div className="operation-error" role="alert">
              <p>{historyState.error}</p>
              <button className="button-link" type="button" onClick={() => {
                setHistoryCache((current) => omitStringKey(current, promptDialog.promptId));
                setHistoryRetry((current) => current + 1);
              }}>Retry</button>
            </div>
          ) : null}
          <div className="repeater-stack">
             {(historyCache[promptDialog.promptId] ?? []).map((version, index) => (
              <article className="repeater-card" key={version.id}>
                <strong>v{version.version_number}</strong>{" "}
                <time dateTime={version.created_at}>{formatDate(version.created_at)}</time>
                {version.archived_at ? <p>Archived</p> : null}
                <pre className="prompt-editor">{version.text}</pre>
                {version.note ? <p>{version.note}</p> : <p className="section-note">No version note</p>}
                <button
                   className="button-secondary compact"
                   autoFocus={index === 0}
                  type="button"
                  disabled={
                    Boolean(version.archived_at)
                    || prompts.some((item) => item.versionId === version.id)
                  }
                  onClick={() => selectVersion(promptDialog.key, promptDialog.promptId, version)}
                >
                  {version.archived_at
                    ? "Archived"
                    : prompts.some((item) => item.versionId === version.id)
                      ? "Already added"
                      : "Use this version"}
                </button>
              </article>
            ))}
          </div>
          <button className="button-link" type="button" onClick={() => cancelDialog()}>Cancel</button>
        </dialog>
      ) : null}

      {promptDialog?.kind === "edit" && editDraft ? (
        <dialog className="prompt-dialog" open aria-labelledby="edit-prompt-title" onCancel={cancelDialog} onKeyDown={cancelOnEscape}>
          <h2 id="edit-prompt-title">Edit as new version</h2>
          <form onSubmit={createVersion}>
            <label className="field">
              <span className="field-label">Prompt template</span>
               <textarea autoFocus required value={editDraft.text} onChange={(event) => setEditDraft((current) => current && ({ ...current, text: event.target.value }))} />
            </label>
            <label className="field">
              <span className="field-label">Version note (optional)</span>
              <textarea value={editDraft.note} onChange={(event) => setEditDraft((current) => current && ({ ...current, note: event.target.value }))} />
            </label>
            {editDraft.error ? <p className="operation-error" role="alert">{editDraft.error}</p> : null}
            <button className="button-primary" type="submit" disabled={editDraft.saving}>{editDraft.saving ? "Saving..." : "Create version"}</button>
          </form>
          <button className="button-link" type="button" onClick={() => cancelDialog()}>Cancel</button>
        </dialog>
      ) : null}

      {promptDialog?.kind === "rename" ? (
        <dialog className="prompt-dialog" open aria-labelledby="rename-prompt-title" onCancel={cancelDialog} onKeyDown={cancelOnEscape}>
          <h2 id="rename-prompt-title">Rename Prompt</h2>
          <form onSubmit={renamePrompt}>
            <label className="field">
              <span className="field-label">Prompt name</span>
               <input autoFocus required value={renameDraft.name} onChange={(event) => setRenameDraft((current) => ({ ...current, name: event.target.value }))} />
            </label>
            {renameDraft.error ? <p className="operation-error" role="alert">{renameDraft.error}</p> : null}
            <button className="button-primary" type="submit" disabled={renameDraft.saving}>{renameDraft.saving ? "Renaming..." : "Rename"}</button>
          </form>
          <button className="button-link" type="button" onClick={() => cancelDialog()}>Cancel</button>
        </dialog>
      ) : null}

      {promptDialog?.kind === "duplicate" && duplicateDraft ? (
        <dialog className="prompt-dialog" open aria-labelledby="duplicate-prompt-title" onCancel={cancelDialog} onKeyDown={cancelOnEscape}>
          <h2 id="duplicate-prompt-title">Duplicate Prompt</h2>
          <form onSubmit={duplicatePrompt}>
            <label className="field">
              <span className="field-label">Prompt name</span>
              <input autoFocus required value={duplicateDraft.name} onChange={(event) => setDuplicateDraft((current) => current && ({ ...current, name: event.target.value }))} />
            </label>
            <label className="field">
              <span className="field-label">Prompt template</span>
              <textarea required value={duplicateDraft.text} onChange={(event) => setDuplicateDraft((current) => current && ({ ...current, text: event.target.value }))} />
            </label>
            <label className="field">
              <span className="field-label">Description (optional)</span>
              <textarea value={duplicateDraft.description} onChange={(event) => setDuplicateDraft((current) => current && ({ ...current, description: event.target.value }))} />
            </label>
            {duplicateDraft.error ? <p className="operation-error" role="alert">{duplicateDraft.error}</p> : null}
            <button className="button-primary" type="submit" disabled={duplicateDraft.saving}>
              {duplicateDraft.saving ? "Duplicating..." : "Duplicate Prompt"}
            </button>
          </form>
          <button className="button-link" type="button" onClick={() => cancelDialog()}>Cancel</button>
        </dialog>
      ) : null}
    </ConfigurationSection>
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
  };
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
