import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ParameterBindingsEditor } from "./ParameterBindingsEditor";

const PROFILE = JSON.stringify({
  mappings: {},
  image_inputs: [],
  parameters: [
    { key: "caption", label: "Caption", node_id: "1", input_name: "caption", value_type: "string" },
    { key: "enabled", label: "Enabled", node_id: "1", input_name: "enabled", value_type: "boolean" },
  ],
});

describe("ParameterBindingsEditor", () => {
  it("represents Base, empty string Override, and boolean false distinctly", () => {
    const onChange = vi.fn();
    const bindings = [
      { parameterKey: "caption", valueType: "string" as const, mode: "base" as const, value: "" },
      { parameterKey: "enabled", valueType: "boolean" as const, mode: "base" as const, value: "" },
    ];
    const view = render(<ParameterBindingsEditor profileJson={PROFILE} parameterBindings={bindings} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Caption value source"), { target: { value: "override" } });
    expect(onChange).toHaveBeenLastCalledWith([
      { ...bindings[0], mode: "override" },
      bindings[1],
    ]);

    const overridden = [{ ...bindings[0], mode: "override" as const }, bindings[1]];
    view.rerender(<ParameterBindingsEditor profileJson={PROFILE} parameterBindings={overridden} onChange={onChange} />);
    expect(screen.getByLabelText("Caption override value")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Enabled value source"), { target: { value: "override" } });
    const booleanOverride = [overridden[0], { ...bindings[1], mode: "override" as const }];
    view.rerender(<ParameterBindingsEditor profileJson={PROFILE} parameterBindings={booleanOverride} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Enabled override value"), { target: { value: "false" } });
    expect(onChange).toHaveBeenLastCalledWith([
      booleanOverride[0],
      { ...booleanOverride[1], value: "false" },
    ]);
  });

  it("does not render or emit a synthetic binding when form state is missing", () => {
    const onChange = vi.fn();
    render(<ParameterBindingsEditor profileJson={PROFILE} parameterBindings={[]} onChange={onChange} />);

    expect(screen.queryByRole("group", { name: "Parameters" })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
