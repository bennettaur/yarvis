import { afterEach, describe, expect, it } from "bun:test";
import type { ToolActivity } from "../lib/chat";
import { mountForInteraction, renderToHtml, textOf } from "../test/render";
import TurnActivity from "./TurnActivity";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function entry(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: "c1",
    name: "search_pages",
    server: "Notion",
    args: { query: "roadmap" },
    status: "ok",
    result: '{"pages":2}',
    durationMs: 1400,
    ...overrides,
  };
}

describe("TurnActivity", () => {
  it("renders nothing when the turn did nothing worth showing", async () => {
    expect(await renderToHtml(<TurnActivity activity={[]} />)).toBe("");
  });

  it("names each tool, its server and how long it took, with details collapsed", async () => {
    const html = await renderToHtml(<TurnActivity activity={[entry()]} />);
    const text = textOf(html);
    expect(text).toContain("search_pages");
    expect(text).toContain("on Notion");
    expect(text).toContain("1.4s");
    expect(text).not.toContain("roadmap");
  });

  it("shows the arguments and result once expanded", async () => {
    const mounted = await mountForInteraction(<TurnActivity activity={[entry()]} />);
    cleanup = mounted.unmount;
    mounted.host.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mounted.host.textContent).toContain("roadmap");
    expect(mounted.host.textContent).toContain('{"pages":2}');
  });

  it("marks a denial as such rather than as a completed call", async () => {
    const html = await renderToHtml(
      <TurnActivity activity={[entry({ status: "denied", result: undefined })]} />,
    );
    expect(textOf(html)).toContain("denied");
  });

  it("shows a call with no outcome yet as still running", async () => {
    const html = await renderToHtml(
      <TurnActivity activity={[entry({ durationMs: undefined, result: undefined })]} running />,
    );
    const text = textOf(html);
    expect(text).toContain("search_pages");
    expect(text).toContain("…");
  });

  it("keeps reasoning behind a disclosure, labelled by whether it is still arriving", async () => {
    const live = await renderToHtml(
      <TurnActivity activity={[]} thinking="weighing it up" running />,
    );
    expect(textOf(live)).toContain("Thinking…");
    expect(textOf(live)).not.toContain("weighing it up");

    const done = await renderToHtml(<TurnActivity activity={[]} thinking="weighing it up" />);
    expect(textOf(done)).toContain("Thought about it");
  });
});
