import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import type { BatchcraftApi } from "../../api/client";
import type {
  AdoptableProject,
  ProjectAdoptRequest,
  ProjectCreateRequest,
  ProjectResponse,
} from "../../api/types";
import { errorMessage } from "../../utils/errors";
import { slugifyProjectName } from "./projectIdentity";

interface Props {
  api: BatchcraftApi;
  selectedProjectId: string | null;
  projectVerified: boolean;
  draftIdentity: { id: string; filesystemKey: string; name: string };
  hasProjectScopedSelections: boolean;
  unsavedChangesNote?: string | null;
  switchingBlocked: boolean;
  onReconnect(project: ProjectResponse): void;
  onUnresolved(): void;
  onSelect(project: ProjectResponse): void;
}

type OpenDialog = "create" | "adopt" | null;
type PendingTransition =
  | { kind: "select"; project: ProjectResponse }
  | { kind: "create"; body: ProjectCreateRequest }
  | { kind: "import"; filesystemKey: string }
  | { kind: "adopt"; body: ProjectAdoptRequest; projectId: string };

const emptyCreateDraft = {
  name: "",
  filesystemKey: "",
  description: "",
  keyEdited: false,
  saving: false,
  error: null as string | null,
};

const emptyAdoptDraft = {
  filesystemKey: "",
  projectId: "",
  name: "",
  description: "",
  saving: false,
  error: null as string | null,
};

export function ProjectSelector({
  api,
  selectedProjectId,
  projectVerified,
  draftIdentity,
  hasProjectScopedSelections,
  unsavedChangesNote,
  switchingBlocked,
  onReconnect,
  onUnresolved,
  onSelect,
}: Props) {
  const [projects, setProjects] = useState<ProjectResponse[]>([]);
  const [listState, setListState] = useState({ loading: true, error: null as string | null });
  const [listRetry, setListRetry] = useState(0);
  const [openDialog, setOpenDialog] = useState<OpenDialog>(null);
  const [pending, setPending] = useState<PendingTransition | null>(null);
  const [createDraft, setCreateDraft] = useState(emptyCreateDraft);
  const [adoptables, setAdoptables] = useState<AdoptableProject[]>([]);
  const [adoptState, setAdoptState] = useState({ loading: false, error: null as string | null });
  const [adoptRetry, setAdoptRetry] = useState(0);
  const [adoptDraft, setAdoptDraft] = useState(emptyAdoptDraft);
  const listTag = useRef(0);
  const adoptTag = useRef(0);
  const mutationTag = useRef(0);
  const trigger = useRef<HTMLButtonElement | HTMLSelectElement | null>(null);
  const contextVersion = useRef(0);
  const previousContext = useRef("");
  const projectVerifiedRef = useRef(projectVerified);
  const candidateId = selectedProjectId ?? draftIdentity.id.trim();
  const candidateKey = draftIdentity.filesystemKey.trim();
  const context = [selectedProjectId ?? "", draftIdentity.id, draftIdentity.filesystemKey].join("\u0001");
  if (previousContext.current !== context) {
    previousContext.current = context;
    contextVersion.current += 1;
  }
  projectVerifiedRef.current = projectVerified;

  const notifyReconnect = useEffectEvent(onReconnect);
  const notifyUnresolved = useEffectEvent(onUnresolved);

  useEffect(() => {
    const tag = ++listTag.current;
    const version = contextVersion.current;
    const controller = new AbortController();
    setListState({ loading: true, error: null });

    void api.listProjects(false, controller.signal).then(
      (response) => {
        if (tag !== listTag.current || version !== contextVersion.current || controller.signal.aborted) return;
        setProjects(response.projects);
        setListState({ loading: false, error: null });
        const match = candidateId && candidateKey
          ? response.projects.find(
            (project) => project.id === candidateId && project.filesystem_key === candidateKey,
          )
          : undefined;
        if (match) {
          if (!projectVerifiedRef.current) notifyReconnect(match);
        } else {
          notifyUnresolved();
        }
      },
      (caught: unknown) => {
        if (tag !== listTag.current || version !== contextVersion.current || isAbortError(caught)) return;
        setListState({ loading: false, error: errorMessage(caught) });
      },
    );

    return () => controller.abort();
  }, [api, candidateId, candidateKey, listRetry]);

  useEffect(() => {
    if (openDialog !== "adopt") return;
    const tag = ++adoptTag.current;
    const version = contextVersion.current;
    const controller = new AbortController();
    setAdoptState({ loading: true, error: null });
    setAdoptables([]);

    void api.listAdoptableProjects(controller.signal).then(
      (response) => {
        if (tag !== adoptTag.current || version !== contextVersion.current || controller.signal.aborted) return;
        setAdoptables(response.projects);
        setAdoptState({ loading: false, error: null });
        if (response.projects.length > 0) selectAdoptable(response.projects[0]);
      },
      (caught: unknown) => {
        if (tag !== adoptTag.current || version !== contextVersion.current || isAbortError(caught)) return;
        setAdoptState({ loading: false, error: errorMessage(caught) });
      },
    );

    return () => controller.abort();
  }, [api, adoptRetry, context, openDialog]);

  const activeProject = projects.find(
    (project) => project.id === candidateId && project.filesystem_key === candidateKey,
  );
  const hasDraftIdentity = Boolean(draftIdentity.id.trim() || draftIdentity.filesystemKey.trim() || draftIdentity.name.trim());
  const duplicateNames = new Set(
    projects.filter((project, index) => projects.findIndex((item) => item.name === project.name) !== index)
      .map((project) => project.name),
  );

  function restoreTriggerFocus() {
    window.setTimeout(() => trigger.current?.focus(), 0);
  }

  function closeOperationDialog() {
    mutationTag.current += 1;
    adoptTag.current += 1;
    setOpenDialog(null);
    setPending(null);
    restoreTriggerFocus();
  }

  function cancelOnEscape(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (pending) {
        setPending(null);
      } else {
        closeOperationDialog();
      }
    }
  }

  function requestTransition(next: PendingTransition) {
    const targetId = next.kind === "select"
      ? next.project.id
      : next.kind === "import"
        ? adoptables.find((item) => item.filesystem_key === next.filesystemKey)?.project_id ?? undefined
      : next.kind === "adopt"
        ? next.projectId
        : undefined;
    const isCurrent = Boolean(
      targetId &&
      targetId === draftIdentity.id.trim() &&
      next.kind !== "create" &&
      (next.kind === "select" || (
        next.kind === "import"
          ? next.filesystemKey === draftIdentity.filesystemKey.trim()
          : next.body.filesystem_key === draftIdentity.filesystemKey.trim()
      )),
    );
    if (hasProjectScopedSelections && !isCurrent) {
      setPending(next);
      return;
    }
    void runTransition(next);
  }

  async function runTransition(next: PendingTransition) {
    setPending(null);
    if (next.kind === "select") {
      setOpenDialog(null);
      onSelect(next.project);
      return;
    }

    const tag = ++mutationTag.current;
    const version = contextVersion.current;
    if (next.kind === "create") {
      setCreateDraft((current) => ({ ...current, saving: true, error: null }));
      try {
        const project = await api.createProject(next.body);
        if (tag !== mutationTag.current || version !== contextVersion.current) return;
        setCreateDraft(emptyCreateDraft);
        setOpenDialog(null);
        onSelect(project);
        setListRetry((current) => current + 1);
      } catch (caught) {
        if (tag !== mutationTag.current || version !== contextVersion.current) return;
        setCreateDraft((current) => ({ ...current, saving: false, error: errorMessage(caught) }));
      }
      return;
    }
    if (next.kind === "import") {
      setAdoptDraft((current) => ({ ...current, saving: true, error: null }));
      try {
        const imported = await api.importProject({ filesystem_key: next.filesystemKey });
        const project = await api.getProject(imported.project_id);
        if (tag !== mutationTag.current || version !== contextVersion.current) return;
        setAdoptDraft(emptyAdoptDraft);
        setOpenDialog(null);
        onSelect(project);
        setListRetry((current) => current + 1);
      } catch (caught) {
        if (tag !== mutationTag.current || version !== contextVersion.current) return;
        setAdoptDraft((current) => ({ ...current, saving: false, error: errorMessage(caught) }));
      }
      return;
    }

    setAdoptDraft((current) => ({ ...current, saving: true, error: null }));
    try {
      const project = await api.adoptProject(next.body);
      if (tag !== mutationTag.current || version !== contextVersion.current) return;
      setAdoptDraft(emptyAdoptDraft);
      setOpenDialog(null);
      onSelect(project);
      setListRetry((current) => current + 1);
    } catch (caught) {
      if (tag !== mutationTag.current || version !== contextVersion.current) return;
      setAdoptDraft((current) => ({ ...current, saving: false, error: errorMessage(caught) }));
    }
  }

  function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body: ProjectCreateRequest = {
      name: createDraft.name.trim(),
      filesystem_key: createDraft.filesystemKey.trim(),
      description: createDraft.description.trim() || null,
    };
    if (!body.name || !body.filesystem_key) return;
    requestTransition({ kind: "create", body });
  }

  function selectAdoptable(candidate: AdoptableProject) {
    setAdoptDraft({
      filesystemKey: candidate.filesystem_key,
      projectId: candidate.project_id ?? "",
      name: candidate.initial_name ?? "",
      description: "",
      saving: false,
      error: null,
    });
  }

  function submitAdopt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = adoptables.find((item) => item.filesystem_key === adoptDraft.filesystemKey);
    if (!candidate) return;
    if (candidate.owner_state === "owned") {
      requestTransition({ kind: "import", filesystemKey: candidate.filesystem_key });
      return;
    }
    if (!adoptDraft.name.trim()) return;
    if (candidate.owner_state === "ownerless" && !adoptDraft.projectId.trim()) return;
    const body: ProjectAdoptRequest = {
      filesystem_key: candidate.filesystem_key,
      name: adoptDraft.name.trim(),
      description: adoptDraft.description.trim() || null,
      ...(candidate.owner_state === "ownerless" ? { project_id: adoptDraft.projectId.trim() } : {}),
    };
    requestTransition({
      kind: "adopt",
      body,
      projectId: candidate.project_id ?? adoptDraft.projectId.trim(),
    });
  }

  const selectedAdoptable = adoptables.find((item) => item.filesystem_key === adoptDraft.filesystemKey);

  return (
    <fieldset className="project-selector">
      <legend>Project</legend>

      {listState.loading ? <p role="status">Loading active Projects...</p> : null}
      {listState.error ? (
        <div className="operation-error" role="alert">
          <p>Could not load Projects: {listState.error}</p>
          <button className="button-link" type="button" onClick={() => setListRetry((current) => current + 1)}>Retry</button>
        </div>
      ) : null}

      {!listState.loading && !listState.error ? (
        <label className="field">
          <span className="field-label">Active Project</span>
          <select
            value={activeProject?.id ?? ""}
            disabled={switchingBlocked}
            title={switchingBlocked ? "Project changes are unavailable while a Run is active." : undefined}
            onChange={(event) => {
              const project = projects.find((item) => item.id === event.target.value);
              if (project && project.id !== activeProject?.id) {
                trigger.current = event.currentTarget;
                requestTransition({ kind: "select", project });
              }
            }}
          >
            <option value="">Select a Project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {duplicateNames.has(project.name) ? `${project.name} — ${project.filesystem_key}` : project.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {activeProject ? (
        <div className="identity-details">
          <details>
            <summary>Project details</summary>
            <p>Filesystem key: <code>{activeProject.filesystem_key}</code></p>
            <p>Project ID: <code>{activeProject.id}</code></p>
          </details>
        </div>
      ) : !listState.loading && !listState.error ? (
        <p className="empty-note">Select an active Project, create one, or import one from a folder.</p>
      ) : null}

      {!listState.loading && !listState.error && hasDraftIdentity && !activeProject ? (
        <p className="blocked-note" role="alert">The saved Project identity does not exactly match an active registered Project.</p>
      ) : null}
      <div className="action-row">
        <button
          className="button-secondary"
          type="button"
          disabled={switchingBlocked}
          title={switchingBlocked ? "Project changes are unavailable while a Run is active." : undefined}
          onClick={(event) => {
            trigger.current = event.currentTarget;
            setCreateDraft(emptyCreateDraft);
            setOpenDialog("create");
          }}
        >
          New Project
        </button>
        <button
          className="button-secondary"
          type="button"
          disabled={switchingBlocked}
          title={switchingBlocked ? "Project changes are unavailable while a Run is active." : undefined}
          onClick={(event) => {
            trigger.current = event.currentTarget;
            setAdoptDraft(emptyAdoptDraft);
            setOpenDialog("adopt");
          }}
        >
          Import from Folder
        </button>
      </div>

      {openDialog === "create" && !pending ? (
        <dialog open aria-labelledby="create-project-title" onCancel={closeOperationDialog} onKeyDown={cancelOnEscape}>
          <h2 id="create-project-title">New Project</h2>
          <form onSubmit={submitCreate}>
            <label className="field">
              <span className="field-label">Project name</span>
              <input
                autoFocus
                required
                value={createDraft.name}
                onChange={(event) => setCreateDraft((current) => ({
                  ...current,
                  name: event.target.value,
                  filesystemKey: current.keyEdited
                    ? current.filesystemKey
                    : slugifyProjectName(event.target.value),
                }))}
              />
            </label>
            <label className="field">
              <span className="field-label">Filesystem key</span>
              <input
                required
                value={createDraft.filesystemKey}
                onChange={(event) => setCreateDraft((current) => ({
                  ...current,
                  filesystemKey: event.target.value,
                  keyEdited: true,
                }))}
              />
            </label>
            <label className="field">
              <span className="field-label">Description (optional)</span>
              <textarea value={createDraft.description} onChange={(event) => setCreateDraft((current) => ({ ...current, description: event.target.value }))} />
            </label>
            {createDraft.error ? <p className="operation-error" role="alert">{createDraft.error}</p> : null}
            <button className="button-primary" type="submit" disabled={createDraft.saving}>{createDraft.saving ? "Creating..." : "Create Project"}</button>
          </form>
          <button className="button-link" type="button" onClick={closeOperationDialog}>Cancel</button>
        </dialog>
      ) : null}

      {openDialog === "adopt" && !pending ? (
        <dialog open aria-labelledby="adopt-project-title" onCancel={closeOperationDialog} onKeyDown={cancelOnEscape}>
          <h2 id="adopt-project-title">Import Project from Folder</h2>
          {adoptState.loading ? <p role="status">Looking for Project folders available to import...</p> : null}
          {adoptState.error ? (
            <div className="operation-error" role="alert">
              <p>Could not find Project folders available to import: {adoptState.error}</p>
              <button className="button-link" type="button" onClick={() => setAdoptRetry((current) => current + 1)}>Retry</button>
            </div>
          ) : null}
          {!adoptState.loading && !adoptState.error && adoptables.length === 0 ? (
            <p className="empty-note">No Project folders are available to import.</p>
          ) : null}
          {selectedAdoptable ? (
            <form onSubmit={submitAdopt}>
              <label className="field">
                <span className="field-label">Project directory</span>
                <select
                  autoFocus
                  value={adoptDraft.filesystemKey}
                  onChange={(event) => {
                    const candidate = adoptables.find((item) => item.filesystem_key === event.target.value);
                    if (candidate) selectAdoptable(candidate);
                  }}
                >
                  {adoptables.map((candidate) => (
                    <option key={candidate.filesystem_key} value={candidate.filesystem_key}>
                      {candidate.filesystem_key}{candidate.owner_state === "ownerless" ? " (ownerless, recovery)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <p>Filesystem key: <code>{selectedAdoptable.filesystem_key}</code></p>
              {selectedAdoptable.owner_state === "owned" ? (
                <>
                  <label className="field">
                    <span className="field-label">Stored Project ID</span>
                    <input readOnly value={selectedAdoptable.project_id ?? ""} />
                  </label>
                  <label className="field">
                    <span className="field-label">Initial label</span>
                    <input readOnly value={selectedAdoptable.initial_name ?? ""} />
                  </label>
                  <p className="section-note">Imports durable Project history and keeps its stored identity.</p>
                </>
              ) : (
                <div className="blocked-note">
                  <strong>Advanced recovery</strong>
                  <p>This directory has no owner record. Enter the exact Project ID to bind it.</p>
                  <label className="field">
                    <span className="field-label">Project ID</span>
                    <input required value={adoptDraft.projectId} onChange={(event) => setAdoptDraft((current) => ({ ...current, projectId: event.target.value }))} />
                  </label>
                </div>
              )}
              {selectedAdoptable.owner_state === "ownerless" ? (
                <>
                  <label className="field">
                    <span className="field-label">Current Project name</span>
                    <input required value={adoptDraft.name} onChange={(event) => setAdoptDraft((current) => ({ ...current, name: event.target.value }))} />
                  </label>
                  <label className="field">
                    <span className="field-label">Description (optional)</span>
                    <textarea value={adoptDraft.description} onChange={(event) => setAdoptDraft((current) => ({ ...current, description: event.target.value }))} />
                  </label>
                </>
              ) : null}
              {adoptDraft.error ? <p className="operation-error" role="alert">{adoptDraft.error}</p> : null}
              <button className="button-primary" type="submit" disabled={adoptDraft.saving}>{adoptDraft.saving ? "Importing..." : "Import Project"}</button>
            </form>
          ) : null}
          <button className="button-link" type="button" onClick={closeOperationDialog}>Cancel</button>
        </dialog>
      ) : null}

      {pending ? (
        <dialog open aria-labelledby="confirm-project-change-title" onCancel={() => setPending(null)} onKeyDown={cancelOnEscape}>
          <h2 id="confirm-project-change-title">Change Project?</h2>
          <p>Changing Project clears the current Project-scoped selections.</p>
          {unsavedChangesNote ? <p>{unsavedChangesNote}</p> : null}
          <div className="action-row">
            <button autoFocus className="button-primary" type="button" onClick={() => void runTransition(pending)}>Continue</button>
            <button className="button-link" type="button" onClick={() => setPending(null)}>Cancel</button>
          </div>
        </dialog>
      ) : null}
    </fieldset>
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
