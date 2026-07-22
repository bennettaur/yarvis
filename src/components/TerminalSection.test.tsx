import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { Settings } from "../lib/settings";
import { renderToHtml } from "../test/render";

// mock.module must register at top level, so the stubs record into module-scoped
// state that beforeEach resets between tests.
let stored: Settings = { maxPtySessions: null, defaultMaxPtySessions: 60 };
const saved: (number | null)[] = [];

mock.module("../lib/settings", () => ({
  getSettings: async () => stored,
  setMaxPtySessions: async (value: number | null) => {
    saved.push(value);
    stored = { ...stored, maxPtySessions: value };
    return stored;
  },
}));

// Imported after the mock is registered so the component binds to the stubs.
const { default: TerminalSection } = await import("./TerminalSection");

describe("TerminalSection", () => {
  beforeEach(() => {
    stored = { maxPtySessions: null, defaultMaxPtySessions: 60 };
    saved.length = 0;
  });

  it("offers the core's default as the placeholder when no cap is stored", async () => {
    const html = await renderToHtml(createElement(TerminalSection));
    expect(html).toContain('placeholder="60"');
    expect(html).toContain("Blank uses the default of 60.");
  });

  it("shows a stored cap as the field's value", async () => {
    stored = { maxPtySessions: 120, defaultMaxPtySessions: 60 };
    const html = await renderToHtml(createElement(TerminalSection));
    expect(html).toContain('value="120"');
  });
});
