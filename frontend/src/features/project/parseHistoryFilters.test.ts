import { describe, expect, it } from "vitest";

import { parseHistoryFilters } from "./parseHistoryFilters";

describe("parseHistoryFilters", () => {
  it.each([
    "0.125", "0.10000000000000001", "9007199254740991.1", "9007199254740993",
    "1.0", "1e0", "1e-400", "1e100", "-0.0",
  ])("preserves backend IEEE-754 float semantics for %s", (value) => {
    const raw = `{"parameters":[{"value":${value},"key":"scale","mode":"equals","value_type":"fl\\u006fat"}]}`;
    expect(parseHistoryFilters(raw)).toEqual(JSON.parse(raw));
  });

  it.each(["1e400", "-1e400"])("rejects nonfinite floats: %s", (value) => {
    expect(() => parseHistoryFilters(`{"parameters":[{"key":"scale","value_type":"float","mode":"equals","value":${value}}]}`)).toThrow();
  });

  it.each(["9007199254740992", "-9007199254740992", "1.00000000000000001", "1e0", "1.0"])("rejects unsafe or non-integer tokens: %s", (value) => {
    expect(() => parseHistoryFilters(`{"seed":${value}}`)).toThrow();
    expect(() => parseHistoryFilters(`{"parameters":[{"value":${value},"key":"steps","mode":"equals","value_type":"int\\u0065ger"}]}`)).toThrow();
  });

  it("round-trips generated JSON without confusing strings or sibling keys with object structure", () => {
    const filters = {
      seed: 9007199254740991,
      parameters: [
        { key: "flag", value_type: "boolean", mode: "equals", value: false },
        { key: "steps", value_type: "integer", mode: "equals", value: -9007199254740991 },
        { key: "zero", value_type: "integer", mode: "equals", value: 0 },
        { key: "empty", value_type: "string", mode: "equals", value: "" },
        { key: "caption", value_type: "string", mode: "equals", value: '{"seed":1,"seed":2}, [ ] \\ "value_type":"integer", "value":1.0' },
        { key: "scale", value_type: "float", mode: "equals", value: 0.125 },
        { key: "base", value_type: "integer", mode: "base" },
      ],
      image_inputs: [{ slot_key: "reference", mode: "asset", asset_id: 'braces } { "mode":"base"' }],
    };
    expect(parseHistoryFilters(JSON.stringify(filters))).toEqual(filters);
  });

  it.each([
    '{"seed":0,"seed":0}',
    '{"parameters":[{"key":"steps","value_type":"float","value_type":"integer","mode":"equals","value":1}]}',
    '{"parameters":[{"key":"steps","value_type":"integer","mode":"equals","value":1,"val\\u0075e":2}]}',
    '{"image_inputs":[{"slot_key":"first","slot_key":"second","mode":"base"}]}',
  ])("rejects duplicate fields: %s", (raw) => {
    expect(() => parseHistoryFilters(raw)).toThrow(/duplicate/);
  });

  it("keeps the raw JSON size bound inclusive", () => {
    expect(parseHistoryFilters('{"seed":0}'.padEnd(16384))).toEqual({ seed: 0 });
    expect(() => parseHistoryFilters('{"seed":0}'.padEnd(16385))).toThrow();
  });
});
