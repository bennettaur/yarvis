import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import BootGate from "./components/shell/BootGate";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BootGate>
      <App />
    </BootGate>
  </React.StrictMode>,
);
