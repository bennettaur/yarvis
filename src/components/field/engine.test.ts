import { afterEach, describe, expect, it } from "bun:test";
import { waitFor } from "../../test/render";
import {
  type AgentField,
  createAgentField,
  eventType,
  type FieldElements,
  nodeKey,
} from "./engine";

describe("eventType", () => {
  it("keeps a known type", () => {
    expect(eventType("edit")).toBe("edit");
    expect(eventType("subagent_done")).toBe("subagent_done");
  });

  it("treats an unknown type as a tool call", () => {
    expect(eventType("teleport")).toBe("tool");
    expect(eventType("constructor")).toBe("tool");
  });
});

describe("nodeKey", () => {
  it("keeps the same source from two origins apart", () => {
    expect(nodeKey("claude", "coder")).not.toBe(nodeKey("yarvis", "coder"));
  });
});

describe("createAgentField", () => {
  let field: AgentField | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    field?.destroy();
    host?.remove();
    field = null;
    host = null;
  });

  function mount(): FieldElements {
    host = document.createElement("div");
    document.body.appendChild(host);
    const div = () => host?.appendChild(document.createElement("div")) as HTMLElement;
    const els: FieldElements = {
      host,
      canvas: host.appendChild(document.createElement("canvas")),
      hud: div(),
      meter: div(),
      stats: div(),
      nodeList: div(),
      log: div(),
      manual: div(),
      slider: host.appendChild(document.createElement("input")),
      startOverlay: div(),
    };
    els.manual.hidden = true;
    field = createAgentField(els);
    return els;
  }

  it("shows event labels and node ids as text, never markup", async () => {
    const els = mount();
    field?.push({ origin: "yarvis", type: "bash", source: "<b>job</b>", label: "<img src=x>" });
    await waitFor(() => (els.log.textContent ?? "").includes("<img src=x>"), "the log line");
    expect(els.log.querySelector("img")).toBeNull();
    expect(els.nodeList.querySelector("b")).toBeNull();
    expect(els.nodeList.textContent).toContain("yarvis/<b>job</b>");
  });

  it("reports LIVE once connected", async () => {
    const els = mount();
    field?.setLive(true);
    await waitFor(() => (els.stats.textContent ?? "").startsWith("LIVE"), "the LIVE status");
  });

  const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));

  it("shows DEMO when the feed fails before it ever connected", async () => {
    const els = mount();
    field?.setLive(false);
    await waitFor(() => (els.stats.textContent ?? "").startsWith("DEMO"), "the DEMO status");
  });

  it("shows WAITING, not DEMO, when a live feed drops", async () => {
    const els = mount();
    field?.setLive(true);
    field?.setLive(false);
    await waitFor(() => (els.stats.textContent ?? "").startsWith("WAITING"), "the WAITING status");
  });

  it("keeps demo traffic the user turned on while live, across pings", async () => {
    const els = mount();
    field?.setLive(true);
    field?.start();
    press(document.body, "d");
    field?.setLive(true);
    await waitFor(() => (els.stats.textContent ?? "").startsWith("LIVE+DEMO"), "LIVE+DEMO");
  });

  it("starts on a plain key aimed at the page or the field", () => {
    const els = mount();
    press(document.body, "x");
    expect(els.startOverlay.hidden).toBe(true);
    press(els.canvas, "h");
    expect(els.hud.hidden).toBe(true);
  });

  it("ignores keys with a modifier, repeats, Escape, and typing", () => {
    const els = mount();
    const input = document.body.appendChild(document.createElement("input"));
    press(input, "h");
    input.remove();
    press(document.body, "1", { metaKey: true });
    press(document.body, "x", { repeat: true });
    press(document.body, "Escape");
    expect(els.startOverlay.hidden).toBe(false);
  });

  it("ignores keys aimed at something outside the field", () => {
    const els = mount();
    const overlay = document.body.appendChild(document.createElement("div"));
    press(overlay, "x");
    overlay.remove();
    expect(els.startOverlay.hidden).toBe(false);
  });

  it("stops listening for keys once destroyed", () => {
    const els = mount();
    field?.start();
    field?.destroy();
    field = null;
    press(document.body, "a");
    expect(els.manual.hidden).toBe(true);
  });
});
