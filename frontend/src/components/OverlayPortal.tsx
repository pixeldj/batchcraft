import { createPortal } from "react-dom";
import type { MouseEventHandler, ReactNode } from "react";

type OverlayLevel = "lightbox" | "details" | "run-plan" | "prompt-library";

interface Props {
  level: OverlayLevel;
  children: ReactNode;
  onBackdropClick?: MouseEventHandler<HTMLDivElement>;
}

export function OverlayPortal({ level, children, onBackdropClick }: Props) {
  return createPortal(
    <div
      className={`overlay-layer overlay-layer-${level}`}
      data-overlay-level={level}
      onClick={onBackdropClick}
    >
      {children}
    </div>,
    document.body,
  );
}
