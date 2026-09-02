import { useEffect, useRef } from "react";

import type { ResultResponse } from "../../api/types";
import { OverlayPortal } from "../../components/OverlayPortal";

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
  const restoreTargetRef = useRef<HTMLElement | null>(restoreTarget);

  useEffect(() => {
    closeRef.current?.focus();
    const target = restoreTargetRef.current;
    return () => {
      // Return focus to the control that opened the lightbox on unmount.
      target?.focus();
    };
  }, []);

  if (!item) {
    return null;
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
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
        open
        aria-modal="true"
        aria-label="Result image preview"
        onCancel={onClose}
        onKeyDown={handleKeyDown}
        onClick={(event) => event.stopPropagation()}
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
