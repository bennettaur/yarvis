import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { firstPaintOf, renderToHtml } from "../test/render";
import SessionsPanel from "./SessionsPanel";

mock.module("../lib/cc", () => ({
  listProjects: async () => [{ dir: "proj", path: "/work/proj", sessionCount: 1 }],
  listSessions: async () => [
    { id: "s1", title: "Fix the flaky test", gitBranch: "main", messageCount: 4, updatedAt: null },
  ],
  listPlans: async () => [],
  getTranscript: async () => [],
  getPlan: async () => ({ content: "" }),
}));

describe("SessionsPanel", () => {
  it("shows a loading indicator until the sessions arrive", async () => {
    const cold = firstPaintOf(createElement(SessionsPanel));
    expect(cold.text).toContain("Loading sessions…");
    cold.unmount();

    const html = await renderToHtml(createElement(SessionsPanel));
    expect(html).not.toContain("Loading sessions…");
    expect(html).toContain("Fix the flaky test");
  });
});
