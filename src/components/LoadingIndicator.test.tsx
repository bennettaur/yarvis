import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToHtml } from "../test/render";
import LoadingIndicator from "./LoadingIndicator";

describe("LoadingIndicator", () => {
  it("shows a spinner with the default label", async () => {
    const html = await renderToHtml(createElement(LoadingIndicator));
    expect(html).toContain("Loading…");
    expect(html).toContain("animate-spin");
    expect(html).toContain('role="status"');
  });

  it("shows the label it is given", async () => {
    const html = await renderToHtml(createElement(LoadingIndicator, { label: "Loading diff…" }));
    expect(html).toContain("Loading diff…");
  });
});
