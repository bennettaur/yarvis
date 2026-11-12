import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { CHAT_TABS_KEY, LEGACY_CHAT_SESSION_KEY } from "../lib/chatTabs";
import { resetChatApi, stubChatApi } from "../test/chatApi";
import { mountForInteraction, waitFor } from "../test/render";
import { resetSidecarApi, stubSidecarApi } from "../test/sidecarApi";
import ChatTabs from "./ChatTabs";
import { ARMING_MS } from "./ToolApprovalBar";

/**
 * The Chat tab's tabs over a stubbed sidecar, each tab a real `ChatPanel`.
 * What matters is that every tab keeps its own chat running while hidden, and
 * that a hidden tab can't be acted on from the keyboard.
 */

type Session = { id: string; title: string | null; createdAt: string; updatedAt: string };

const session = (id: string, title: string | null): Session => ({
  id,
  title,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

const providers = [
  {
    id: "anthropic",
    label: "Anthropic",
    models: [{ id: "claude-sonnet-5", capabilities: ["chat"] }],
    available: true,
  },
];

let sessions: Session[] = [];
/** Session ids whose messages were fetched, in order. */
let loaded: string[] = [];
/** Tool call ids answered through the approval route. */
let answered: string[] = [];
/** Events the next turn streams after the sidecar names the chat. */
let scripted: unknown[] = [];
/** Lets a turn scripted with `{ type: "wait" }` go on. */
let release: () => void = () => {};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

stubSidecarApi({
  sidecarFetch: async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/chat/providers")) return json(providers);
    if (path === "/api/chat/sessions" && init?.method === "POST") {
      const created = session(`new-${sessions.length + 1}`, null);
      sessions = [created, ...sessions];
      return json(created);
    }
    if (path === "/api/chat/sessions") return json(sessions);
    const messages = path.match(/^\/api\/chat\/sessions\/([^/]+)\/messages$/);
    if (messages) {
      loaded.push(messages[1]!);
      return json([]);
    }
    const approval = path.match(/^\/api\/chat\/approvals\/([^/]+)$/);
    if (approval) {
      answered.push(decodeURIComponent(approval[1]!));
      return json({ ok: true });
    }
    if (path === "/api/voice/config") return new Response("none", { status: 404 });
    return new Response("unexpected request", { status: 404 });
  },
});

stubChatApi({
  streamChat: async function* (
    req: { sessionId: string; message: string },
    init: { signal?: AbortSignal } = {},
  ) {
    // The sidecar names a chat after its first prompt while the turn runs.
    sessions = sessions.map((s) =>
      s.id === req.sessionId && s.title === null ? { ...s, title: req.message } : s,
    );
    for (const event of scripted) {
      const type = (event as { type?: string }).type;
      if (type === "wait") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        continue;
      }
      if (type === "hang") {
        await new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      yield event;
    }
  } as unknown as typeof import("../lib/chat").streamChat,
});

let unmount: (() => void) | null = null;

afterAll(() => {
  resetSidecarApi();
  resetChatApi();
});

afterEach(() => {
  release();
  unmount?.();
  unmount = null;
  sessions = [];
  loaded = [];
  answered = [];
  scripted = [
    { type: "delta", text: "ok" },
    { type: "done", finishReason: "stop" },
  ];
  localStorage.clear();
});

scripted = [
  { type: "delta", text: "ok" },
  { type: "done", finishReason: "stop" },
];

const noop = () => {};

async function mount(props: Partial<Parameters<typeof ChatTabs>[0]> = {}) {
  const mounted = await mountForInteraction(
    createElement(ChatTabs, {
      active: true,
      requestedSessionId: null,
      onRequestConsumed: noop,
      requestedArtifactId: null,
      onArtifactRequestConsumed: noop,
      ...props,
    }),
  );
  unmount = mounted.unmount;
  return mounted;
}

const tabs = (host: HTMLElement) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
const tabLabels = (host: HTMLElement) => tabs(host).map((t) => t.textContent);
const selectedTab = (host: HTMLElement) =>
  host.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
const historyButton = (host: HTMLElement, title: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("aside button")).find(
    (b) => b.textContent === title,
  );
const buttonLabelled = (host: HTMLElement, label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
/** The panel of the tab on screen; hidden tabs' panels sit in `.hidden` wrappers. */
const visiblePanel = (host: HTMLElement) =>
  host
    .querySelector<HTMLElement>('[role="tablist"]')!
    .parentElement!.nextElementSibling!.querySelector<HTMLElement>(":scope > div:not(.hidden)")!;

const pressA = () =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));

/** Types into the tab on screen and presses Send. */
async function say(host: HTMLElement, text: string) {
  const panel = visiblePanel(host);
  await waitFor(
    () => panel.querySelector<HTMLSelectElement>("select")?.value === "anthropic",
    "the provider list",
  );
  const box = panel.querySelector<HTMLTextAreaElement>('textarea[placeholder="Message..."]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set as (
    v: string,
  ) => void;
  setter.call(box, text);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(() => box.value === text, "the composer to take the text");
  Array.from(panel.querySelectorAll("button"))
    .find((b) => b.textContent === "Send")!
    .click();
}

describe("ChatTabs", () => {
  it("opens the chat the Chat tab had open before it had tabs, named by its title", async () => {
    sessions = [session("s1", "Plan my week"), session("s2", "Dentist")];
    localStorage.setItem(LEGACY_CHAT_SESSION_KEY, "s1");
    const { host } = await mount();

    await waitFor(() => tabLabels(host).includes("Plan my week"), "the tab to take its title");
    await waitFor(() => loaded.includes("s1"), "the chat to load");
    expect(tabLabels(host)).toEqual(["Plan my week"]);
    // Every chat is listed in the history sidebar.
    expect(historyButton(host, "Dentist")).toBeDefined();
  });

  it("opens a chat from the history in a new tab, and focuses it when already open", async () => {
    sessions = [session("s1", "Plan my week"), session("s2", "Dentist")];
    localStorage.setItem(LEGACY_CHAT_SESSION_KEY, "s1");
    const { host } = await mount();
    await waitFor(() => historyButton(host, "Dentist") !== undefined, "the history to load");
    await waitFor(() => loaded.includes("s1"), "the first chat to load");

    historyButton(host, "Dentist")!.click();
    await waitFor(() => selectedTab(host) === "Dentist", "the new tab to be selected");
    expect(tabLabels(host)).toEqual(["Plan my week", "Dentist"]);
    await waitFor(() => loaded.includes("s2"), "the chat to load in its tab");

    historyButton(host, "Plan my week")!.click();
    await waitFor(() => selectedTab(host) === "Plan my week", "the open tab to be focused");
    expect(tabLabels(host)).toHaveLength(2);
    // Focusing a chat that is already open doesn't read it again.
    expect(loaded.filter((id) => id === "s1")).toHaveLength(1);
  });

  it("switches tabs from the tab strip", async () => {
    const { host } = await mount();
    buttonLabelled(host, "New chat")!.click();
    await waitFor(() => tabs(host).length === 2, "a second tab");
    expect(tabs(host)[1]!.getAttribute("aria-selected")).toBe("true");

    tabs(host)[0]!.click();
    await waitFor(() => tabs(host)[0]!.getAttribute("aria-selected") === "true", "the first tab");
  });

  it("leaves an empty tab behind when the last tab closes", async () => {
    sessions = [session("s1", "Plan my week")];
    localStorage.setItem(LEGACY_CHAT_SESSION_KEY, "s1");
    const { host } = await mount();
    await waitFor(() => tabLabels(host).includes("Plan my week"), "the saved tab");

    buttonLabelled(host, "Close Plan my week")!.click();
    await waitFor(() => tabLabels(host)[0] === "New chat", "an empty tab to replace it");
    expect(tabLabels(host)).toEqual(["New chat"]);
  });

  it("names a new chat's tab once its first reply finishes", async () => {
    const { host } = await mount();
    await say(host, "Book a dentist visit");

    await waitFor(() => selectedTab(host) === "Book a dentist visit", "the tab to take its title");
    await waitFor(
      () => historyButton(host, "Book a dentist visit") !== undefined,
      "the chat in the history",
    );
  });

  it("keeps a reply streaming in a tab the user has left", async () => {
    scripted = [
      { type: "delta", text: "before " },
      { type: "wait" },
      { type: "delta", text: "and after" },
      { type: "done", finishReason: "stop" },
    ];
    const { host } = await mount();
    await say(host, "Write a long answer");
    await waitFor(() => host.textContent?.includes("before") ?? false, "the reply to start");

    buttonLabelled(host, "New chat")!.click();
    await waitFor(() => tabs(host).length === 2, "a second tab");
    // The first tab shows that its reply is still running.
    expect(tabs(host)[0]!.querySelector(".animate-pulse")).not.toBeNull();
    release();

    tabs(host)[0]!.click();
    await waitFor(
      () => visiblePanel(host).textContent?.includes("before and after") ?? false,
      "the whole reply in the first tab",
    );
  });

  it("answers an approval only from the tab on screen, and marks the tab that waits", async () => {
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
    const { host } = await mount();
    await say(host, "pull the notion doc");
    await waitFor(() => host.textContent?.includes("search_pages") ?? false, "the approval bar");

    buttonLabelled(host, "New chat")!.click();
    await waitFor(
      () => tabs(host)[0]!.title.includes("needs your approval"),
      "the waiting tab to be marked",
    );
    // Past the bar's arming delay, so a key it ignores is ignored for being
    // off screen, not for being too early.
    await new Promise((resolve) => setTimeout(resolve, ARMING_MS * 2));
    pressA();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toEqual([]);

    tabs(host)[0]!.click();
    await waitFor(() => {
      pressA();
      return answered.includes("call-1");
    }, "the approval to be answered once its tab is on screen");
  });

  it("opens a requested chat and tells the host it did", async () => {
    sessions = [session("s7", "From a link")];
    let consumed = 0;
    const { host } = await mount({
      requestedSessionId: "s7",
      onRequestConsumed: () => {
        consumed += 1;
      },
    });

    await waitFor(() => selectedTab(host) === "From a link", "the requested chat's tab");
    await waitFor(() => loaded.includes("s7"), "the requested chat to load");
    expect(consumed).toBeGreaterThan(0);
  });

  it("remembers open tabs and whether the history is hidden", async () => {
    sessions = [session("s1", "Plan my week")];
    localStorage.setItem(LEGACY_CHAT_SESSION_KEY, "s1");
    const first = await mount();
    await waitFor(() => loaded.includes("s1"), "the chat to load");
    buttonLabelled(first.host, "Hide chat history")!.click();
    await waitFor(() => first.host.querySelector("aside") === null, "the history to hide");
    first.unmount();

    const second = await mount();
    expect(second.host.querySelector("aside")).toBeNull();
    expect(buttonLabelled(second.host, "Show chat history")).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(CHAT_TABS_KEY)!).tabs[0].sessionId).toBe("s1");
    await waitFor(() => tabLabels(second.host).includes("Plan my week"), "the restored tab");
  });
});
