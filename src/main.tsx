import "./zodConfig";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import BootGate from "./components/shell/BootGate";
import SignInGate from "./components/shell/SignInGate";
import VaultGate from "./components/shell/VaultGate";
import "./index.css";
import { loadAppearance } from "./lib/appearance";

function render() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <SignInGate>
        <VaultGate>
          <BootGate>
            <App />
          </BootGate>
        </VaultGate>
      </SignInGate>
    </React.StrictMode>,
  );
}

// The theme and terminal size are read before the first render, so a Palenight
// user doesn't see the default palette for a frame. The core already holds the
// settings in memory, so this costs one round trip. A device that isn't signed
// in renders at once and gets them after sign-in.
loadAppearance().finally(render);
