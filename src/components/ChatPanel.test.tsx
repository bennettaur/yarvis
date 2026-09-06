import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import * as realApi from "../lib/api";
import { mountForInteraction, textOf } from "../test/render";
import ChatPanel from "./ChatPanel";

/**
 * The Chat tab over a stubbed sidecar. What matters here is that the surface
 * still owns its session picker while `useChatThread` owns the turn — the
 * sessions the hook creates have to reach the list, since the hook decides when
 * they happen.
 */

const providers = [
  {
    id: "anthropic",
    label: "Anthropic",
    models: [{ id: "claude-sonnet-5", capabilities: ["chat"] }],
    available: true,
  },
  { id: "gemini", label: "Gemini", models: [], available: false },
];

let sessions: Array<{ id: string; title: string | null; createdAt: string; updatedAt: string }> =
  [];
let created = 0;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

mock.module("../lib/api", () => ({
  ...realApi,
  sidecarFetch: async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/chat/providers")) return json(providers);
    if (path === "/api/chat/sessions" && init?.method === "POST") {
      created += 1;
      const session = {
        id: `new-session-${created}`,
        title: `Fresh chat ${created}`,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      return json(session);
    }
    if (path === "/api/chat/sessions") return json(sessions);
    if (path.endsWith("/messages")) return json([]);
    return realApi.sidecarFetch(path, init);
  },
}));

mock.module("@tauri-apps/api/core", () => ({ invoke: async () => ({ port: 1, token: "t" }) }));

let unmount: (() => void) | null = null;

afterAll(() => {
  mock.module("../lib/api", () => realApi);
});

afterEach(() => {
  unmount?.();
  unmount = null;
  sessions = [];
  created = 0;
  localStorage.clear();
});

describe("ChatPanel", () => {
  it("lists the existing sessions and the available providers", async () => {
    sessions = [
      {
        id: "s1",
        title: "Yesterday",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    const mounted = await mountForInteraction(createElement(ChatPanel));
    unmount = mounted.unmount;
    const text = textOf(mounted.host.innerHTML);
    expect(text).toContain("Yesterday");
    expect(text).toContain("Anthropic");
    expect(text).toContain("Gemini (no key)");
  });

  it("adds a session the thread created to the picker and selects it", async () => {
    const mounted = await mountForInteraction(createElement(ChatPanel));
    unmount = mounted.unmount;

    const newChat = Array.from(mounted.host.querySelectorAll("button")).find(
      (b) => b.textContent === "New chat",
    );
    newChat?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const picker = mounted.host.querySelector("select");
    expect(textOf(mounted.host.innerHTML)).toContain("Fresh chat 1");
    expect(picker?.value).toBe("new-session-1");
  });
});
