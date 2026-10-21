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
const authorized: string[] = [];
let refreshResult: Record<string, unknown> = { connected: true, toolCount: 1 };

mock.module("../lib/api", () => ({
  ...realApi,
  sidecarFetch: async (path: string, init?: RequestInit) => {
    if (path === "/api/mcp/servers") return json(servers);
    const status = path.match(/^\/api\/mcp\/servers\/([^/]+)\/status$/);
    if (status) return json(statuses[status[1]]);
    const refresh = path.match(/^\/api\/mcp\/servers\/([^/]+)\/refresh$/);
    if (refresh && init?.method === "POST") {
      refreshed.push(refresh[1]);
      return json(refreshResult);
    }
    const authorize = path.match(/^\/api\/mcp\/servers\/([^/]+)\/authorize$/);
    if (authorize && init?.method === "POST") {
      authorized.push(authorize[1]);
      return json({ authorizationUrl: "https://example.com/authorize" });
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
  authorized.length = 0;
  refreshResult = { connected: true, toolCount: 1 };
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function click(host: HTMLElement, label: string) {
  Array.from(host.querySelectorAll("button"))
    .find((b) => b.textContent === label)
    ?.click();
}

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
    click(mounted.host, "Reconnect");
    await waitFor(() => refreshed.length > 0);

    expect(refreshed).toEqual(["s1"]);
  });

  it("shows why a reconnect failed and lets the user try again", async () => {
    servers = [server({ name: "Local" })];
    statuses = { s1: { connected: false, toolCount: 0, oauth: null } };
    refreshResult = { connected: false, toolCount: 0, error: "boom" };
    const mounted = await mountForInteraction(<McpConnectionBar />);
    cleanup = mounted.unmount;

    click(mounted.host, "Reconnect");
    await waitFor(() => mounted.host.textContent?.includes("boom") ?? false);

    expect(mounted.host.textContent).toContain("Local is not connected");
    expect(mounted.host.textContent).toContain("boom");
    expect(mounted.host.querySelector("button")?.disabled).toBe(false);
  });

  it("hands a refresh that needs authorization off to sign-in", async () => {
    servers = [server({ oauth: true })];
    statuses = {
      s1: {
        connected: false,
        toolCount: 0,
        oauth: { registered: true, authorized: true, scope: null },
      },
    };
    refreshResult = { connected: false, toolCount: 0, needsAuthorization: true };
    const mounted = await mountForInteraction(<McpConnectionBar />);
    cleanup = mounted.unmount;

    // Authorized but disconnected reads as a reconnect, not a sign-in.
    expect(mounted.host.textContent).toContain("Notion is not connected");
    click(mounted.host, "Reconnect");
    await waitFor(() => authorized.length > 0);

    expect(refreshed).toEqual(["s1"]);
    expect(authorized).toEqual(["s1"]);
  });

  it("rechecks when the window regains focus", async () => {
    servers = [server({})];
    statuses = { s1: { connected: true, toolCount: 3, oauth: null } };
    const mounted = await mountForInteraction(<McpConnectionBar />);
    cleanup = mounted.unmount;
    expect(mounted.host.textContent).toBe("");

    statuses = { s1: { connected: false, toolCount: 0, oauth: null } };
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => (mounted.host.textContent ?? "") !== "");

    expect(mounted.host.textContent).toContain("Notion is not connected");
  });

  it("does not check while hidden", async () => {
    servers = [server({})];
    statuses = { s1: { connected: false, toolCount: 0, oauth: null } };
    expect(await renderToHtml(<McpConnectionBar visible={false} />)).toBe("");
  });
});
