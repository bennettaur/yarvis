import { afterEach, describe, expect, it } from "bun:test";
import { createRoot, type Root } from "react-dom/client";
import { SETTINGS_TAB_STORAGE_KEY, type SettingsTabKey, useSettingsTab } from "./settingsTabs";

/** A `yarvis://settings/<tab>` link and the setup guide's Open buttons both land here. */

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  localStorage.removeItem(SETTINGS_TAB_STORAGE_KEY);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function Probe(props: { requestedTab: SettingsTabKey | null; onRequestConsumed: () => void }) {
  const [active] = useSettingsTab(props.requestedTab, props.onRequestConsumed);
  return <span>{active}</span>;
}

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  cleanup = () => {
    root.unmount();
    host.remove();
  };
  let consumed = 0;
  const render = (tab: SettingsTabKey | null) =>
    root.render(<Probe requestedTab={tab} onRequestConsumed={() => consumed++} />);
  return { host, render, consumed: () => consumed };
}

describe("useSettingsTab", () => {
  it("reopens on the tab the user last chose", async () => {
    localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, "voice");
    const { host, render } = mount();
    render(null);
    await settle();
    expect(host.textContent).toBe("voice");
  });

  it("opens on a requested tab, remembers it, and reports the request consumed", async () => {
    const { host, render, consumed } = mount();
    render("repos");
    await settle();
    expect(host.textContent).toBe("repos");
    expect(localStorage.getItem(SETTINGS_TAB_STORAGE_KEY)).toBe("repos");
    expect(consumed()).toBe(1);
  });

  it("switches when a request arrives while Settings is already showing", async () => {
    const { host, render } = mount();
    render("repos");
    await settle();
    render(null);
    await settle();
    render("diagnostics");
    await settle();
    expect(host.textContent).toBe("diagnostics");
  });
});
