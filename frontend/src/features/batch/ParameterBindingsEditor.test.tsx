import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkflowProfileParameter } from "../../api/types";
import type { ParameterBindingForm } from "./form";
import { ParameterBindingsEditor } from "./ParameterBindingsEditor";

const PARAMETERS: WorkflowProfileParameter[] = [
  { key: "caption", label: "Caption", node_id: "1", input_name: "caption", value_type: "string" },
  { key: "enabled", label: "Enabled", node_id: "1", input_name: "enabled", value_type: "boolean" },
  { key: "steps", label: "Steps", node_id: "1", input_name: "steps", value_type: "integer" },
];

describe("ParameterBindingsEditor", () => {
  it("adds, removes, and reorders ordered overrides while toggling Base independently", () => {
    const onChange = vi.fn();
    const bindings: ParameterBindingForm[] = [
      binding("caption", "string", [{ kind: "base" }]),
      binding("enabled", "boolean", [{ kind: "base" }]),
      binding("steps", "integer", [{ kind: "base" }]),
    ];
    const view = render(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={bindings} onChange={onChange} />);

    expect(screen.getByRole("button", { name: "Add override for Caption" })).toHaveTextContent("Add override");
    expect(screen.getByRole("checkbox", { name: "Include Base workflow for Caption" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Include Base workflow for Enabled" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Add override for Caption" }));
    const withOne = [
      { ...bindings[0], alternatives: [{ kind: "base" as const }, { kind: "override" as const, value: "" }] },
      bindings[1],
      bindings[2],
    ];
    expect(onChange).toHaveBeenLastCalledWith(withOne);

    view.rerender(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={withOne} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Caption override 2"), { target: { value: "first" } });
    const edited = [
      { ...withOne[0], alternatives: [{ kind: "base" as const }, { kind: "override" as const, value: "first" }] },
      bindings[1],
      bindings[2],
    ];
    view.rerender(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={edited} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Add override for Caption" }));
    const withTwo = [
      { ...edited[0], alternatives: [...edited[0].alternatives, { kind: "override" as const, value: "" }] },
      bindings[1],
      bindings[2],
    ];
    view.rerender(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={withTwo} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Move Caption alternative 3 up" }));
    expect(onChange).toHaveBeenLastCalledWith([
      { ...withTwo[0], alternatives: [withTwo[0].alternatives[0], withTwo[0].alternatives[2], withTwo[0].alternatives[1]] },
      bindings[1],
      bindings[2],
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Remove Caption alternative 3" }));
    expect(onChange).toHaveBeenLastCalledWith([
      { ...withTwo[0], alternatives: withTwo[0].alternatives.slice(0, 2) },
      bindings[1],
      bindings[2],
    ]);

    fireEvent.click(screen.getByRole("checkbox", { name: "Include Base workflow for Caption" }));
    expect(onChange).toHaveBeenLastCalledWith([
      { ...withTwo[0], alternatives: withTwo[0].alternatives.slice(1) },
      bindings[1],
      bindings[2],
    ]);
    expect(screen.queryByText("caption")).not.toBeInTheDocument();
  });

  it("preserves empty string and boolean false controls", () => {
    const onChange = vi.fn();
    const bindings: ParameterBindingForm[] = [
      binding("caption", "string", [{ kind: "override", value: "" }]),
      binding("enabled", "boolean", [{ kind: "override", value: "false" }]),
    ];
    render(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={bindings} onChange={onChange} />);

    expect(screen.getByLabelText("Caption override 1")).toHaveValue("");
    expect(screen.getByLabelText("Enabled override 1")).toHaveValue("false");
    expect(within(screen.getByRole("list", { name: "Caption alternatives" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("does not render or emit a synthetic binding when form state is missing", () => {
    const onChange = vi.fn();
    render(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={[]} onChange={onChange} />);

    expect(screen.queryByRole("group", { name: "Parameters" })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("retains Values and Range drafts across mode switches and exposes Range only for numeric parameters", () => {
    const onChange = vi.fn();
    const bindings = [
      binding("caption", "string", [{ kind: "override", value: "retained caption" }]),
      binding("enabled", "boolean", [{ kind: "override", value: "false" }]),
      binding("steps", "integer", [{ kind: "override", value: "30" }]),
    ];
    const view = render(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={bindings} onChange={onChange} />);

    expect(screen.queryByRole("group", { name: "Caption mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Enabled mode" })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Steps mode" })).getByRole("button", { name: "Range" }));
    const rangeMode = bindings.map((item) => item.parameterKey === "steps" ? { ...item, mode: "range" as const } : item);
    expect(onChange).toHaveBeenLastCalledWith(rangeMode);

    view.rerender(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={rangeMode} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Steps range end"), { target: { value: "20" } });
    const editedRange = rangeMode.map((item) => item.parameterKey === "steps" ? { ...item, range: { ...item.range, end: "20" } } : item);
    view.rerender(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={editedRange} onChange={onChange} />);
    expect(screen.getAllByText("21 alternatives")).toHaveLength(2);
    fireEvent.click(within(screen.getByRole("group", { name: "Steps mode" })).getByRole("button", { name: "Values" }));

    expect(onChange).toHaveBeenLastCalledWith(editedRange.map((item) => item.parameterKey === "steps" ? { ...item, mode: "values" } : item));
    view.rerender(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={editedRange.map((item) => item.parameterKey === "steps" ? { ...item, mode: "values" as const } : item)} onChange={onChange} />);
    expect(screen.getByLabelText("Steps override 1")).toHaveValue("30");
  });

  it("associates Range errors with each numeric input", () => {
    const bindings = [
      { ...binding("steps", "integer", [{ kind: "base" }]), mode: "range" as const },
    ];
    bindings[0].range.step = "0";

    render(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={bindings} onChange={vi.fn()} />);

    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("step must not be zero");
    for (const key of ["start", "end", "step"]) {
      expect(screen.getByLabelText(`Steps range ${key}`)).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByLabelText(`Steps range ${key}`)).toHaveAttribute("aria-describedby", error.id);
    }
  });
});

function binding(
  parameterKey: string,
  valueType: ParameterBindingForm["valueType"],
  alternatives: ParameterBindingForm["alternatives"],
): ParameterBindingForm {
  return {
    parameterKey,
    valueType,
    mode: "values",
    alternatives,
    range: valueType === "integer"
      ? { start: "0", end: "10", step: "1", includeBase: false }
      : { start: "0", end: "1", step: "0.1", includeBase: false },
  };
}
