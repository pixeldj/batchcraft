import { useEffect, useRef, useState } from "react";

import type { JsonObject, ParameterValueType, WorkflowProfileParameter } from "../../api/types";
import { formatBaseWorkflowValue, type BaseWorkflowValueDisplay } from "./baseWorkflowValue";
import {
  defaultParameterRange,
  deriveLinkedParameterSetKey,
  parameterRangeCount,
  type LinkedParameterSetForm,
  type ParameterAlternativeForm,
  type ParameterBindingForm,
  type ParameterRangeDraft,
} from "./form";

interface Props {
  parameters: WorkflowProfileParameter[];
  workflow?: JsonObject;
  parameterBindings: ParameterBindingForm[];
  linkedParameterSets: LinkedParameterSetForm[];
  onAddParameter?(): void;
  onChange(state: { parameterBindings: ParameterBindingForm[]; linkedParameterSets: LinkedParameterSetForm[] }): void;
}

export function ParameterBindingsEditor({ parameters, workflow = {}, parameterBindings, linkedParameterSets, onAddParameter, onChange }: Props) {
  const [creating, setCreating] = useState(false);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [removeConfirmation, setRemoveConfirmation] = useState<string | null>(null);
  const rows = parameters.flatMap((parameter) => {
    const binding = parameterBindings.find((candidate) => (
      candidate.parameterKey === parameter.key && candidate.valueType === parameter.value_type
    ));
    return binding ? [{ parameter, binding }] : [];
  });
  if (rows.length === 0 && linkedParameterSets.length === 0 && !onAddParameter) return null;

  function patch(parameterKey: string, next: Partial<ParameterBindingForm>) {
    onChange({
      linkedParameterSets,
      parameterBindings: parameterBindings.map((binding) => binding.parameterKey === parameterKey
        ? { ...binding, ...next }
        : binding),
    });
  }

  function update(parameterKey: string, alternatives: ParameterAlternativeForm[]) {
    patch(parameterKey, { alternatives });
  }

  function createPreset() {
    const members = selectedMembers.flatMap((parameterKey) => {
      const parameter = parameters.find((candidate) => candidate.key === parameterKey);
      return parameter ? [{ parameterKey, valueType: parameter.value_type }] : [];
    });
    if (members.length < 2) return;
    const labels = members.map((member) => parameters.find((parameter) => parameter.key === member.parameterKey)?.label ?? member.parameterKey);
    const setLabel = labels.join(" + ");
    const bindingsByKey = new Map(parameterBindings.map((binding) => [binding.parameterKey, binding]));
    const rowCount = Math.max(
      1,
      ...members.map((member) => bindingsByKey.get(member.parameterKey)?.alternatives.length ?? 0),
    );
    const preset: LinkedParameterSetForm = {
      setKey: deriveLinkedParameterSetKey(setLabel, linkedParameterSets.map((set) => set.setKey)),
      setLabel,
      members,
      rows: Array.from({ length: rowCount }, (_, index) => ({
        rowLabel: "",
        values: Object.fromEntries(members.map((member) => [
          member.parameterKey,
          bindingsByKey.get(member.parameterKey)?.alternatives[index] ?? { kind: "base" as const },
        ])),
      })),
    };
    onChange({
      linkedParameterSets: [...linkedParameterSets, preset],
      parameterBindings: parameterBindings.filter((binding) => !selectedMembers.includes(binding.parameterKey)),
    });
    setSelectedMembers([]);
    setCreating(false);
  }

  function updatePreset(setKey: string, next: LinkedParameterSetForm) {
    onChange({ parameterBindings, linkedParameterSets: linkedParameterSets.map((set) => set.setKey === setKey ? next : set) });
  }

  function removePreset(set: LinkedParameterSetForm) {
    const restored = set.members.flatMap((member) => parameters.some((parameter) => parameter.key === member.parameterKey && parameter.value_type === member.valueType) ? [{
      parameterKey: member.parameterKey,
      valueType: member.valueType,
      mode: "values" as const,
      alternatives: [{ kind: "base" as const }],
      range: defaultParameterRange(member.valueType),
    }] : []);
    const byKey = new Map([...parameterBindings, ...restored].map((binding) => [binding.parameterKey, binding]));
    onChange({
      linkedParameterSets: linkedParameterSets.filter((candidate) => candidate.setKey !== set.setKey),
      parameterBindings: parameters.flatMap((parameter) => {
        const binding = byKey.get(parameter.key);
        return binding ? [binding] : [];
      }),
    });
    setRemoveConfirmation(null);
  }

  return (
    <div className="parameter-bindings">
      <div className="parameter-preset-toolbar">
        <p className="field-hint">Independent alternatives sweep separately. Preset rows keep selected values together.</p>
        {onAddParameter ? <button className="button-secondary compact" type="button" onClick={onAddParameter}>Add Parameter</button> : null}
        <button className="button-secondary compact" type="button" disabled={rows.length < 2} onClick={() => setCreating((value) => !value)}>Create preset</button>
      </div>
      {creating ? (
        <fieldset className="parameter-preset-picker">
          <legend>Choose at least two independent parameters</legend>
          {rows.map(({ parameter }) => (
            <label className="checkbox-row" key={parameter.key}>
              <input type="checkbox" checked={selectedMembers.includes(parameter.key)} onChange={(event) => setSelectedMembers(event.target.checked ? [...selectedMembers, parameter.key] : selectedMembers.filter((key) => key !== parameter.key))} />
              <span>{parameter.label}</span>
            </label>
          ))}
          <div className="parameter-preset-picker-actions">
            <button className="button-primary compact" type="button" disabled={selectedMembers.length < 2} onClick={createPreset}>Create preset</button>
            <button className="button-link" type="button" onClick={() => { setCreating(false); setSelectedMembers([]); }}>Cancel</button>
          </div>
        </fieldset>
      ) : null}
      {linkedParameterSets.length ? (
        <div className="repeater-stack parameter-presets">
          {linkedParameterSets.map((set) => (
            <PresetEditor
              key={set.setKey}
              preset={set}
              parameters={parameters}
              workflow={workflow}
              confirmingRemove={removeConfirmation === set.setKey}
              onChange={(next) => updatePreset(set.setKey, next)}
              onRequestRemove={() => setRemoveConfirmation(set.setKey)}
              onCancelRemove={() => setRemoveConfirmation(null)}
              onConfirmRemove={() => removePreset(set)}
            />
          ))}
        </div>
      ) : null}
      <div className="repeater-stack">
        {rows.map(({ parameter, binding }) => {
          const baseValue = formatBaseWorkflowValue(workflow, parameter, parameter.value_type);
          const includesBase = binding.alternatives.some((alternative) => alternative.kind === "base");
          const rangeResult = binding.mode === "range" ? rangeValidation(binding) : null;
          const count = binding.mode === "range"
            ? rangeResult?.count ?? null
            : binding.alternatives.length;
          return (
            <div className="repeater-card" key={parameter.key}>
              <div className="repeater-title">
                <strong>{parameter.label}</strong>
                <span className="field-hint">
                  {count === null ? "Invalid range" : `${count} ${count === 1 ? "alternative" : "alternatives"}`}
                </span>
              </div>
              {binding.valueType === "integer" || binding.valueType === "float" ? (
                <div className="parameter-mode" role="group" aria-label={`${parameter.label} mode`}>
                  <button aria-pressed={binding.mode === "values"} className={binding.mode === "values" ? "selected" : ""} type="button" onClick={() => patch(parameter.key, { mode: "values" })}>Values</button>
                  <button aria-pressed={binding.mode === "range"} className={binding.mode === "range" ? "selected" : ""} type="button" onClick={() => patch(parameter.key, { mode: "range" })}>Range</button>
                </div>
              ) : null}
              {binding.mode === "range" ? (
                <RangeEditor
                  parameterKey={parameter.key}
                  label={parameter.label}
                  range={binding.range}
                  error={rangeResult?.error ?? null}
                  count={rangeResult?.count ?? null}
                  baseValue={baseValue}
                  onChange={(range) => patch(parameter.key, { range })}
                />
              ) : (
                <>
              <div className="parameter-alternative-toolbar">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    aria-label={`Include Base workflow for ${parameter.label}`}
                    checked={includesBase}
                    onChange={(event) => update(
                      parameter.key,
                      event.target.checked
                        ? [{ kind: "base" }, ...binding.alternatives.filter((item) => item.kind !== "base")]
                        : binding.alternatives.filter((item) => item.kind !== "base"),
                    )}
                  />
                  <span>Include Base workflow</span>
                </label>
                <button
                  className="button-secondary compact"
                  type="button"
                  aria-label={`Add override for ${parameter.label}`}
                  onClick={() => update(parameter.key, [
                    ...binding.alternatives,
                    { kind: "override", value: defaultRawValue(binding.valueType) },
                  ])}
                >
                  Add override
                </button>
              </div>
              {binding.alternatives.length === 0 ? (
                <p className="operation-error">Add at least one alternative before Preview.</p>
              ) : null}
              <ol className="parameter-alternatives" aria-label={`${parameter.label} alternatives`}>
                {binding.alternatives.map((alternative, index) => (
                  <li key={`${alternative.kind}-${index}`}>
                    <span className="parameter-alternative-order">{index + 1}</span>
                    {alternative.kind === "base" ? (
                      <BaseValue display={baseValue} className="parameter-base-value" />
                    ) : (
                      <ParameterValueInput
                        valueType={binding.valueType}
                        value={alternative.value}
                        label={`${parameter.label} override ${index + 1}`}
                        onChange={(value) => update(parameter.key, binding.alternatives.map((item, itemIndex) => (
                          itemIndex === index ? { kind: "override", value } : item
                        )))}
                      />
                    )}
                    <div className="parameter-alternative-actions">
                      {alternative.kind === "override" ? (
                        <>
                          <button
                            className="button-link"
                            type="button"
                            disabled={index === (includesBase ? 1 : 0)}
                            aria-label={`Move ${parameter.label} alternative ${index + 1} up`}
                            onClick={() => update(parameter.key, move(binding.alternatives, index, index - 1))}
                          >Up</button>
                          <button
                            className="button-link"
                            type="button"
                            disabled={index === binding.alternatives.length - 1}
                            aria-label={`Move ${parameter.label} alternative ${index + 1} down`}
                            onClick={() => update(parameter.key, move(binding.alternatives, index, index + 1))}
                          >Down</button>
                        </>
                      ) : null}
                      <button
                        className="button-link danger"
                        type="button"
                        aria-label={`Remove ${parameter.label} alternative ${index + 1}`}
                        onClick={() => update(parameter.key, binding.alternatives.filter((_, itemIndex) => itemIndex !== index))}
                      >Remove</button>
                    </div>
                  </li>
                ))}
              </ol>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PresetEditor({ preset, parameters, workflow, confirmingRemove, onChange, onRequestRemove, onCancelRemove, onConfirmRemove }: {
  preset: LinkedParameterSetForm;
  parameters: WorkflowProfileParameter[];
  workflow: JsonObject;
  confirmingRemove: boolean;
  onChange(next: LinkedParameterSetForm): void;
  onRequestRemove(): void;
  onCancelRemove(): void;
  onConfirmRemove(): void;
}) {
  const labels = new Map(parameters.map((parameter) => [parameter.key, parameter.label]));
  const confirmRemoveRef = useRef<HTMLButtonElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const wasConfirmingRemove = useRef(confirmingRemove);
  useEffect(() => {
    if (confirmingRemove) confirmRemoveRef.current?.focus();
    else if (wasConfirmingRemove.current) removeButtonRef.current?.focus();
    wasConfirmingRemove.current = confirmingRemove;
  }, [confirmingRemove]);
  function updateRow(index: number, patch: Partial<LinkedParameterSetForm["rows"][number]>) {
    onChange({ ...preset, rows: preset.rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row) });
  }
  function addRow() {
    onChange({
      ...preset,
      rows: [...preset.rows, {
        rowLabel: "",
        values: Object.fromEntries(preset.members.map((member) => [member.parameterKey, { kind: "base" }])),
      }],
    });
  }
  return (
    <section className="repeater-card parameter-preset" aria-label={`${preset.setLabel || "Unnamed"} preset`}>
      <div className="repeater-title">
        <label className="field parameter-preset-label">
          <span className="field-label">Preset label</span>
          <input aria-label={`Preset label ${preset.setKey}`} value={preset.setLabel} onChange={(event) => onChange({ ...preset, setLabel: event.target.value })} />
        </label>
        <span className="field-hint"><code>{preset.setKey}</code></span>
      </div>
      <p className="field-hint">{preset.members.map((member) => labels.get(member.parameterKey) ?? member.parameterKey).join(" + ")}</p>
      <div className="table-scroll parameter-preset-table">
        <table>
          <thead><tr><th scope="col">Row</th><th scope="col">Label (optional)</th>{preset.members.map((member) => <th scope="col" key={member.parameterKey}>{labels.get(member.parameterKey) ?? member.parameterKey}</th>)}<th scope="col">Actions</th></tr></thead>
          <tbody>{preset.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <td className="ordinal">{rowIndex + 1}</td>
              <td><input aria-label={`${preset.setLabel} row ${rowIndex + 1} label`} value={row.rowLabel} onChange={(event) => updateRow(rowIndex, { rowLabel: event.target.value })} /></td>
              {preset.members.map((member) => {
                const value = row.values[member.parameterKey] ?? { kind: "base" as const };
                const label = `${preset.setLabel} row ${rowIndex + 1} ${labels.get(member.parameterKey) ?? member.parameterKey}`;
                const parameter = parameters.find((candidate) => candidate.key === member.parameterKey);
                const baseValue = parameter
                  ? formatBaseWorkflowValue(workflow, parameter, parameter.value_type)
                  : { text: "Base workflow · Unavailable", available: false };
                return <td key={member.parameterKey}><PresetCell label={label} valueType={member.valueType} value={value} baseValue={baseValue} onChange={(next) => updateRow(rowIndex, { values: { ...row.values, [member.parameterKey]: next } })} /></td>;
              })}
              <td><div className="parameter-row-actions">
                <button className="button-link" type="button" disabled={rowIndex === 0} aria-label={`Move ${preset.setLabel} row ${rowIndex + 1} up`} onClick={() => onChange({ ...preset, rows: move(preset.rows, rowIndex, rowIndex - 1) })}>Up</button>
                <button className="button-link" type="button" disabled={rowIndex === preset.rows.length - 1} aria-label={`Move ${preset.setLabel} row ${rowIndex + 1} down`} onClick={() => onChange({ ...preset, rows: move(preset.rows, rowIndex, rowIndex + 1) })}>Down</button>
                <button className="button-link danger" type="button" disabled={preset.rows.length === 1} aria-label={`Remove ${preset.setLabel} row ${rowIndex + 1}`} onClick={() => onChange({ ...preset, rows: preset.rows.filter((_, index) => index !== rowIndex) })}>Remove</button>
              </div></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="parameter-preset-actions">
        <button className="button-secondary compact" type="button" onClick={addRow}>Add row</button>
        {!confirmingRemove ? <button ref={removeButtonRef} className="button-link danger" type="button" onClick={onRequestRemove}>Remove preset</button> : (
          <div className="parameter-preset-confirm" role="alert"><span>Discard every Preset row and label, then restore members as Base workflow?</span><button ref={confirmRemoveRef} className="button-link danger" type="button" onClick={onConfirmRemove}>Confirm remove</button><button className="button-link" type="button" onClick={onCancelRemove}>Cancel</button></div>
        )}
      </div>
    </section>
  );
}

function PresetCell({ label, valueType, value, baseValue, onChange }: { label: string; valueType: ParameterValueType; value: ParameterAlternativeForm; baseValue: BaseWorkflowValueDisplay; onChange(value: ParameterAlternativeForm): void }) {
  return (
    <div className="parameter-preset-cell">
      <select aria-label={`${label} source`} value={value.kind} onChange={(event) => onChange(event.target.value === "base" ? { kind: "base" } : { kind: "override", value: defaultRawValue(valueType) })}>
        <option value="base">Base workflow</option>
        <option value="override">Override</option>
      </select>
      <BaseValue display={baseValue} />
      {value.kind === "override" ? <ParameterValueInput valueType={valueType} value={value.value} label={`${label} value`} onChange={(next) => onChange({ kind: "override", value: next })} /> : null}
    </div>
  );
}

function RangeEditor({ parameterKey, label, range, error, count, baseValue, onChange }: {
  parameterKey: string;
  label: string;
  range: ParameterRangeDraft;
  error: string | null;
  count: number | null;
  baseValue: BaseWorkflowValueDisplay;
  onChange(range: ParameterRangeDraft): void;
}) {
  const errorId = `${parameterKey}-range-error`;
  function update(key: keyof ParameterRangeDraft, value: string | boolean) {
    onChange({ ...range, [key]: value });
  }
  return (
    <div className="parameter-range-editor">
      <div className="field-grid three-columns">
        {(["start", "end", "step"] as const).map((key) => (
          <label className="field" key={key}>
            <span className="field-label">{key[0].toUpperCase() + key.slice(1)}</span>
            <input
              aria-describedby={error ? errorId : undefined}
              aria-invalid={Boolean(error)}
              aria-label={`${label} range ${key}`}
              inputMode="decimal"
              value={range[key]}
              onChange={(event) => update(key, event.target.value)}
            />
          </label>
        ))}
      </div>
      <label className="checkbox-row">
        <input type="checkbox" aria-label={`Include Base workflow for ${label}`} checked={range.includeBase} onChange={(event) => update("includeBase", event.target.checked)} />
        <span>Include Base workflow</span>
      </label>
      {range.includeBase ? <BaseValue display={baseValue} className="field-hint" /> : null}
      {error
        ? <p className="operation-error" id={errorId} role="alert">{error}</p>
        : <p className="field-hint">{count} {count === 1 ? "alternative" : "alternatives"}{range.includeBase ? " including Base" : ""}</p>}
    </div>
  );
}

function BaseValue({ display, className }: { display: BaseWorkflowValueDisplay; className?: string }) {
  return <span className={className} title={display.title}>{display.text}</span>;
}

function rangeValidation(binding: ParameterBindingForm): { count: number | null; error: string | null } {
  try {
    return { count: parameterRangeCount(binding.range, binding.valueType, binding.parameterKey), error: null };
  } catch (error) {
    return { count: null, error: error instanceof Error ? error.message : "Invalid range." };
  }
}

function ParameterValueInput({ valueType, value, label, onChange }: { valueType: ParameterValueType; value: string; label: string; onChange(value: string): void }) {
  if (valueType === "boolean") {
    return (
      <label className="field parameter-value-field">
        <span className="visually-hidden">{label}</span>
        <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </label>
    );
  }
  const hints: Record<Exclude<ParameterValueType, "boolean">, string> = {
    string: "Empty string is a valid override",
    integer: "Exact signed JavaScript-safe integer",
    float: "Finite number",
  };
  return (
    <label className="field parameter-value-field">
      <span className="visually-hidden">{label}</span>
      <input
        aria-label={label}
        inputMode={valueType === "string" ? undefined : "decimal"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="field-hint">{hints[valueType]}</span>
    </label>
  );
}

function defaultRawValue(valueType: ParameterValueType): string {
  if (valueType === "boolean") return "true";
  if (valueType === "string") return "";
  return "0";
}

function move<T>(values: T[], from: number, to: number): T[] {
  const next = [...values];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
