import { describe, expect, it } from "vitest";

import {
  formatWorkflowNodeLabel,
  isComfyUIConnection,
  parseWorkflowNodeCatalog,
  rankWorkflowInputCandidates,
  summarizeLiteralValue,
} from "./workflowCatalog";

describe("parseWorkflowNodeCatalog", () => {
  it("extracts valid nodes and inputs in deterministic natural order", () => {
    const catalog = parseWorkflowNodeCatalog({
      output: {
        class_type: "SaveImage",
        inputs: { images: ["10", 0], filename_prefix: "batchcraft" },
      },
      "10": {
        class_type: "CLIPTextEncode",
        _meta: { title: "Positive prompt" },
        inputs: { text: "a portrait", clip: ["2", 1] },
      },
      "2": {
        class_type: "KSampler",
        inputs: { steps: 20, seed: 42 },
      },
    });

    expect(catalog.map((node) => node.id)).toEqual(["2", "10", "output"]);
    expect(catalog[1]).toEqual({
      id: "10",
      classType: "CLIPTextEncode",
      title: "Positive prompt",
      inputs: [
        { name: "clip", currentValue: ["2", 1], kind: "connection" },
        { name: "text", currentValue: "a portrait", kind: "literal" },
      ],
    });
    expect(catalog[0].inputs.map((input) => input.name)).toEqual(["seed", "steps"]);
  });

  it("skips malformed nodes while keeping unusual literal values", () => {
    const catalog = parseWorkflowNodeCatalog({
      missingClass: { inputs: {} },
      missingInputs: { class_type: "Broken" },
      arrayNode: [],
      valid: {
        class_type: "CustomNode",
        _meta: { title: 7 },
        inputs: { "": "ignored", config: { nested: true }, pair: ["", 0] },
      },
    });

    expect(catalog).toEqual([{
      id: "valid",
      classType: "CustomNode",
      inputs: [
        { name: "config", currentValue: { nested: true }, kind: "literal" },
        { name: "pair", currentValue: ["", 0], kind: "literal" },
      ],
    }]);
  });

  it("recognizes only exact ComfyUI connection pairs", () => {
    expect(isComfyUIConnection(["12", 0])).toBe(true);
    expect(isComfyUIConnection(["12", -1])).toBe(false);
    expect(isComfyUIConnection(["12", 0.5])).toBe(false);
    expect(isComfyUIConnection(["", 0])).toBe(false);
    expect(isComfyUIConnection(["12", 0, "extra"])).toBe(false);
  });
});

describe("workflow catalog presentation helpers", () => {
  it("labels nodes with their ID, class, and optional title", () => {
    expect(formatWorkflowNodeLabel({
      id: "7",
      classType: "KSampler",
      title: "Main sampler",
      inputs: [],
    })).toBe("7 · KSampler · Main sampler");
    expect(formatWorkflowNodeLabel({
      id: "25",
      classType: "LoadImage",
      inputs: [],
    })).toBe("25 · LoadImage");
  });

  it("summarizes literals without dumping nested JSON", () => {
    expect(summarizeLiteralValue("  a prompt\nwith spacing  ")).toBe('"a prompt with spacing"');
    expect(summarizeLiteralValue("abcdefghijklmnopqrstuvwxyz", 10)).toBe('"abcdefg..."');
    expect(summarizeLiteralValue({ private: "details", nested: {} })).toBe("Object(2)");
    expect(summarizeLiteralValue([1, 2, 3])).toBe("Array(3)");
    expect(summarizeLiteralValue(null)).toBe("null");
    expect(summarizeLiteralValue(42)).toBe("42");
  });
});

describe("rankWorkflowInputCandidates", () => {
  const catalog = parseWorkflowNodeCatalog({
    "3": {
      class_type: "LoadImage",
      inputs: { image: "source.png", upload: "image" },
    },
    "7": {
      class_type: "KSampler",
      inputs: { model: ["1", 0], sampler_name: "euler", seed: 1, steps: 20 },
    },
    "10": {
      class_type: "CLIPTextEncode",
      inputs: { clip: ["2", 0], text: "prompt" },
    },
    "41": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "output", images: ["7", 0] },
    },
  });

  it.each([
    ["prompt", "10.text"],
    ["seed", "7.seed"],
    ["output_prefix", "41.filename_prefix"],
    ["image_input", "3.image"],
  ] as const)("places the obvious %s target first", (mappingKind, expected) => {
    const candidates = rankWorkflowInputCandidates(catalog, mappingKind);

    expect(`${candidates[0].node.id}.${candidates[0].input.name}`).toBe(expected);
    expect(candidates).toHaveLength(7);
    expect(candidates.every((candidate) => candidate.input.kind === "literal")).toBe(true);
  });

  it("uses natural node and input order to break equal scores", () => {
    const candidates = rankWorkflowInputCandidates(
      parseWorkflowNodeCatalog({
        "10": { class_type: "Unknown", inputs: { z: false, a: false } },
        "2": { class_type: "Unknown", inputs: { value: false } },
      }),
      "prompt",
    );

    expect(candidates.map(({ node, input }) => `${node.id}.${input.name}`)).toEqual([
      "2.value",
      "10.a",
      "10.z",
    ]);
  });
});
