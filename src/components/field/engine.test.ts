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

  it("starts on a plain key but ignores one with a modifier or typed into a field", () => {
    const els = mount();
    const input = document.body.appendChild(document.createElement("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", metaKey: true }));
    expect(els.startOverlay.hidden).toBe(false);
    input.remove();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    expect(els.startOverlay.hidden).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "h" }));
    expect(els.hud.hidden).toBe(true);
  });

  it("stops listening for keys once destroyed", () => {
    const els = mount();
    field?.start();
    field?.destroy();
    field = null;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(els.manual.hidden).toBe(true);
  });
});
