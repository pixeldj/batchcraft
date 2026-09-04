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
  it("creates and edits a stable keyed Preset, manages typed rows, and confirms unlinking to Base", () => {
    const onChange = vi.fn();
    let parameterBindings = PARAMETERS.map((parameter) => binding(parameter.key, parameter.value_type, [{ kind: "base" }]));
    let linkedParameterSets: Parameters<typeof ParameterBindingsEditor>[0]["linkedParameterSets"] = [];
    const view = render(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={parameterBindings} linkedParameterSets={linkedParameterSets} onChange={onChange} />);
    const rerenderFromLastChange = () => {
      ({ parameterBindings, linkedParameterSets } = onChange.mock.calls.at(-1)?.[0] as { parameterBindings: ParameterBindingForm[]; linkedParameterSets: typeof linkedParameterSets });
      view.rerender(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={parameterBindings} linkedParameterSets={linkedParameterSets} onChange={onChange} />);
    };

    fireEvent.click(screen.getByRole("button", { name: "Create preset" }));
    const picker = screen.getByRole("group", { name: "Choose at least two independent parameters" });
    fireEvent.click(within(picker).getByRole("checkbox", { name: "Caption" }));
    fireEvent.click(within(picker).getByRole("checkbox", { name: "Enabled" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Create preset" }));
    rerenderFromLastChange();

    expect(linkedParameterSets[0].setKey).toBe("caption_enabled");
    expect(screen.queryByRole("button", { name: "Add override for Caption" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add override for Steps" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Preset label caption_enabled"), { target: { value: "Display states" } });
    rerenderFromLastChange();
    expect(linkedParameterSets[0]).toMatchObject({ setKey: "caption_enabled", setLabel: "Display states" });

    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    rerenderFromLastChange();
    fireEvent.change(screen.getByLabelText("Display states row 2 label"), { target: { value: "Enabled caption" } });
    rerenderFromLastChange();
    fireEvent.change(screen.getByLabelText("Display states row 2 Caption source"), { target: { value: "override" } });
    rerenderFromLastChange();
    fireEvent.change(screen.getByLabelText("Display states row 2 Caption value"), { target: { value: "ready" } });
    rerenderFromLastChange();
    fireEvent.change(screen.getByLabelText("Display states row 2 Enabled source"), { target: { value: "override" } });
    rerenderFromLastChange();
    fireEvent.change(screen.getByLabelText("Display states row 2 Enabled value"), { target: { value: "false" } });
    rerenderFromLastChange();
    expect(linkedParameterSets[0].rows[0].values.caption).toEqual({ kind: "base" });
    expect(linkedParameterSets[0].rows[1]).toMatchObject({ rowLabel: "Enabled caption", values: { caption: { value: "ready" }, enabled: { value: "false" } } });

    fireEvent.click(screen.getByRole("button", { name: "Move Display states row 2 up" }));
    rerenderFromLastChange();
    expect(linkedParameterSets[0].rows[0].rowLabel).toBe("Enabled caption");
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    rerenderFromLastChange();
    fireEvent.click(screen.getByRole("button", { name: "Remove Display states row 3" }));
    rerenderFromLastChange();
    expect(linkedParameterSets[0].rows).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove preset" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Discard every Preset row and label");
    expect(screen.getByRole("button", { name: "Confirm remove" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Remove preset" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Remove preset" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
    rerenderFromLastChange();
    expect(linkedParameterSets).toEqual([]);
    expect(parameterBindings.map((item) => [item.parameterKey, item.alternatives])).toEqual([
      ["caption", [{ kind: "base" }]], ["enabled", [{ kind: "base" }]], ["steps", [{ kind: "base" }]],
    ]);
  });

  it("transfers saved Values alternatives into Preset rows and fills shorter members with Base", () => {
    const onChange = vi.fn();
    const steps = binding("steps", "integer", [{ kind: "override", value: "30" }]);
    steps.mode = "range";
    const bindings = [
      binding("caption", "string", [
        { kind: "override", value: "first" },
        { kind: "override", value: "second" },
      ]),
      binding("enabled", "boolean", [{ kind: "override", value: "false" }]),
      steps,
    ];
    render(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={bindings} linkedParameterSets={[]} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Create preset" }));
    const picker = screen.getByRole("group", { name: "Choose at least two independent parameters" });
    fireEvent.click(within(picker).getByRole("checkbox", { name: "Caption" }));
    fireEvent.click(within(picker).getByRole("checkbox", { name: "Steps" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Create preset" }));

    expect(onChange).toHaveBeenLastCalledWith({
      parameterBindings: [bindings[1]],
      linkedParameterSets: [{
        setKey: "caption_steps",
        setLabel: "Caption + Steps",
        members: [
          { parameterKey: "caption", valueType: "string" },
          { parameterKey: "steps", valueType: "integer" },
        ],
        rows: [
          {
            rowLabel: "",
            values: {
              caption: { kind: "override", value: "first" },
              steps: { kind: "override", value: "30" },
            },
          },
          {
            rowLabel: "",
            values: {
              caption: { kind: "override", value: "second" },
              steps: { kind: "base" },
            },
          },
        ],
      }],
    });
  });

  it("keeps the frozen Base value visible when a Preset cell uses an override", () => {
    const onChange = vi.fn();
    const preset = {
      setKey: "display",
      setLabel: "Display",
      members: [
        { parameterKey: "caption", valueType: "string" as const },
        { parameterKey: "enabled", valueType: "boolean" as const },
      ],
      rows: [{ rowLabel: "", values: { caption: { kind: "base" as const }, enabled: { kind: "base" as const } } }],
    };
    const view = render(<ParameterBindingsEditor
      parameters={PARAMETERS}
      workflow={{ "1": { inputs: { caption: "base caption", enabled: false } } }}
      parameterBindings={[binding("steps", "integer", [{ kind: "base" }])]}
      linkedParameterSets={[preset]}
      onChange={onChange}
    />);

    fireEvent.change(screen.getByLabelText("Display row 1 Caption source"), { target: { value: "override" } });
    const updated = onChange.mock.calls.at(-1)?.[0].linkedParameterSets[0];
    view.rerender(<ParameterBindingsEditor
      parameters={PARAMETERS}
      workflow={{ "1": { inputs: { caption: "base caption", enabled: false } } }}
      parameterBindings={[binding("steps", "integer", [{ kind: "base" }])]}
      linkedParameterSets={[updated]}
      onChange={onChange}
    />);

    const cell = screen.getByLabelText("Display row 1 Caption source").closest(".parameter-preset-cell");
    expect(cell).not.toBeNull();
    expect(within(cell as HTMLElement).getByText("Base workflow · base caption")).toBeInTheDocument();
    expect(within(cell as HTMLElement).getByLabelText("Display row 1 Caption value")).toBeInTheDocument();
  });

  it("places Add Parameter before Create preset and invokes the Profile action", () => {
    const onAddParameter = vi.fn();
    render(<ParameterBindingsEditor
      parameters={[]}
      parameterBindings={[]}
      linkedParameterSets={[]}
      onAddParameter={onAddParameter}
      onChange={vi.fn()}
    />);

    const addParameter = screen.getByRole("button", { name: "Add Parameter" });
    const createPreset = screen.getByRole("button", { name: "Create preset" });
    expect(addParameter.compareDocumentPosition(createPreset) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(createPreset).toBeDisabled();
    fireEvent.click(addParameter);
    expect(onAddParameter).toHaveBeenCalledOnce();
  });

  it("marks Preset table headings as column headers", () => {
    render(<ParameterBindingsEditor
      parameters={PARAMETERS}
      parameterBindings={[binding("steps", "integer", [{ kind: "base" }])]}
      linkedParameterSets={[{
        setKey: "display_states",
        setLabel: "Display states",
        members: [
          { parameterKey: "caption", valueType: "string" },
          { parameterKey: "enabled", valueType: "boolean" },
        ],
        rows: [{ rowLabel: "", values: { caption: { kind: "base" }, enabled: { kind: "base" } } }],
      }]}
      onChange={vi.fn()}
    />);

    expect(screen.getAllByRole("columnheader")).toHaveLength(5);
    for (const heading of screen.getAllByRole("columnheader")) expect(heading).toHaveAttribute("scope", "col");
  });

  it("adds, removes, and reorders ordered overrides while toggling Base independently", () => {
    const onChange = vi.fn();
    const bindings: ParameterBindingForm[] = [
      binding("caption", "string", [{ kind: "base" }]),
      binding("enabled", "boolean", [{ kind: "base" }]),
      binding("steps", "integer", [{ kind: "base" }]),
    ];
    const view = render(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={bindings} linkedParameterSets={[]} onChange={onChange} />);

    expect(screen.getByRole("button", { name: "Add override for Caption" })).toHaveTextContent("Add override");
    expect(screen.getByRole("checkbox", { name: "Include Base workflow for Caption" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Include Base workflow for Enabled" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Add override for Caption" }));
    const withOne = [
      { ...bindings[0], alternatives: [{ kind: "base" as const }, { kind: "override" as const, value: "" }] },
      bindings[1],
      bindings[2],
    ];
    expect(onChange).toHaveBeenLastCalledWith({ parameterBindings: withOne, linkedParameterSets: [] });

    view.rerender(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={withOne} linkedParameterSets={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Caption override 2"), { target: { value: "first" } });
    const edited = [
      { ...withOne[0], alternatives: [{ kind: "base" as const }, { kind: "override" as const, value: "first" }] },
      bindings[1],
      bindings[2],
    ];
    view.rerender(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={edited} linkedParameterSets={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Add override for Caption" }));
    const withTwo = [
      { ...edited[0], alternatives: [...edited[0].alternatives, { kind: "override" as const, value: "" }] },
      bindings[1],
      bindings[2],
    ];
    view.rerender(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={withTwo} linkedParameterSets={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Move Caption alternative 3 up" }));
    expect(onChange).toHaveBeenLastCalledWith({ linkedParameterSets: [], parameterBindings: [
      { ...withTwo[0], alternatives: [withTwo[0].alternatives[0], withTwo[0].alternatives[2], withTwo[0].alternatives[1]] },
      bindings[1],
      bindings[2],
    ] });

    fireEvent.click(screen.getByRole("button", { name: "Remove Caption alternative 3" }));
    expect(onChange).toHaveBeenLastCalledWith({ linkedParameterSets: [], parameterBindings: [
      { ...withTwo[0], alternatives: withTwo[0].alternatives.slice(0, 2) },
      bindings[1],
      bindings[2],
    ] });

    fireEvent.click(screen.getByRole("checkbox", { name: "Include Base workflow for Caption" }));
    expect(onChange).toHaveBeenLastCalledWith({ linkedParameterSets: [], parameterBindings: [
      { ...withTwo[0], alternatives: withTwo[0].alternatives.slice(1) },
      bindings[1],
      bindings[2],
    ] });
    expect(screen.queryByText("caption")).not.toBeInTheDocument();
  });

  it("preserves empty string and boolean false controls", () => {
    const onChange = vi.fn();
    const bindings: ParameterBindingForm[] = [
      binding("caption", "string", [{ kind: "override", value: "" }]),
      binding("enabled", "boolean", [{ kind: "override", value: "false" }]),
    ];
    render(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={bindings} linkedParameterSets={[]} onChange={onChange} />);

    expect(screen.getByLabelText("Caption override 1")).toHaveValue("");
    expect(screen.getByLabelText("Enabled override 1")).toHaveValue("false");
    expect(within(screen.getByRole("list", { name: "Caption alternatives" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("does not render or emit a synthetic binding when form state is missing", () => {
    const onChange = vi.fn();
    render(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={[]} linkedParameterSets={[]} onChange={onChange} />);

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
    const view = render(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={bindings} linkedParameterSets={[]} onChange={onChange} />);

    expect(screen.queryByRole("group", { name: "Caption mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Enabled mode" })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Steps mode" })).getByRole("button", { name: "Range" }));
    const rangeMode = bindings.map((item) => item.parameterKey === "steps" ? { ...item, mode: "range" as const } : item);
    expect(onChange).toHaveBeenLastCalledWith({ parameterBindings: rangeMode, linkedParameterSets: [] });

    view.rerender(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={rangeMode} linkedParameterSets={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Steps range end"), { target: { value: "20" } });
    const editedRange = rangeMode.map((item) => item.parameterKey === "steps" ? { ...item, range: { ...item.range, end: "20" } } : item);
    view.rerender(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={editedRange} linkedParameterSets={[]} onChange={onChange} />);
    expect(screen.getAllByText("21 alternatives")).toHaveLength(2);
    fireEvent.click(within(screen.getByRole("group", { name: "Steps mode" })).getByRole("button", { name: "Values" }));

    expect(onChange).toHaveBeenLastCalledWith({ parameterBindings: editedRange.map((item) => item.parameterKey === "steps" ? { ...item, mode: "values" } : item), linkedParameterSets: [] });
    view.rerender(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={editedRange.map((item) => item.parameterKey === "steps" ? { ...item, mode: "values" as const } : item)} linkedParameterSets={[]} onChange={onChange} />);
    expect(screen.getByLabelText("Steps override 1")).toHaveValue("30");
  });

  it("associates Range errors with each numeric input", () => {
    const bindings = [
      { ...binding("steps", "integer", [{ kind: "base" }]), mode: "range" as const },
    ];
    bindings[0].range.step = "0";

    render(<ParameterBindingsEditor parameters={PARAMETERS} parameterBindings={bindings} linkedParameterSets={[]} onChange={vi.fn()} />);

    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("step must not be zero");
    for (const key of ["start", "end", "step"]) {
      expect(screen.getByLabelText(`Steps range ${key}`)).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByLabelText(`Steps range ${key}`)).toHaveAttribute("aria-describedby", error.id);
    }
  });

  it("shows frozen Base values in Values, Range, and Preset rows", () => {
    const parameters: WorkflowProfileParameter[] = [
      ...PARAMETERS,
      { key: "cfg", label: "CFG", node_id: "1", input_name: "cfg", value_type: "float" },
    ];
    const steps = binding("steps", "integer", [{ kind: "base" }]);
    steps.mode = "range";
    steps.range.includeBase = true;
    render(<ParameterBindingsEditor
      parameters={parameters}
      workflow={{ "1": { inputs: { caption: "", enabled: false, steps: 20, cfg: 7.25 } } }}
      parameterBindings={[binding("caption", "string", [{ kind: "base" }]), steps]}
      linkedParameterSets={[{
        setKey: "display",
        setLabel: "Display",
        members: [
          { parameterKey: "enabled", valueType: "boolean" },
          { parameterKey: "cfg", valueType: "float" },
        ],
        rows: [{ rowLabel: "Base row", values: { enabled: { kind: "base" }, cfg: { kind: "base" } } }],
      }]}
      onChange={vi.fn()}
    />);

    expect(screen.getByRole("list", { name: "Caption alternatives" })).toHaveTextContent("Base workflow · Empty string");
    expect(screen.getByText("Base workflow · 20")).toBeInTheDocument();
    const preset = screen.getByRole("region", { name: "Display preset" });
    expect(within(preset).getByText("Base workflow · false")).toBeInTheDocument();
    expect(within(preset).getByText("Base workflow · 7.25")).toBeInTheDocument();
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
