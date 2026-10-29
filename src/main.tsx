import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import BootGate from "./components/shell/BootGate";
import "./index.css";
import { loadAttentionSweep } from "./lib/attentionSweep";
import { getSettings } from "./lib/settings";
import { loadTerminalFontSize } from "./lib/terminalFont";
import { loadColorTheme } from "./lib/theme";

function render() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <BootGate>
        <App />
      </BootGate>
    </React.StrictMode>,
  );
}

// The theme and terminal size are read before the first render, so a Palenight
// user doesn't see the default palette for a frame. The core already holds the
// settings in memory, so this costs one round trip. On failure the defaults
// stand.
getSettings()
  .then((settings) => {
    loadColorTheme(settings.colorTheme);
    loadTerminalFontSize(settings.terminalFontSize);
    loadAttentionSweep(settings.attentionSweep);
  })
  .catch((e) => console.error("[settings] loading appearance failed:", e))
  .finally(render);
