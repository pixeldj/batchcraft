import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { LibraryApi } from "../../api/client";
import type { GlobalCopyResponse, GlobalRunSetup, GlobalRunSetupImportRequest } from "../../api/types";
import { errorMessage } from "../../utils/errors";
import { HistoricalSetupImportDialog } from "./HistoricalSetupImportDialog";

export type ImportHistoricalSetup = (source: { runId: string; projectId?: string }, trigger: HTMLElement) => void;

interface Operation {
  request: GlobalRunSetupImportRequest;
  fingerprint: string;
  setup: GlobalRunSetup;
  receipt: GlobalCopyResponse | null;
  error: string | null;
}
export interface HistoricalSetupReview {
  source: { runId: string; projectId?: string };
  trigger: HTMLElement;
  scope: string;
  setup: GlobalRunSetup | null;
  name: string;
  profileName: string;
  loading: boolean;
  pending: boolean;
  error: string | null;
  receipt: GlobalCopyResponse | null;
}

export function useHistoricalSetupImport(api: LibraryApi, scope: string, onOpenLibrary: () => void) {
  const [review, setReview] = useState<HistoricalSetupReview | null>(null);
  const current = useRef<HistoricalSetupReview | null>(null);
  // One retained operation, independent of inspection portals and working-session recovery.
  const operation = useRef<Operation | null>(null);
  const read = useRef<AbortController | null>(null);
  const write = useRef<AbortController | null>(null);

  function update(next: HistoricalSetupReview | null) {
    current.current = next;
    setReview(next);
  }
  function close() {
    read.current?.abort();
    write.current?.abort();
    read.current = null;
    write.current = null;
    update(null);
  }
  const dispose = useEffectEvent(close);
  useEffect(() => () => dispose(), [scope]);

  async function load(next: HistoricalSetupReview) {
    const controller = new AbortController();
    read.current?.abort();
    read.current = controller;
    update({ ...next, loading: true, error: null });
    try {
      const setup = await api.getGlobalRunSetup(next.source.runId, controller.signal);
      if (controller.signal.aborted || read.current !== controller) return;
      if (setup.run_id !== next.source.runId ||
        (next.source.projectId !== undefined && setup.project_id !== next.source.projectId) ||
        setup.source.scope !== "historical_run" || setup.source.run_id !== setup.run_id ||
        setup.source.project_id !== setup.project_id || setup.source.batch_id !== setup.batch_id || setup.source.profiles.length !== 1 ||
        !/^[0-9a-f]{64}$/.test(setup.source.workflow.content_sha256) ||
        !/^[0-9a-f]{64}$/.test(setup.source.profiles[0].content_sha256))
        throw new Error("The frozen setup did not match the selected Run or Project.");
      update({ ...(current.current ?? next), setup, loading: false, error: null,
        // Only the first validated read supplies defaults; reload is not a name edit.
        ...(!next.setup ? {
          name: setup.workflow_name ?? "Imported Workflow",
          profileName: setup.profile_name ?? (typeof setup.profile.name === "string" ? setup.profile.name : "Imported Profile"),
        } : {}),
      });
    } catch (caught) {
      if (!controller.signal.aborted && read.current === controller)
        update({ ...(current.current ?? next), loading: false, error: errorMessage(caught) });
    }
  }

  const open: ImportHistoricalSetup = (source, trigger) => {
    close();
    const saved = operation.current;
    const reusable = saved?.setup.run_id === source.runId &&
      (source.projectId === undefined || saved.setup.project_id === source.projectId) ? saved : null;
    const next: HistoricalSetupReview = {
      source, trigger, scope, setup: reusable?.setup ?? null,
      name: reusable?.request.name ?? "", profileName: reusable?.request.profile_name ?? "",
      loading: false, pending: false, error: reusable?.error ?? null, receipt: reusable?.receipt ?? null,
    };
    if (reusable) update(next);
    else void load(next);
  };

  function rename(field: "name" | "profileName", value: string) {
    const next = current.current;
    if (!next || next.pending || next.receipt) return;
    // Editing after an unknown outcome starts a new explicit operation, even if later reverted.
    operation.current = null;
    update({ ...next, [field]: value });
  }

  async function submit() {
    const next = current.current;
    if (!next?.setup || next.loading || write.current || next.receipt ||
      !validName(next.name) || !validName(next.profileName)) return;
    const body = {
      run_id: next.setup.run_id, name: next.name.trim(), profile_name: next.profileName.trim(),
      expected_workflow_sha256: next.setup.source.workflow.content_sha256,
      expected_profile_sha256: next.setup.source.profiles[0].content_sha256,
    };
    const fingerprint = JSON.stringify(body);
    const saved = operation.current;
    const op: Operation = saved?.fingerprint === fingerprint ? saved : {
      request: { request_id: crypto.randomUUID(), ...body }, fingerprint,
      setup: next.setup, receipt: null, error: null,
    };
    operation.current = op;
    const controller = new AbortController();
    write.current = controller;
    update({ ...next, pending: true, error: null });
    try {
      const receipt = await api.importRunSetup(op.request, controller.signal);
      op.receipt = receipt;
      op.error = null;
      if (!controller.signal.aborted && write.current === controller)
        update({ ...next, pending: false, error: null, receipt });
    } catch (caught) {
      op.error = errorMessage(caught);
      if (!controller.signal.aborted && write.current === controller)
        update({ ...next, pending: false, error: op.error });
    } finally {
      if (write.current === controller) write.current = null;
    }
  }

  return {
    open,
    dialog: review && review.scope === scope ? <HistoricalSetupImportDialog
      key={JSON.stringify([review.scope, review.source])}
      review={review} onClose={close} onRename={rename} onSubmit={() => void submit()}
      onReload={() => void load(review)}
      onOpenLibrary={() => { close(); onOpenLibrary(); }}
    /> : null,
  };
}

export function validName(name: string) {
  return name.trim().length > 0 && Array.from(name).length <= 200;
}
