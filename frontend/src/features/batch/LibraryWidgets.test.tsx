import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryMenu } from "./LibraryMenu";
import { LibrarySearch } from "./LibrarySearch";
import { profileMappingCount, ReadonlyProfileSummary } from "./ReadonlyProfileSummary";

describe("Library search", () => {
  afterEach(() => vi.useRealTimers());
  it("debounces for 300ms, uses the latest callback, and commits Enter once immediately", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const props = { label: "Search", query: "", scope: "one", onChange };
    const view = render(<LibrarySearch {...props} />);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "por" } });
    act(() => vi.advanceTimersByTime(299)); expect(onChange).not.toHaveBeenCalled();
    const latest = vi.fn(); view.rerender(<LibrarySearch {...props} onChange={latest} />);
    act(() => vi.advanceTimersByTime(1)); expect(latest).toHaveBeenCalledExactlyOnceWith("por");
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "portrait" } });
    fireEvent.keyDown(screen.getByLabelText("Search"), { key: "Enter" });
    expect(latest).toHaveBeenLastCalledWith("portrait");
    act(() => vi.advanceTimersByTime(500)); expect(latest).toHaveBeenCalledTimes(2);
  });
  it.each(["query", "scope", "inactive", "unmount"])("cancels a stale timer on %s without echoing navigation", (change) => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const props = { label: "Search", query: "initial", scope: "first", active: true, onChange };
    const view = render(<LibrarySearch {...props} />);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "stale" } });
    act(() => vi.advanceTimersByTime(299));
    if (change === "unmount") view.unmount();
    else view.rerender(<LibrarySearch {...props} query={change === "query" ? "back" : props.query} scope={change === "scope" ? "second" : props.scope} active={change !== "inactive"} />);
    act(() => vi.advanceTimersByTime(500)); expect(onChange).not.toHaveBeenCalled();
    if (change !== "unmount") expect(screen.getByLabelText("Search")).toHaveValue(change === "query" ? "back" : "initial");
  });
});

describe("Library menu", () => {
  function setup() {
    const onSelect = vi.fn(() => expect(screen.getByRole("button", { name: "Actions" })).toHaveFocus());
    render(<><LibraryMenu label="Actions" items={[{ label: "Rename", onSelect }, { label: "Disabled", disabled: true, onSelect }, { label: "History", onSelect }, { label: "Archive", onSelect }]} /><button>Outside</button></>);
    return onSelect;
  }
  it("supports arrow keys, Home/End, skips disabled items, and restores focus on Escape", () => {
    setup(); const trigger = screen.getByRole("button", { name: "Actions" }); trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "History" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" }); expect(screen.getByRole("menuitem", { name: "Archive" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" }); expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" }); expect(screen.getByRole("menuitem", { name: "Archive" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" }); expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" }); expect(trigger).toHaveFocus(); expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(trigger, { key: "ArrowUp" }); expect(screen.getByRole("menuitem", { name: "Archive" })).toHaveFocus();
  });
  it("dismisses outside and on Tab, and restores the trigger before invoking an action", () => {
    const onSelect = setup(); const trigger = screen.getByRole("button", { name: "Actions" });
    fireEvent.click(trigger); fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" })); expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(trigger); fireEvent.keyDown(document.activeElement!, { key: "Tab" }); expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(trigger); fireEvent.click(screen.getByRole("menuitem", { name: "Rename" })); expect(onSelect).toHaveBeenCalledOnce(); expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  it("clamps a long menu to narrow viewport bounds", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "menu" ? { width: 260, height: 200, top: 0, bottom: 200, left: 0, right: 260, x: 0, y: 0, toJSON() {} } : { width: 40, height: 30, top: 280, bottom: 310, left: 280, right: 320, x: 280, y: 280, toJSON() {} };
    });
    const width = vi.spyOn(window, "innerWidth", "get").mockReturnValue(320);
    const height = vi.spyOn(window, "innerHeight", "get").mockReturnValue(320);
    setup(); fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menu")).toHaveStyle({ left: "52px", top: "112px" });
    width.mockRestore(); height.mockRestore();
  });
});

describe("Read-only Profile summary", () => {
  it("uses friendly exact-workflow node labels, preserves definition order and types, and hides technical targets", () => {
    const profile = {
      mappings: { prompt: { node_id: "1", input_name: "text" }, seed: { node_id: "2", input_name: "seed" }, output_prefix: { node_id: "3", input_name: "filename_prefix" } },
      image_inputs: [{ key: "second", label: "Second image" }, { key: "first", label: "First image" }],
      parameters: [{ key: "zero", label: "Zero", value_type: "integer" }, { key: "false", label: "False", value_type: "boolean" }, { key: "empty", label: "Empty", value_type: "string" }],
    };
    render(<ReadonlyProfileSummary profile={profile} workflow={{ "1": { class_type: "CLIPTextEncode", _meta: { title: "Positive prompt" }, inputs: { text: "" } }, "2": { class_type: "Sampler", inputs: { seed: 0 } }, "3": { class_type: "SaveImage", inputs: { filename_prefix: "" } } }} />);
    expect(screen.getByText("Positive prompt")).toBeVisible(); expect(screen.getByText("Sampler")).toBeVisible(); expect(screen.getByText("SaveImage")).toBeVisible();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Second image second", "First image first", "Zero integer", "False boolean", "Empty string"]);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument(); expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText(/"input_name": "text"/)).not.toBeVisible();
    expect(profileMappingCount(profile)).toBe("2 named inputs / 3 parameters");
  });
  it("does not invent zero counts for unknown payloads", () => {
    expect(profileMappingCount({})).toBe("Summary unavailable");
    expect(profileMappingCount({ image_inputs: [], parameters: [] })).toBe("0 named inputs / 0 parameters");
  });
});
