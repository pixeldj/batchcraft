import type { ParameterValueType, WorkflowProfileParameter } from "../../api/types";
import {
  parameterRangeCount,
  type ParameterAlternativeForm,
  type ParameterBindingForm,
  type ParameterRangeDraft,
} from "./form";

interface Props {
  parameters: WorkflowProfileParameter[];
  parameterBindings: ParameterBindingForm[];
  onChange(bindings: ParameterBindingForm[]): void;
}

export function ParameterBindingsEditor({ parameters, parameterBindings, onChange }: Props) {
  const rows = parameters.flatMap((parameter) => {
    const binding = parameterBindings.find((candidate) => (
      candidate.parameterKey === parameter.key && candidate.valueType === parameter.value_type
    ));
    return binding ? [{ parameter, binding }] : [];
  });
  if (rows.length === 0) return null;

  function patch(parameterKey: string, next: Partial<ParameterBindingForm>) {
    onChange(parameterBindings.map((binding) => binding.parameterKey === parameterKey
      ? { ...binding, ...next }
      : binding));
  }

  function update(parameterKey: string, alternatives: ParameterAlternativeForm[]) {
    patch(parameterKey, { alternatives });
  }

  return (
    <div className="parameter-bindings">
      <p className="field-hint">Each ordered alternative is resolved by the backend into concrete Jobs.</p>
      <div className="repeater-stack">
        {rows.map(({ parameter, binding }) => {
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
                      <span className="parameter-base-value">Base workflow</span>
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

function RangeEditor({ parameterKey, label, range, error, count, onChange }: {
  parameterKey: string;
  label: string;
  range: ParameterRangeDraft;
  error: string | null;
  count: number | null;
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
      {error
        ? <p className="operation-error" id={errorId} role="alert">{error}</p>
        : <p className="field-hint">{count} {count === 1 ? "alternative" : "alternatives"}{range.includeBase ? " including Base" : ""}</p>}
    </div>
  );
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
