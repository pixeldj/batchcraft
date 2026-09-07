export type ThemePreference = "system" | "light" | "dark";

export const appearanceStorageKey = "batchcraft.appearance.v1";
export const paletteStorageKey = "batchcraft.palette.v1";
export const darkModeQuery = "(prefers-color-scheme: dark)";

export const palettes = [
  { id: "jipiti", name: "Jipiti", description: "Paper, forest & a little lime" },
  { id: "github", name: "GitHub", description: "Quiet charcoal, crisp blue" },
  { id: "synthwave", name: "Synthwave", description: "After-hours magenta & cyan" },
  { id: "solarized", name: "Solarized", description: "Warm sand meets deep teal" },
  { id: "dracula", name: "Dracula", description: "Violet dusk & neon green" },
  { id: "nord", name: "Nord", description: "Arctic frost & ocean blues" },
  { id: "monokai", name: "Monokai", description: "Ink, neon & electric lime" },
  { id: "gruvbox", name: "Gruvbox", description: "Earthy warmth, amber glow" },
  { id: "catppuccin", name: "Catppuccin", description: "Soft pastels, latte to mocha" },
] as const;

export type Palette = typeof palettes[number]["id"];

export function loadPalettePreference(): Palette {
  try {
    const value = window.localStorage.getItem(paletteStorageKey);
    return palettes.find((palette) => palette.id === value)?.id ?? "jipiti";
  } catch {
    return "jipiti";
  }
}

export function savePalettePreference(palette: Palette): boolean {
  try {
    window.localStorage.setItem(paletteStorageKey, palette);
    return true;
  } catch {
    return false;
  }
}

export function applyPalettePreference(palette: Palette) {
  document.documentElement.dataset.palette = palette;
}

export function loadThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(appearanceStorageKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function saveThemePreference(theme: ThemePreference): boolean {
  try {
    window.localStorage.setItem(appearanceStorageKey, theme);
    return true;
  } catch {
    return false;
  }
}

export function applyThemePreference(theme: ThemePreference) {
  document.documentElement.dataset.theme = theme === "system"
    ? (window.matchMedia?.(darkModeQuery).matches ? "dark" : "light")
    : theme;
}
