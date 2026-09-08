import type { HistoryProvenanceFilters } from "../../api/types";
import { validateHistoryFilters } from "./HistoryFilters";

export function parseHistoryFilters(raw: string): HistoryProvenanceFilters {
  if (raw.length > 16384) throw new Error("History filters exceed the supported size.");
  const parsed: unknown = JSON.parse(raw);
  const error = validateHistoryFilters(parsed);
  if (error) throw new Error(error);

  // Syntax and shape are already validated. Inspect whole tokens for information JSON.parse
  // discards: duplicate decoded keys and integer versus float spelling. Strings stay opaque.
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)!;
  const objects: Map<string, string>[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "{") objects.push(new Map());
    else if (token === "}") {
      const fields = objects.pop()!;
      const integerToken = objects.length === 0 ? fields.get("seed")
        : JSON.parse(fields.get("value_type") ?? "null") === "integer" ? fields.get("value") : undefined;
      if (integerToken !== undefined && !/^-?\d+$/.test(integerToken)) {
        throw new Error("Seeds and integer parameter values must use JSON integer tokens.");
      }
    } else if (tokens[index + 1] === ":") {
      const key: string = JSON.parse(token);
      const fields = objects[objects.length - 1];
      if (fields.has(key)) throw new Error("History filters contain a duplicate field.");
      fields.set(key, tokens[index + 2]);
    }
  }
  return parsed as HistoryProvenanceFilters;
}
