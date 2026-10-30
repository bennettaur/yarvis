import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { mountForInteraction, renderToHtml, waitFor } from "../../test/render";
import AgentFieldPanel, { type FieldSubscribe } from "./AgentFieldPanel";
import type { FieldEvent } from "./engine";

describe("AgentFieldPanel", () => {
  let unmount: (() => void) | null = null;
  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  it("renders the HUD and the start prompt", async () => {
    const html = await renderToHtml(createElement(AgentFieldPanel, { subscribe: () => () => {} }));
    expect(html).toContain("AGENT//FIELD");
    expect(html).toContain("jack in_");
    expect(html).toContain("<canvas");
  });

  it("takes focus on mount so its keys work at once", async () => {
    const mounted = await mountForInteraction(
      createElement(AgentFieldPanel, { subscribe: () => () => {} }),
    );
    unmount = mounted.unmount;
    expect(mounted.host.contains(document.activeElement)).toBe(true);
  });

  it("feeds subscribed events to the field and unsubscribes on unmount", async () => {
    const feed: { emit?: (ev: FieldEvent) => void } = {};
    let unsubscribed = false;
    const subscribe: FieldSubscribe = (onEvent, onStatus) => {
      feed.emit = onEvent;
      onStatus(true);
      return () => {
        unsubscribed = true;
      };
    };
    const mounted = await mountForInteraction(createElement(AgentFieldPanel, { subscribe }));
    unmount = mounted.unmount;
    feed.emit?.({ origin: "claude", type: "edit", source: "coder", label: "App.tsx" });
    await waitFor(() => (mounted.host.textContent ?? "").includes("App.tsx"), "the log line");
    expect(mounted.host.textContent).toContain("LIVE");

    mounted.unmount();
    unmount = null;
    expect(unsubscribed).toBe(true);
  });
});
