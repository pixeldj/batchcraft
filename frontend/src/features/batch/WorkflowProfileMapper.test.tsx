import { useState, type FormEvent } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../../api/types";
import { deriveImageInputKey, deriveParameterKey, WorkflowProfileMapper } from "./WorkflowProfileMapper";

const WORKFLOW: JsonObject = {
  "7": { class_type: "KSampler", inputs: { model: ["2", 0], seed: 1, steps: 20, cfg: 7.5, enabled: true, scheduler: "normal" } },
  "25": { class_type: "LoadImage", inputs: { image: "base.png", connected: ["3", 0] } },
  "34": { class_type: "CLIPTextEncode", inputs: { text: "Prompt" } },
  "41": { class_type: "SaveImage", inputs: { filename_prefix: "output" } },
};

describe("WorkflowProfileMapper", () => {
  it("supports a Profile with zero Image Inputs", () => {
    render(<Harness initialProfile={profileJson([])} />);

    expect(screen.getByText("No Image Inputs.")).toBeInTheDocument();
    expect(readProfile().image_inputs).toEqual([]);
  });

  it("adds one stable keyed Image Input and does not change its key after a label edit", () => {
    render(<Harness initialProfile={profileJson([])} />);

    fireEvent.click(screen.getByRole("button", { name: "Add Image Input" }));
    fireEvent.change(screen.getByLabelText("Image Input 1 label"), { target: { value: "Control image" } });
    fireEvent.blur(screen.getByLabelText("Image Input 1 label"));
    const key = (readProfile().image_inputs as Array<{ key: string }>)[0].key;
    fireEvent.change(screen.getByLabelText("Image Input 1 label"), { target: { value: "Renamed control" } });

    expect(key).toBe("control_image");
    expect(readProfile().image_inputs).toEqual([
      { key: "control_image", label: "Renamed control", node_id: "", input_name: "" },
    ]);
  });

  it("derives a readable key when the first label edit finishes", () => {
    render(<Harness initialProfile={profileJson([])} />);
    fireEvent.click(screen.getByRole("button", { name: "Add Image Input" }));
    const label = screen.getByLabelText("Image Input 1 label");
    label.focus();

    fireEvent.change(label, { target: { value: "S" } });
    fireEvent.change(label, { target: { value: "Sampling steps" } });

    expect(screen.getByLabelText("Image Input 1 label")).toHaveFocus();
    expect((readProfile().image_inputs as Array<{ key: string }>)[0].key).toBe("");
    fireEvent.blur(label);
    expect((readProfile().image_inputs as Array<{ key: string }>)[0].key).toBe("sampling_steps");
  });

  it("keeps image slot keys separate from core mapping names", () => {
    render(<Harness initialProfile={profileJson([
      { key: "prompt", label: "Image prompt", node_id: "25", input_name: "image" },
    ])} />);

    expect(screen.getByLabelText("Prompt node")).toHaveValue("34");
    expect(screen.getByLabelText("Image prompt node")).toHaveValue("25");
  });

  it("preserves multiple Image Input order and reorders with Up and Down", () => {
    render(<Harness initialProfile={profileJson([
      { key: "style", label: "Style", node_id: "25", input_name: "image" },
      { key: "pose", label: "Pose", node_id: "25", input_name: "missing" },
    ])} />);

    expect(screen.getByText("Input missing is missing from node 25.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move Pose up" }));

    expect(readProfile().image_inputs).toEqual([
      { key: "pose", label: "Pose", node_id: "25", input_name: "missing" },
      { key: "style", label: "Style", node_id: "25", input_name: "image" },
    ]);
    expect(screen.getByRole("button", { name: "Move Pose down" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Pose" })).toBeInTheDocument();
  });

  it("keeps copied broken mappings visible for repair and protects connected inputs", () => {
    render(<Harness initialProfile={profileJson([
      { key: "source", label: "Source", node_id: "99", input_name: "image" },
    ])} />);

    expect(screen.getByLabelText("Source node")).toHaveValue("99");
    expect(screen.getByText("Node 99 is missing from this WorkflowVersion.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Source node"), { target: { value: "25" } });
    expect(screen.getByRole("option", { name: "connected (connected)" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Source input"), { target: { value: "image" } });
    expect(screen.queryByText("Node 99 is missing from this WorkflowVersion.")).not.toBeInTheDocument();
  });

  it("derives deterministic collision-safe keys", () => {
    expect(deriveImageInputKey("Style Image", [])).toBe("style_image");
    expect(deriveImageInputKey("Style Image", ["style_image", "style_image_2"])).toBe("style_image_3");
    expect(deriveImageInputKey("123", [])).toBe("image_123");
    expect(deriveImageInputKey("***", [])).toBe("image_input");
    expect(deriveParameterKey("123", [])).toBe("parameter_123");
  });

  it("adds, infers, edits, reorders, and removes stable Parameters", () => {
    render(<Harness initialProfile={profileJson([])} />);

    fireEvent.click(screen.getByRole("button", { name: "Add Parameter" }));
    fireEvent.change(screen.getByLabelText("Parameter 1 label"), { target: { value: "Steps" } });
    fireEvent.change(screen.getByLabelText("Steps node"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("Steps input"), { target: { value: "steps" } });
    expect(screen.getByLabelText("Steps type")).toHaveValue("integer");
    expect(screen.getByRole("option", { name: "float" })).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText("Steps type"), { target: { value: "float" } });
    fireEvent.change(screen.getByLabelText("Parameter 1 label"), { target: { value: "Sampling steps" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Parameter" }));
    fireEvent.change(screen.getByLabelText("Parameter 2 label"), { target: { value: "Enabled" } });
    fireEvent.change(screen.getByLabelText("Enabled node"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("Enabled input"), { target: { value: "enabled" } });
    expect(screen.getByLabelText("Enabled type")).toHaveValue("boolean");
    fireEvent.click(screen.getByRole("button", { name: "Move Enabled up" }));

    expect(readProfile().parameters).toEqual([
      { key: "enabled", label: "Enabled", node_id: "7", input_name: "enabled", value_type: "boolean" },
      { key: "steps", label: "Sampling steps", node_id: "7", input_name: "steps", value_type: "float" },
    ]);
    expect(screen.getByRole("button", { name: "Move Enabled down" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Enabled" }));
    expect(readProfile().parameters).toEqual([
      { key: "steps", label: "Sampling steps", node_id: "7", input_name: "steps", value_type: "float" },
    ]);
  });

  it("retains a copied broken Parameter for repair and rejects connected and duplicate targets", () => {
    render(<Harness initialProfile={JSON.stringify({
      ...JSON.parse(profileJson([])),
      parameters: [{ key: "steps", label: "Steps", node_id: "99", input_name: "steps", value_type: "integer" }],
    })} />);

    expect(screen.getByLabelText("Steps node")).toHaveValue("99");
    expect(screen.getByText("Node 99 is missing from this WorkflowVersion.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Steps node"), { target: { value: "7" } });
    expect(within(screen.getByLabelText("Steps input")).getByRole("option", { name: "model (connected)" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Steps input"), { target: { value: "seed" } });
    expect(screen.getAllByText("Node 7 input seed is used by more than one mapping.").length).toBeGreaterThan(0);
  });

  it("marks unsafe integer literals incompatible before Profile submission", () => {
    const workflow = structuredClone(WORKFLOW);
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    (workflow["7"] as { inputs: Record<string, unknown> }).inputs.unsafe = Number.MAX_SAFE_INTEGER + 1;
    render(<form onSubmit={onSubmit}>
      <Harness initialProfile={JSON.stringify({
        ...JSON.parse(profileJson([])),
        parameters: [{ key: "unsafe", label: "Unsafe", node_id: "7", input_name: "unsafe", value_type: "integer" }],
      })} workflow={workflow} />
      <button type="submit">Save Profile</button>
    </form>);

    expect(screen.getByText("Unsafe type integer is incompatible with the current literal.")).toBeInTheDocument();
    expect(screen.getByLabelText("Unsafe type")).toBeRequired();
    expect(screen.getByLabelText("Unsafe type")).toHaveValue("");
    expect(within(screen.getByLabelText("Unsafe input")).getByRole("option", { name: "unsafe (not scalar)" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save Profile" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("establishes a Parameter key when the first nonblank label edit finishes", () => {
    render(<Harness initialProfile={profileJson([])} />);
    fireEvent.click(screen.getByRole("button", { name: "Add Parameter" }));
    fireEvent.change(screen.getByLabelText("Parameter 1 label"), { target: { value: "S" } });
    fireEvent.change(screen.getByLabelText("Parameter 1 label"), { target: { value: "Steps" } });
    fireEvent.blur(screen.getByLabelText("Parameter 1 label"));

    expect((readProfile().parameters as Array<{ key: string }>)[0].key).toBe("steps");
  });
});

function Harness({ initialProfile, workflow = WORKFLOW }: { initialProfile: string; workflow?: JsonObject }) {
  const [profile, setProfile] = useState(initialProfile);
  return <WorkflowProfileMapper workflow={workflow} profileJson={profile} onChange={setProfile} />;
}

function profileJson(imageInputs: unknown[]) {
  return JSON.stringify({
    id: "profile-1",
    name: "Mapping",
    mappings: {
      prompt: { node_id: "34", input_name: "text", value_type: "string" },
      seed: { node_id: "7", input_name: "seed", value_type: "integer" },
      output_prefix: { node_id: "41", input_name: "filename_prefix", value_type: "string" },
    },
    image_inputs: imageInputs,
    parameters: [],
  });
}

function readProfile(): JsonObject {
  const raw = screen.getByLabelText("Raw profile JSON") as HTMLTextAreaElement;
  return JSON.parse(raw.value) as JsonObject;
}
