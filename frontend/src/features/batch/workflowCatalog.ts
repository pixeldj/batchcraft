import type { JsonObject } from "../../api/types";

export type WorkflowInputKind = "literal" | "connection";

export type WorkflowMappingKind =
  | "prompt"
  | "seed"
  | "output_prefix"
  | "reference_image";

export interface WorkflowCatalogInput {
  name: string;
  currentValue: unknown;
  kind: WorkflowInputKind;
}

export interface WorkflowCatalogNode {
  id: string;
  classType: string;
  title?: string;
  inputs: WorkflowCatalogInput[];
}

export interface WorkflowInputCandidate {
  node: WorkflowCatalogNode;
  input: WorkflowCatalogInput;
  score: number;
}

export function parseWorkflowNodeCatalog(workflow: JsonObject): WorkflowCatalogNode[] {
  const nodes: WorkflowCatalogNode[] = [];

  for (const [id, value] of Object.entries(workflow)) {
    if (id.length === 0 || !isObject(value)) continue;

    const classType = value.class_type;
    const rawInputs = value.inputs;
    if (typeof classType !== "string" || classType.length === 0 || !isObject(rawInputs)) {
      continue;
    }

    const inputs = Object.entries(rawInputs)
      .filter(([name]) => name.length > 0)
      .map(([name, currentValue]) => ({
        name,
        currentValue,
        kind: isComfyUIConnection(currentValue) ? "connection" as const : "literal" as const,
      }))
      .sort((left, right) => compareText(left.name, right.name));

    const title = isObject(value._meta) && typeof value._meta.title === "string"
      && value._meta.title.length > 0
      ? value._meta.title
      : undefined;

    nodes.push({ id, classType, ...(title === undefined ? {} : { title }), inputs });
  }

  return nodes.sort((left, right) => compareNodeIds(left.id, right.id));
}

export function isComfyUIConnection(value: unknown): value is [string, number] {
  return Array.isArray(value)
    && value.length === 2
    && typeof value[0] === "string"
    && value[0].length > 0
    && typeof value[1] === "number"
    && Number.isInteger(value[1])
    && value[1] >= 0;
}

export function formatWorkflowNodeLabel(node: WorkflowCatalogNode): string {
  return node.title === undefined
    ? `${node.id} · ${node.classType}`
    : `${node.id} · ${node.classType} · ${node.title}`;
}

export function summarizeLiteralValue(value: unknown, maxStringLength = 48): string {
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    const limit = Math.max(4, Math.floor(maxStringLength));
    const truncated = compact.length > limit
      ? `${compact.slice(0, limit - 3)}...`
      : compact;
    return `"${truncated}"`;
  }
  if (value === null) return "null";
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (isObject(value)) return `Object(${Object.keys(value).length})`;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return typeof value;
}

export function scoreWorkflowInputCandidate(
  mappingKind: WorkflowMappingKind,
  node: WorkflowCatalogNode,
  input: WorkflowCatalogInput,
): number {
  const name = normalizeIdentifier(input.name);
  const classType = normalizeIdentifier(node.classType);
  let score = preferredLiteralTypeScore(mappingKind, input.currentValue);

  if (mappingKind === "prompt") {
    score += nameScore(name, ["prompt", "text", "positiveprompt"], ["prompt", "text"]);
    if (classType.includes("cliptextencode")) score += 80;
    else if (classType.includes("textencode")) score += 60;
  } else if (mappingKind === "seed") {
    score += nameScore(name, ["seed", "noiseseed"], ["seed"]);
    if (classType.includes("ksampler")) score += 80;
    else if (classType.includes("sampler")) score += 60;
  } else if (mappingKind === "output_prefix") {
    score += nameScore(
      name,
      ["filenameprefix", "outputprefix", "prefix"],
      ["filename", "output", "prefix"],
    );
    if (classType.includes("saveimage")) score += 80;
    else if (classType.startsWith("save")) score += 60;
  } else {
    score += nameScore(
      name,
      ["image", "filename", "imagepath", "filepath"],
      ["image", "file", "path"],
    );
    if (classType.includes("loadimage")) score += 80;
    else if (classType.includes("imageloader")) score += 60;
  }

  return score;
}

export function rankWorkflowInputCandidates(
  nodes: WorkflowCatalogNode[],
  mappingKind: WorkflowMappingKind,
): WorkflowInputCandidate[] {
  const candidates = nodes.flatMap((node) => node.inputs
    .filter((input) => input.kind === "literal")
    .map((input) => ({
      node,
      input,
      score: scoreWorkflowInputCandidate(mappingKind, node, input),
    })));

  return candidates.sort((left, right) => (
    right.score - left.score
    || compareNodeIds(left.node.id, right.node.id)
    || compareText(left.input.name, right.input.name)
  ));
}

function preferredLiteralTypeScore(mappingKind: WorkflowMappingKind, value: unknown): number {
  if (mappingKind === "seed") {
    return typeof value === "number" && Number.isInteger(value) ? 50 : 0;
  }
  return typeof value === "string" ? 50 : 0;
}

function nameScore(name: string, exact: string[], partial: string[]): number {
  if (exact.includes(name)) return 120;
  return partial.some((part) => name.includes(part)) ? 80 : 0;
}

function normalizeIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function compareNodeIds(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    const numericOrder = compareUnsignedIntegers(left, right);
    return numericOrder || compareText(left, right);
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return compareText(left, right);
}

function compareUnsignedIntegers(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  return normalizedLeft.length - normalizedRight.length
    || compareText(normalizedLeft, normalizedRight);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
