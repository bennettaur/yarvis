import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import * as realApi from "../lib/api";
import * as realChat from "../lib/chat";
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
/** Events the next turn streams back, in order. */
let scripted: unknown[] = [];
/** Bodies of every chat request, so a test can see what was re-sent. */
let sent: Array<Record<string, unknown>> = [];

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
    // Never fall back to `realApi.sidecarFetch`: after `mock.module` that name
    // resolves to this function, and an unhandled path recurses until the stack
    // gives out.
    return new Response("unexpected request", { status: 404 });
  },
}));

mock.module("@tauri-apps/api/core", () => ({ invoke: async () => ({ port: 1, token: "t" }) }));

/**
 * The turn itself is faked at `streamChat` rather than at the socket: several
 * other suites replace `lib/api` process-wide, so which stub answers an SSE
 * request depends on file order. Nothing else stubs `lib/chat`.
 */
mock.module("../lib/chat", () => ({
  ...realChat,
  streamChat: async function* (req: Record<string, unknown>) {
    sent.push(req);
    for (const event of scripted) yield event;
  },
}));

/** Types a message into the composer and presses Send. */
async function say(host: HTMLElement, text: string) {
  const box = host.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set as (
    v: string,
  ) => void;
  setter.call(box, text);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  Array.from(host.querySelectorAll("button"))
    .find((b) => b.textContent === "Send")
    ?.click();
  await new Promise((resolve) => setTimeout(resolve, 80));
}

let unmount: (() => void) | null = null;

afterAll(() => {
  mock.module("../lib/api", () => realApi);
  mock.module("../lib/chat", () => realChat);
});

afterEach(() => {
  unmount?.();
  unmount = null;
  sessions = [];
  created = 0;
  scripted = [];
  sent = [];
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

  it("shows the reply and the tools the turn ran", async () => {
    scripted = [
      { type: "tool_call", id: "c1", name: "search_pages", server: "Notion", args: { q: "x" } },
      { type: "tool_result", id: "c1", status: "ok", result: "{}", durationMs: 12 },
      { type: "delta", text: "found it" },
      { type: "done", finishReason: "stop" },
    ];
    const mounted = await mountForInteraction(createElement(ChatPanel));
    unmount = mounted.unmount;

    await say(mounted.host, "pull the notion doc");
    const text = textOf(mounted.host.innerHTML);
    expect(text).toContain("found it");
    expect(text).toContain("search_pages");
    expect(text).toContain("on Notion");
  });

  // Nothing is persisted for a failed turn, so a partial reply left on screen is
  // a message the next reload cannot reproduce — and Retry would stack a second
  // one under it.
  it("drops the partial reply of a failed turn and offers to retry it", async () => {
    scripted = [
      { type: "delta", text: "half a th" },
      { type: "error", message: "model not found (status 404)", detail: "status=404" },
    ];
    const mounted = await mountForInteraction(createElement(ChatPanel));
    unmount = mounted.unmount;

    await say(mounted.host, "pull the notion doc");
    expect(mounted.host.textContent).toContain("model not found (status 404)");
    expect(mounted.host.textContent).not.toContain("half a th");

    scripted = [
      { type: "delta", text: "second time lucky" },
      { type: "done", finishReason: "stop" },
    ];
    Array.from(mounted.host.querySelectorAll("button"))
      .find((b) => b.textContent === "Retry")
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // The same text, sent again — the sidecar recognises it as the same turn.
    expect(sent.map((body) => body.message)).toEqual([
      "pull the notion doc",
      "pull the notion doc",
    ]);
    expect(mounted.host.textContent).toContain("second time lucky");
  });
});
