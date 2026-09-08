import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { ApiError, type BatchcraftApi } from "../../api/client";
import type { HistoryChoice, HistoryChoiceKind, HistoryChoicesResponse, HistoryImageInputFilter, HistoryParameterFilter, HistoryProvenanceFilters, HistoryQuery, ParameterScalar, ParameterValueType } from "../../api/types";
import { useModalDialog } from "../../components/useModalDialog";
import "./historyFilters.css";

const fields = {
  parameter: "Parameter", seed: "Seed", prompt_id: "Prompt", prompt_version_id: "Prompt revision",
  workflow_version_id: "Workflow revision", profile_version_id: "Profile revision",
  image: "Image Input", asset_id: "Asset in any slot", date: "Created date", saved_batch_id: "Saved Batch",
} as const;
type FilterType = keyof typeof fields;
type IdentityField = Exclude<FilterType, "parameter" | "seed" | "image" | "date">;
const kinds: Record<IdentityField, HistoryChoiceKind> = {
  prompt_id: "prompt", prompt_version_id: "prompt_version", workflow_version_id: "workflow_version",
  profile_version_id: "profile_version", saved_batch_id: "saved_batch", asset_id: "asset",
};
interface EditTarget { type: FilterType; parameter?: HistoryParameterFilter; image?: HistoryImageInputFilter }
interface Props {
  api: BatchcraftApi;
  projectId: string;
  value: HistoryQuery;
  onChange(query: HistoryQuery): void;
  disabled?: boolean;
}

export function parseHistoryScalar(text: string, type: ParameterValueType): ParameterScalar {
  if (type === "string") return text;
  if (type === "boolean") {
    if (text !== "true" && text !== "false") throw new Error("Choose true or false.");
    return text === "true";
  }
  if (type === "integer" && !/^[+-]?\d+$/.test(text.trim())) throw new Error("Enter a whole integer without a fraction.");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) {
    throw new Error("Enter a finite decimal number.");
  }
  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error("Enter a finite decimal number.");
  if (type === "integer" && !Number.isSafeInteger(number)) throw new Error("Enter a safe integer (absolute value at most 9007199254740991).");
  return number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function historyDateMicroseconds(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = "", zone = "Z"] = match;
  if (+year < 1 || +month < 1 || +month > 12 || +day < 1 || +hour > 23 || +minute > 59 || +second > 59) return null;
  // Validate the local calendar before applying its offset; Date.parse normalizes impossible days.
  const date = new Date(0);
  date.setUTCFullYear(+year, +month - 1, +day);
  date.setUTCHours(+hour, +minute, +second, 0);
  if (date.getUTCFullYear() !== +year || date.getUTCMonth() !== +month - 1 || date.getUTCDate() !== +day) return null;
  const offset = zone === "Z" ? "0000" : zone.slice(1).replace(":", "");
  if (+offset.slice(0, 2) > 23 || +offset.slice(2) > 59) return null;
  const offsetMinutes = (+offset.slice(0, 2) * 60 + +offset.slice(2)) * (zone[0] === "-" ? -1 : 1);
  return BigInt(date.getTime()) * 1000n + BigInt(fraction.slice(0, 6).padEnd(6, "0")) - BigInt(offsetMinutes) * 60_000_000n;
}

export function validateHistoryFilters(filters: unknown): string | null {
  if (!isRecord(filters)) return "Advanced filters must be a JSON object.";
  const allowed = [...Object.keys(kinds), "seed", "created_from", "created_before", "parameters", "image_inputs"];
  if (Object.keys(filters).some((key) => !allowed.includes(key))) return "Advanced filters contain an unknown field.";
  for (const field of Object.keys(kinds)) {
    if (Object.hasOwn(filters, field) && !isIdentity(filters[field])) return `${fields[field as IdentityField]} must be a non-empty string identity.`;
  }
  if (Object.hasOwn(filters, "seed") && (typeof filters.seed !== "number" || !Number.isSafeInteger(filters.seed) || filters.seed < 0)) return "Seed must be an integer from 0 to 9007199254740991.";
  if (Object.hasOwn(filters, "parameters") && !Array.isArray(filters.parameters)) return "Parameter filters must be an array.";
  const parameters = (filters.parameters ?? []) as unknown[];
  if (parameters.length > 8) return "Use at most 8 parameter filters. Edit or remove an existing parameter first.";
  const parameterKeys = new Set<string>();
  for (const parameter of parameters) {
    if (!isRecord(parameter)) return "Each parameter filter must be an object.";
    if (Object.keys(parameter).some((key) => !["key", "value_type", "mode", "value"].includes(key))) return "Parameter filter contains an unknown field.";
    if (!isIdentity(parameter.key) || typeof parameter.value_type !== "string" || typeof parameter.mode !== "string"
      || !["string", "integer", "float", "boolean"].includes(parameter.value_type) || !["equals", "base", "override"].includes(parameter.mode)) return "Choose a parameter, declared type, and mode.";
    const key = JSON.stringify([parameter.key, parameter.value_type]);
    if (parameterKeys.has(key)) return "Each parameter key and type can appear only once.";
    parameterKeys.add(key);
    if (parameter.mode === "equals") {
      const expected = parameter.value_type === "integer" || parameter.value_type === "float" ? "number" : parameter.value_type;
      if (!Object.hasOwn(parameter, "value") || typeof parameter.value !== expected) return "Parameter value must match its declared type.";
      if (typeof parameter.value === "number" && (!Number.isFinite(parameter.value) || (parameter.value_type === "integer" && !Number.isSafeInteger(parameter.value)))) return "Parameter numbers must be finite and integer values must be safe.";
    } else if (Object.hasOwn(parameter, "value")) return "Base and Any override must not include a value.";
  }
  if (Object.hasOwn(filters, "image_inputs") && !Array.isArray(filters.image_inputs)) return "Image Input filters must be an array.";
  const images = (filters.image_inputs ?? []) as unknown[];
  if (images.length > 4) return "Use at most 4 Image Input filters. Edit or remove an existing slot first.";
  const slotKeys = new Set<string>();
  for (const image of images) {
    if (!isRecord(image)) return "Each Image Input filter must be an object.";
    if (Object.keys(image).some((key) => !["slot_key", "mode", "asset_id"].includes(key))) return "Image Input filter contains an unknown field.";
    if (!isIdentity(image.slot_key) || (image.mode !== "base" && image.mode !== "asset")
      || (image.mode === "asset" ? !isIdentity(image.asset_id) || !image.asset_id.trim() : Object.hasOwn(image, "asset_id"))) return "Choose an Image Input slot and Base workflow or an Asset.";
    if (slotKeys.has(image.slot_key)) return "Each Image Input slot can appear only once.";
    slotKeys.add(image.slot_key);
  }
  const from = historyDateMicroseconds(filters.created_from);
  const before = historyDateMicroseconds(filters.created_before);
  if ((Object.hasOwn(filters, "created_from") && from === null) || (Object.hasOwn(filters, "created_before") && before === null)) return "Enter a valid ISO date or timestamp (UTC or an explicit offset).";
  if (from !== null && before !== null && from >= before) return "Created before must be later than Created from.";
  try {
    if (JSON.stringify(filters).length > 16384) return "Advanced filters must fit within 16,384 characters.";
  } catch {
    return "Advanced filters must be JSON-serializable.";
  }
  return null;
}

function metadataKey(kind: HistoryChoiceKind, choice: Pick<HistoryChoice, "value" | "value_type">) {
  return JSON.stringify([kind, choice.value, kind === "parameter" ? choice.value_type : null]);
}

export function HistoryFilters(props: Props) {
  // Project changes discard editor selections and historical labels together.
  return <ProjectHistoryFilters key={props.projectId} {...props} />;
}

function ProjectHistoryFilters({ api, projectId, value, onChange, disabled = false }: Props) {
  const [editor, setEditor] = useState<{ target: EditTarget; opener: HTMLElement; filtersKey: string } | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const filters = value.filters ?? {};
  const filtersKey = JSON.stringify(filters);
  if (editor && (editor.filtersKey !== filtersKey || disabled)) setEditor(null);
  function remember(kind: HistoryChoiceKind, items: HistoryChoice[]) {
    const active = new Set<string>();
    for (const [field, choiceKind] of Object.entries(kinds) as Array<[IdentityField, HistoryChoiceKind]>) {
      if (filters[field] !== undefined) active.add(metadataKey(choiceKind, { value: filters[field] }));
    }
    for (const parameter of filters.parameters ?? []) active.add(metadataKey("parameter", { value: parameter.key, value_type: parameter.value_type }));
    for (const image of filters.image_inputs ?? []) {
      active.add(metadataKey("image_slot", { value: image.slot_key }));
      if (image.asset_id) active.add(metadataKey("asset", { value: image.asset_id }));
    }
    setLabels((previous) => {
      const entries = new Map(Object.entries(previous));
      for (const item of items) {
        const key = metadataKey(kind, item);
        entries.delete(key);
        entries.set(key, item.label);
      }
      for (const key of entries.keys()) {
        if (entries.size <= 200) break;
        if (!active.has(key)) entries.delete(key);
      }
      return Object.fromEntries(entries);
    });
  }
  function label(kind: HistoryChoiceKind, id: string, fallback: string, type?: ParameterValueType) {
    return labels[metadataKey(kind, { value: id, value_type: type })] ?? fallback;
  }
  function apply(next: HistoryProvenanceFilters) {
    const clean = Object.fromEntries(Object.entries(next).filter(([, entry]) => entry !== undefined && (!Array.isArray(entry) || entry.length > 0)));
    const query = { ...value };
    if (Object.keys(clean).length) query.filters = clean;
    else delete query.filters;
    onChange(query);
  }
  const chips: Array<{ id: string; text: string; target: EditTarget; remove(): void }> = [];
  for (const [field, kind] of Object.entries(kinds) as Array<[IdentityField, HistoryChoiceKind]>) {
    const id = filters[field];
    if (id !== undefined) chips.push({ id: field, text: `${fields[field]}: ${label(kind, id, fields[field])}`, target: { type: field }, remove: () => apply({ ...filters, [field]: undefined }) });
  }
  if (filters.seed !== undefined) chips.push({ id: "seed", text: `Seed: ${filters.seed}`, target: { type: "seed" }, remove: () => apply({ ...filters, seed: undefined }) });
  if (filters.created_from || filters.created_before) chips.push({ id: "date", text: `Created: ${filters.created_from ? `from ${filters.created_from} (inclusive)` : "any start"} / ${filters.created_before ? `before ${filters.created_before} (exclusive)` : "any end"} (compared in UTC)`, target: { type: "date" }, remove: () => apply({ ...filters, created_from: undefined, created_before: undefined }) });
  for (const parameter of filters.parameters ?? []) {
    chips.push({ id: metadataKey("parameter", { value: parameter.key, value_type: parameter.value_type }), text: `${label("parameter", parameter.key, parameter.key, parameter.value_type)} (${parameter.value_type}): ${parameter.mode === "equals" ? JSON.stringify(parameter.value) : parameter.mode === "base" ? "Base workflow" : "Any override"}`, target: { type: "parameter", parameter }, remove: () => apply({ ...filters, parameters: filters.parameters?.filter((p) => p !== parameter) }) });
  }
  for (const image of filters.image_inputs ?? []) {
    chips.push({ id: `image:${image.slot_key}`, text: `${label("image_slot", image.slot_key, image.slot_key)}: ${image.mode === "base" ? "Base workflow" : label("asset", image.asset_id ?? "", "Historical Asset")}`, target: { type: "image", image }, remove: () => apply({ ...filters, image_inputs: filters.image_inputs?.filter((i) => i !== image) }) });
  }
  return <div className="hf" aria-label="Advanced history filters">
    <button type="button" className="hf-add" disabled={disabled} onClick={(event) => setEditor({ target: { type: "parameter" }, opener: event.currentTarget, filtersKey })}>+ Add filter</button>
    {chips.map((chip) => <span className="hf-chip" key={chip.id}>
      <button type="button" disabled={disabled} aria-label={`Edit ${chip.text}`} title={chip.text} onClick={(event) => setEditor({ target: chip.target, opener: event.currentTarget, filtersKey })}>{chip.text}</button>
      <button type="button" disabled={disabled} aria-label={`Remove ${chip.text}`} onClick={chip.remove}>Remove</button>
    </span>)}
    {chips.length > 0 && <button type="button" className="button-link" disabled={disabled} onClick={() => apply({})}>Clear advanced</button>}
    {editor && <FilterDialog api={api} projectId={projectId} filters={filters} target={editor.target} restoreTarget={editor.opener} onClose={() => setEditor(null)} remember={remember} label={label} onApply={(next) => { apply(next); setEditor(null); }} />}
  </div>;
}

interface DialogProps {
  api: BatchcraftApi;
  projectId: string;
  filters: HistoryProvenanceFilters;
  target: EditTarget;
  restoreTarget: HTMLElement;
  onClose(): void;
  onApply(filters: HistoryProvenanceFilters): void;
  remember(kind: HistoryChoiceKind, items: HistoryChoice[]): void;
  label(kind: HistoryChoiceKind, id: string, fallback: string, type?: ParameterValueType): string;
}

function FilterDialog(props: DialogProps) {
  const { onClose, restoreTarget } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const modal = useModalDialog(dialogRef, onClose, restoreTarget, closeRef);
  const titleId = useId();
  const [type, setType] = useState(props.target.type);
  return <dialog className="hf-dialog" ref={dialogRef} aria-labelledby={titleId} aria-modal="true" {...modal}>
    <header className="hf-heading"><div><p className="hf-eyebrow">History / provenance</p><h2 id={titleId}>Find the exact experiment</h2></div><button type="button" ref={closeRef} onClick={onClose}>Close</button></header>
    <p className="hf-context">All filters combine with AND. Seed, Prompt, Parameter, Image Input and Asset conditions must match the same Job.</p>
    <div className="hf-layout">
      <fieldset className="hf-categories"><legend>Filter type</legend>{(Object.entries(fields) as Array<[FilterType, string]>).map(([key, text]) => <label key={key} className={type === key ? "hf-category-selected" : ""}><input type="radio" name={`${titleId}-type`} value={key} checked={type === key} onChange={() => setType(key)} />{text}</label>)}</fieldset>
      <FilterEditor key={type} {...props} type={type} />
    </div>
  </dialog>;
}

function FilterEditor({ api, projectId, filters, target, type, onApply, remember, label }: DialogProps & { type: FilterType }) {
  const parameter = type === target.type ? target.parameter : undefined;
  const image = type === target.type ? target.image : undefined;
  const initialIdentity = type in kinds ? filters[type as IdentityField] : undefined;
  const [choice, setChoice] = useState<HistoryChoice | null>(() => parameter ? { value: parameter.key, value_type: parameter.value_type, label: label("parameter", parameter.key, parameter.key, parameter.value_type) } : image ? { value: image.slot_key, label: label("image_slot", image.slot_key, image.slot_key) } : initialIdentity ? { value: initialIdentity, label: label(kinds[type as IdentityField], initialIdentity, fields[type]) } : null);
  const [mode, setMode] = useState<HistoryParameterFilter["mode"]>(parameter?.mode ?? "equals");
  const [text, setText] = useState(parameter?.value !== undefined ? String(parameter.value) : type === "seed" ? String(filters.seed ?? "") : "");
  const [imageMode, setImageMode] = useState<HistoryImageInputFilter["mode"]>(image?.mode ?? "base");
  const [asset, setAsset] = useState<HistoryChoice | null>(image?.asset_id ? { value: image.asset_id, label: label("asset", image.asset_id, "Historical Asset") } : null);
  const [assetSearch, setAssetSearch] = useState(false);
  const [from, setFrom] = useState(filters.created_from ?? "");
  const [before, setBefore] = useState(filters.created_before ?? "");
  const [error, setError] = useState<string | null>(null);
  const choiceKind = type === "parameter" ? "parameter" : type === "image" ? assetSearch ? "asset" : "image_slot" : type in kinds ? kinds[type as IdentityField] : null;
  function submit() {
    const next = { ...filters };
    try {
      if (type === "parameter") {
        if (!choice?.value_type) throw new Error("Choose a historical parameter and its declared type.");
        const entry: HistoryParameterFilter = { key: choice.value, value_type: choice.value_type, mode };
        if (mode === "equals") entry.value = parseHistoryScalar(text, choice.value_type);
        next.parameters = (filters.parameters ?? []).filter((p) => !(p.key === parameter?.key && p.value_type === parameter.value_type) && !(p.key === entry.key && p.value_type === entry.value_type));
        next.parameters.push(entry);
      } else if (type === "image") {
        if (!choice || (imageMode === "asset" && !asset)) throw new Error("Choose an Image Input slot and an Asset, or Base workflow.");
        const entry: HistoryImageInputFilter = { slot_key: choice.value, mode: imageMode };
        if (imageMode === "asset") entry.asset_id = asset!.value;
        next.image_inputs = (filters.image_inputs ?? []).filter((i) => i.slot_key !== image?.slot_key && i.slot_key !== entry.slot_key);
        next.image_inputs.push(entry);
      } else if (type === "seed") {
        next.seed = parseHistoryScalar(text, "integer") as number;
      } else if (type === "date") {
        if (!from && !before) throw new Error("Enter at least one date boundary.");
        if (from) next.created_from = from;
        else delete next.created_from;
        if (before) next.created_before = before;
        else delete next.created_before;
      } else {
        if (!choice) throw new Error("Choose a historical value.");
        next[type] = choice.value;
      }
      const validation = validateHistoryFilters(next);
      if (validation) throw new Error(validation);
      if (choice && choiceKind) {
        const kind = type === "image" ? "image_slot" : choiceKind;
        remember(kind, [{ ...choice, label: label(kind, choice.value, choice.label, choice.value_type ?? undefined) }]);
      }
      if (type === "image" && asset && imageMode === "asset") remember("asset", [{ ...asset, label: label("asset", asset.value, asset.label) }]);
      onApply(next);
    } catch (failure) { setError((failure as Error).message); }
  }
  return <form className="hf-editor" onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <div className="hf-editor-content">
      <h3>{fields[type]}</h3>
      {choiceKind && <>
        {choice && <p className="hf-selected">Selected: <strong>{label(type === "image" ? "image_slot" : choiceKind, choice.value, choice.label, choice.value_type ?? undefined)}</strong>{choice.value_type && <small> / {choice.value_type}</small>}</p>}
        {type === "image" && <div className="hf-switch"><button type="button" aria-pressed={!assetSearch} onClick={() => setAssetSearch(false)}>Find slot</button><button type="button" aria-pressed={assetSearch} onClick={() => { setAssetSearch(true); setImageMode("asset"); }}>Find Asset</button></div>}
        <HistoricalChoices key={choiceKind} api={api} projectId={projectId} kind={choiceKind} selected={assetSearch ? asset : choice} remember={remember} onSelect={(item) => {
          if (assetSearch) setAsset(item);
          else { setChoice(item); if (type === "parameter" && (item.value !== choice?.value || item.value_type !== choice?.value_type)) setText(""); }
          setError(null);
        }} />
      </>}
      {type === "parameter" && <>
        <label>Match mode<select value={mode} onChange={(event) => setMode(event.target.value as HistoryParameterFilter["mode"])}><option value="equals">Equals</option><option value="base">Base workflow</option><option value="override">Any override</option></select></label>
        {mode === "equals" && (choice?.value_type === "boolean" ? <label>Exact value<select value={text} onChange={(event) => setText(event.target.value)}><option value="" disabled>Choose boolean</option><option value="false">false</option><option value="true">true</option></select></label> : <label>Exact value<input value={text} onChange={(event) => setText(event.target.value)} inputMode={choice?.value_type === "integer" || choice?.value_type === "float" ? "decimal" : "text"} /><small>{choice?.value_type === "string" ? 'Empty text is a valid exact value: "".' : "Numeric values must be finite; integers must be safe."}</small></label>)}
        <p className="hf-help">Base workflow means no override, not a missing parameter. An override equal to the Base value is still an override. Up to 8 distinct key/type pairs.</p>
      </>}
      {type === "image" && <><label>Image match<select value={imageMode} onChange={(event) => { setImageMode(event.target.value as HistoryImageInputFilter["mode"]); setAssetSearch(event.target.value === "asset"); }}><option value="base">Base workflow</option><option value="asset">Asset</option></select></label>{imageMode === "asset" && <p className="hf-selected">Asset: {asset ? label("asset", asset.value, asset.label) : "Choose an Asset using Find Asset."}</p>}<p className="hf-help">Up to 4 distinct slots. A missing slot does not match Base workflow.</p></>}
      {type === "seed" && <label>Exact seed<input value={text} inputMode="numeric" onChange={(event) => setText(event.target.value)} /><small>Whole number from 0 to 9007199254740991.</small></label>}
      {type === "date" && <><label>Created from (inclusive)<input value={from} placeholder="2026-09-07 or 2026-09-07T12:00:00Z" onChange={(event) => setFrom(event.target.value)} /></label><label>Created before (exclusive)<input value={before} placeholder="2026-09-08 or 2026-09-08T12:00:00Z" onChange={(event) => setBefore(event.target.value)} /></label><p className="hf-help">Use YYYY-MM-DD for midnight UTC, or an ISO timestamp with Z or an explicit offset. Timestamps without an offset mean UTC, not local time. From includes that instant; before excludes it. To include a whole day, use the next day as the upper boundary.</p></>}
      {error && <p role="alert" className="hf-error">{error}</p>}
    </div>
    <footer className="hf-footer"><span>Exact historical provenance</span><button type="submit">Apply filter</button></footer>
  </form>;
}

function HistoricalChoices({ api, projectId, kind, selected, onSelect, remember }: {
  api: BatchcraftApi; projectId: string; kind: HistoryChoiceKind; selected: HistoryChoice | null;
  onSelect(choice: HistoryChoice): void; remember(kind: HistoryChoiceKind, items: HistoryChoice[]): void;
}) {
  const [q, setQ] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ q: string; attempt: number; response?: HistoryChoicesResponse; error?: string } | null>(null);
  const rememberResponse = useEffectEvent(remember);
  const name = useId();
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api.getHistoryChoices(projectId, kind, q, controller.signal).then((response) => {
        if (controller.signal.aborted || response.project_id !== projectId) return;
        rememberResponse(kind, response.items.slice(0, 30));
        setState({ q, attempt, response });
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof ApiError && error.code === "history_reindex_required"
          ? "Historical choices need an updated index. Use Reindex Project in the Project browser, then Retry choices."
          : error instanceof ApiError && error.status === 404
            ? "Historical choices are unavailable. Check that the Project exists and restart the backend from the same version as this frontend. Reindexing cannot add a missing API route."
            : error instanceof Error ? error.message : "Cannot load historical choices.";
        setState({ q, attempt, error: message });
      });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, projectId, kind, q, attempt]);
  const current = state?.q === q && state.attempt === attempt ? state : null;
  return <div className="hf-choices">
    <label>Search historical choices<input type="search" maxLength={200} value={q} onChange={(event) => setQ(event.target.value)} placeholder={kind === "parameter" ? "Parameter label or key..." : "Search frozen names..."} /></label>
    {!current && <p role="status">Loading historical choices...</p>}
    {current?.error && <div role="alert"><p>{current.error}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry choices</button></div>}
    {current?.response && <>
      <fieldset className="hf-choice-list">
        <legend>Historical choices</legend>
        {current.response.items.slice(0, 30).map((item) => <label key={metadataKey(kind, item)}>
          <input type="radio" name={name} aria-label={[item.label, item.value_type, item.detail].filter(Boolean).join(" ")}
            checked={Boolean(selected && metadataKey(kind, selected) === metadataKey(kind, item))} onChange={() => onSelect(item)} />
          <span>{item.label}{item.value_type && <small>{item.value_type}</small>}{item.detail && <small>{item.detail}</small>}</span>
        </label>)}
      </fieldset>
      {current.response.items.length === 0 && <p className="hf-help">No historical choices match. Choices come from imported or reindexed Run snapshots, not the current library. Import or Reindex Project if history is missing.</p>}
      {current.response.has_more && <p className="hf-help">Showing up to 30 choices. Narrow your search to find more.</p>}
    </>}
  </div>;
}
