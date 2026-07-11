import { describe, expect, it } from "bun:test";
import { createElement as h, useEffect } from "react";
import { renderToHtml } from "../test/render";
import SplitPane, { usePersistedRatio } from "./SplitPane";

describe("SplitPane", () => {
  it("renders both panes and a draggable divider", async () => {
    const html = await renderToHtml(
      h(SplitPane, {
        orientation: "horizontal",
        ratio: 0.6,
        onRatioChange: () => {},
        first: h("div", null, "left pane"),
        second: h("div", null, "right pane"),
      }),
    );
    expect(html).toContain("left pane");
    expect(html).toContain("right pane");
    expect(html).toContain("cursor-col-resize");
  });

  it("sizes the first pane from the ratio", async () => {
    const html = await renderToHtml(
      h(SplitPane, {
        orientation: "horizontal",
        ratio: 0.3,
        onRatioChange: () => {},
        first: h("div", null, "a"),
        second: h("div", null, "b"),
      }),
    );
    expect(html).toContain("flex-basis: 30%");
  });

  it("clamps an out-of-range ratio to the min bound", async () => {
    const html = await renderToHtml(
      h(SplitPane, {
        orientation: "vertical",
        ratio: 2,
        onRatioChange: () => {},
        minRatio: 0.2,
        first: h("div", null, "a"),
        second: h("div", null, "b"),
      }),
    );
    // ratio 2 clamps to 1 - minRatio = 0.8.
    expect(html).toContain("flex-basis: 80%");
    expect(html).toContain("cursor-row-resize");
  });
});

describe("usePersistedRatio", () => {
  it("falls back to the initial value when nothing is stored", async () => {
    localStorage.removeItem("test.ratio.a");
    let seen = -1;
    function Probe() {
      const [ratio] = usePersistedRatio("test.ratio.a", 0.42);
      seen = ratio;
      return null;
    }
    await renderToHtml(h(Probe));
    expect(seen).toBe(0.42);
  });

  it("reads a previously stored value and persists updates", async () => {
    localStorage.setItem("test.ratio.b", "0.25");
    let seen = -1;
    function Probe() {
      const [ratio, setRatio] = usePersistedRatio("test.ratio.b", 0.5);
      seen = ratio;
      useEffect(() => {
        setRatio(0.75);
      }, [setRatio]);
      return null;
    }
    await renderToHtml(h(Probe));
    expect(seen).toBe(0.75);
    expect(localStorage.getItem("test.ratio.b")).toBe("0.75");
  });
});
