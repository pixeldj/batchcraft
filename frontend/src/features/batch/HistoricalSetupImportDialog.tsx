import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { OverlayPortal } from "../../components/OverlayPortal";
import { useModalDialog } from "../../components/useModalDialog";
import { ReadonlyProfileSummary } from "./ReadonlyProfileSummary";
import { validName, type HistoricalSetupReview } from "./useHistoricalSetupImport";
import "./globalWorkflowLibrary.css";

export function HistoricalSetupImportDialog({ review, onClose, onRename, onSubmit, onReload, onOpenLibrary }: {
  review: HistoricalSetupReview;
  onClose(): void;
  onRename(field: "name" | "profileName", value: string): void;
  onSubmit(): void;
  onReload(): void;
  onOpenLibrary(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const title = useId();
  const modal = useModalDialog(dialog, onClose, review.trigger, cancel);
  const closeOwner = useEffectEvent(onClose);
  useEffect(() => {
    const trigger = review.trigger;
    const owner = trigger.closest("dialog");
    const checkOwner = () => {
      if (!trigger.isConnected || (owner && !owner.open) || trigger.closest("[hidden]")) closeOwner();
    };
    checkOwner();
    const observer = new MutationObserver(checkOwner);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden"] });
    return () => observer.disconnect();
  }, [review.trigger]);
  const setup = review.setup;
  return <OverlayPortal level="details">
    <dialog ref={dialog} className="global-library-dialog project-add-dialog historical-setup-dialog"
      style={{ position: "fixed", inset: 0, margin: "auto" }} aria-labelledby={title} {...modal}>
      <header className="project-add-header"><h2 id={title}>Import to Library</h2></header>
      <form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); onSubmit(); }}>
        <div className="project-add-body">
          {review.loading ? <p role="status">Loading frozen setup...</p> : null}
          {setup ? <>
            <div className="project-add-destination"><span className="global-library-meta">Source Run</span>
              <strong>{setup.run_name ?? `Run ${setup.run_number}`}</strong>
              <span className="global-library-meta">{setup.project_name} / {setup.batch_name}</span>
            </div>
            {review.receipt ? <p role="status">Imported to Library.</p> : <>
              <p className="field-help">Copies the base setup, not Job overrides.</p>
              <Name label="Workflow name" value={review.name} forced={!!review.error || !validName(review.name)} disabled={review.pending} onChange={(value) => onRename("name", value)} />
              <Name label="Profile name" value={review.profileName} forced={!!review.error || !validName(review.profileName)} disabled={review.pending} onChange={(value) => onRename("profileName", value)} />
              <details className="global-library-technical"><summary>Inspect frozen setup</summary>
                <ReadonlyProfileSummary workflow={setup.workflow} profile={setup.profile} />
                <details><summary>Workflow JSON</summary><pre>{JSON.stringify(setup.workflow, null, 2)}</pre></details>
              </details>
            </>}
          </> : null}
          {review.error ? <div role="alert" className="operation-error"><p>{review.error}</p>
            {setup ? <p>Check names or reload setup.</p> : null}
            <button className="button-link" type="button" onClick={onReload}>Reload setup</button>
          </div> : null}
          {review.pending ? <p className="project-add-note" role="status">Closing stops waiting.</p> : null}
        </div>
        <footer className="project-add-footer">
          <button ref={cancel} type="button" className="button-secondary" onClick={onClose}>{review.receipt ? "Close" : "Cancel"}</button>
          {review.receipt ? <button type="button" className="button-secondary" onClick={onOpenLibrary}>Open Workflow Library</button> :
            <button className="button-primary" type="submit" disabled={!setup || review.loading || review.pending || !validName(review.name) || !validName(review.profileName)}>{review.pending ? "Importing..." : "Import to Library"}</button>}
        </footer>
      </form>
    </dialog>
  </OverlayPortal>;
}

function Name({ label, value, forced, disabled, onChange }: { label: string; value: string; forced: boolean; disabled: boolean; onChange(value: string): void }) {
  const hintId = useId();
  const [renaming, setRenaming] = useState(forced);
  if (forced && !renaming) setRenaming(true);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming) input.current?.focus(); }, [renaming]);
  return <div className="project-add-workflow">
    {renaming || forced ? <label className="field">{label}<input ref={input} aria-label={label} value={value} disabled={disabled} aria-invalid={!validName(value)} aria-describedby={!validName(value) ? hintId : undefined} onChange={(event) => onChange(event.target.value)} />{!validName(value) && <span id={hintId} className="field-hint">Enter a name (max 200 characters).</span>}</label> :
      <div><span className="global-library-meta">{label}</span><p>{value}</p></div>}
    {!renaming && !forced ? <button className="button-link compact" type="button" disabled={disabled} onClick={() => setRenaming(true)} aria-label={`Rename ${label}`}>Rename</button> : null}
  </div>;
}
