import { useRef } from "react";

import type { ResultResponse } from "../../api/types";
import { OverlayPortal } from "../../components/OverlayPortal";
import { useModalDialog } from "../../components/useModalDialog";

export interface LightboxItem {
  key: string;
  url: string;
  alt: string;
  label: string;
  result: ResultResponse;
}

interface Props {
  items: LightboxItem[];
  index: number;
  restoreTarget: HTMLElement | null;
  onClose(): void;
  onDetails(result: ResultResponse, target: HTMLElement): void;
  onNavigate(delta: number): void;
}

export function ResultLightbox({
  items,
  index,
  restoreTarget,
  onClose,
  onDetails,
  onNavigate,
}: Props) {
  const item = items[index];
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const modal = useModalDialog(dialogRef, onClose, restoreTarget, closeRef, Boolean(item));

  if (!item) {
    return null;
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDialogElement>) {
    modal.onKeyDown(event);
    if (event.defaultPrevented || (event.target instanceof HTMLElement &&
      event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"))) return;
    if (event.key === "ArrowLeft" && index > 0) {
      onNavigate(-1);
    }
    if (event.key === "ArrowRight" && index < items.length - 1) {
      onNavigate(1);
    }
  }

  return (
    <OverlayPortal level="lightbox" onBackdropClick={onClose}>
      <dialog
        className="result-lightbox"
        ref={dialogRef}
        style={{ position: "fixed", inset: 0, margin: "auto" }}
        aria-modal="true"
        aria-label="Result image preview"
        onCancel={modal.onCancel}
        onKeyDown={handleKeyDown}
        onClick={modal.onClick}
      >
        <div className="lightbox-toolbar">
          <button
            className="button-secondary compact"
            type="button"
            disabled={index === 0}
            onClick={() => onNavigate(-1)}
          >
            Previous
          </button>
          <span className="lightbox-position">{index + 1} of {items.length}</span>
          <button
            className="button-secondary compact"
            type="button"
            disabled={index === items.length - 1}
            onClick={() => onNavigate(1)}
          >
            Next
          </button>
          <button
            className="button-secondary compact lightbox-details-button"
            type="button"
            onClick={(event) => onDetails(item.result, event.currentTarget)}
          >
            ⓘ Details
          </button>
          <a
            className="button-secondary compact lightbox-original-link"
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open full image in new tab"
            title="Open full image in new tab"
          >
            Open original
          </a>
          <button className="button-link" type="button" onClick={onClose} ref={closeRef}>
            Close
          </button>
        </div>
        <div className="lightbox-image-stage">
          <div className="lightbox-image-fit">
            <img className="result-lightbox-image" src={item.url} alt={item.alt} />
          </div>
        </div>
        <p className="lightbox-caption">{item.label}</p>
      </dialog>
    </OverlayPortal>
  );
}
