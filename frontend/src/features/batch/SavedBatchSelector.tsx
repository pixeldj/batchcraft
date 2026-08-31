import { useEffect, useRef, useState } from "react";

import type { BatchcraftApi } from "../../api/client";
import type { SavedBatchListItem } from "../../api/types";
import { errorMessage } from "../../utils/errors";
import { slugifyProjectName } from "../project/projectIdentity";

export interface SavedBatchCreateInput {
  name: string;
  filesystemKey: string;
  description: string | null;
}

interface Props {
  api: BatchcraftApi;
  projectId: string;
  refreshToken: number;
  selectedBatchId: string | null;
  revision: number | null;
  filesystemKey: string;
  currentName: string;
  currentDescription: string;
  dirty: boolean;
  hasUnsavedChanges: boolean;
  disabled: boolean;
  saving: boolean;
  dialogRequest: "save-as" | null;
  onDialogRequestHandled(): void;
  onSelectBatch(batchId: string): Promise<void>;
  onCreateEmpty(input: SavedBatchCreateInput): Promise<void>;
  onCreateFromCurrent(input: SavedBatchCreateInput): Promise<void>;
  onSave(): Promise<void>;
  onArchive(): Promise<void>;
}

type DialogMode = "new" | "save-current" | "save-as";

interface DialogDraft {
  name: string;
  filesystemKey: string;
  keyEdited: boolean;
  description: string;
  saving: boolean;
  error: string | null;
}

const emptyDialogDraft: DialogDraft = {
  name: "",
  filesystemKey: "",
  keyEdited: false,
  description: "",
  saving: false,
  error: null,
};

export function SavedBatchSelector({
  api,
  projectId,
  refreshToken,
  selectedBatchId,
  revision,
  filesystemKey,
  currentName,
  currentDescription,
  dirty,
  hasUnsavedChanges,
  disabled,
  saving,
  dialogRequest,
  onDialogRequestHandled,
  onSelectBatch,
  onCreateEmpty,
  onCreateFromCurrent,
  onSave,
  onArchive,
}: Props) {
  const [batches, setBatches] = useState<SavedBatchListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialogMode, setDialogMode] = useState<DialogMode | null>(null);
  const [dialogDraft, setDialogDraft] = useState<DialogDraft>(emptyDialogDraft);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const [pendingNew, setPendingNew] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const requested = generation.current;
    const controller = new AbortController();
    setBatches([]);
    setListError(null);
    if (!projectId) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    void (async () => {
      try {
        const response = await api.listSavedBatches(projectId, false, controller.signal);
        if (controller.signal.aborted || requested !== generation.current) return;
        setBatches(response.batches);
      } catch (caught) {
        if (controller.signal.aborted || requested !== generation.current) return;
        setListError(errorMessage(caught));
      } finally {
        if (!controller.signal.aborted && requested === generation.current) {
          setLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [api, projectId, refreshToken]);

  useEffect(() => {
    if (dialogRequest === "save-as") {
      openDialog("save-as");
      onDialogRequestHandled();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogRequest]);

  const duplicateNames = new Set(
    batches
      .map((batch) => batch.name)
      .filter((name, index, names) => names.indexOf(name) !== index),
  );

  const busy = disabled || saving || switching || archiving;
  const statusLabel = selectedBatchId
    ? dirty
      ? "Unsaved changes"
      : "Saved"
    : "Unsaved draft";

  function openDialog(mode: DialogMode) {
    setActionError(null);
    if (mode === "new") {
      setDialogDraft({ ...emptyDialogDraft });
    } else {
      setDialogDraft({
        ...emptyDialogDraft,
        name: currentName,
        filesystemKey: slugifyProjectName(currentName),
        description: currentDescription,
      });
    }
    setDialogMode(mode);
  }

  function requestNew() {
    if (hasUnsavedChanges) {
      setPendingNew(true);
      return;
    }
    openDialog("new");
  }

  function requestSelect(batchId: string) {
    if (!batchId || batchId === selectedBatchId) return;
    if (hasUnsavedChanges) {
      setPendingSwitch(batchId);
      return;
    }
    void selectBatch(batchId);
  }

  async function selectBatch(batchId: string) {
    setSwitching(true);
    setActionError(null);
    try {
      await onSelectBatch(batchId);
      setPendingSwitch(null);
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setSwitching(false);
    }
  }

  async function submitDialog(event: React.FormEvent) {
    event.preventDefault();
    if (!dialogMode) return;
    const input: SavedBatchCreateInput = {
      name: dialogDraft.name.trim(),
      filesystemKey: dialogDraft.filesystemKey.trim(),
      description: dialogDraft.description.trim() || null,
    };
    setDialogDraft((current) => ({ ...current, saving: true, error: null }));
    try {
      if (dialogMode === "new") {
        await onCreateEmpty(input);
      } else {
        await onCreateFromCurrent(input);
      }
      setDialogMode(null);
      setPendingNew(false);
    } catch (caught) {
      setDialogDraft((current) => ({ ...current, saving: false, error: errorMessage(caught) }));
    }
  }

  async function archiveSelected() {
    setArchiving(true);
    setActionError(null);
    try {
      await onArchive();
      setConfirmArchive(false);
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setArchiving(false);
    }
  }

  const dialogTitle =
    dialogMode === "new" ? "New Batch" : dialogMode === "save-as" ? "Save As" : "Save Batch";
  const dialogSubmitLabel =
    dialogMode === "new" ? "Create Batch" : dialogMode === "save-as" ? "Save as new Batch" : "Save Batch";

  return (
    <div className="saved-batch-selector">
      {!projectId ? (
        <p className="empty-note">Select a Project to load its Saved Batches.</p>
      ) : loading ? (
        <p role="status" className="empty-note">Loading Saved Batches...</p>
      ) : listError ? (
        <div className="operation-error" role="alert">
          <p>Could not load Saved Batches: {listError}</p>
        </div>
      ) : (
        <div className="saved-batch-grid">
          <label className="field">
            <span className="field-label">Batch</span>
            <select
              aria-label="Saved Batch"
              value={selectedBatchId ?? ""}
              disabled={busy}
              onChange={(event) => requestSelect(event.target.value)}
            >
              <option value="">Unsaved draft</option>
              {batches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {duplicateNames.has(batch.name)
                    ? `${batch.name} — ${batch.filesystem_key}`
                    : batch.name}
                </option>
              ))}
            </select>
          </label>
          <div className="saved-batch-details">
            <span className={`saved-batch-status ${dirty ? "dirty" : ""}`} role="status">
              {statusLabel}
            </span>
            {selectedBatchId ? (
              <details className="technical-details">
                <summary>Batch details</summary>
                <p>Filesystem key: <code>{filesystemKey}</code></p>
                <p>Batch ID: <code>{selectedBatchId}</code></p>
                <p>Revision: {revision ?? "Unknown"}</p>
              </details>
            ) : null}
          </div>
        </div>
      )}

      <div className="action-row">
        <button className="button-secondary compact" type="button" disabled={busy || !projectId} onClick={requestNew}>
          New
        </button>
        {selectedBatchId ? (
          <button
            className="button-secondary compact"
            type="button"
            disabled={busy || !dirty}
            onClick={() => void onSave().catch(() => undefined)}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        ) : (
          <button
            className="button-secondary compact"
            type="button"
            disabled={busy || !projectId}
            onClick={() => openDialog("save-current")}
          >
            Save
          </button>
        )}
        <button
          className="button-secondary compact"
          type="button"
          disabled={busy || !projectId}
          onClick={() => openDialog("save-as")}
        >
          Save As
        </button>
        {selectedBatchId ? (
          <button
            className="button-link"
            type="button"
            disabled={busy}
            onClick={() => setConfirmArchive(true)}
          >
            Archive
          </button>
        ) : null}
      </div>
      {actionError ? <p className="operation-error" role="alert">{actionError}</p> : null}

      {dialogMode ? (
        <dialog open aria-labelledby="saved-batch-dialog-title" onCancel={() => setDialogMode(null)}>
          <h2 id="saved-batch-dialog-title">{dialogTitle}</h2>
          <form onSubmit={(event) => void submitDialog(event)}>
            <label className="field">
              <span className="field-label">Batch name</span>
              <input
                autoFocus
                required
                value={dialogDraft.name}
                onChange={(event) =>
                  setDialogDraft((current) => ({
                    ...current,
                    name: event.target.value,
                    filesystemKey: current.keyEdited
                      ? current.filesystemKey
                      : slugifyProjectName(event.target.value),
                  }))
                }
              />
            </label>
            <label className="field">
              <span className="field-label">Filesystem key</span>
              <input
                required
                value={dialogDraft.filesystemKey}
                onChange={(event) =>
                  setDialogDraft((current) => ({
                    ...current,
                    filesystemKey: event.target.value,
                    keyEdited: true,
                  }))
                }
              />
            </label>
            <label className="field">
              <span className="field-label">Description (optional)</span>
              <textarea
                value={dialogDraft.description}
                onChange={(event) =>
                  setDialogDraft((current) => ({ ...current, description: event.target.value }))
                }
              />
            </label>
            {dialogDraft.error ? <p className="operation-error" role="alert">{dialogDraft.error}</p> : null}
            <button className="button-primary" type="submit" disabled={dialogDraft.saving}>
              {dialogDraft.saving ? "Saving..." : dialogSubmitLabel}
            </button>
          </form>
          <button className="button-link" type="button" onClick={() => setDialogMode(null)}>
            Cancel
          </button>
        </dialog>
      ) : null}

      {pendingSwitch ? (
        <dialog open aria-labelledby="confirm-batch-switch-title" onCancel={() => setPendingSwitch(null)}>
          <h2 id="confirm-batch-switch-title">Switch Batch?</h2>
          <p>You have unsaved changes.</p>
          <div className="action-row">
            <button
              autoFocus
              className="button-primary"
              type="button"
              disabled={switching}
              onClick={() => void selectBatch(pendingSwitch)}
            >
              Discard and switch
            </button>
            <button className="button-link" type="button" onClick={() => setPendingSwitch(null)}>
              Cancel
            </button>
          </div>
        </dialog>
      ) : null}

      {pendingNew ? (
        <dialog open aria-labelledby="confirm-new-batch-title" onCancel={() => setPendingNew(false)}>
          <h2 id="confirm-new-batch-title">New Batch?</h2>
          <p>You have unsaved changes.</p>
          <div className="action-row">
            <button
              autoFocus
              className="button-primary"
              type="button"
              onClick={() => {
                setPendingNew(false);
                openDialog("new");
              }}
            >
              Discard and continue
            </button>
            <button className="button-link" type="button" onClick={() => setPendingNew(false)}>
              Cancel
            </button>
          </div>
        </dialog>
      ) : null}

      {confirmArchive ? (
        <dialog open aria-labelledby="confirm-archive-batch-title" onCancel={() => setConfirmArchive(false)}>
          <h2 id="confirm-archive-batch-title">Archive Batch?</h2>
          <p>
            Archiving hides this Batch from the selector. Its Runs and filesystem owner binding are
            preserved. The current editor content remains as an unsaved draft.
          </p>
          <div className="action-row">
            <button
              autoFocus
              className="button-primary"
              type="button"
              disabled={archiving}
              onClick={() => void archiveSelected()}
            >
              {archiving ? "Archiving..." : "Archive Batch"}
            </button>
            <button className="button-link" type="button" onClick={() => setConfirmArchive(false)}>
              Cancel
            </button>
          </div>
        </dialog>
      ) : null}
    </div>
  );
}
