import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import * as realApi from "../lib/api";
import type { McpServer, ServerStatus } from "../lib/mcp";
import { mountForInteraction, renderToHtml } from "../test/render";
import McpServerSection from "./McpServerSection";

/**
 * The OAuth half of the MCP settings section. The sidecar API and the Tauri
 * commands are stubbed, so these cover what the user sees and what pressing
 * Authorize actually asks for — not the flow itself, which lives in the sidecar.
 */

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "srv-1",
    name: "locker",
    transport: "http",
    url: "https://mcp.example.com/mcp",
    command: null,
    args: [],
    headerNames: [],
    oauth: true,
    oauthScope: null,
    enabled: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

let servers: McpServer[] = [];
let status: ServerStatus = { connected: false, toolCount: 0, oauth: null };
let authorizeCalls: string[] = [];
let opened: string[] = [];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

// `mock.module` replaces the module for the whole test process, not just this
// file, so this stub has to be invisible to every other suite: real exports are
// passed through, and a path this file doesn't care about goes to the real
// `sidecarFetch` rather than to a catch-all. Answering everything with `{}` once
// fed an empty object to unrelated components that expected a list.
mock.module("../lib/api", () => ({
  ...realApi,
  sidecarFetch: async (path: string, init?: RequestInit) => {
    if (path === "/api/mcp/servers") return json(servers);
    if (path.startsWith("/api/mcp/servers/") && path.endsWith("/status")) return json(status);
    if (path.endsWith("/authorize") && init?.method === "POST") {
      authorizeCalls.push(path);
      return json({ authorizationUrl: "https://as.example.com/authorize?client_id=cl" });
    }
    return realApi.sidecarFetch(path, init);
  },
}));

mock.module("@tauri-apps/api/core", () => ({ invoke: async () => [] }));
mock.module("@tauri-apps/plugin-opener", () => ({
  openUrl: async (url: string) => {
    opened.push(url);
  },
}));

let unmount: (() => void) | null = null;

// Hand the real module back, so nothing after this file runs against the stub.
afterAll(() => {
  mock.module("../lib/api", () => realApi);
});

afterEach(() => {
  unmount?.();
  unmount = null;
  servers = [];
  status = { connected: false, toolCount: 0, oauth: null };
  authorizeCalls = [];
  opened = [];
});

describe("McpServerSection OAuth", () => {
  it("offers Authorize for a server that hasn't signed in", async () => {
    servers = [server()];
    status = {
      connected: false,
      toolCount: 0,
      oauth: { registered: false, authorized: false, scope: null },
    };
    const html = await renderToHtml(createElement(McpServerSection));
    expect(html).toContain("not signed in");
    expect(html).toContain("Authorize");
  });

  it("shows the granted scopes once signed in", async () => {
    servers = [server()];
    status = {
      connected: true,
      toolCount: 3,
      oauth: { registered: true, authorized: true, scope: "api:read tools:execute" },
    };
    const html = await renderToHtml(createElement(McpServerSection));
    expect(html).toContain("signed in");
    expect(html).toContain("api:read tools:execute");
    expect(html).toContain("Re-authorize");
  });

  it("shows no OAuth block for a server using header credentials", async () => {
    servers = [server({ oauth: false, headerNames: ["Authorization"] })];
    const html = await renderToHtml(createElement(McpServerSection));
    expect(html).not.toContain("not signed in");
    expect(html).toContain("Authorization");
  });

  it("opens the browser at the url the sidecar hands back", async () => {
    servers = [server()];
    status = {
      connected: false,
      toolCount: 0,
      oauth: { registered: false, authorized: false, scope: null },
    };
    const mounted = await mountForInteraction(createElement(McpServerSection));
    unmount = mounted.unmount;

    const authorize = [...mounted.host.querySelectorAll("button")].find(
      (b) => b.textContent === "Authorize",
    );
    authorize?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(authorizeCalls).toEqual(["/api/mcp/servers/srv-1/authorize"]);
    expect(opened).toEqual(["https://as.example.com/authorize?client_id=cl"]);
  });
});
