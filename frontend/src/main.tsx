import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { applyPalettePreference, applyThemePreference, loadPalettePreference, loadThemePreference } from "./features/settings/appearance";
import "./styles.css";
import "./features/settings/palettes.css";
import "./features/settings/settings.css";
import "./features/project/projectBrowser.css";

applyThemePreference(loadThemePreference());
applyPalettePreference(loadPalettePreference());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
