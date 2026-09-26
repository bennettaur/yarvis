import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import * as realApi from "../lib/api";
import type { McpServer } from "../lib/mcp";
import { mountForInteraction, renderToHtml, textOf } from "../test/render";
import McpConnectionBar from "./McpConnectionBar";

function server(overrides: Partial<McpServer>): McpServer {
  return {
    id: "s1",
    name: "Notion",
    transport: "http",
    url: "https://example.com/mcp",
    command: null,
    args: [],
    headerNames: [],
    oauth: false,
    oauthScope: null,
    enabled: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

let servers: McpServer[] = [];
let statuses: Record<string, unknown> = {};
const refreshed: string[] = [];

mock.module("../lib/api", () => ({
  ...realApi,
  sidecarFetch: async (path: string, init?: RequestInit) => {
    if (path === "/api/mcp/servers") return json(servers);
    const status = path.match(/^\/api\/mcp\/servers\/([^/]+)\/status$/);
    if (status) return json(statuses[status[1]]);
    const refresh = path.match(/^\/api\/mcp\/servers\/([^/]+)\/refresh$/);
    if (refresh && init?.method === "POST") {
      refreshed.push(refresh[1]);
      return json({ connected: true, toolCount: 1 });
    }
    return new Response("unexpected request", { status: 404 });
  },
}));

mock.module("@tauri-apps/api/core", () => ({ invoke: async () => ({ port: 1, token: "t" }) }));

afterAll(() => {
  mock.module("../lib/api", () => realApi);
});

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  refreshed.length = 0;
});

describe("McpConnectionBar", () => {
  it("renders nothing when every enabled server is connected", async () => {
    servers = [server({})];
    statuses = { s1: { connected: true, toolCount: 3, oauth: null } };
    expect(await renderToHtml(<McpConnectionBar />)).toBe("");
  });

  it("asks an unauthorized OAuth server to sign in, and ignores disabled ones", async () => {
    servers = [
      server({ oauth: true }),
      server({ id: "s2", name: "Off", enabled: false, oauth: true }),
    ];
    statuses = {
      s1: {
        connected: false,
        toolCount: 0,
        oauth: { registered: true, authorized: false, scope: null },
      },
      s2: { connected: false, toolCount: 0, oauth: null },
    };
    const text = textOf(await renderToHtml(<McpConnectionBar />));
    expect(text).toContain("Notion needs you to sign in");
    expect(text).toContain("Sign in");
    expect(text).not.toContain("Off");
  });

  it("reconnects a dropped server from the button", async () => {
    servers = [server({ name: "Local" })];
    statuses = { s1: { connected: false, toolCount: 0, oauth: null } };
    const mounted = await mountForInteraction(<McpConnectionBar />);
    cleanup = mounted.unmount;

    expect(mounted.host.textContent).toContain("Local is not connected");
    Array.from(mounted.host.querySelectorAll("button"))
      .find((b) => b.textContent === "Reconnect")
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(refreshed).toEqual(["s1"]);
  });
});
