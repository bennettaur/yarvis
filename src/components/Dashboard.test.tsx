import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusDot } from "./Dashboard";

describe("StatusDot", () => {
  test("names its state for hover and screen readers when given a label", () => {
    const html = renderToStaticMarkup(createElement(StatusDot, { state: true, label: "Key set" }));
    expect(html).toContain('title="Key set"');
    expect(html).toContain('aria-label="Key set"');
  });

  test("stays unlabelled without one", () => {
    const html = renderToStaticMarkup(createElement(StatusDot, { state: false }));
    expect(html).not.toContain("title=");
    expect(html).not.toContain("aria-label");
  });
});
