import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../api/types";
import { WorkflowProfileMapper } from "./WorkflowProfileMapper";

const WORKFLOW: JsonObject = {
  "7": {
    class_type: "KSampler",
    _meta: { title: "Main sampler" },
    inputs: { model: ["2", 0], seed: 1, steps: 20 },
  },
  "25": {
    class_type: "LoadImage",
    _meta: { title: "Source image" },
    inputs: { image: "base.png", upload: "image" },
  },
  "34": {
    class_type: "CLIPTextEncode",
    _meta: { title: "Positive Prompt" },
    inputs: { clip: ["3", 0], text: "A very long base workflow prompt that should stay out of the node label" },
  },
  "41": {
    class_type: "SaveImage",
    _meta: { title: "Final output" },
    inputs: { filename_prefix: "output", images: ["8", 0] },
  },
};

describe("WorkflowProfileMapper", () => {
  it("populates existing mappings and presents node title, class, and ID", () => {
    render(<Harness initialProfile={profileJson(true)} />);

    expect(screen.getByLabelText("Prompt node")).toHaveValue("34");
    expect(screen.getByLabelText("Prompt input")).toHaveValue("text");
    expect(screen.getAllByRole("option", {
      name: "34 · CLIPTextEncode · Positive Prompt",
    })).toHaveLength(4);
    expect(screen.getAllByText(/Current value:/)[0]?.closest("p")).toHaveTextContent(
      '"A very long base workflow prompt that should ..."',
    );
    expect(screen.getByLabelText("Input Image node")).toHaveValue("25");
  });

  it("generates the persisted mappings from visual selections with optional Input Image", () => {
    render(<Harness initialProfile={JSON.stringify({ mappings: {} })} />);

    selectTarget("Prompt", "34", "text");
    selectTarget("Seed", "7", "seed");
    selectTarget("Output Prefix", "41", "filename_prefix");

    expect(readRawMappings()).toEqual({
      prompt: { node_id: "34", input_name: "text", value_type: "string" },
      seed: { node_id: "7", input_name: "seed", value_type: "integer" },
      output_prefix: { node_id: "41", input_name: "filename_prefix", value_type: "string" },
    });
    expect(screen.getByLabelText("Input Image node")).toHaveValue("");
    expect(screen.queryByText("Input Image must be mapped.")).not.toBeInTheDocument();

    selectTarget("Input Image", "25", "image");
    expect(readRawMappings()).toHaveProperty("reference_image", {
      node_id: "25",
      input_name: "image",
      value_type: "image",
    });
    fireEvent.change(screen.getByLabelText("Input Image node"), { target: { value: "" } });
    expect(readRawMappings()).not.toHaveProperty("reference_image");
  });

  it("retains valid copied targets while clearly marking and repairing a missing target", () => {
    const profile = JSON.parse(profileJson(false)) as JsonObject;
    const mappings = profile.mappings as JsonObject;
    mappings.seed = { node_id: "99", input_name: "noise_seed", value_type: "integer" };
    render(<Harness initialProfile={JSON.stringify(profile)} />);

    expect(screen.getByLabelText("Prompt node")).toHaveValue("34");
    expect(screen.getByRole("alert", { name: "" })).toHaveTextContent(
      "Node 99 is missing from this WorkflowVersion.",
    );
    expect(screen.getByLabelText("Seed node")).toHaveValue("99");

    selectTarget("Seed", "7", "seed");
    expect(screen.queryByText("Node 99 is missing from this WorkflowVersion.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Prompt node")).toHaveValue("34");
    expect(readRawMappings()).toHaveProperty("seed", {
      node_id: "7",
      input_name: "seed",
      value_type: "integer",
    });
  });

  it("shows connected inputs but prevents selecting them as writable targets", () => {
    const profile = JSON.parse(profileJson(false)) as JsonObject;
    const mappings = profile.mappings as JsonObject;
    mappings.prompt = { node_id: "34", input_name: "clip", value_type: "string" };
    render(<Harness initialProfile={JSON.stringify(profile)} />);

    expect(screen.getByRole("option", { name: "clip (connected)" })).toBeDisabled();
    expect(screen.getByText(/is connected and cannot be overwritten/)).toBeInTheDocument();
  });

  it("marks wrong declared types and duplicate writable targets", () => {
    const profile = JSON.parse(profileJson(false)) as JsonObject;
    const mappings = profile.mappings as JsonObject;
    mappings.seed = { node_id: "7", input_name: "seed", value_type: "string" };
    mappings.output_prefix = { node_id: "34", input_name: "text", value_type: "string" };
    render(<Harness initialProfile={JSON.stringify(profile)} />);

    expect(screen.getByText("Seed must use value type integer.")).toBeInTheDocument();
    expect(screen.getAllByText("Node 34 input text is used by more than one mapping.")).toHaveLength(2);
  });

  it("keeps raw profile JSON read-only so it cannot diverge from visual state", () => {
    render(<Harness initialProfile={profileJson(false)} />);

    expect(screen.getByLabelText("Raw profile JSON")).toHaveAttribute("readonly");
  });
});

function Harness({ initialProfile }: { initialProfile: string }) {
  const [profile, setProfile] = useState(initialProfile);
  return <WorkflowProfileMapper workflow={WORKFLOW} profileJson={profile} onChange={setProfile} />;
}

function selectTarget(label: string, nodeId: string, inputName: string) {
  fireEvent.change(screen.getByLabelText(`${label} node`), { target: { value: nodeId } });
  fireEvent.change(screen.getByLabelText(`${label} input`), { target: { value: inputName } });
}

function readRawMappings() {
  const raw = screen.getByLabelText("Raw profile JSON") as HTMLTextAreaElement;
  return (JSON.parse(raw.value) as { mappings: JsonObject }).mappings;
}

function profileJson(includeImage: boolean) {
  return JSON.stringify({
    id: "profile-1",
    name: "Mapping",
    mappings: {
      prompt: { node_id: "34", input_name: "text", value_type: "string" },
      seed: { node_id: "7", input_name: "seed", value_type: "integer" },
      output_prefix: { node_id: "41", input_name: "filename_prefix", value_type: "string" },
      ...(includeImage ? {
        reference_image: { node_id: "25", input_name: "image", value_type: "image" },
      } : {}),
    },
  });
}
