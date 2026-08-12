import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { renderToHtml } from "../test/render";
import McpEndpointSection from "./McpEndpointSection";

const ENDPOINT = { url: "http://127.0.0.1:8765/mcp", token: "s3cret-mcp-token" };

mock.module("../lib/api", () => ({
  sidecarFetch: async () =>
    new Response(JSON.stringify(ENDPOINT), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
}));

describe("McpEndpointSection", () => {
  it("shows the endpoint but keeps the token masked until asked for", async () => {
    const html = await renderToHtml(createElement(McpEndpointSection));
    expect(html).toContain("http://127.0.0.1:8765/mcp");
    expect(html).not.toContain("s3cret-mcp-token");
    expect(html).toContain("Show");
  });
});
