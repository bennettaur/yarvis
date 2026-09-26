import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToHtml } from "../test/render";
import DeleteFilterButton from "./DeleteFilterButton";

describe("DeleteFilterButton", () => {
  it("names the glyph-only button for hover and screen readers", async () => {
    const html = await renderToHtml(createElement(DeleteFilterButton, { onDelete: () => {} }));
    expect(html).toContain('title="Delete this saved filter"');
    expect(html).toContain('aria-label="Delete this saved filter"');
  });
});
