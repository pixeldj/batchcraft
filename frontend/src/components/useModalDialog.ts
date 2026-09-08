import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type RefObject, type SyntheticEvent } from "react";

const modalStack: HTMLDialogElement[] = [];
let previousOverflow = "";

export function useModalDialog(
  dialogRef: RefObject<HTMLDialogElement | null>,
  onClose: () => void,
  restoreTarget: HTMLElement | null,
  closeRef: RefObject<HTMLButtonElement | null>,
  enabled = true,
) {
  const restoreTargetRef = useRef(restoreTarget);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!enabled || !dialog) return;
    const target = restoreTargetRef.current;
    dialog.showModal();
    if (modalStack.length === 0) previousOverflow = document.body.style.overflow;
    modalStack.push(dialog);
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      modalStack.splice(modalStack.indexOf(dialog), 1);
      dialog.close();
      if (modalStack.length === 0) document.body.style.overflow = previousOverflow;
      // Navigation can hide or remove the opener before this cleanup runs.
      if (!target?.isConnected) return;
      for (let element: HTMLElement | null = target; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (element.hidden || element.inert || style.display === "none" ||
          style.visibility === "hidden" || style.visibility === "collapse" ||
          (element instanceof HTMLDialogElement && !element.open)) return;
      }
      const remaining = modalStack.at(-1);
      if (!remaining || remaining.contains(target)) target.focus();
    };
  }, [closeRef, dialogRef, enabled]);

  function onCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    const dialog = dialogRef.current;
    const focusedDialog = document.activeElement?.closest("dialog");
    if (dialog && modalStack.at(-1) === dialog && (!focusedDialog || focusedDialog === dialog)) {
      // Use the same React cancellation path for native and synthetic keyboard events.
      dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    }
  }

  function onClick(event: MouseEvent<HTMLDialogElement>) {
    event.stopPropagation();
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
      event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }

  return { onCancel, onKeyDown, onClick };
}
