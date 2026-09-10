import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowAuthoringDialog, WorkflowAuthoringFields, type WorkflowAuthoringDialogProps, type WorkflowAuthoringDraft } from "./WorkflowAuthoringDialog";

const workflow = {
  "1": { class_type: "CLIPTextEncode", inputs: { text: "prompt" } },
  "2": { class_type: "KSampler", inputs: { seed: 1 } },
  "3": { class_type: "SaveImage", inputs: { filename_prefix: "result" } },
};
const draft: WorkflowAuthoringDraft = {
  name: "Portrait",
  workflowJson: JSON.stringify(workflow),
  profileJson: JSON.stringify({
    mappings: {
      prompt: { node_id: "1", input_name: "text", value_type: "string" },
      seed: { node_id: "2", input_name: "seed", value_type: "integer" },
      output_prefix: { node_id: "3", input_name: "filename_prefix", value_type: "string" },
    },
    image_inputs: [], parameters: [],
  }),
  note: "",
};

afterEach(() => vi.restoreAllMocks());

function Editor(props: Partial<WorkflowAuthoringDialogProps>) {
  const [value, setValue] = useState(props.draft ?? draft);
  const [open, setOpen] = useState(true);
  return open && <WorkflowAuthoringDialog
    title="New Workflow" kind="workflow" workflow={workflow}
    onSave={() => undefined} onCancel={() => setOpen(false)}
    {...props} draft={value} onChange={(patch) => {
      setValue((current) => ({ ...current, ...patch }));
      props.onChange?.(patch);
    }}
  />;
}

function chooseFile(file: File) {
  fireEvent.change(screen.getByLabelText("Choose JSON file"), { target: { files: [file] } });
}

function jsonFile(text: string) {
  const file = new File([text], "workflow.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: vi.fn(async () => text) });
  return file;
}

describe("WorkflowAuthoringDialog", () => {
  it.each([
    ["workflow", true, "Name"],
    ["profile", true, "Name"],
    ["workflow", false, "Workflow JSON"],
    ["profile", false, "Prompt node"],
    ["metadata", false, "Save"],
  ] as const)("focuses %s / %s's %s after native showModal focuses the scrollable form", (kind, showName, target) => {
    vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) {
      this.open = true;
      const form = this.querySelector("form")!;
      form.tabIndex = -1;
      form.focus();
    });
    const view = render(<Editor kind={kind} showName={showName} showNote={false} />);
    const field = target === "Save" ? screen.getByRole("button", { name: target }) : screen.getByLabelText(target);
    expect(field).toHaveFocus();
    view.rerender(<Editor kind={kind} showName={showName} showNote={false} active={false} />);
    const focus = vi.spyOn(field, "focus");
    view.rerender(<Editor kind={kind} showName={showName} showNote={false} active={false} error="Retained error" />);
    expect(focus).not.toHaveBeenCalled();
    view.rerender(<Editor kind={kind} showName={showName} showNote={false} />);
    expect(field).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("does not focus disabled fields on a pending-save reopen or steal footer focus on updates", () => {
    const view = render(<Editor />);
    const name = screen.getByLabelText("Name");
    const focus = vi.spyOn(name, "focus");
    screen.getByRole("button", { name: "Save" }).focus();
    view.rerender(<Editor error="Retained draft" />);
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    view.rerender(<Editor active={false} saving />);
    view.rerender(<Editor saving />);
    expect(name).toBeDisabled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("suspends a dirty modal without cancellation and preserves its original dirty baseline on return", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const view = render(<Editor />);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unfinished" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirm).toHaveBeenCalledOnce();
    view.rerender(<Editor active={false} />);
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(dialog).not.toHaveAttribute("open");
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(confirm).toHaveBeenCalledOnce();
    view.rerender(<Editor />);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(screen.getByLabelText("Name")).toHaveValue("Unfinished");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: draft.name } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps pending saves locked while suspended and exposes the latest parent error on return", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const view = render(<Editor saving onSave={onSave} onCancel={onCancel} />);
    const dialog = screen.getByRole("dialog");
    view.rerender(<Editor active={false} saving onSave={onSave} onCancel={onCancel} />);
    expect(dialog).not.toHaveAttribute("open");
    expect(document.body.style.overflow).not.toBe("hidden");
    view.rerender(<Editor active={false} error="Save failed" onSave={onSave} onCancel={onCancel} />);
    fireEvent.submit(dialog.querySelector("form")!);
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    view.rerender(<Editor error="Save failed" onSave={onSave} onCancel={onCancel} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("keeps both actions outside the scrolling form while retaining native form submission and validation", () => {
    const onSave = vi.fn();
    render(<Editor onSave={onSave} />);
    const dialog = screen.getByRole("dialog");
    const form = dialog.querySelector("form")!;
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.parentElement).toBe(dialog);
    expect(screen.getByRole("button", { name: "Cancel" }).parentElement).toBe(dialog);
    expect(save.form).toBe(form);
    expect(form).not.toContainElement(save);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "" } });
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Valid name" } });
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledOnce();
    fireEvent.submit(form);
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("opens a native modal, autofocuses Name, locks scrolling and restores the opener", () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const confirm = vi.spyOn(window, "confirm");
    const openerView = render(<button>Open authoring</button>);
    const opener = screen.getByRole("button", { name: "Open authoring" });
    opener.focus();
    const previous = document.body.style.overflow;
    render(<Editor />);
    expect(showModal).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe(previous);
    expect(opener).toHaveFocus();
    openerView.unmount();
  });

  it.each(["Cancel", "Escape", "backdrop", "native cancel"])("guards dirty %s and retains edits when discard is declined", (method) => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Editor />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Edited" } });
    function close() {
      const dialog = screen.getByRole("dialog");
      if (method === "Cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      else if (method === "Escape") fireEvent.keyDown(dialog, { key: "Escape" });
      else if (method === "backdrop") fireEvent.click(dialog, { clientX: -1 });
      else fireEvent(dialog, new Event("cancel", { cancelable: true }));
    }
    close();
    expect(confirm).toHaveBeenLastCalledWith("Discard unsaved changes?");
    expect(screen.getByLabelText("Name")).toHaveValue("Edited");
    confirm.mockReturnValue(true);
    close();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses Save by default and leaves errors, successful close and handoff to the parent", () => {
    const onSave = vi.fn();
    const view = render(<Editor onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Version note (optional)"), { target: { value: "Review" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    view.rerender(<Editor onSave={onSave} error="Write failed; retry after checking." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Write failed");
    expect(screen.getByLabelText("Version note (optional)")).toHaveValue("Review");
    view.rerender(<Editor onSave={onSave} saveLabel="Apply snapshots" />);
    fireEvent.click(screen.getByRole("button", { name: "Apply snapshots" }));
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("blocks editing, repeated saves and all cancellation while saving or reconciling", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const confirm = vi.spyOn(window, "confirm");
    const view = render(<Editor saving onSave={onSave} onCancel={onCancel} />);
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("dialog"), { clientX: -1 });
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    view.rerender(<Editor saveDisabled closeDisabled onSave={onSave} onCancel={onCancel} error="Checking whether the write succeeded." />);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("reuses the mapper against the supplied exact workflow without exposing profile file import", () => {
    const onChange = vi.fn();
    render(<Editor kind="profile" title="Edit Profile" showName={false} onChange={onChange} />);
    expect(screen.getByLabelText("Prompt node")).toHaveValue("1");
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Choose JSON file")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Prompt node"), { target: { value: "" } });
    expect(JSON.parse(onChange.mock.calls[0][0].profileJson).mappings.prompt.node_id).toBe("");
    expect(workflow["1"].inputs.text).toBe("prompt");
  });

  it("allows metadata-only fields and optional descriptions without a Batch or API", () => {
    const onChange = vi.fn();
    render(<WorkflowAuthoringFields kind="metadata" draft={{ ...draft, description: "Description" }} workflow={{}} onChange={onChange} />);
    expect(screen.queryByLabelText("Workflow JSON")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Prompt node")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: "Updated" } });
    expect(onChange).toHaveBeenCalledWith({ description: "Updated" });
  });

  it("loads JSON into the same textarea without conversion, renaming or saving", async () => {
    const text = '{ "1": { "class_type": "Example", "inputs": {} } }';
    const onSave = vi.fn();
    render(<Editor onSave={onSave} />);
    chooseFile(jsonFile(text));
    await waitFor(() => expect(screen.getByLabelText("Workflow JSON")).toHaveValue(text));
    expect(screen.getByLabelText("Name")).toHaveValue("Portrait");
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Workflow JSON"), { target: { value: "edited JSON" } });
    expect(screen.getByLabelText("Workflow JSON")).toHaveValue("edited JSON");
  });

  it.each(["invalid JSON", "[]", "null", "42"])("retains textarea content when a file contains %s", async (text) => {
    render(<Editor />);
    chooseFile(jsonFile(text));
    expect(await screen.findByRole("alert")).toHaveTextContent(/must contain (valid JSON|an object)/);
    expect(screen.getByLabelText("Workflow JSON")).toHaveValue(draft.workflowJson);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("rejects oversized files before reading and reports read failures without losing the draft", async () => {
    render(<Editor />);
    const oversized = jsonFile("{}");
    Object.defineProperty(oversized, "size", { value: 64 * 1024 * 1024 + 1 });
    chooseFile(oversized);
    expect(await screen.findByRole("alert")).toHaveTextContent("must not exceed 64 MiB");
    expect(oversized.text).not.toHaveBeenCalled();
    const unreadable = jsonFile("{}");
    vi.mocked(unreadable.text).mockRejectedValue(new Error("File cannot be read"));
    chooseFile(unreadable);
    expect(await screen.findByRole("alert")).toHaveTextContent("File cannot be read");
    expect(screen.getByLabelText("Workflow JSON")).toHaveValue(draft.workflowJson);
  });

  it("blocks Save during file reading and ignores the read after cancellation", async () => {
    let resolve!: (text: string) => void;
    const file = jsonFile("{}");
    vi.mocked(file.text).mockReturnValue(new Promise((done) => { resolve = done; }));
    const onChange = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Editor onChange={onChange} />);
    chooseFile(file);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => resolve('{"late":true}'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("supports a parent-owned Workflow-to-Profile handoff and keeps the created Workflow on cancel", () => {
    const createWorkflow = vi.fn();
    const createProfile = vi.fn();
    function Parent() {
      const [stage, setStage] = useState<"workflow" | "profile" | null>("workflow");
      const [value, setValue] = useState(draft);
      const [created, setCreated] = useState(false);
      return <>
        {created && <p>Workflow saved</p>}
        {stage && <WorkflowAuthoringDialog key={stage} kind={stage} title={stage === "workflow" ? "New Workflow" : "New Profile"} draft={value} workflow={workflow}
          onChange={(patch) => setValue((current) => ({ ...current, ...patch }))}
          onCancel={() => setStage(null)} onSave={() => {
            if (stage === "workflow") {
              createWorkflow();
              setCreated(true);
              setValue({ ...value, name: `${value.name}-profile`, note: "" });
              setStage("profile");
            } else createProfile();
          }} />}
      </>;
    }
    render(<Parent />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("dialog", { name: "New Profile" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Portrait-profile");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Workflow saved")).toBeInTheDocument();
    expect(createWorkflow).toHaveBeenCalledOnce();
    expect(createProfile).not.toHaveBeenCalled();
  });
});
