import { describe, expect, it } from "vitest";

import {
  formatWorkflowNodeLabel,
  isComfyUIConnection,
  parseWorkflowNodeCatalog,
  rankWorkflowInputCandidates,
  summarizeLiteralValue,
} from "./workflowCatalog";
import { formatBaseWorkflowValue, readFrozenWorkflowInput } from "./baseWorkflowValue";

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

describe("Base workflow values", () => {
  const workflow = {
    "1": {
      inputs: {
        filename: "reference-image.png",
        empty: "",
        integer: 20,
        float: 7.25,
        enabled: false,
        unsupported: null,
      },
    },
  };

  it.each([
    ["filename", "string", "Base workflow · reference-image.png"],
    ["empty", "string", "Base workflow · Empty string"],
    ["integer", "integer", "Base workflow · 20"],
    ["float", "float", "Base workflow · 7.25"],
    ["enabled", "boolean", "Base workflow · false"],
  ] as const)("formats the frozen %s input", (input_name, valueType, expected) => {
    expect(formatBaseWorkflowValue(workflow, { node_id: "1", input_name }, valueType).text).toBe(expected);
  });

  it("handles missing, null, and type-incompatible mapped inputs without throwing", () => {
    expect(readFrozenWorkflowInput(workflow, { node_id: "missing", input_name: "value" })).toEqual({ found: false });
    expect(formatBaseWorkflowValue(workflow, { node_id: "1", input_name: "missing" }).text).toBe("Base workflow · Unavailable");
    expect(formatBaseWorkflowValue(workflow, { node_id: "1", input_name: "unsupported" }).text).toBe("Base workflow · Unavailable");
    expect(formatBaseWorkflowValue(workflow, { node_id: "1", input_name: "integer" }, "string").text).toBe("Base workflow · Unavailable");
  });

  it("truncates long values while retaining the full value in the title", () => {
    const value = "a".repeat(100);
    const display = formatBaseWorkflowValue({ "1": { inputs: { value } } }, { node_id: "1", input_name: "value" }, "string");

    expect(display.text).toHaveLength("Base workflow · ".length + 80);
    expect(display.title).toBe(`Base workflow · ${value}`);
  });

  it("preserves original whitespace in the full-value title", () => {
    const value = `${"a".repeat(78)}\nfinal line`;
    const display = formatBaseWorkflowValue({ "1": { inputs: { value } } }, { node_id: "1", input_name: "value" }, "string");

    expect(display.text).not.toContain("\n");
    expect(display.title).toBe(`Base workflow · ${value}`);
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
