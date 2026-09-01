import type { ParameterValueType } from "../../api/types";
import {
  profileParameters,
  type ParameterBindingForm,
} from "./form";

interface Props {
  profileJson: string;
  parameterBindings: ParameterBindingForm[];
  onChange(bindings: ParameterBindingForm[]): void;
}

export function ParameterBindingsEditor({ profileJson, parameterBindings, onChange }: Props) {
  const parameters = safeProfileParameters(profileJson);
  if (parameters === null) return null;
  const rows = parameters.flatMap((parameter) => {
    const binding = parameterBindings.find((candidate) => (
      candidate.parameterKey === parameter.key && candidate.valueType === parameter.value_type
    ));
    return binding ? [{ parameter, binding }] : [];
  });
  if (rows.length === 0) return null;

  function update(parameterKey: string, patch: Partial<ParameterBindingForm>) {
    onChange(parameterBindings.map((binding) => binding.parameterKey === parameterKey
      ? { ...binding, ...patch }
      : binding));
  }

  return (
    <fieldset className="parameter-bindings">
      <legend>Parameters</legend>
      <p className="field-hint">Fixed Workflow Profile parameters do not change the Job count.</p>
      <div className="repeater-stack">
        {rows.map(({ parameter, binding }) => {
          return (
            <div className="repeater-card" key={parameter.key}>
              <div className="repeater-title">
                <strong>{parameter.label}</strong>
                <code>{parameter.key}</code>
              </div>
              <div className="field-grid two-columns align-start">
                <label className="field">
                  <span className="field-label">Value source</span>
                  <select
                    aria-label={`${parameter.label} value source`}
                    value={binding.mode}
                    onChange={(event) => update(parameter.key, { mode: event.target.value as "base" | "override" })}
                  >
                    <option value="base">Base workflow</option>
                    <option value="override">Override</option>
                  </select>
                </label>
                {binding.mode === "override" ? <ParameterValueInput binding={binding} label={parameter.label} onChange={(value) => update(parameter.key, { value })} /> : null}
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

function safeProfileParameters(profileJson: string) {
  try {
    return profileParameters(profileJson);
  } catch {
    return null;
  }
}

function ParameterValueInput({ binding, label, onChange }: { binding: ParameterBindingForm; label: string; onChange(value: string): void }) {
  if (binding.valueType === "boolean") {
    return (
      <label className="field">
        <span className="field-label">Override value</span>
        <select aria-label={`${label} override value`} value={binding.value} onChange={(event) => onChange(event.target.value)}>
          <option value="">Select true or false</option>
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
    <label className="field">
      <span className="field-label">Override value</span>
      <input
        aria-label={`${label} override value`}
        inputMode={binding.valueType === "string" ? undefined : "decimal"}
        value={binding.value}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="field-hint">{hints[binding.valueType]}</span>
    </label>
  );
}
