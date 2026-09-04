import type { JsonObject, ParameterValueType } from "../../api/types";

export interface WorkflowInputTarget {
  node_id: string;
  input_name: string;
}

export interface BaseWorkflowValueDisplay {
  text: string;
  title?: string;
  available: boolean;
}

export function readFrozenWorkflowInput(
  workflow: JsonObject,
  target: WorkflowInputTarget,
): { found: true; value: unknown } | { found: false } {
  const node = workflow[target.node_id];
  if (!isObject(node) || !isObject(node.inputs) || !(target.input_name in node.inputs)) {
    return { found: false };
  }
  return { found: true, value: node.inputs[target.input_name] };
}

export function formatBaseWorkflowValue(
  workflow: JsonObject,
  target: WorkflowInputTarget,
  valueType?: ParameterValueType,
): BaseWorkflowValueDisplay {
  const input = readFrozenWorkflowInput(workflow, target);
  if (!input.found || !matchesType(input.value, valueType)) {
    return { text: "Base workflow · Unavailable", available: false };
  }
  const value = formatLiteral(input.value);
  if (!value) return { text: "Base workflow · Unavailable", available: false };
  const text = `Base workflow · ${value.compact}`;
  const fullText = `Base workflow · ${value.full}`;
  return {
    text,
    ...(text === fullText ? {} : { title: fullText }),
    available: true,
  };
}

function formatLiteral(value: unknown): { compact: string; full: string } | null {
  if (typeof value === "string") {
    if (value === "") return { compact: "Empty string", full: "Empty string" };
    const compact = value.replace(/\s+/g, " ");
    return {
      compact: compact.length > 80 ? `${compact.slice(0, 77)}...` : compact,
      full: value,
    };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { compact: String(value), full: String(value) };
  }
  if (typeof value === "boolean") {
    return { compact: String(value), full: String(value) };
  }
  return null;
}

function matchesType(value: unknown, valueType?: ParameterValueType): boolean {
  if (!valueType) return true;
  if (valueType === "string") return typeof value === "string";
  if (valueType === "boolean") return typeof value === "boolean";
  if (valueType === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  return typeof value === "number" && Number.isFinite(value);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
