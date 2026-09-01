import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkflowProfileParameter } from "../../api/types";
import type { ParameterBindingForm } from "./form";
import { ParameterBindingsEditor } from "./ParameterBindingsEditor";

const PARAMETERS: WorkflowProfileParameter[] = [
  { key: "caption", label: "Caption", node_id: "1", input_name: "caption", value_type: "string" },
  { key: "enabled", label: "Enabled", node_id: "1", input_name: "enabled", value_type: "boolean" },
];

describe("ParameterBindingsEditor", () => {
  it("adds, removes, and reorders ordered overrides while toggling Base independently", () => {
    const onChange = vi.fn();
    const bindings: ParameterBindingForm[] = [
      { parameterKey: "caption", valueType: "string", alternatives: [{ kind: "base" }] },
      { parameterKey: "enabled", valueType: "boolean", alternatives: [{ kind: "base" }] },
    ];
    const view = render(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={bindings} onChange={onChange} />);

    expect(screen.getByRole("button", { name: "Add override for Caption" })).toHaveTextContent("Add override");
    expect(screen.getByRole("checkbox", { name: "Include Base workflow for Caption" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Include Base workflow for Enabled" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Add override for Caption" }));
    const withOne = [
      { ...bindings[0], alternatives: [{ kind: "base" as const }, { kind: "override" as const, value: "" }] },
      bindings[1],
    ];
    expect(onChange).toHaveBeenLastCalledWith(withOne);

    view.rerender(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={withOne} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Caption override 2"), { target: { value: "first" } });
    const edited = [
      { ...withOne[0], alternatives: [{ kind: "base" as const }, { kind: "override" as const, value: "first" }] },
      bindings[1],
    ];
    view.rerender(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={edited} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Add override for Caption" }));
    const withTwo = [
      { ...edited[0], alternatives: [...edited[0].alternatives, { kind: "override" as const, value: "" }] },
      bindings[1],
    ];
    view.rerender(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={withTwo} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Move Caption alternative 3 up" }));
    expect(onChange).toHaveBeenLastCalledWith([
      { ...withTwo[0], alternatives: [withTwo[0].alternatives[0], withTwo[0].alternatives[2], withTwo[0].alternatives[1]] },
      bindings[1],
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Remove Caption alternative 3" }));
    expect(onChange).toHaveBeenLastCalledWith([
      { ...withTwo[0], alternatives: withTwo[0].alternatives.slice(0, 2) },
      bindings[1],
    ]);

    fireEvent.click(screen.getByRole("checkbox", { name: "Include Base workflow for Caption" }));
    expect(onChange).toHaveBeenLastCalledWith([
      { ...withTwo[0], alternatives: withTwo[0].alternatives.slice(1) },
      bindings[1],
    ]);
    expect(screen.queryByText("caption")).not.toBeInTheDocument();
  });

  it("preserves empty string and boolean false controls", () => {
    const onChange = vi.fn();
    const bindings: ParameterBindingForm[] = [
      { parameterKey: "caption", valueType: "string", alternatives: [{ kind: "override", value: "" }] },
      { parameterKey: "enabled", valueType: "boolean", alternatives: [{ kind: "override", value: "false" }] },
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
});
