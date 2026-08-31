import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { renderToHtml, textOf } from "../test/render";

const CATALOG = {
  userDir: "/Users/me/.yarvis/agents",
  problems: [
    {
      path: "/Users/me/.yarvis/agents/broken.md",
      message: "broken.md:1: expected a '---' frontmatter fence on the first line",
    },
  ],
  specialists: [
    {
      name: "planner",
      description: "Suggests what to work on next.",
      prompt: "You advise on what to do next.",
      tools: ["recall", "list_todos"],
      unattended: [],
      provider: null,
      model: null,
      maxSteps: 12,
      enabled: true,
      source: "builtin",
      path: "definitions/planner.md",
    },
    {
      name: "project-manager",
      description: "Keeps a project's tickets straight.",
      prompt: "You manage project tracking.",
      tools: ["get_project", "jira_create_issue"],
      unattended: ["jira_create_issue"],
      provider: "anthropic",
      model: "claude-sonnet-5",
      maxSteps: 12,
      enabled: true,
      source: "user",
      path: "/Users/me/.yarvis/agents/project-manager.md",
    },
  ],
};

/**
 * `mock.module` replaces the module for the whole test process, so the real
 * exports are spread back in: a stub that only defines `sidecarFetch` breaks
 * every other file importing this one, and one that redefines `ensureOk`
 * silently replaces what `api.test.ts` is asserting about.
 */
const actualApi = await import("../lib/api");

mock.module("../lib/api", () => ({
  ...actualApi,
  sidecarFetch: async () =>
    new Response(JSON.stringify(CATALOG), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
}));

const SpecialistSection = (await import("./SpecialistSection")).default;

describe("SpecialistSection", () => {
  it("lists each specialist with its tool count, model and step budget", async () => {
    const text = textOf(await renderToHtml(createElement(SpecialistSection)));
    expect(text).toContain("planner");
    expect(text).toContain("2 tool(s)");
    expect(text).toContain("default model");
    expect(text).toContain("anthropic/claude-sonnet-5");
    expect(text).toContain("12 steps");
  });

  it("says where to add one, and which came from there", async () => {
    const text = textOf(await renderToHtml(createElement(SpecialistSection)));
    expect(text).toContain("/Users/me/.yarvis/agents");
    expect(text).toContain("yours");
    expect(text).toContain("built-in");
  });

  it("surfaces a file that failed to parse rather than hiding it", async () => {
    const text = textOf(await renderToHtml(createElement(SpecialistSection)));
    expect(text).toContain("frontmatter fence");
  });

  it("names the specialist that can write without being asked", async () => {
    const html = await renderToHtml(createElement(SpecialistSection));
    const text = textOf(html);
    expect(text).toContain("acts unattended");
    expect(text).toContain("jira_create_issue");
    expect(text).toContain("no way to ask you first");
    // One badge for the one grant, not one per specialist.
    expect(html.match(/acts unattended/g)).toHaveLength(1);
  });

  it("keeps each prompt behind a toggle, so the list stays readable", async () => {
    const text = textOf(await renderToHtml(createElement(SpecialistSection)));
    expect(text).toContain("Show prompt");
    expect(text).not.toContain("You advise on what to do next.");
  });
});
