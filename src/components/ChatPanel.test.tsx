import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { createElement, useState } from "react";
import type { HealthResponse } from "../lib/api";
import * as realChat from "../lib/chat";
import { MODEL_HINT, PROVIDER_HINT, SESSION_HINT } from "../lib/chatControlHints";
import { OmniChatOverlayProvider } from "../lib/omniChatOverlay";
import { useChatThread } from "../lib/useChatThread";
import { REASONING_HINT } from "../lib/useReasoningPreference";
import { mountForInteraction, textOf } from "../test/render";
import { realSidecarApi, resetSidecarApi, stubSidecarApi } from "../test/sidecarApi";
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
  {
    id: "openai",
    label: "OpenAI",
    models: [
      { id: "gpt-6", capabilities: ["chat"] },
      { id: "gpt-6-mini", capabilities: ["chat"] },
    ],
    available: true,
  },
];

let sessions: Array<{ id: string; title: string | null; createdAt: string; updatedAt: string }> =
  [];
let created = 0;
/** Events the next turn streams back, in order. */
let scripted: unknown[] = [];
/** Bodies of every chat request, so a test can see what was re-sent. */
let sent: Array<Record<string, unknown>> = [];
/** What `/health` answers after a dropped stream, and how long it takes. */
let health: HealthResponse | Error = { status: "ok", service: "s", uptimeMs: 3_600_000 };
let healthDelayMs = 0;

const ARTIFACT_ID = "6f1c2b3a-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const artifact = {
  id: ARTIFACT_ID,
  title: "Launch plan",
  format: "markdown",
  content: "Ship it on Thursday.",
  createdBy: "chat",
  untrusted: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

stubSidecarApi({
  getHealth: async () => {
    await new Promise((resolve) => setTimeout(resolve, healthDelayMs));
    if (health instanceof Error) throw health;
    return health;
  },
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
      sessions = [session, ...sessions];
      return json(session);
    }
    if (path === "/api/chat/sessions") return json(sessions);
    if (path.endsWith("/messages")) return json([]);
    if (path === `/api/artifacts/${ARTIFACT_ID}`) return json(artifact);
    // An unknown path fails loudly rather than reaching the real client.
    return new Response("unexpected request", { status: 404 });
  },
  // An open artifact's stream stays quiet until the pane closes.
  streamSSE: async function* (path: string, init: RequestInit = {}) {
    if (!path.startsWith("/api/artifacts/")) {
      yield* realSidecarApi.streamSSE(path, init);
      return;
    }
    yield JSON.stringify({ type: "ping" });
    await new Promise<void>((resolve) =>
      init.signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
  },
});

mock.module("@tauri-apps/api/core", () => ({ invoke: async () => ({ port: 1, token: "t" }) }));

/**
 * The turn itself is faked at `streamChat` rather than at the socket, so the
 * test scripts chat events instead of SSE frames. `OmniChat.test.tsx` stubs it
 * the same way; each file sets its stub as it loads, so neither runs on the other's.
 */
mock.module("../lib/chat", () => ({
  ...realChat,
  streamChat: async function* (req: Record<string, unknown>, init: { signal?: AbortSignal } = {}) {
    sent.push(req);
    for (const event of scripted) {
      // A turn that never finishes on its own, so a test can stop it. The real
      // stream rejects on abort; this one has to as well.
      // A pause mid-turn, long enough for a test to act while it streams.
      if ((event as { type?: string }).type === "wait") {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      // The connection failing underneath the turn, as WebKit reports it.
      if ((event as { type?: string }).type === "drop") {
        throw new TypeError((event as { message?: string }).message ?? "Load failed");
      }
      if ((event as { type?: string }).type === "hang") {
        await new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      yield event;
    }
  },
}));

/**
 * The turn machine on its own, for what the Chat tab has no affordance to
 * drive — a spoken turn. `lib/chat` is already stubbed for this file. The hook
 * has no test file of its own: a file that loads it without stubbing `lib/chat`
 * gets whichever stub an earlier file left behind.
 */
let thread: ReturnType<typeof useChatThread> | null = null;
/** What the harness reports as on screen, as Omni Chat would. */
let screen: string | undefined;
function ThreadHarness() {
  thread = useChatThread({ getContext: () => screen });
  return null;
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

/** A host that can take the panel off screen and back, as the tab switch does. */
let setHostActive: (active: boolean) => void = () => {};
function TogglingHost({
  initiallyActive = true,
  focusOnShow = false,
}: {
  initiallyActive?: boolean;
  focusOnShow?: boolean;
}) {
  const [active, setActive] = useState(initiallyActive);
  setHostActive = setActive;
  return createElement(ChatPanel, { active, focusOnShow });
}

const composerOf = (host: HTMLElement) =>
  host.querySelector<HTMLTextAreaElement>('textarea[placeholder="Message..."]');

/** Types a message into the composer and presses the named button (Send by default). */
async function say(host: HTMLElement, text: string, button = "Send") {
  const box = host.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set as (
    v: string,
  ) => void;
  setter.call(box, text);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  Array.from(host.querySelectorAll("button"))
    .find((b) => b.textContent === button)
    ?.click();
  await new Promise((resolve) => setTimeout(resolve, 80));
}

let unmount: (() => void) | null = null;

afterAll(() => {
  resetSidecarApi();
  mock.module("../lib/chat", () => realChat);
});

afterEach(() => {
  unmount?.();
  unmount = null;
  thread = null;
  screen = undefined;
  sessions = [];
  created = 0;
  scripted = [];
  sent = [];
  health = { status: "ok", service: "s", uptimeMs: 3_600_000 };
  healthDelayMs = 0;
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

  it("explains the Thinking checkbox in a tooltip", async () => {
    const mounted = await mountForInteraction(createElement(ChatPanel));
    unmount = mounted.unmount;
    await settle();
    const label = Array.from(mounted.host.querySelectorAll("label")).find(
      (l) => l.textContent?.trim() === "Thinking",
    );
    expect(label).toBeTruthy();
    expect(label?.getAttribute("title")).toBe(REASONING_HINT);
  });

  it("labels the session, provider and model pickers", async () => {
    const mounted = await mountForInteraction(createElement(ChatPanel));
    unmount = mounted.unmount;
    await settle();
    const titles = Array.from(mounted.host.querySelectorAll("select")).map((s) =>
      s.getAttribute("title"),
    );
    expect(titles).toEqual([SESSION_HINT, PROVIDER_HINT, MODEL_HINT]);
  });

  it("switches to the new provider's first model when the provider changes", async () => {
    const mounted = await mountForInteraction(createElement(ChatPanel));
    unmount = mounted.unmount;
    await settle();
    const picker = (title: string) =>
      Array.from(mounted.host.querySelectorAll("select")).find((s) => s.title === title);
    expect(picker(MODEL_HINT)?.value).toBe("claude-sonnet-5");

    const provider = picker(PROVIDER_HINT);
    if (!provider) throw new Error("no provider picker");
    provider.value = "openai";
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    // Checked on the request: a select whose value matches no option shows its
    // first one anyway, so the picker would read "gpt-6" even with a stale model.
    scripted = [{ type: "done", finishReason: "stop" }];
    await say(mounted.host, "hello");
    expect(sent[sent.length - 1]).toMatchObject({ provider: "openai", model: "gpt-6" });
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

  it("opens an artifact the reply links to beside the conversation", async () => {
    scripted = [
      { type: "delta", text: `Wrote it up: [Launch plan](yarvis://artifact/${ARTIFACT_ID}).` },
      { type: "done", finishReason: "stop" },
    ];
    const mounted = await mountForInteraction(createElement(ChatPanel));
    unmount = mounted.unmount;
    await say(mounted.host, "write a launch plan");
    expect(mounted.host.querySelector('[aria-label="Artifact: Launch plan"]')).toBeNull();

    const link = Array.from(mounted.host.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === `yarvis://artifact/${ARTIFACT_ID}`,
    );
    link?.click();
    await settle();
    const pane = mounted.host.querySelector('[aria-label="Artifact: Launch plan"]');
    expect(pane?.textContent).toContain("Ship it on Thursday.");
    // The conversation stays beside it.
    expect(textOf(mounted.host.innerHTML)).toContain("Wrote it up");

    pane?.querySelector<HTMLButtonElement>('[aria-label="Close artifact"]')?.click();
    await settle();
    expect(mounted.host.querySelector('[aria-label="Artifact: Launch plan"]')).toBeNull();
  });

  it("opens an artifact the host asks for, and says once that it has", async () => {
    const consumed = mock(() => {});
    const mounted = await mountForInteraction(
      createElement(ChatPanel, {
        requestedArtifactId: ARTIFACT_ID,
        onArtifactRequestConsumed: consumed,
      }),
    );
    unmount = mounted.unmount;
    await settle();
    expect(mounted.host.querySelector('[aria-label="Artifact: Launch plan"]')).not.toBeNull();
    expect(consumed).toHaveBeenCalledTimes(1);
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

  // The sidecar collapses two identical consecutive sends into one turn, so a
  // message the user retypes after a failure must not leave a second bubble the
  // transcript never gained.
  it("shows one question when the same message is sent twice in a row", async () => {
    scripted = [{ type: "error", message: "model not found (status 404)" }];
    const mounted = await mountForInteraction(createElement(ChatPanel));
    unmount = mounted.unmount;

    await say(mounted.host, "pull the notion doc");
    scripted = [
      { type: "delta", text: "second time lucky" },
      { type: "done", finishReason: "stop" },
    ];
    await say(mounted.host, "pull the notion doc");

    const asked = mounted.host.textContent?.split("pull the notion doc").length ?? 0;
    expect(asked - 1).toBe(1);
    expect(mounted.host.textContent).toContain("second time lucky");
  });

  it("queues a message typed during a reply and sends it once the reply lands", async () => {
    scripted = [{ type: "wait" }, { type: "delta", text: "a reply" }, { type: "done" }];
    const mounted = await mountForInteraction(createElement(ChatPanel));
    unmount = mounted.unmount;

    await say(mounted.host, "first question");
    expect(composerOf(mounted.host)?.disabled).toBe(false);
    // Otherwise the next message is typed onto the end of the one already sent.
    expect(composerOf(mounted.host)?.value).toBe("");
    await say(mounted.host, "follow-up", "Queue");
    expect(sent.map((body) => body.message)).toEqual(["first question"]);
    expect(mounted.host.querySelector('[aria-label="Queued messages"]')?.textContent).toContain(
      "follow-up",
    );

    await settle(300);
    expect(sent.map((body) => body.message)).toEqual(["first question", "follow-up"]);
    await settle(300);
    expect(mounted.host.querySelector('[aria-label="Queued messages"]')).toBeNull();
  });

  it("drops the queued message the user removes", async () => {
    scripted = [{ type: "hang" }];
    const mounted = await mountForInteraction(createElement(ChatPanel));
    unmount = mounted.unmount;

    await say(mounted.host, "first question");
    await say(mounted.host, "keep me", "Queue");
    await say(mounted.host, "drop me", "Queue");
    mounted.host
      .querySelectorAll<HTMLButtonElement>('[aria-label="Remove queued message"]')[1]
      ?.click();
    await settle(20);

    const queue = mounted.host.querySelector('[aria-label="Queued messages"]')?.textContent;
    expect(queue).toContain("keep me");
    expect(queue).not.toContain("drop me");
  });

  it("holds the queue after a failed reply and sends it on Send next", async () => {
    scripted = [{ type: "wait" }, { type: "error", message: "model not found (status 404)" }];
    const mounted = await mountForInteraction(createElement(ChatPanel));
    unmount = mounted.unmount;

    await say(mounted.host, "first question");
    await say(mounted.host, "follow-up", "Queue");
    await settle(300);
    expect(sent).toHaveLength(1);
    expect(mounted.host.textContent).toContain("waiting until you send them");

    // Sending now would jump the queue and, once it landed, release it.
    await say(mounted.host, "another thought");
    expect(sent).toHaveLength(1);
    expect(mounted.host.querySelector('[aria-label="Queued messages"]')?.textContent).toContain(
      "another thought",
    );

    scripted = [{ type: "delta", text: "a reply" }, { type: "done" }];
    Array.from(mounted.host.querySelectorAll("button"))
      .find((b) => b.textContent === "Send next")
      ?.click();
    await settle(300);
    expect(sent.map((body) => body.message)).toEqual([
      "first question",
      "follow-up",
      "another thought",
    ]);
  });

  it("sends what is left in the queue in order, one turn at a time", async () => {
    scripted = [{ type: "wait" }, { type: "delta", text: "a reply" }, { type: "done" }];
    const mounted = await mountForInteraction(createElement(ThreadHarness));
    unmount = mounted.unmount;
    await settle(50);

    void thread?.send("first question");
    await settle(20);
    thread?.enqueue("one");
    thread?.enqueue("two");
    thread?.enqueue("three");
    await settle(20);
    thread?.removeQueued(1);
    await settle(100);
    expect(sent).toHaveLength(1);

    await settle(900);
    expect(sent.map((body) => body.message)).toEqual(["first question", "one", "three"]);
  });

  // The overlay can be hidden and the user can move on while a reply runs; the
  // queued message is about what they were looking at when they wrote it.
  it("sends a queued message with the screen context from when it was queued", async () => {
    scripted = [{ type: "wait" }, { type: "delta", text: "a reply" }, { type: "done" }];
    const mounted = await mountForInteraction(createElement(ThreadHarness));
    unmount = mounted.unmount;
    await settle(50);

    screen = "PR #18";
    void thread?.send("what's risky here?");
    await settle();
    thread?.enqueue("merge it if it's fine");
    screen = "PR #19";
    await settle(500);

    expect(sent.map((body) => body.context)).toEqual(["PR #18", "PR #18"]);
  });

  // The Omni Chat overlay covers this panel and carries an approval bar of its
  // own. Two live keydown listeners and one "A" is how a call the user cannot
  // see gets approved.
  it("stops answering the keyboard while the Omni Chat overlay covers it", async () => {
    scripted = [
      {
        type: "tool_approval_request",
        id: "call-1",
        toolId: "mcp:server-uuid:search_pages",
        name: "search_pages",
        server: "Notion",
        args: { query: "roadmap" },
      },
      { type: "hang" },
    ];
    const mounted = await mountForInteraction(
      createElement(OmniChatOverlayProvider, { value: true }, createElement(ChatPanel)),
    );
    unmount = mounted.unmount;

    await say(mounted.host, "pull the notion doc");
    await settle(500);
    expect(mounted.host.textContent).toContain("search_pages");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await settle();
    expect(mounted.host.textContent).toContain("search_pages");
  });

  // The Chat tab stays mounted behind other tabs so its turn keeps running;
  // while there it must not answer for a call the user cannot see.
  it("stops answering the keyboard while the host keeps it off screen", async () => {
    scripted = [
      {
        type: "tool_approval_request",
        id: "call-1",
        toolId: "mcp:server-uuid:search_pages",
        name: "search_pages",
        server: "Notion",
        args: { query: "roadmap" },
      },
      { type: "hang" },
    ];
    const mounted = await mountForInteraction(createElement(TogglingHost));
    unmount = mounted.unmount;

    await say(mounted.host, "pull the notion doc");
    await settle(500);
    expect(mounted.host.textContent).toContain("search_pages");
    setHostActive(false);
    await settle();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await settle();
    expect(mounted.host.textContent).toContain("search_pages");
  });

  it("keeps the turn running while the host keeps it off screen", async () => {
    scripted = [
      { type: "delta", text: "before " },
      { type: "wait" },
      { type: "delta", text: "and after" },
      { type: "done", finishReason: "stop" },
    ];
    const mounted = await mountForInteraction(createElement(TogglingHost));
    unmount = mounted.unmount;

    await say(mounted.host, "pull the notion doc");
    setHostActive(false);
    await settle(300);
    setHostActive(true);
    await settle();

    expect(mounted.host.textContent).toContain("before and after");
  });

  it("picks up sessions created elsewhere when it comes back into view", async () => {
    const mounted = await mountForInteraction(createElement(TogglingHost));
    unmount = mounted.unmount;

    setHostActive(false);
    await settle(20);
    sessions = [
      {
        id: "s2",
        title: "From Omni Chat",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    setHostActive(true);
    await settle();

    expect(textOf(mounted.host.innerHTML)).toContain("From Omni Chat");
  });

  it("reopens the session it last had open", async () => {
    sessions = [
      {
        id: "s1",
        title: "Yesterday",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    localStorage.setItem("test.chat.sessionId", "s1");
    const mounted = await mountForInteraction(
      createElement(ChatPanel, { sessionStorageKey: "test.chat.sessionId" }),
    );
    unmount = mounted.unmount;
    await settle();

    expect(mounted.host.querySelector("select")?.value).toBe("s1");
  });

  it("remembers the session a thread opens for the next mount", async () => {
    const first = await mountForInteraction(
      createElement(ChatPanel, { sessionStorageKey: "test.chat.sessionId" }),
    );
    unmount = first.unmount;
    Array.from(first.host.querySelectorAll("button"))
      .find((b) => b.textContent === "New chat")
      ?.click();
    await settle(50);
    first.unmount();

    const second = await mountForInteraction(
      createElement(ChatPanel, { sessionStorageKey: "test.chat.sessionId" }),
    );
    unmount = second.unmount;
    await settle();

    expect(second.host.querySelector("select")?.value).toBe("new-session-1");
  });

  it("focuses the composer after New chat", async () => {
    const mounted = await mountForInteraction(createElement(ChatPanel));
    unmount = mounted.unmount;
    const newChat = Array.from(mounted.host.querySelectorAll("button")).find(
      (b) => b.textContent === "New chat",
    );
    newChat?.focus();
    newChat?.click();
    await settle(50);

    expect(document.activeElement).toBe(composerOf(mounted.host));
  });

  it("focuses the composer when it comes into view", async () => {
    const mounted = await mountForInteraction(
      createElement(TogglingHost, { initiallyActive: false, focusOnShow: true }),
    );
    unmount = mounted.unmount;
    expect(document.activeElement).not.toBe(composerOf(mounted.host));

    setHostActive(true);
    await settle();
    expect(document.activeElement).toBe(composerOf(mounted.host));
  });

  // An Omni widget sits beside the layout builder's own composer.
  it("leaves focus alone without focusOnShow", async () => {
    const mounted = await mountForInteraction(createElement(ChatPanel));
    unmount = mounted.unmount;

    expect(document.activeElement).not.toBe(composerOf(mounted.host));
  });

  it("leaves focus alone under the Omni Chat overlay", async () => {
    const mounted = await mountForInteraction(
      createElement(
        OmniChatOverlayProvider,
        { value: true },
        createElement(ChatPanel, { focusOnShow: true }),
      ),
    );
    unmount = mounted.unmount;

    expect(document.activeElement).not.toBe(composerOf(mounted.host));
  });
});

describe("useChatThread", () => {
  // `source: "voice"` is what puts the irreversible built-ins behind a
  // confirmation. A retry that dropped it would run them unconfirmed.
  it("retries a spoken turn as a spoken turn", async () => {
    scripted = [{ type: "error", message: "model not found (status 404)" }];
    const mounted = await mountForInteraction(createElement(ThreadHarness));
    unmount = mounted.unmount;
    await settle(50);

    await thread?.send("delete the workspace", { source: "voice" });
    await settle();
    thread?.retry();
    await settle();

    expect(sent).toHaveLength(2);
    expect(sent[1]?.source).toBe("voice");
    expect(sent[1]?.message).toBe("delete the workspace");
  });

  it("reports a stopped turn as the user's own doing, not a failure", async () => {
    scripted = [{ type: "delta", text: "half a th" }, { type: "hang" }];
    const mounted = await mountForInteraction(createElement(ThreadHarness));
    unmount = mounted.unmount;
    await settle(50);

    void thread?.send("pull the notion doc");
    await settle();
    thread?.stop();
    await settle();

    expect(thread?.error?.tone).toBe("notice");
    expect(thread?.error?.message).toContain("Turn stopped");
    // Nothing was persisted for it, so the partial reply goes with it.
    expect(thread?.messages.some((m) => m.content.includes("half a th"))).toBe(false);
  });

  // A follow-up written for a reply that never came may no longer make sense,
  // so it waits for the user rather than going out on its own.
  it("holds the queue after a stopped turn until the user sends it", async () => {
    scripted = [{ type: "hang" }];
    const mounted = await mountForInteraction(createElement(ThreadHarness));
    unmount = mounted.unmount;
    await settle(50);

    void thread?.send("first question");
    await settle();
    thread?.enqueue("follow-up");
    thread?.stop();
    await settle();
    expect(sent).toHaveLength(1);
    expect(thread?.queued.map((q) => q.text)).toEqual(["follow-up"]);

    scripted = [{ type: "delta", text: "a reply" }, { type: "done" }];
    thread?.sendNextQueued();
    await settle();
    expect(sent.map((body) => body.message)).toEqual(["first question", "follow-up"]);
    expect(thread?.queued).toEqual([]);
  });

  it("queues trimmed text and refuses a blank message", async () => {
    scripted = [{ type: "hang" }];
    const mounted = await mountForInteraction(createElement(ThreadHarness));
    unmount = mounted.unmount;
    await settle(50);

    void thread?.send("first question");
    await settle();
    expect(thread?.enqueue("   ")).toBe(false);
    expect(thread?.enqueue("  follow-up \n")).toBe(true);
    await settle(20);
    expect(thread?.queued.map((q) => q.text)).toEqual(["follow-up"]);
  });

  it("drops the queue when the user starts a new chat", async () => {
    scripted = [{ type: "hang" }];
    const mounted = await mountForInteraction(createElement(ThreadHarness));
    unmount = mounted.unmount;
    await settle(50);

    void thread?.send("first question");
    await settle();
    thread?.enqueue("follow-up");
    await thread?.newChat();
    await settle();
    expect(thread?.queued).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("explains a dropped stream by the last real event, not a heartbeat", async () => {
    scripted = [
      { type: "tool_call", id: "t1", name: "search_jira" },
      { type: "ping" },
      { type: "drop" },
    ];
    const mounted = await mountForInteraction(createElement(ThreadHarness));
    unmount = mounted.unmount;
    await settle(50);

    await thread?.send("grab my tickets");
    await settle();

    expect(thread?.error?.message).toContain("dropped mid-turn");
    expect(thread?.error?.detail).toContain("Last event received: tool_call");
  });

  it("says the sidecar restarted when it came back up during the turn", async () => {
    scripted = [{ type: "wait" }, { type: "drop" }];
    health = { status: "ok", service: "s", uptimeMs: 0 };
    const mounted = await mountForInteraction(createElement(ThreadHarness));
    unmount = mounted.unmount;
    await settle(50);

    await thread?.send("what's on today");
    await settle();

    expect(thread?.error?.message).toContain("restarted during this turn");
  });

  it("leaves a newer turn's outcome alone when a late explanation arrives", async () => {
    scripted = [{ type: "drop" }];
    healthDelayMs = 300;
    const mounted = await mountForInteraction(createElement(ThreadHarness));
    unmount = mounted.unmount;
    await settle(50);

    await thread?.send("first try");
    scripted = [{ type: "error", message: "model not found (status 404)" }];
    await thread?.send("second try");
    await settle(400);

    expect(thread?.error?.message).toBe("model not found (status 404)");
  });

  it("formats other TypeErrors as usual", async () => {
    scripted = [{ type: "drop", message: "undefined is not an object" }];
    const mounted = await mountForInteraction(createElement(ThreadHarness));
    unmount = mounted.unmount;
    await settle(50);

    await thread?.send("hello");
    await settle();

    expect(thread?.error?.message).toBe("undefined is not an object");
  });
});
