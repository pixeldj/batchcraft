import { useEffect, useRef, useState } from "react";

import {
  applyPalettePreference,
  applyThemePreference,
  darkModeQuery,
  loadPalettePreference,
  loadThemePreference,
  palettes,
  savePalettePreference,
  saveThemePreference,
  type Palette,
  type ThemePreference,
} from "./appearance";

const themes = [
  { value: "system", label: "System", description: "Follow your device" },
  { value: "light", label: "Light", description: "A lighter workspace" },
  { value: "dark", label: "Dark", description: "A darker workspace" },
] as const;

export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(loadThemePreference);
  const [palette, setPalette] = useState<Palette>(loadPalettePreference);
  const [saved, setSaved] = useState(true);
  const [paletteSaved, setPaletteSaved] = useState(true);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    applyThemePreference(theme);
    if (theme !== "system") return;
    const media = window.matchMedia?.(darkModeQuery);
    const update = () => applyThemePreference("system");
    media?.addEventListener("change", update);
    return () => media?.removeEventListener("change", update);
  }, [theme]);

  useEffect(() => { applyPalettePreference(palette); }, [palette]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current!;
    const trigger = triggerRef.current;
    const overflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      trigger?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        className="settings-trigger"
        type="button"
        aria-label="Settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        title="Settings"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="m9 3-.6 2.4-1.8 1L4.2 6l-2 3.4L4 11v2l-1.8 1.6 2 3.4 2.4-.4 1.8 1L9 21h4l.6-2.4 1.8-1 2.4.4 2-3.4L18 13v-2l1.8-1.6-2-3.4-2.4.4-1.8-1L13 3Z" />
          <circle cx="11" cy="12" r="3" />
        </svg>
      </button>
      {open && (
        <dialog
          ref={dialogRef}
          className="settings-dialog"
          aria-labelledby="settings-title"
          onCancel={(event) => { event.preventDefault(); setOpen(false); }}
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const controls = event.currentTarget.querySelectorAll<HTMLElement>("button, a[href], input:checked");
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }}
        >
          <header className="settings-header">
            <div>
              <p className="settings-kicker">Your workspace</p>
              <h2 id="settings-title">Settings</h2>
            </div>
            <button className="settings-close" type="button" aria-label="Close settings" onClick={() => setOpen(false)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </header>
          <div className="settings-workspace">
            <nav className="settings-sidebar" aria-label="Settings pages">
              <a href="#settings-appearance" aria-current="page">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <circle cx="12" cy="12" r="8" />
                  <path d="M12 4v16a8 8 0 0 0 0-16Z" fill="currentColor" stroke="none" />
                </svg>
                Appearance
              </a>
            </nav>
            <section className="settings-content" id="settings-appearance" aria-labelledby="appearance-title">
              <h3 id="appearance-title">Appearance</h3>
              <p className="settings-description">Make yourself at home. Choose how batchcraft looks on this device.</p>
              <fieldset className="theme-fieldset" aria-describedby="theme-help">
                <legend>Appearance mode</legend>
                <p id="theme-help">Choose a light or dark workspace, or let your system decide.</p>
                <div className="theme-options">
                  {themes.map((option) => (
                    <label className="theme-option" key={option.value}>
                      <input
                        type="radio"
                        aria-label={option.label}
                        name="appearance-theme"
                        value={option.value}
                        checked={theme === option.value}
                        onChange={() => {
                          setTheme(option.value);
                          applyThemePreference(option.value);
                          setSaved(saveThemePreference(option.value));
                        }}
                      />
                      <span className="theme-option-label">{option.label}</span>
                      <span className="theme-option-description">{option.description}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="palette-fieldset" aria-describedby="palette-help">
                <legend>Palette <span className="palette-count">{String(palettes.length).padStart(2, "0")} curated</span></legend>
                <p id="palette-help">Find your colors. Every palette has a light and a dark side.</p>
                <div className="palette-options">
                  {palettes.map((option) => (
                    <label className="palette-option" key={option.id}>
                      <input
                        type="radio"
                        name="appearance-palette"
                        aria-label={option.name}
                        value={option.id}
                        checked={palette === option.id}
                        onChange={() => {
                          setPalette(option.id);
                          applyPalettePreference(option.id);
                          setPaletteSaved(savePalettePreference(option.id));
                        }}
                      />
                      <span className="palette-tile">
                        <span className="palette-preview" aria-hidden="true">
                          {(["light", "dark"] as const).map((mode) => (
                            <span className="palette-half" data-palette={option.id} data-theme={mode} key={mode}>
                              <span className="palette-mini-header"><span /><span /><span /></span>
                              <span className="palette-mini-body">
                                <span className="palette-mini-line" />
                                <span className="palette-mini-line" />
                                <span className="palette-swatches"><span /><span /><span /></span>
                              </span>
                            </span>
                          ))}
                        </span>
                        <span className="palette-label">{option.name}<span className="palette-check" aria-hidden="true">{palette === option.id ? "Selected" : ""}</span></span>
                        <span className="palette-description">{option.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <p className="settings-storage-note" role="status">
                {saved && paletteSaved
                  ? "Changes apply immediately and are saved in this browser."
                  : "Appearance applied for this session. Browser storage is unavailable, so your choice could not be saved."}
              </p>
            </section>
          </div>
          <footer className="settings-footer">
            <span>Personal preferences. Your Batches and Runs stay unchanged.</span>
            <button className="button-secondary" type="button" onClick={() => setOpen(false)}>Done</button>
          </footer>
        </dialog>
      )}
    </>
  );
}
