import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { mountForInteraction, renderToHtml } from "../test/render";
import McpEndpointSection, { claudeAddCommand } from "./McpEndpointSection";

const ENDPOINT = { url: "http://127.0.0.1:8765/mcp", token: "s3cret-mcp-token" };

mock.module("../lib/api", () => ({
  sidecarFetch: async () =>
    new Response(JSON.stringify(ENDPOINT), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
}));

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("McpEndpointSection", () => {
  it("shows the endpoint but keeps the token masked until asked for", async () => {
    const html = await renderToHtml(createElement(McpEndpointSection));
    expect(html).toContain("http://127.0.0.1:8765/mcp");
    expect(html).not.toContain("s3cret-mcp-token");
    expect(html).toContain("Show");
  });

  it("reveals the token when Show is clicked", async () => {
    const mounted = await mountForInteraction(createElement(McpEndpointSection));
    unmount = mounted.unmount;

    const show = [...mounted.host.querySelectorAll("button")].find((b) => b.textContent === "Show");
    show?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mounted.host.innerHTML).toContain("s3cret-mcp-token");
  });

  it("hands the user a runnable connect command", () => {
    // The whole point of the section: this string is pasted into a terminal, so
    // the flags and the quoting around the header are the deliverable.
    expect(claudeAddCommand(ENDPOINT)).toBe(
      'claude mcp add --transport http yarvis http://127.0.0.1:8765/mcp --header "Authorization: Bearer s3cret-mcp-token"',
    );
  });
});
