import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { PrRef } from "../../lib/pr/types";
import { renderToHtml } from "../../test/render";
import PrWorkspaceAction from "./PrWorkspaceAction";

// findWorkspaceForPr goes through sidecarFetch. The stub answers with whatever
// `lookup` is set to, so both states of the control are reachable: a matching
// workspace (the backlink) and none (the start button).
let lookup = "null";
mock.module("../../lib/api", () => ({
  sidecarFetch: async () => new Response(lookup, { status: 200 }),
  streamSSE: () => () => {},
  ensureOk: async () => {},
}));

const matched = JSON.stringify({
  id: "ws-1",
  name: "Rename API",
  slug: "rename-api",
  status: "active",
});

const render = (prRef: PrRef) => renderToHtml(createElement(PrWorkspaceAction, { prRef }));

describe("PrWorkspaceAction", () => {
  it("renders the backlink button for a GitHub PR raised from a workspace", async () => {
    lookup = matched;
    const html = await render({ provider: "github", owner: "octo", repo: "repo", number: 1 });
    expect(html).toContain("Workspace: Rename API");
  });

  it("renders the backlink button for an Azure PR (no longer early-returns)", async () => {
    lookup = matched;
    const html = await render({
      provider: "azure",
      org: "acme",
      project: "Shop",
      repo: "web",
      prId: 42,
    });
    expect(html).toContain("Workspace: Rename API");
  });

  it("offers to start one for a PR with no workspace", async () => {
    lookup = "null";
    const html = await render({ provider: "github", owner: "octo", repo: "repo", number: 1 });
    expect(html).toContain("Start workspace");
    expect(html).not.toContain("Workspace: ");
  });
});
