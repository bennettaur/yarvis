import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { renderToHtml, textOf } from "../test/render";

const SPECIALISTS = [
  {
    id: "s1",
    name: "planner",
    description: "Suggests what to work on next.",
    prompt: "You advise on what to do next.",
    toolIds: ["builtin:recall", "builtin:list_todos"],
    unattendedToolIds: [],
    provider: null,
    model: null,
    maxSteps: 12,
    builtin: true,
    enabled: true,
  },
  {
    id: "s2",
    name: "project-manager",
    description: "Keeps a project's tickets straight.",
    prompt: "You manage project tracking.",
    toolIds: ["builtin:get_project", "builtin:jira_create_issue"],
    unattendedToolIds: ["builtin:jira_create_issue"],
    provider: null,
    model: null,
    maxSteps: 12,
    builtin: true,
    enabled: true,
  },
];

mock.module("../lib/api", () => ({
  sidecarFetch: async () =>
    new Response(JSON.stringify(SPECIALISTS), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
}));

const SpecialistSection = (await import("./SpecialistSection")).default;

describe("SpecialistSection", () => {
  it("lists each specialist with its tool count and model", async () => {
    const text = textOf(await renderToHtml(createElement(SpecialistSection)));
    expect(text).toContain("planner");
    expect(text).toContain("2 tool(s)");
    expect(text).toContain("default model");
  });

  it("says which specialist can write without being asked, and what it can do", async () => {
    const text = textOf(await renderToHtml(createElement(SpecialistSection)));
    expect(text).toContain("acts unattended");
    expect(text).toContain("jira_create_issue");
    expect(text).toContain("no way to ask you first");
  });

  it("leaves the badge off a specialist that only reads", async () => {
    const html = await renderToHtml(createElement(SpecialistSection));
    // One badge for the one grant, not one per specialist.
    expect(html.match(/acts unattended/g)).toHaveLength(1);
  });
});
