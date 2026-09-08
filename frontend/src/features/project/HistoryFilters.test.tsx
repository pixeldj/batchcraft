import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type BatchcraftApi } from "../../api/client";
import type { HistoryChoice, HistoryChoicesResponse, HistoryProvenanceFilters, HistoryQuery, ParameterValueType } from "../../api/types";
import { HistoryFilters, parseHistoryScalar, validateHistoryFilters } from "./HistoryFilters";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function response(items: HistoryChoice[] = [], projectId = "p", hasMore = false): HistoryChoicesResponse {
  return { project_id: projectId, generation: "g", items, has_more: hasMore };
}
function makeApi(items: HistoryChoice[] = []): BatchcraftApi {
  return { getHistoryChoices: vi.fn(async (id: string) => response(items, id)), reindexProject: vi.fn() } as unknown as BatchcraftApi;
}
function Harness({ api, initial = {}, changed = vi.fn() }: { api: BatchcraftApi; initial?: HistoryQuery; changed?(value: HistoryQuery): void }) {
  const [value, setValue] = useState(initial);
  return <HistoryFilters api={api} projectId="p" value={value} onChange={(next) => { changed(next); setValue(next); }} />;
}
async function choices() { await act(() => vi.advanceTimersByTimeAsync(200)); }
function open(type?: string) {
  fireEvent.click(screen.getByRole("button", { name: "+ Add filter" }));
  if (type) fireEvent.click(screen.getByRole("radio", { name: type }));
}
function apply() { fireEvent.click(screen.getByRole("button", { name: "Apply filter" })); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("history filter validation", () => {
  it.each<[string, ParameterValueType, string | number | boolean]>([
    ["", "string", ""], ["  ", "string", "  "], ["false", "boolean", false], ["true", "boolean", true],
    ["0", "integer", 0], ["-9007199254740991", "integer", -Number.MAX_SAFE_INTEGER], ["1.25e2", "float", 125],
  ])("preserves %j as %s", (text, type, expected) => expect(parseHistoryScalar(text, type)).toBe(expected));
  it.each<[string, ParameterValueType]>([
    ["", "integer"], [" ", "float"], ["Infinity", "float"], ["NaN", "float"], ["1e309", "float"],
    ["1.2", "integer"], ["9007199254740992", "integer"], ["9007199254740991.1", "integer"], ["0x10", "float"], ["yes", "boolean"],
  ])("rejects %j as %s", (text, type) => expect(() => parseHistoryScalar(text, type)).toThrow());
  it.each<HistoryProvenanceFilters>([
    { seed: -1 }, { seed: 0.5 }, { seed: Number.MAX_SAFE_INTEGER + 1 },
    { parameters: [{ key: "a", value_type: "boolean", mode: "equals", value: "false" }] },
    { parameters: [{ key: "a", value_type: "float", mode: "equals", value: Infinity }] },
    { parameters: [{ key: "a", value_type: "string", mode: "base", value: "" }] },
    { parameters: Array.from({ length: 9 }, (_, i) => ({ key: String(i), value_type: "string", mode: "base" })) },
    { parameters: Array.from({ length: 2 }, () => ({ key: "a", value_type: "string", mode: "base" })) },
    { image_inputs: [{ slot_key: "ref", mode: "asset" }] },
    { image_inputs: Array.from({ length: 5 }, (_, i) => ({ slot_key: String(i), mode: "base" })) },
    { image_inputs: Array.from({ length: 2 }, () => ({ slot_key: "ref", mode: "base" })) },
    { created_from: "2026-02-30" }, { created_before: "garbage" },
    { created_from: "2026-09-08", created_before: "2026-09-07" }, { created_from: "2026-09-07", created_before: "2026-09-07" },
    { parameters: [{ key: "a", value_type: "string", mode: "equals", value: "a".repeat(16384) }] },
  ])("rejects invalid filters %j", (filters) => expect(validateHistoryFilters(filters)).not.toBeNull());
  it("accepts all exact typed values, distinct types for one key, and UTC boundaries", () => {
    expect(validateHistoryFilters({ seed: Number.MAX_SAFE_INTEGER, created_from: "2026-09-07T12:00:00Z", created_before: "2026-09-08", parameters: [
      { key: "a", value_type: "string", mode: "equals", value: "" },
      { key: "a", value_type: "boolean", mode: "equals", value: false },
    ] })).toBeNull();
  });

  it("returns errors without throwing for untrusted root values and unknown fields", () => {
    const inputs: unknown[] = [null, undefined, false, true, 0, 1, "", "filters", [], [1],
      { other: true }, { parameters: [], label: "injected" }, JSON.parse('{"__proto__":{}}'), { constructor: "injected" },
      { seed: null }, { seed: "0" }, { seed: false }, { seed: Infinity }, { seed: NaN },
      { parameters: null }, { parameters: "" }, { parameters: {} }, { parameters: false },
      { image_inputs: null }, { image_inputs: "" }, { image_inputs: {} }, { image_inputs: 0 },
    ];
    for (const input of inputs) expect(typeof validateHistoryFilters(input)).toBe("string");
    expect(validateHistoryFilters({})).toBeNull();
    expect(validateHistoryFilters({ parameters: [], image_inputs: [] })).toBeNull();
  });

  it("rejects malformed identities without trimming or capping valid exact identities", () => {
    const identityFields = ["prompt_id", "prompt_version_id", "workflow_version_id", "profile_version_id", "saved_batch_id", "asset_id"];
    for (const field of identityFields) {
      for (const identity of [null, undefined, "", 0, false, [], {}]) {
        expect(typeof validateHistoryFilters({ [field]: identity })).toBe("string");
      }
      const value = { [field]: `  Exact / Mixed Case ${"x".repeat(1500)}  ` };
      const original = structuredClone(value);
      expect(validateHistoryFilters(value)).toBeNull();
      expect(value).toEqual(original);
    }
  });

  it("checks parameter objects and fields before reading their values", () => {
    const valid = { key: "key", value_type: "string", mode: "equals", value: "" };
    const inputs: unknown[] = [null, false, 0, "", [], {}, { key: "key" },
      { ...valid, key: null }, { ...valid, key: 0 }, { ...valid, key: {} }, { ...valid, key: "" },
      { ...valid, value_type: null }, { ...valid, value_type: [] }, { ...valid, value_type: "unknown" },
      { ...valid, mode: false }, { ...valid, mode: {} }, { ...valid, mode: "other" },
      { key: "key", value_type: "string", mode: "equals" },
      { ...valid, value: null }, { ...valid, value: undefined }, { ...valid, value: [] }, { ...valid, value: {} },
      { ...valid, value_type: "boolean", value: 0 }, { ...valid, value_type: "float", value: "1.5" },
      { ...valid, value_type: "integer", value: true }, { ...valid, value_type: "float", value: NaN },
      { ...valid, mode: "override", value: undefined }, { ...valid, mode: "base", value: null },
      { ...valid, label: "Frozen label" }, JSON.parse('{"key":"key","mode":"base","value_type":"string","__proto__":{}}'),
    ];
    for (const input of inputs) expect(typeof validateHistoryFilters({ parameters: [input] })).toBe("string");
    for (const [value_type, value] of [["string", ""], ["string", " "], ["boolean", false], ["boolean", true], ["integer", 0], ["float", 0], ["float", -1.5]]) {
      expect(validateHistoryFilters({ parameters: [{ key: "key", value_type, mode: "equals", value }] })).toBeNull();
    }
  });

  it("checks Image Input objects, exact modes, and conditional Asset identity", () => {
    const valid = { slot_key: "slot", mode: "asset", asset_id: "exact" };
    for (const input of [null, false, 0, "", [], {}, { slot_key: "slot" },
      { ...valid, slot_key: null }, { ...valid, slot_key: false }, { ...valid, slot_key: [] }, { ...valid, slot_key: "" },
      { ...valid, mode: {} }, { ...valid, mode: "override" }, { slot_key: "slot", mode: "asset" },
      { ...valid, asset_id: null }, { ...valid, asset_id: false }, { ...valid, asset_id: {} }, { ...valid, asset_id: "" }, { ...valid, asset_id: "  " },
      { ...valid, mode: "base" }, { ...valid, mode: "base", asset_id: undefined }, { ...valid, label: "Image" },
    ]) expect(typeof validateHistoryFilters({ image_inputs: [input] })).toBe("string");
    const input = { image_inputs: [{ ...valid, asset_id: "  exact  " }] };
    const original = structuredClone(input);
    expect(validateHistoryFilters(input)).toBeNull();
    expect(input).toEqual(original);
  });

  it.each([
    ["2026-09-07T00:00:00+05:30", "2026-09-06T19:00:00Z"],
    ["2026-09-07T23:30:00-0230", "2026-09-08T02:01:00Z"],
    ["2026-09-07T12:00:00.000001Z", "2026-09-07T12:00:00.000002Z"],
    ["2026-09-07 12:00:00", "2026-09-07T12:00:00.000001+00:00"],
    ["2024-02-29", "2024-03-01"], ["0099-12-31", "0100-01-01"],
  ])("compares %s and %s as UTC microseconds without changing either string", (created_from, created_before) => {
    const input = { created_from, created_before };
    expect(validateHistoryFilters(input)).toBeNull();
    expect(input).toEqual({ created_from, created_before });
    expect(validateHistoryFilters({ created_from: created_before, created_before: created_from })).toMatch(/later/);
  });

  it.each(["2026-02-29", "2026-02-30T12:00:00+02:00", "2026-04-31T00:00:00-05:00", "0000-01-01", "2026-00-01", "2026-13-01", "2026-01-00", "2026-01-01T24:00:00Z", "2026-01-01T12:60:00Z", "2026-01-01T12:00:60Z", "2026-01-01T12:00:00+24:00", "2026-01-01T12:00:00+01:60", "", null, 0, false, [], {}])("rejects impossible or malformed ISO date %j", (date) => {
    expect(typeof validateHistoryFilters({ created_from: date })).toBe("string");
  });

  it("rejects equal instants expressed using different offsets", () => {
    expect(validateHistoryFilters({ created_from: "2026-09-07T12:00:00+05:30", created_before: "2026-09-07T06:30:00Z" })).toMatch(/later/);
  });
});

describe("HistoryFilters", () => {
  it("closes stale edits on external filter changes and aborts their choices", async () => {
    const api = makeApi();
    const pending = deferred<HistoryChoicesResponse>();
    vi.mocked(api.getHistoryChoices).mockReturnValueOnce(pending.promise);
    const changed = vi.fn();
    const value: HistoryQuery = { filters: { parameters: [{ key: "flag", value_type: "boolean", mode: "equals", value: false }] } };
    const { rerender } = render(<HistoryFilters api={api} projectId="p" value={value} onChange={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit flag (boolean): false" }));
    await choices();
    fireEvent.change(screen.getByLabelText("Exact value"), { target: { value: "true" } });
    rerender(<HistoryFilters api={api} projectId="p" value={structuredClone(value)} onChange={changed} />);
    expect(screen.getByLabelText("Exact value")).toHaveValue("true");
    rerender(<HistoryFilters api={api} projectId="p" value={{ filters: { seed: 4 } }} onChange={changed} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(vi.mocked(api.getHistoryChoices).mock.calls[0][3]?.aborted).toBe(true);
    await act(async () => pending.resolve(response([{ value: "flag", label: "Stale label", value_type: "boolean" }])));
    rerender(<HistoryFilters api={api} projectId="p" value={value} onChange={changed} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
  });

  it("disables Add, Edit, Remove, and Clear and closes an editor when disabled", () => {
    const api = makeApi();
    const changed = vi.fn();
    const value = { filters: { seed: 0 } };
    const { rerender } = render(<HistoryFilters api={api} projectId="p" value={value} onChange={changed} disabled />);
    for (const button of screen.getAllByRole("button")) { expect(button).toBeDisabled(); fireEvent.click(button); }
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
    rerender(<HistoryFilters api={api} projectId="p" value={value} onChange={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Seed: 0" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    rerender(<HistoryFilters api={api} projectId="p" value={value} onChange={changed} disabled />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply filter" })).not.toBeInTheDocument();
  });

  it("requires an explicit boolean selection, preserves false on edit, and resets for a different key", async () => {
    const api = makeApi([{ value: "flag", label: "Flag", value_type: "boolean" }, { value: "other", label: "Other flag", value_type: "boolean" }]);
    const changed = vi.fn();
    render(<Harness api={api} changed={changed} />);
    open(); await choices();
    fireEvent.click(screen.getByRole("radio", { name: "Flag boolean" }));
    expect(screen.getByLabelText("Exact value")).toHaveValue("");
    apply();
    expect(screen.getByRole("alert")).toHaveTextContent("Choose true or false");
    expect(changed).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Exact value"), { target: { value: "false" } }); apply();
    fireEvent.click(screen.getByRole("button", { name: "Edit Flag (boolean): false" }));
    expect(screen.getByLabelText("Exact value")).toHaveValue("false");
    await choices();
    fireEvent.click(screen.getByRole("radio", { name: "Other flag boolean" }));
    expect(screen.getByLabelText("Exact value")).toHaveValue("");
  });

  it("retains friendly labels across filter changes but evicts old inactive choices after 200 entries", async () => {
    const api = makeApi();
    vi.mocked(api.getHistoryChoices).mockImplementation(async (id, _kind, q = "") => response(
      Array.from({ length: 30 }, (_, i) => ({ value: `${q}-${i}`, label: `Frozen ${q}-${i}` })), id,
    ));
    const changed = vi.fn();
    const value: HistoryQuery = { filters: { prompt_id: "-0" } };
    const { rerender } = render(<HistoryFilters api={api} projectId="p" value={value} onChange={changed} />);
    open("Prompt"); await choices();
    for (let i = 1; i <= 7; i++) {
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: `page${i}` } }); await choices();
    }
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    // An active chip is retained even after more than 200 distinct choices have been fetched.
    expect(screen.getByRole("button", { name: "Edit Prompt: Frozen -0" })).toBeInTheDocument();
    rerender(<HistoryFilters api={api} projectId="p" value={{}} onChange={changed} />);
    rerender(<HistoryFilters api={api} projectId="p" value={value} onChange={changed} />);
    expect(screen.getByRole("button", { name: "Edit Prompt: Frozen -0" })).toBeInTheDocument();
    rerender(<HistoryFilters api={api} projectId="p" value={{ filters: { prompt_id: "-1" } }} onChange={changed} />);
    expect(screen.getByRole("button", { name: "Edit Prompt: Prompt" })).toBeInTheDocument();
    rerender(<HistoryFilters api={api} projectId="p" value={{ filters: { prompt_id: "page7-29" } }} onChange={changed} />);
    expect(screen.getByRole("button", { name: "Edit Prompt: Frozen page7-29" })).toBeInTheDocument();
  });

  it("fetches only when open, debounces literal searches, and restores focus on Escape", async () => {
    const api = makeApi();
    render(<Harness api={api} />);
    await choices();
    expect(api.getHistoryChoices).not.toHaveBeenCalled();
    const opener = screen.getByRole("button", { name: "+ Add filter" });
    open();
    expect(document.body.style.overflow).toBe("hidden");
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "a" } });
    fireEvent.change(search, { target: { value: "a%_ &" } });
    await choices();
    expect(api.getHistoryChoices).toHaveBeenCalledTimes(1);
    expect(api.getHistoryChoices).toHaveBeenCalledWith("p", "parameter", "a%_ &", expect.any(AbortSignal));
    expect(screen.getByText(/not the current library/)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(opener).toHaveFocus();
  });

  it.each<[ParameterValueType, string, string | number | boolean]>([["string", "", ""], ["boolean", "false", false], ["boolean", "true", true], ["integer", "0", 0], ["float", "1.5", 1.5]])("adds exact %s without labels or loss of type", async (type, text, scalar) => {
    const api = makeApi([{ value: "key", label: "Frozen label", value_type: type }]);
    const changed = vi.fn();
    render(<Harness api={api} changed={changed} initial={{ q: "keep", run_id: "r", batch_id: "b", execution_status: "failed", execution_available: false }} />);
    open(); await choices();
    fireEvent.click(screen.getByRole("radio", { name: `Frozen label ${type}` }));
    fireEvent.change(screen.getByLabelText(/^Exact value/), { target: { value: text } });
    apply();
    expect(changed).toHaveBeenLastCalledWith({ q: "keep", run_id: "r", batch_id: "b", execution_status: "failed", execution_available: false, filters: { parameters: [{ key: "key", value_type: type, mode: "equals", value: scalar }] } });
    expect(screen.getByRole("button", { name: `Edit Frozen label (${type}): ${JSON.stringify(scalar)}` })).toBeInTheDocument();
    expect(screen.queryByText("keep")).not.toBeInTheDocument();
  });

  it("edits and removes parameters without touching basic filters", async () => {
    const changed = vi.fn();
    render(<Harness api={makeApi()} changed={changed} initial={{ q: "keep", filters: { parameters: [{ key: "a", value_type: "string", mode: "equals", value: "" }] } }} />);
    fireEvent.click(screen.getByRole("button", { name: 'Edit a (string): ""' }));
    expect(screen.getByLabelText(/^Exact value/)).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Match mode"), { target: { value: "override" } });
    apply();
    expect(changed).toHaveBeenLastCalledWith({ q: "keep", filters: { parameters: [{ key: "a", value_type: "string", mode: "override" }] } });
    fireEvent.click(screen.getByRole("button", { name: "Edit a (string): Any override" }));
    fireEvent.change(screen.getByLabelText("Match mode"), { target: { value: "base" } });
    apply();
    fireEvent.click(screen.getByRole("button", { name: "Remove a (string): Base workflow" }));
    expect(changed).toHaveBeenLastCalledWith({ q: "keep" });
  });

  it.each([
    ["Prompt", "prompt_id", "prompt"], ["Prompt revision", "prompt_version_id", "prompt_version"],
    ["Workflow revision", "workflow_version_id", "workflow_version"], ["Profile revision", "profile_version_id", "profile_version"],
    ["Saved Batch", "saved_batch_id", "saved_batch"], ["Asset in any slot", "asset_id", "asset"],
  ])("selects and reopens %s by frozen name with exact identity", async (type, field, kind) => {
    const changed = vi.fn();
    const api = makeApi([{ value: "exact-id", label: "Frozen name", detail: "Revision 2" }]);
    render(<Harness api={api} changed={changed} />);
    open(type); await choices();
    expect(api.getHistoryChoices).toHaveBeenCalledWith("p", kind, "", expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("radio", { name: "Frozen name Revision 2" })); apply();
    expect(changed).toHaveBeenLastCalledWith({ filters: { [field]: "exact-id" } });
    fireEvent.click(screen.getByRole("button", { name: `Edit ${type}: Frozen name` }));
    await choices();
    expect(screen.getByRole("radio", { name: "Frozen name Revision 2" })).toBeChecked();
    apply();
    expect(changed).toHaveBeenLastCalledWith({ filters: { [field]: "exact-id" } });
  });

  it("restores prop filters, avoids raw IDs, and clears advanced only", () => {
    const changed = vi.fn();
    const api = makeApi();
    const { rerender } = render(<HistoryFilters api={api} projectId="p" value={{}} onChange={changed} />);
    rerender(<HistoryFilters api={api} projectId="p" value={{ q: "keep", execution_status: "failed", filters: { prompt_version_id: "uuid-secret", seed: 0, parameters: [{ key: "flag", value_type: "boolean", mode: "equals", value: false }] } }} onChange={changed} />);
    expect(screen.queryByText(/uuid-secret/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit flag (boolean): false" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit Seed: 0" }));
    expect(screen.getByLabelText(/^Exact seed/)).toHaveValue("0");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear advanced" }));
    expect(changed).toHaveBeenLastCalledWith({ q: "keep", execution_status: "failed" });
  });

  it("validates seed and preserves UTC date boundaries when edited", () => {
    const changed = vi.fn();
    render(<Harness api={makeApi()} changed={changed} />);
    open("Seed");
    fireEvent.change(screen.getByLabelText(/^Exact seed/), { target: { value: "-1" } }); apply();
    expect(screen.getByRole("alert")).toHaveTextContent("Seed must be");
    expect(changed).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/^Exact seed/), { target: { value: "0" } }); apply();
    open("Created date");
    fireEvent.change(screen.getByLabelText("Created from (inclusive)"), { target: { value: "2026-09-07T12:00:00Z" } });
    fireEvent.change(screen.getByLabelText("Created before (exclusive)"), { target: { value: "2026-09-08" } }); apply();
    expect(changed).toHaveBeenLastCalledWith({ filters: { seed: 0, created_from: "2026-09-07T12:00:00Z", created_before: "2026-09-08" } });
    fireEvent.click(screen.getByRole("button", { name: /^Edit Created:/ }));
    expect(screen.getByLabelText("Created from (inclusive)")).toHaveValue("2026-09-07T12:00:00Z");
    fireEvent.change(screen.getByLabelText("Created before (exclusive)"), { target: { value: "" } }); apply();
    expect(changed).toHaveBeenLastCalledWith({ filters: { seed: 0, created_from: "2026-09-07T12:00:00Z" } });
  });

  it("selects slot and Asset separately and can edit back to Base workflow", async () => {
    const api = makeApi();
    vi.mocked(api.getHistoryChoices).mockImplementation(async (id, kind) => response(kind === "image_slot" ? [{ value: "ref", label: "Reference image" }] : [{ value: "asset-id", label: "Original.png" }], id));
    const changed = vi.fn();
    render(<Harness api={api} changed={changed} />);
    open("Image Input"); await choices();
    fireEvent.click(screen.getByRole("radio", { name: "Reference image" }));
    fireEvent.click(screen.getByRole("button", { name: "Find Asset" })); await choices();
    fireEvent.click(screen.getByRole("radio", { name: "Original.png" })); apply();
    expect(changed).toHaveBeenLastCalledWith({ filters: { image_inputs: [{ slot_key: "ref", mode: "asset", asset_id: "asset-id" }] } });
    fireEvent.click(screen.getByRole("button", { name: "Edit Reference image: Original.png" }));
    expect(screen.getByLabelText("Image match")).toHaveValue("asset");
    fireEvent.change(screen.getByLabelText("Image match"), { target: { value: "base" } }); apply();
    expect(changed).toHaveBeenLastCalledWith({ filters: { image_inputs: [{ slot_key: "ref", mode: "base" }] } });
    fireEvent.click(screen.getByRole("button", { name: "Remove Reference image: Base workflow" }));
    expect(changed).toHaveBeenLastCalledWith({});
  });

  it("enforces 8 parameters but permits replacing an existing key/type at the limit", async () => {
    const filters: HistoryProvenanceFilters = { parameters: Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, value_type: "integer", mode: "base" })) };
    const changed = vi.fn();
    render(<Harness api={makeApi([{ value: "new", label: "New", value_type: "integer" }, { value: "k0", label: "Existing", value_type: "integer" }])} initial={{ filters }} changed={changed} />);
    open(); await choices();
    fireEvent.click(screen.getByRole("radio", { name: "New integer" }));
    fireEvent.change(screen.getByLabelText("Match mode"), { target: { value: "base" } }); apply();
    expect(screen.getByRole("alert")).toHaveTextContent("at most 8");
    expect(changed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Existing integer" })); apply();
    expect(changed.mock.lastCall?.[0].filters.parameters).toHaveLength(8);
    expect(new Set(changed.mock.lastCall?.[0].filters.parameters.map((p: { key: string }) => p.key)).size).toBe(8);
  });

  it("enforces 4 slots but permits editing a slot at the limit", async () => {
    const filters: HistoryProvenanceFilters = { image_inputs: Array.from({ length: 4 }, (_, i) => ({ slot_key: `s${i}`, mode: "base" })) };
    const changed = vi.fn();
    render(<Harness api={makeApi([{ value: "new", label: "New slot" }])} initial={{ filters }} changed={changed} />);
    open("Image Input"); await choices();
    fireEvent.click(screen.getByRole("radio", { name: "New slot" })); apply();
    expect(screen.getByRole("alert")).toHaveTextContent("at most 4");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit s0: Base workflow" })); apply();
    expect(changed.mock.lastCall?.[0].filters.image_inputs).toHaveLength(4);
  });

  it("caps displayed choices and explains narrowing", async () => {
    const api = makeApi();
    vi.mocked(api.getHistoryChoices).mockResolvedValue(response(Array.from({ length: 35 }, (_, i) => ({ value: String(i), label: `Choice ${i}` })), "p", true));
    render(<Harness api={api} />); open("Prompt"); await choices();
    expect(within(screen.getByRole("group", { name: "Historical choices" })).getAllByRole("radio")).toHaveLength(30);
    expect(screen.getByText(/Narrow your search/)).toBeInTheDocument();
  });

  it.each([new ApiError("Reindex", "history_reindex_required", 409), new ApiError("Missing", "http_error", 404), new Error("Network interrupted")])("offers retry without automatic reindex: %s", async (error) => {
    const api = makeApi();
    vi.mocked(api.getHistoryChoices).mockRejectedValueOnce(error);
    render(<Harness api={api} />); open(); await choices();
    if (error instanceof ApiError && error.status === 409) expect(screen.getByRole("alert")).toHaveTextContent("Use Reindex Project");
    if (error instanceof ApiError && error.status === 404) expect(screen.getByRole("alert")).toHaveTextContent("restart the backend");
    fireEvent.click(screen.getByRole("button", { name: "Retry choices" })); await choices();
    expect(api.getHistoryChoices).toHaveBeenCalledTimes(2);
    expect(api.reindexProject).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("aborts and ignores stale search, type, and Project responses", async () => {
    const oldSearch = deferred<HistoryChoicesResponse>();
    const oldType = deferred<HistoryChoicesResponse>();
    const oldProject = deferred<HistoryChoicesResponse>();
    const api = makeApi();
    vi.mocked(api.getHistoryChoices).mockReturnValueOnce(oldSearch.promise).mockReturnValueOnce(oldType.promise).mockReturnValueOnce(oldProject.promise);
    const { rerender } = render(<HistoryFilters api={api} projectId="p" value={{}} onChange={vi.fn()} />);
    open(); await choices();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new" } });
    expect(vi.mocked(api.getHistoryChoices).mock.calls[0][3]?.aborted).toBe(true);
    await choices();
    await act(async () => oldSearch.resolve(response([{ value: "old", label: "Stale search" }])));
    expect(screen.queryByText("Stale search")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Prompt" })); await choices();
    expect(vi.mocked(api.getHistoryChoices).mock.calls[1][3]?.aborted).toBe(true);
    await act(async () => oldType.resolve(response([{ value: "old", label: "Stale type" }])));
    expect(screen.queryByText("Stale type")).not.toBeInTheDocument();
    rerender(<HistoryFilters api={api} projectId="other" value={{}} onChange={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(vi.mocked(api.getHistoryChoices).mock.calls[2][3]?.aborted).toBe(true);
    open("Prompt"); await choices();
    await act(async () => oldProject.resolve(response([{ value: "old", label: "Stale Project" }])));
    expect(screen.queryByText("Stale Project")).not.toBeInTheDocument();
  });
});
