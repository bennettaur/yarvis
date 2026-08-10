import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { PrRef } from "../../lib/pr/types";
import { renderToHtml } from "../../test/render";
import PrWorkspaceLink from "./PrWorkspaceLink";

// findWorkspaceForPr goes through sidecarFetch. Stub it to report a matching
// workspace so the positive (button-rendered) path is exercised.
mock.module("../../lib/api", () => ({
  sidecarFetch: async () =>
    new Response(
      JSON.stringify({ id: "ws-1", name: "Rename API", slug: "rename-api", status: "active" }),
      {
        status: 200,
      },
    ),
  streamSSE: () => () => {},
}));

const render = (prRef: PrRef) => renderToHtml(createElement(PrWorkspaceLink, { prRef }));

describe("PrWorkspaceLink", () => {
  it("renders the backlink button for a GitHub PR raised from a workspace", async () => {
    const html = await render({ provider: "github", owner: "octo", repo: "repo", number: 1 });
    expect(html).toContain("Workspace: Rename API");
    expect(html).toContain("Rename API");
  });

  it("renders the backlink button for an Azure PR (no longer early-returns)", async () => {
    const html = await render({
      provider: "azure",
      org: "acme",
      project: "Shop",
      repo: "web",
      prId: 42,
    });
    expect(html).toContain("Workspace: Rename API");
  });
});
