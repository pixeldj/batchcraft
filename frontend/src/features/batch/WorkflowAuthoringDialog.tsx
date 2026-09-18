import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import type { JsonObject } from "../../api/types";
import { useModalDialog } from "../../components/useModalDialog";
import { WorkflowProfileMapper } from "./WorkflowProfileMapper";
import "./workflowAuthoring.css";

export interface WorkflowAuthoringDraft {
  name: string;
  workflowJson: string;
  profileJson: string;
  note: string;
  /** Omit to hide metadata not supported by the owning operation. */
  description?: string;
}

export interface WorkflowAuthoringFieldsProps {
  kind: "workflow" | "profile" | "metadata";
  draft: WorkflowAuthoringDraft;
  /** Exact immutable source Workflow, required by the Profile mapper. */
  workflow: JsonObject;
  onChange(patch: Partial<WorkflowAuthoringDraft>): void;
  showName?: boolean;
  nameExtras?: ReactNode;
  onWorkflowFileChange?(file: File): void;
  firstFieldRef?: RefObject<HTMLElement | null>;
}

export function WorkflowAuthoringFields({
  kind, draft, workflow, onChange, showName = true, nameExtras, onWorkflowFileChange, firstFieldRef,
}: WorkflowAuthoringFieldsProps) {
  const fileHintId = useId();
  return <>
    {showName && <label className="field"><span className="field-label">Name</span><input ref={(element) => { if (firstFieldRef) firstFieldRef.current = element; }} required value={draft.name} onChange={(event) => onChange({ name: event.target.value })} /></label>}
    {nameExtras}
    {draft.description !== undefined && <label className="field"><span className="field-label">Description (optional)</span><textarea value={draft.description} onChange={(event) => onChange({ description: event.target.value })} /></label>}
    {kind === "workflow" && <>
      {onWorkflowFileChange && <label className="field"><span className="field-label">Choose JSON file</span><input aria-label="Choose JSON file" aria-describedby={fileHintId} type="file" accept=".json,application/json" onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) onWorkflowFileChange(file);
      }} /><span id={fileHintId} className="field-hint">Choose a ComfyUI API-format JSON object (up to 64 MiB), or paste below. The backend validates the workflow when saving; no format conversion is performed.</span></label>}
      <label className="field"><span className="field-label">Workflow JSON</span><textarea ref={(element) => { if (firstFieldRef && !showName) firstFieldRef.current = element; }} className="json-editor" spellCheck={false} value={draft.workflowJson} onChange={(event) => onChange({ workflowJson: event.target.value })} /></label>
    </>}
    {kind === "profile" && <WorkflowProfileMapper workflow={workflow} profileJson={draft.profileJson} onChange={(profileJson) => onChange({ profileJson })} />}
  </>;
}

export interface WorkflowAuthoringDialogProps extends Omit<WorkflowAuthoringFieldsProps, "onWorkflowFileChange" | "firstFieldRef"> {
  /** Suspend the native modal without discarding the draft or pending operation. */
  active?: boolean;
  title: string;
  saveLabel?: string;
  showNote?: boolean;
  allowFileImport?: boolean;
  message?: string | null;
  error?: string | null;
  saving?: boolean;
  /** Also keep true when the parent must reconcile an uncertain write. */
  saveDisabled?: boolean;
  closeDisabled?: boolean;
  /** Include edits in caller-specific fields, such as duplicate options. */
  dirty?: boolean;
  intro?: ReactNode;
  children?: ReactNode;
  restoreTarget?: HTMLElement | null;
  /** Parent owns persistence, errors, IDs, and successful close/handoff. */
  onSave(): void;
  onCancel(): void;
}

/** Mount a fresh instance (or change its key) for each authoring operation. */
export function WorkflowAuthoringDialog({
  active = true,
  title, saveLabel = "Save", showNote = true, allowFileImport = true,
  message, error, saving = false, saveDisabled = false, closeDisabled = false,
  dirty, intro, children, restoreTarget = document.activeElement as HTMLElement | null,
  onSave, onCancel, ...fields
}: WorkflowAuthoringDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const formId = useId();
  const firstField = useRef<HTMLElement>(null);
  const initialFocus = useRef<HTMLElement>(null);
  const latestFields = useRef(fields);
  // Select after refs/disabled fieldsets commit; the modal hook focuses after showModal().
  useLayoutEffect(() => {
    latestFields.current = fields;
    const preferred = firstField.current;
    initialFocus.current = preferred && !preferred.matches(":disabled")
      ? preferred
      : (fields.kind === "profile" ? dialog.current?.querySelector<HTMLSelectElement>("select:not(:disabled)") : null)
        ?? dialog.current?.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)")
        ?? null;
  });
  const [initialDraft] = useState(fields.draft);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const fileRequest = useRef(0);
  useEffect(() => () => { fileRequest.current += 1; }, []);
  const changed = dirty
    || fields.draft.name !== initialDraft.name
    || fields.draft.workflowJson !== initialDraft.workflowJson
    || fields.draft.profileJson !== initialDraft.profileJson
    || fields.draft.note !== initialDraft.note
    || fields.draft.description !== initialDraft.description;
  function cancel() {
    if (!active || saving || closeDisabled) return;
    if ((changed || reading) && !window.confirm("Discard unsaved changes?")) return;
    onCancel();
  }
  const modal = useModalDialog(dialog, cancel, restoreTarget, initialFocus, active);

  async function loadFile(file: File) {
    const request = ++fileRequest.current;
    setReading(true);
    setFileError(null);
    try {
      if (file.size > 64 * 1024 * 1024) throw new Error("Workflow JSON file must not exceed 64 MiB.");
      const text = await file.text();
      if (request !== fileRequest.current) return;
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new Error("Workflow JSON file must contain valid JSON."); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Workflow JSON file must contain an object.");
      }
      const current = latestFields.current;
      const filename = file.name.replace(/\.json$/i, "") || file.name;
      current.onChange({
        workflowJson: text,
        ...(current.showName !== false && !current.draft.name.trim() ? { name: filename } : {}),
      });
    } catch (caught) {
      if (request === fileRequest.current) setFileError(caught instanceof Error ? caught.message : "Could not read the Workflow JSON file.");
    } finally {
      if (request === fileRequest.current) setReading(false);
    }
  }

  return createPortal(<dialog ref={dialog} className={`prompt-dialog workflow-authoring-dialog${fields.kind === "profile" ? " workflow-profile-dialog" : ""}`} aria-label={title} {...modal}>
    <h2>{title}</h2>
    <form id={formId} onSubmit={(event) => {
      event.preventDefault();
      event.stopPropagation();
      if (active && !saving && !reading && !saveDisabled) onSave();
    }}>
      {message && <p className="workflow-dialog-message" role="status">{message}</p>}
      {intro}
      <fieldset className="workflow-authoring-fields" disabled={saving || reading || saveDisabled}>
        <WorkflowAuthoringFields {...fields} firstFieldRef={firstField} onWorkflowFileChange={allowFileImport && fields.kind === "workflow" ? (file) => void loadFile(file) : undefined} />
        {children}
        {showNote && <label className="field"><span className="field-label">Version note (optional)</span><textarea value={fields.draft.note} onChange={(event) => fields.onChange({ note: event.target.value })} /></label>}
      </fieldset>
      {reading && <p role="status">Reading JSON file...</p>}
      {fileError && <p className="operation-error" role="alert">{fileError}</p>}
      {error && <p className="operation-error" role="alert">{error}</p>}
    </form>
    <button className="button-primary" type="submit" form={formId} disabled={!active || saving || reading || saveDisabled}>{saving ? "Saving..." : saveLabel}</button>
    <button className="button-link" type="button" disabled={!active || saving || closeDisabled} onClick={cancel}>Cancel</button>
  </dialog>, document.body);
}
