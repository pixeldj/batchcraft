import { fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ResultResponse } from "../../api/types";
import { ResultDetailsDialog } from "./ResultDetailsDialog";
import { ResultLightbox } from "./ResultLightbox";

const result: ResultResponse = {
  job_ordinal: 1, artifact_ordinal: 1, producing_node_id: "41", output_name: "images",
  remote_filename: "portrait.png", content_type: "image/png", byte_size: 1024,
  sha256: "abc123", integrity_status: "verified", download_url: "/image.png",
};
const items = ["portrait", "landscape", "detail"].map((name, index) => ({
  key: String(index), url: `/${name}.png`, alt: `${name} preview`, label: `Job ${index + 1}: ${name}`,
  result: { ...result, job_ordinal: index + 1, remote_filename: `${name}.png`, download_url: `/${name}.png` },
}));
const loadRun = () => new Promise<never>(() => {});

function Navigation({ onNavigate, onDetails = () => {} }: {
  onNavigate(delta: number): void;
  onDetails?(result: ResultResponse, target: HTMLElement): void;
}) {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(true);
  return open && <ResultLightbox items={items} index={index} restoreTarget={null}
    onClose={() => setOpen(false)} onDetails={onDetails}
    onNavigate={(delta) => { onNavigate(delta); setIndex((current) => current + delta); }} />;
}

function Nested() {
  const [open, setOpen] = useState(true);
  const [detailsTarget, setDetailsTarget] = useState<HTMLElement | null>(null);
  return <>
    {open && <ResultLightbox items={items} index={0} restoreTarget={null}
      onClose={() => setOpen(false)} onNavigate={() => {}}
      onDetails={(_, target) => setDetailsTarget(target)} />}
    {detailsTarget && <ResultDetailsDialog runId="run-1" result={result} execution={null}
      restoreTarget={detailsTarget} getCachedRun={() => null} loadRun={loadRun}
      onClose={() => setDetailsTarget(null)} />}
  </>;
}

describe("Result inspection native modals", () => {
  it("closes with Escape", () => {
    render(<Navigation onNavigate={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["Previous/Next", "keyboard arrows"])("navigates with %s without callbacks beyond either endpoint", (controls) => {
    const onNavigate = vi.fn();
    const onDetails = vi.fn();
    render(<Navigation onNavigate={onNavigate} onDetails={onDetails} />);
    const dialog = screen.getByRole("dialog");
    const previous = within(dialog).getByRole("button", { name: "Previous" });
    const next = within(dialog).getByRole("button", { name: "Next" });
    function navigate(delta: number) {
      if (controls === "Previous/Next") fireEvent.click(delta < 0 ? previous : next);
      else fireEvent.keyDown(dialog, { key: delta < 0 ? "ArrowLeft" : "ArrowRight" });
    }
    for (const [step, index] of [0, 1, 2, 1, 0].entries()) {
      if (step > 0) navigate(step <= 2 ? 1 : -1);
      const item = items[index];
      expect(within(dialog).getByRole("img", { name: item.alt })).toHaveAttribute("src", item.url);
      expect(within(dialog).getByText(item.label)).toBeInTheDocument();
      expect(within(dialog).getByText(`${index + 1} of 3`)).toBeInTheDocument();
      const original = within(dialog).getByRole("link", { name: "Open full image in new tab" });
      expect(original).toHaveAttribute("href", item.url);
      expect(original).toHaveAttribute("target", "_blank");
      expect(original).toHaveAttribute("rel", "noopener noreferrer");
      const details = within(dialog).getByRole("button", { name: /Details/ });
      fireEvent.click(details);
      expect(onDetails).toHaveBeenLastCalledWith(item.result, details);
      expect(onDetails.mock.calls.at(-1)?.[0]).toBe(item.result);
      if (index === 0) expect(previous).toBeDisabled();
      else expect(previous).toBeEnabled();
      if (index === 2) expect(next).toBeDisabled();
      else expect(next).toBeEnabled();
      if (index === 0 || index === 2) {
        navigate(index === 0 ? -1 : 1);
        expect(onNavigate).toHaveBeenCalledTimes(step);
      }
    }
    expect(onNavigate.mock.calls).toEqual([[1], [1], [-1], [-1]]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens through showModal in StrictMode, focuses Close, and restores the opener and scroll state", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    document.body.style.overflow = "scroll";
    const show = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const close = vi.spyOn(HTMLDialogElement.prototype, "close");
    const view = render(<StrictMode><ResultLightbox items={items} index={0} restoreTarget={opener}
      onClose={() => {}} onNavigate={() => {}} onDetails={() => {}} /></StrictMode>);
    const dialog = screen.getByRole("dialog");
    expect(show).toHaveBeenCalledTimes(2);
    expect(dialog).toHaveAttribute("open");
    expect(dialog.parentElement).toHaveAttribute("data-overlay-level", "lightbox");
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    view.unmount();
    expect(close).toHaveBeenCalledTimes(2);
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe("scroll");
    opener.remove();
    document.body.style.overflow = "";
    show.mockRestore();
    close.mockRestore();
  });

  it("closes only the topmost modal on Escape and restores nested focus without unlocking scroll", () => {
    render(<Nested />);
    const lightbox = screen.getByRole("dialog");
    const detailsButton = within(lightbox).getByRole("button", { name: /Details/ });
    fireEvent.click(detailsButton);
    const details = screen.getByRole("dialog", { name: /Job 001/ });
    fireEvent.keyDown(lightbox, { key: "Escape" });
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    fireEvent.keyDown(details, { key: "Escape" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(detailsButton).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(lightbox, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
  });

  it("routes cancel through React, prevents default, and unlocks after non-LIFO removal", () => {
    render(<Nested />);
    const lightbox = screen.getByRole("dialog");
    fireEvent.click(within(lightbox).getByRole("button", { name: /Details/ }));
    const details = screen.getByRole("dialog", { name: /Job 001/ });
    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(lightbox, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(lightbox).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent(details, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
  });

  it.each(["hidden", "removed"])("does not restore focus to a %s opener", (state) => {
    const opener = document.createElement("button");
    document.body.append(opener);
    const view = render(<ResultLightbox items={items} index={0} restoreTarget={opener}
      onClose={() => {}} onNavigate={() => {}} onDetails={() => {}} />);
    const focus = vi.spyOn(opener, "focus");
    if (state === "hidden") opener.style.display = "none";
    else opener.remove();
    view.unmount();
    expect(focus).not.toHaveBeenCalled();
    opener.remove();
  });

  it("closes only outside dialog bounds and leaves editable arrow keys alone", () => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    render(<ResultLightbox items={items} index={0} restoreTarget={null}
      onClose={onClose} onNavigate={onNavigate} onDetails={() => {}} />);
    const dialog = screen.getByRole("dialog");
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
      x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 110, width: 100, height: 100,
      toJSON: () => ({}),
    });
    fireEvent.click(dialog, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByAltText("portrait preview"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(dialog, { clientX: 5, clientY: 20 });
    expect(onClose).toHaveBeenCalledTimes(1);
    const input = document.createElement("input");
    dialog.append(input);
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(onNavigate).toHaveBeenCalledWith(1);
  });
});
