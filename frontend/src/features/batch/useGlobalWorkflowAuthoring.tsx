import { useRef, useState } from "react";
import type { LibraryApi } from "../../api/client";
import type { GlobalArchiveKind, GlobalCatalogItem, GlobalProfile, GlobalProfileVersion, GlobalWorkflowVersion, JsonObject } from "../../api/types";
import { errorMessage } from "../../utils/errors";
import { WorkflowAuthoringDialog, type WorkflowAuthoringDraft } from "./WorkflowAuthoringDialog";

export interface GlobalAuthoringOperation {
  kind: "workflow" | "profile" | "metadata" | "archive" | "restore";
  root?: GlobalCatalogItem;
  workflow?: GlobalWorkflowVersion;
  family?: GlobalProfile;
  profile?: GlobalProfileVersion;
  archive?: { kind: GlobalArchiveKind; id: string; archived: boolean };
  create?: boolean;
}

const emptyProfile = { mappings: {}, image_inputs: [], parameters: [] };
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON must contain an object.");
  return value as JsonObject;
}

export function useGlobalWorkflowAuthoring(api: LibraryApi, active: boolean, onSaved: (root?: GlobalCatalogItem, preserveExact?: boolean, profile?: GlobalProfile) => void) {
  const [operation, setOperation] = useState<GlobalAuthoringOperation | null>(null);
  const [draft, setDraft] = useState<WorkflowAuthoringDraft>({ name: "", workflowJson: "{}", profileJson: "{}", note: "" });
  const [initial, setInitial] = useState(draft);
  const [serial, setSerial] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Keep operation identity above the modal: navigation may unmount the portal, not its draft.
  const receipt = useRef<{ fingerprint: string; id: string } | null>(null);
  const pending = useRef(false);
  const authoringRead = useRef<AbortController | null>(null);

  function beginRead() {
    authoringRead.current?.abort();
    const controller = new AbortController();
    authoringRead.current = controller;
    return controller;
  }

  function open(value: GlobalAuthoringOperation, notice: string | null = null) {
    if (pending.current) return;
    authoringRead.current?.abort();
    const next: WorkflowAuthoringDraft = {
      name: value.family?.name ?? (value.kind === "profile" ? `${value.root?.name ?? "Workflow"}-profile` : value.root?.name ?? ""),
      workflowJson: JSON.stringify(value.workflow?.workflow ?? {}, null, 2),
      profileJson: JSON.stringify(value.profile?.profile ?? emptyProfile, null, 2),
      note: "",
      ...((value.create || value.kind === "metadata") ? { description: value.kind === "profile" && value.create ? "" : (value.family ?? value.root)?.description ?? "" } : {}),
    };
    setOperation(value); setDraft(next); setInitial(next); setError(null); setMessage(notice);
    setSerial((n) => n + 1); receipt.current = null;
  }

  async function save() {
    if (!operation || pending.current) return;
    const op = operation;
    pending.current = true; setSaving(true); setError(null);
    let handoff: GlobalAuthoringOperation | null = null;
    let savedRoot: GlobalCatalogItem | undefined;
    let savedProfile: GlobalProfile | undefined;
    try {
      const note = draft.note.trim() || null;
      let body: JsonObject;
      if (op.kind === "archive") body = { archived: op.archive!.archived };
      else if (op.kind === "metadata") body = { name: draft.name.trim(), description: draft.description?.trim() || null };
      else if (op.kind === "profile" || (op.kind === "restore" && op.profile)) {
        const profile = op.kind === "restore" ? op.profile!.profile : object(JSON.parse(draft.profileJson));
        body = {
          workflow_version_id: op.kind === "restore" ? op.profile!.workflow_version_id : op.workflow!.id,
          mappings: object(profile.mappings),
          image_inputs: profile.image_inputs ?? [], parameters: profile.parameters ?? [], note,
          ...(op.create ? { name: draft.name.trim(), description: draft.description?.trim() || null } : {}),
        };
      } else body = {
        workflow: op.kind === "restore" ? op.workflow!.workflow : object(JSON.parse(draft.workflowJson)), note,
        ...(op.create ? { name: draft.name.trim(), description: draft.description?.trim() || null } : {}),
      };
      const fingerprint = JSON.stringify([op.kind, op.create, op.root?.id, op.family?.id, op.archive, body]);
      if (receipt.current?.fingerprint !== fingerprint) receipt.current = { fingerprint, id: crypto.randomUUID() };
      const request_id = receipt.current.id;
      if (op.kind === "archive") await api.archiveGlobalEntry(op.archive!.kind, op.archive!.id, { request_id, archived: op.archive!.archived });
      else if (op.kind === "metadata") {
        const request = { request_id, name: draft.name.trim(), description: draft.description?.trim() || null };
        if (op.family) savedProfile = await api.updateGlobalProfile(op.family.id, request);
        else await api.updateGlobalWorkflow(op.root!.id, request);
      } else if (op.kind === "profile" || (op.kind === "restore" && op.profile)) {
        if (!Array.isArray(body.image_inputs) || !Array.isArray(body.parameters)) throw new Error("Profile Image Inputs and parameters must be arrays.");
        const request = { request_id, workflow_version_id: String(body.workflow_version_id), mappings: object(body.mappings), image_inputs: body.image_inputs.map(object), parameters: body.parameters.map(object), note };
        if (op.create) await api.createGlobalProfile(op.root!.id, { ...request, name: draft.name.trim(), description: draft.description?.trim() || null });
        else await api.appendGlobalProfile(op.family!.id, request);
      } else {
        const request = { request_id, workflow: object(body.workflow), note };
        if (op.create) {
          const result = await api.createGlobalWorkflow({ ...request, name: draft.name.trim(), description: draft.description?.trim() || null });
          savedRoot = { ...result.workflow, latest_version_id: result.version.id };
          handoff = { kind: "profile", create: true, root: savedRoot, workflow: result.version };
        } else {
          const version = await api.appendGlobalWorkflow(op.root!.id, request);
          if (op.kind === "workflow" && op.profile && op.family) handoff = { kind: "profile", root: op.root, workflow: version, family: op.family, profile: op.profile };
        }
      }
      receipt.current = null;
      setOperation(null);
      onSaved(savedRoot, op.kind === "metadata", savedProfile);
    } catch (caught) {
      setError(`${errorMessage(caught)} Your draft is retained. If the outcome is unknown, retry unchanged to recover the same operation; changed content starts a new operation.`);
    } finally {
      pending.current = false; setSaving(false);
      if (handoff) open(handoff, "Workflow saved. Configure the Profile, or Cancel to keep just the Workflow. Your Batch is unchanged.");
    }
  }

  const confirmation = operation?.kind === "archive" || operation?.kind === "restore";
  const name = operation?.family?.name ?? operation?.root?.name ?? "Workflow";
  const action = operation?.kind === "archive" ? (operation.archive?.archived ? "Archive" : "Unarchive") : "Restore";
  const title = confirmation ? `${action} ${name}` : operation?.kind === "metadata" ? `Edit metadata: ${name}` : `${operation?.create ? "New" : "Edit"} ${operation?.kind === "profile" ? "Profile" : "Workflow"}`;
  return {
    open,
    beginRead,
    occupied: operation !== null,
    dialog: active && operation ? <WorkflowAuthoringDialog key={serial} title={title}
      kind={confirmation ? "metadata" : operation.kind as "workflow" | "profile" | "metadata"}
      workflow={operation.workflow?.workflow ?? {}} draft={draft} onChange={(patch) => setDraft((value) => ({ ...value, ...patch }))}
      showName={!confirmation && (operation.create || operation.kind === "metadata")}
      showNote={!confirmation && operation.kind !== "metadata"} dirty={JSON.stringify(draft) !== JSON.stringify(initial)}
      saving={saving} message={message} error={error} saveLabel={confirmation ? action : "Save"}
      intro={confirmation ? <p>{operation.kind === "restore"
        ? "Restore this previous content by saving a new immutable revision? Existing revisions, Project copies, Batches, and Runs remain unchanged."
        : `${action} this entry? Archiving hides it from default lists; names remain reserved. Existing Project copies, Batches, and Runs remain unchanged.`}</p>
        : <>
          {operation.root && <p>{operation.family ? `${operation.family.name} for ${operation.root.name}` : operation.root.name}. Project copies and your Batch remain unchanged.</p>}
          {operation.profile && operation.workflow?.id !== operation.profile.workflow_version_id && <p>Profile mappings need review against the viewed Workflow. Repair missing targets before saving.</p>}
        </>}
      onSave={() => void save()} onCancel={() => {
        if (receipt.current && !window.confirm("The previous save outcome may be unknown. Closing abandons this retry receipt. Close anyway?")) return;
        authoringRead.current?.abort();
        setOperation(null); receipt.current = null;
      }}>
      {saving && <p role="status">Waiting for the server. Navigation retains this draft and operation; it does not cancel the save.</p>}
    </WorkflowAuthoringDialog> : null,
  };
}
