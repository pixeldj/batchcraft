import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function LibraryMenu({ label, disabled, items }: { label: string; disabled?: boolean; items: { label: string; accessibleLabel?: string; onSelect(): void; disabled?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  // A body portal is inert while a native modal is open; stay inside that dialog.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const last = useRef(false);
  const id = useId();
  function close(restore = false) { if (restore) trigger.current?.focus(); setOpen(false); }
  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return;
    const panel = menu.current;
    panel.showPopover?.();
    panel.style.display = "block";
    const position = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(rect.right - bounds.width, window.innerWidth - bounds.width - 8))}px`;
      panel.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - bounds.height - 8))}px`;
      panel.style.visibility = "visible";
    };
    position();
    const buttons = panel.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    (last.current ? buttons[buttons.length - 1] : buttons[0])?.focus();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <>
    <button ref={trigger} type="button" className="button-secondary compact global-library-menu-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={(event) => { setPortalTarget(event.currentTarget.closest("dialog")); last.current = false; setOpen(!open); }} onKeyDown={(event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setPortalTarget(event.currentTarget.closest("dialog")); last.current = event.key === "ArrowUp"; setOpen(true); }
    }}>...</button>
    {open && createPortal(<div ref={menu} id={id} popover="manual" role="menu" aria-label={label} className="global-library-menu" onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === "Tab") close(true);
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>{items.map((item) => <button key={item.label} type="button" role="menuitem" aria-label={item.accessibleLabel} disabled={item.disabled} onClick={() => { close(true); item.onSelect(); }}>{item.label}</button>)}</div>, portalTarget ?? document.body)}
  </>;
}
