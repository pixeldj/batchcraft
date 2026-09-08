import { useEffect, useId, useRef, useState } from "react";
import { ApiError, type BatchcraftApi } from "../../api/client";
import type { HistoryDiagnosticPageResponse } from "../../api/types";
import { useModalDialog } from "../../components/useModalDialog";
import "./HistoryDiagnostics.css";

export interface HistoryDiagnosticsProps {
  api: Pick<BatchcraftApi, "browseProjectDiagnostics">;
  projectId: string;
  onClose: () => void;
  onReindex?: () => void;
}

export function HistoryDiagnostics(props: HistoryDiagnosticsProps) {
  return <DiagnosticsDialog key={props.projectId} {...props} />;
}

function DiagnosticsDialog({ api, projectId, onClose, onReindex }: HistoryDiagnosticsProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const title = useId();
  const modal = useModalDialog(dialog, onClose, document.activeElement as HTMLElement | null, close);
  const [request, setRequest] = useState<{ cursor?: string; previous: (string | undefined)[] }>({ previous: [] });
  const [result, setResult] = useState<{
    request: typeof request;
    api: typeof api;
    page?: HistoryDiagnosticPageResponse;
    error?: string;
  }>();
  const current = result?.request === request && result.api === api ? result : undefined;
  const loading = !current;
  const page = current?.page;

  useEffect(() => {
    const controller = new AbortController();
    void api.browseProjectDiagnostics(projectId, { limit: 25, cursor: request.cursor }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        if (page.project_id !== projectId) throw new Error("Project mismatch");
        setResult({ request, api, page });
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof ApiError && error.code === "history_generation_changed"
          ? "History changed. Refresh to restart diagnostic browsing."
          : error instanceof ApiError && error.code === "history_browser_unavailable"
            ? "The running backend does not support history diagnostics. Restart the backend from the same version as the frontend, then Refresh. Reindexing cannot fix a missing API route."
            : "Diagnostics could not be loaded. Refresh to retry; existing history has not been cleared.";
        setResult({ request, api, error: message });
      });
    return () => controller.abort();
  }, [api, projectId, request]);

  return <dialog ref={dialog} className="history-diagnostics" aria-labelledby={title} {...modal}>
    <header>
      <h2 id={title}>History diagnostics</h2>
      <button ref={close} type="button" onClick={onClose}>Close</button>
    </header>
    <p>Indexed problems for this Project, in scan order. Refresh reads the index without checking storage.</p>
    <button type="button" onClick={() => setRequest({ previous: [] })}>Refresh</button>
    <section aria-label="Diagnostic page" aria-busy={loading}>
      {loading && <p role="status">Loading diagnostics...</p>}
      {current?.error && <p role="alert">{current.error}</p>}
      {page && <>
        <p>{page.scanned_at ? `Last indexed: ${page.scanned_at}` : "Scan time unknown; storage has not been confirmed."}</p>
        {page.items.length === 0 && <p>No diagnostics in this indexed page. This is not a new storage check.</p>}
        <ol>
          {page.items.map((item) => <li key={item.ordinal}>
            <h3>{item.scope === "asset" ? "Reference Asset" : item.scope.charAt(0).toUpperCase() + item.scope.slice(1)}{item.name_excerpt ? `: ${item.name_excerpt}` : ""}</h3>
            {item.display_truncated && <small>Name shortened</small>}
            {item.entity_id ? <p>ID: <code>{item.entity_id}</code></p> : <p>Identity unavailable</p>}
            <p>{item.message}</p>
          </li>)}
        </ol>
      </>}
    </section>
    <nav aria-label="Diagnostic pages">
      <button type="button" disabled={loading || !request.previous.length} onClick={() => setRequest({
        cursor: request.previous.at(-1), previous: request.previous.slice(0, -1),
      })}>Previous</button>
      <button type="button" disabled={loading || !page?.next_cursor} onClick={() => {
        if (page?.next_cursor) setRequest({ cursor: page.next_cursor, previous: [...request.previous, request.cursor].slice(-20) });
      }}>Next</button>
    </nav>
    <footer>
      <p>Diagnostics describe the last successful index, not current storage. After checking the reported records or restoring missing files, use Reindex Project to check again. A failed reindex preserves the prior index.</p>
      {onReindex && <button type="button" onClick={() => { onClose(); onReindex(); }}>Reindex Project</button>}
    </footer>
  </dialog>;
}
