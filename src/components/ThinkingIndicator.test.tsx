import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToHtml } from "../test/render";
import ThinkingIndicator from "./ThinkingIndicator";

describe("ThinkingIndicator", () => {
  it("labels the pending row as assistant and shows a spinner with a waiting message", async () => {
    const html = await renderToHtml(createElement(ThinkingIndicator));
    expect(html).toContain("assistant");
    expect(html).toContain("Thinking…");
    expect(html).toContain("animate-spin");
  });
});
