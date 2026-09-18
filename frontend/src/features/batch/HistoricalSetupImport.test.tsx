import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ApiError, type LibraryApi } from "../../api/client";
import type { GlobalCopyResponse, GlobalRunSetup } from "../../api/types";
import { useModalDialog } from "../../components/useModalDialog";
import { historicalSetup, importedSetup, workflowLibraryApi } from "../../test/workflowLibraryFixtures";
import { useHistoricalSetupImport, type ImportHistoricalSetup } from "./useHistoricalSetupImport";

function Harness({ api, scope = "batch", runId = "run-1", projectId, onOpen = () => {} }: {
  api: LibraryApi; scope?: string; runId?: string; projectId?: string; onOpen?: () => void;
}) {
  const importer = useHistoricalSetupImport(api, scope, onOpen);
  const [parent, setParent] = useState(false);
  return <>
    <button onClick={(event) => importer.open({ runId, projectId }, event.currentTarget)}>Review</button>
    <button onClick={() => setParent(true)}>Inspect</button>
    <button onClick={() => setParent(false)}>Remove parent</button>
    {parent ? <Owner onImport={importer.open} onClose={() => setParent(false)} /> : null}
    {importer.dialog}
  </>;
}
function Owner({ onImport, onClose }: { onImport: ImportHistoricalSetup; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const initial = useRef<HTMLButtonElement>(null);
  const modal = useModalDialog(dialog, onClose, null, initial);
  return <dialog ref={dialog} aria-label="Run inspection" {...modal}>
    <button ref={initial} onClick={(event) => onImport({ runId: "run-1" }, event.currentTarget)}>Import to Library</button>
  </dialog>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function review() { return screen.getByRole("dialog", { name: "Import to Library" }); }
function submit() { fireEvent.click(within(review()).getByRole("button", { name: "Import to Library" })); }
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  await screen.findByText("Copies the base setup, not Job overrides.");
}
function setupFor(runId: string): GlobalRunSetup {
  return { ...historicalSetup, run_id: runId, run_name: runId, source: { ...historicalSetup.source, run_id: runId } };
}

describe("historical setup import", () => {
  it("imports the complete frozen base pair with both source hashes, no Project or Job payload, and explicit navigation", async () => {
    const api = workflowLibraryApi(); const navigate = vi.fn();
    render(<Harness api={api} onOpen={navigate} />); await open();
    expect(review()).toHaveStyle({ position: "fixed", inset: "0", margin: "auto" });
    expect(api.getGlobalRunSetup).toHaveBeenCalledWith("run-1", expect.any(AbortSignal));
    expect(screen.getByText("Frozen Workflow")).toBeVisible();
    expect(screen.getByText("Frozen Profile")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Inspect frozen setup"));
    expect(screen.getByText("Named Image Inputs")).toBeVisible();
    expect(screen.queryByText("Concrete Jobs")).not.toBeInTheDocument();
    submit();
    await screen.findByText("Imported to Library.");
    expect(api.importRunSetup).toHaveBeenCalledExactlyOnceWith({
      request_id: expect.any(String), run_id: "run-1", name: "Frozen Workflow", profile_name: "Frozen Profile",
      expected_workflow_sha256: "a".repeat(64), expected_profile_sha256: "b".repeat(64),
    }, expect.any(AbortSignal));
    expect(navigate).not.toHaveBeenCalled();
    expect(api.useGlobalSetup).not.toHaveBeenCalled();
    expect(api.createGlobalWorkflow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Workflow Library" }));
    expect(navigate).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["run", "project", "source", "hash", "profiles"])("rejects a mismatched %s before any import", async (kind) => {
    const api = workflowLibraryApi(); const setup = structuredClone(historicalSetup);
    if (kind === "run") setup.run_id = "wrong";
    if (kind === "project") setup.project_id = "wrong";
    if (kind === "source") setup.source.run_id = "wrong";
    if (kind === "hash") setup.source.workflow.content_sha256 = "not-a-hash";
    if (kind === "profiles") setup.source.profiles = [];
    vi.mocked(api.getGlobalRunSetup).mockResolvedValue(setup);
    render(<Harness api={api} projectId="source-project" />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("did not match");
    expect(within(review()).getByRole("button", { name: "Import to Library" })).toBeDisabled();
    expect(api.importRunSetup).not.toHaveBeenCalled();
  });

  it.each(["Snapshot Profile", null])("uses safe fallback names without inferring lineage (%s)", async (profileName) => {
    const api = workflowLibraryApi();
    vi.mocked(api.getGlobalRunSetup).mockResolvedValue({ ...historicalSetup, workflow_name: null, profile_name: null,
      run_name: null, profile: { ...historicalSetup.profile, name: profileName, id: "not-a-friendly-name" } });
    render(<Harness api={api} />); await open();
    expect(screen.getByText(`Run ${historicalSetup.run_number}`)).toBeVisible();
    submit(); await screen.findByText("Imported to Library.");
    expect(api.importRunSetup).toHaveBeenCalledWith(expect.objectContaining({ name: "Imported Workflow", profile_name: profileName ?? "Imported Profile" }), expect.any(AbortSignal));
  });

  it.each(["", "x".repeat(201)])("reveals invalid historical names without silently truncating them", async (name) => {
    const api = workflowLibraryApi();
    vi.mocked(api.getGlobalRunSetup).mockResolvedValue({ ...historicalSetup, workflow_name: name });
    render(<Harness api={api} />); await open();
    expect(screen.getByLabelText("Workflow name")).toHaveValue(name);
    expect(screen.getByLabelText("Workflow name")).toHaveAccessibleDescription("Enter a name (max 200 characters).");
    expect(within(review()).getByRole("button", { name: "Import to Library" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Repaired name" } });
    expect(screen.getByLabelText("Workflow name")).toHaveValue("Repaired name");
    submit(); await screen.findByText("Imported to Library.");
  });

  it("retains names and reveals both controls for a generic conflict; editing starts a new UUID", async () => {
    const api = workflowLibraryApi();
    vi.mocked(api.importRunSetup).mockRejectedValueOnce(new ApiError("Name or source conflict", "library_conflict", 409));
    render(<Harness api={api} />); await open(); submit();
    await screen.findByText("Check names or reload setup.");
    expect(screen.getByLabelText("Workflow name")).toHaveValue("Frozen Workflow");
    expect(screen.getByLabelText("Profile name")).toHaveValue("Frozen Profile");
    const first = vi.mocked(api.importRunSetup).mock.calls[0][0];
    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "New Profile" } });
    submit(); await screen.findByText("Imported to Library.");
    const second = vi.mocked(api.importRunSetup).mock.calls[1][0];
    expect(second.request_id).not.toBe(first.request_id);
    expect(second.profile_name).toBe("New Profile");
  });

  it("guards double submits synchronously and replays an unchanged unknown operation after close without reading a lost source", async () => {
    const api = workflowLibraryApi(); const pending = deferred<GlobalCopyResponse>();
    vi.mocked(api.importRunSetup).mockReturnValueOnce(pending.promise);
    render(<Harness api={api} />); await open();
    act(() => { fireEvent.submit(review().querySelector("form")!); fireEvent.submit(review().querySelector("form")!); });
    expect(api.importRunSetup).toHaveBeenCalledOnce();
    expect(screen.getByText("Closing stops waiting.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(vi.mocked(api.importRunSetup).mock.calls[0][1]?.aborted).toBe(true);
    await act(async () => pending.reject(new Error("Unknown response")));
    vi.mocked(api.getGlobalRunSetup).mockRejectedValue(new Error("Source removed"));
    await open(); submit(); await screen.findByText("Imported to Library.");
    expect(api.getGlobalRunSetup).toHaveBeenCalledOnce();
    expect(vi.mocked(api.importRunSetup).mock.calls[1][0]).toEqual(vi.mocked(api.importRunSetup).mock.calls[0][0]);
  });

  it("starts a new request after editing an unknown operation even when the names are reverted", async () => {
    const api = workflowLibraryApi();
    vi.mocked(api.importRunSetup).mockRejectedValueOnce(new Error("Response lost"));
    render(<Harness api={api} />); await open(); submit(); await screen.findByText("Response lost");
    const first = vi.mocked(api.importRunSetup).mock.calls[0][0];
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Changed" } });
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Frozen Workflow" } });
    submit(); await screen.findByText("Imported to Library.");
    expect(vi.mocked(api.importRunSetup).mock.calls[1][0]).toEqual({ ...first, request_id: expect.any(String) });
    expect(vi.mocked(api.importRunSetup).mock.calls[1][0].request_id).not.toBe(first.request_id);
  });

  it("binds a reloaded review to its new source hashes and requires another explicit submit", async () => {
    const api = workflowLibraryApi();
    vi.mocked(api.importRunSetup).mockRejectedValueOnce(new ApiError("Frozen setup changed", "library_conflict", 409));
    render(<Harness api={api} />); await open(); submit(); await screen.findByText("Frozen setup changed");
    const first = vi.mocked(api.importRunSetup).mock.calls[0][0];
    vi.mocked(api.getGlobalRunSetup).mockResolvedValue({ ...historicalSetup, source: { ...historicalSetup.source,
      workflow: { content_sha256: "c".repeat(64) }, profiles: [{ content_sha256: "d".repeat(64) }] } });
    fireEvent.click(screen.getByRole("button", { name: "Reload setup" }));
    await waitFor(() => expect(within(review()).getByRole("button", { name: "Import to Library" })).toBeEnabled());
    expect(api.importRunSetup).toHaveBeenCalledOnce();
    submit(); await screen.findByText("Imported to Library.");
    expect(vi.mocked(api.importRunSetup).mock.calls[1][0]).toEqual({ ...first, request_id: expect.any(String),
      expected_workflow_sha256: "c".repeat(64), expected_profile_sha256: "d".repeat(64) });
    expect(vi.mocked(api.importRunSetup).mock.calls[1][0].request_id).not.toBe(first.request_id);
  });

  it.each([
    ["collision", "success"], ["collision", "failure"],
    ["unknown", "success"], ["unknown", "failure"],
  ])("retains reviewed names and the request UUID after %s and reload %s", async (outcome, reload) => {
    const api = workflowLibraryApi();
    const pending = deferred<GlobalRunSetup>();
    vi.mocked(api.importRunSetup).mockRejectedValueOnce(outcome === "collision"
      ? new ApiError("Name conflict", "library_conflict", 409) : new Error("Response lost"));
    render(<Harness api={api} />); await open();
    fireEvent.click(screen.getByRole("button", { name: "Rename Workflow name" }));
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Reviewed Workflow" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename Profile name" }));
    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "Reviewed Profile" } });
    submit(); await screen.findByText("Check names or reload setup.");
    const first = vi.mocked(api.importRunSetup).mock.calls[0][0];
    vi.mocked(api.getGlobalRunSetup).mockReturnValueOnce(pending.promise);
    const reloadButton = screen.getByRole("button", { name: "Reload setup" });
    expect(reloadButton).toHaveAttribute("type", "button");
    fireEvent.click(reloadButton);
    expect(screen.getByText("Original experiment")).toBeVisible();
    expect(screen.getByLabelText("Workflow name")).toHaveValue("Reviewed Workflow");
    expect(screen.getByLabelText("Profile name")).toHaveValue("Reviewed Profile");
    expect(within(review()).getByRole("button", { name: "Import to Library" })).toBeDisabled();
    expect(api.importRunSetup).toHaveBeenCalledOnce();
    if (reload === "success") {
      await act(async () => pending.resolve({ ...historicalSetup, workflow_name: "Different default", profile_name: "Different Profile default" }));
    } else {
      await act(async () => pending.reject(new Error("Source removed")));
      expect(screen.getByRole("alert")).toHaveTextContent("Source removed");
    }
    expect(screen.getByLabelText("Workflow name")).toHaveValue("Reviewed Workflow");
    expect(screen.getByLabelText("Profile name")).toHaveValue("Reviewed Profile");
    expect(within(review()).getByRole("button", { name: "Import to Library" })).toBeEnabled();
    expect(api.importRunSetup).toHaveBeenCalledOnce();
    submit(); await screen.findByText("Imported to Library.");
    expect(vi.mocked(api.importRunSetup).mock.calls[1][0]).toEqual(first);
    expect(api.getGlobalRunSetup).toHaveBeenCalledTimes(2);
  });

  it.each(["run", "project"])("rejects a reloaded %s mismatch without losing the last validated setup or retry identity", async (kind) => {
    const api = workflowLibraryApi();
    vi.mocked(api.importRunSetup).mockRejectedValueOnce(new Error("Response lost"));
    render(<Harness api={api} projectId="source-project" />); await open(); submit();
    await screen.findByText("Response lost");
    const first = vi.mocked(api.importRunSetup).mock.calls[0][0];
    const invalid = { ...historicalSetup, run_name: "Wrong source", source: { ...historicalSetup.source } };
    if (kind === "run") { invalid.run_id = "other-run"; invalid.source.run_id = "other-run"; }
    else { invalid.project_id = "other-project"; invalid.source.project_id = "other-project"; }
    vi.mocked(api.getGlobalRunSetup).mockResolvedValue(invalid);
    fireEvent.click(screen.getByRole("button", { name: "Reload setup" }));
    await screen.findByText("The frozen setup did not match the selected Run or Project.");
    expect(screen.getByText("Original experiment")).toBeVisible();
    expect(screen.queryByText("Wrong source")).not.toBeInTheDocument();
    expect(api.importRunSetup).toHaveBeenCalledOnce();
    submit(); await screen.findByText("Imported to Library.");
    expect(vi.mocked(api.importRunSetup).mock.calls[1][0]).toEqual(first);
  });

  it.each(["success", "failure"])("preserves name edits and local validation during reload %s", async (reload) => {
    const api = workflowLibraryApi(); const pending = deferred<GlobalRunSetup>();
    vi.mocked(api.importRunSetup).mockRejectedValueOnce(new Error("Response lost"));
    render(<Harness api={api} />); await open(); submit(); await screen.findByText("Response lost");
    const first = vi.mocked(api.importRunSetup).mock.calls[0][0];
    vi.mocked(api.getGlobalRunSetup).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Reload setup" }));
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "x".repeat(201) } });
    if (reload === "success") await act(async () => pending.resolve(historicalSetup));
    else await act(async () => pending.reject(new Error("Source removed")));
    expect(screen.getByLabelText("Workflow name")).toHaveValue("");
    expect(screen.getByLabelText("Profile name")).toHaveValue("x".repeat(201));
    expect(screen.getByLabelText("Workflow name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Profile name")).toHaveAttribute("aria-invalid", "true");
    expect(within(review()).getByRole("button", { name: "Import to Library" })).toBeDisabled();
    expect(api.importRunSetup).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Repaired Workflow" } });
    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "Repaired Profile" } });
    submit(); await screen.findByText("Imported to Library.");
    const second = vi.mocked(api.importRunSetup).mock.calls[1][0];
    expect(second.request_id).not.toBe(first.request_id);
    expect(second).toMatchObject({ name: "Repaired Workflow", profile_name: "Repaired Profile" });
  });

  it("records a late receipt without reopening the closed dialog or navigating", async () => {
    const api = workflowLibraryApi(); const pending = deferred<GlobalCopyResponse>(); const navigate = vi.fn();
    vi.mocked(api.importRunSetup).mockReturnValueOnce(pending.promise);
    render(<Harness api={api} onOpen={navigate} />); await open(); submit();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => pending.resolve(importedSetup));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Imported to Library.")).toBeVisible();
    expect(api.getGlobalRunSetup).toHaveBeenCalledOnce();
  });

  it("ignores late Run A source reads after opening Run B", async () => {
    const api = workflowLibraryApi(); const pending = deferred<GlobalRunSetup>();
    vi.mocked(api.getGlobalRunSetup).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(setupFor("run-B"));
    const view = render(<Harness api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    view.rerender(<Harness api={api} runId="run-B" scope="other-context" />);
    await open();
    await act(async () => pending.resolve(setupFor("run-A")));
    expect(screen.getByText("run-B")).toBeVisible();
    expect(screen.queryByText("run-A")).not.toBeInTheDocument();
    submit(); await screen.findByText("Imported to Library.");
    expect(api.importRunSetup).toHaveBeenCalledWith(expect.objectContaining({ run_id: "run-B" }), expect.any(AbortSignal));
  });

  it("does not replace Run B review with a late Run A write", async () => {
    const api = workflowLibraryApi(); const pending = deferred<GlobalCopyResponse>();
    vi.mocked(api.importRunSetup).mockReturnValueOnce(pending.promise);
    const view = render(<Harness api={api} />); await open(); submit();
    view.rerender(<Harness api={api} runId="run-B" scope="other-context" />);
    vi.mocked(api.getGlobalRunSetup).mockResolvedValue(setupFor("run-B"));
    await open(); await act(async () => pending.resolve(importedSetup));
    expect(screen.getByText("run-B")).toBeVisible();
    expect(screen.queryByText("Imported to Library.")).not.toBeInTheDocument();
  });

  it.each(["query", "project", "active-run"])("hides and cancels pending review on %s context changes, retaining unchanged retry", async (scope) => {
    const api = workflowLibraryApi(); const pending = deferred<GlobalCopyResponse>();
    vi.mocked(api.importRunSetup).mockReturnValueOnce(pending.promise);
    const view = render(<Harness api={api} />); await open(); submit();
    view.rerender(<Harness api={api} scope={scope} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(vi.mocked(api.importRunSetup).mock.calls[0][1]?.aborted).toBe(true);
    await act(async () => pending.reject(new Error("Unknown response")));
    view.rerender(<Harness api={api} />); await open(); submit();
    await screen.findByText("Imported to Library.");
    expect(api.getGlobalRunSetup).toHaveBeenCalledOnce();
  });

  it("Escape closes only the top dialog and restores its exact trigger and scroll lock", async () => {
    const api = workflowLibraryApi(); render(<Harness api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    const trigger = within(screen.getByRole("dialog", { name: "Run inspection" })).getByRole("button");
    trigger.focus(); fireEvent.click(trigger);
    await screen.findByText("Frozen Workflow");
    fireEvent.click(screen.getByText("Inspect frozen setup"));
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    fireEvent.keyDown(review(), { key: "Escape" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
  });

  it("removes the child portal when its inspection owner unmounts at the same URL", async () => {
    const api = workflowLibraryApi(); render(<Harness api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    fireEvent.click(screen.getByRole("button", { name: "Import to Library" }));
    await screen.findByText("Frozen Workflow");
    fireEvent.click(screen.getByRole("button", { name: "Remove parent" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe("");
  });

  it("retries a failed source read explicitly and never posts an invalid immutable setup", async () => {
    const api = workflowLibraryApi(); vi.mocked(api.getGlobalRunSetup).mockRejectedValueOnce(new Error("Invalid immutable source"));
    render(<Harness api={api} />); fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByText("Invalid immutable source");
    expect(within(review()).getByRole("button", { name: "Import to Library" })).toBeDisabled();
    expect(api.importRunSetup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload setup" }));
    await screen.findByText("Frozen Workflow"); submit(); await screen.findByText("Imported to Library.");
  });
});
