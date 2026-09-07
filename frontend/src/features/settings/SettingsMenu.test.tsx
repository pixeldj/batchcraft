import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsMenu } from "./SettingsMenu";
import { appearanceStorageKey, loadPalettePreference, loadThemePreference, palettes, paletteStorageKey } from "./appearance";

describe("Appearance settings", () => {
  let dark: boolean;
  let media: EventTarget;

  beforeEach(() => {
    localStorage.clear();
    dark = false;
    media = new EventTarget();
    vi.stubGlobal("matchMedia", vi.fn(() => Object.assign(media, { matches: dark })));
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: function (this: HTMLDialogElement) { this.open = true; },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: function (this: HTMLDialogElement) { this.open = false; },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.palette;
  });

  it("defaults to System, follows OS changes, and lets an explicit choice override them", () => {
    render(<SettingsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    act(() => { dark = true; media.dispatchEvent(new Event("change")); });
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem(appearanceStorageKey)).toBe("light");
    act(() => media.dispatchEvent(new Event("change")));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem(appearanceStorageKey)).toBe("system");
  });

  it("restores a saved preference independently of working-session storage", () => {
    localStorage.setItem(appearanceStorageKey, "dark");
    localStorage.setItem("batchcraft.working-session-recovery.v4", "untouched");
    const view = render(<SettingsMenu />);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    view.unmount();
    render(<SettingsMenu />);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem("batchcraft.working-session-recovery.v4")).toBe("untouched");
  });

  it("locks scrolling, closes with cancel and Done, and restores trigger focus", () => {
    render(<SettingsMenu />);
    const trigger = screen.getByRole("button", { name: "Settings" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent(screen.getByRole("dialog", { name: "Settings" }), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("defaults to jipiti and saves every palette without changing the selected mode", () => {
    localStorage.setItem(appearanceStorageKey, "dark");
    render(<SettingsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("radio", { name: "Jipiti" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "GitHub" }));
    for (const palette of palettes) {
      fireEvent.click(screen.getByRole("radio", { name: palette.name }));
      expect(document.documentElement).toHaveAttribute("data-palette", palette.id);
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
      expect(localStorage.getItem(paletteStorageKey)).toBe(palette.id);
      expect(localStorage.getItem(appearanceStorageKey)).toBe("dark");
    }
    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    act(() => { dark = true; media.dispatchEvent(new Event("change")); });
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-palette", "catppuccin");
  });

  it("restores palette independently and falls back to jipiti for an unknown palette", () => {
    localStorage.setItem(paletteStorageKey, "solarized");
    const view = render(<SettingsMenu />);
    expect(document.documentElement).toHaveAttribute("data-palette", "solarized");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    view.unmount();
    localStorage.setItem(paletteStorageKey, "unsupported");
    localStorage.setItem(appearanceStorageKey, "dark");
    render(<SettingsMenu />);
    expect(document.documentElement).toHaveAttribute("data-palette", "jipiti");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("keeps a palette write failure visible when a subsequent mode write succeeds", () => {
    render(<SettingsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("full"); });
    fireEvent.click(screen.getByRole("radio", { name: "Nord" }));
    expect(document.documentElement).toHaveAttribute("data-palette", "nord");
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(screen.getByRole("status")).toHaveTextContent("could not be saved");
    fireEvent.click(screen.getByRole("radio", { name: "Monokai" }));
    expect(screen.getByRole("status")).toHaveTextContent("saved in this browser");
  });

  it("falls back on invalid or inaccessible storage and still applies choices when saving fails", () => {
    localStorage.setItem(appearanceStorageKey, "unsupported");
    expect(loadThemePreference()).toBe("system");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(loadPalettePreference()).toBe("jipiti");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    render(<SettingsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(screen.getByRole("status")).toHaveTextContent("could not be saved");
  });
});
