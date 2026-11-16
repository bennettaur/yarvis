import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { CHAT_TABS_KEY, LEGACY_CHAT_SESSION_KEY } from "../lib/chatTabs";
import { resetChatApi, stubChatApi } from "../test/chatApi";
import { mountForInteraction, waitFor } from "../test/render";
import { resetSidecarApi, stubSidecarApi } from "../test/sidecarApi";
import ChatTabs from "./ChatTabs";

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
/** While set, creating a session waits on it, as a slow sidecar would. */
let holdCreate: Promise<void> | null = null;
let createRequested = false;
/** How many more times listing the chats fails. */
let listFailures = 0;
/** How many times the chats were listed. */
let listCalls = 0;
/** How many times a panel checked its MCP connections. */
let mcpChecks = 0;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

stubSidecarApi({
  sidecarFetch: async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/chat/providers")) return json(providers);
    if (path === "/api/chat/sessions" && init?.method === "POST") {
      createRequested = true;
      if (holdCreate) await holdCreate;
      const created = session(`new-${sessions.length + 1}`, null);
      sessions = [created, ...sessions];
      return json(created);
    }
    if (path === "/api/chat/sessions") {
      listCalls += 1;
      if (listFailures > 0) {
        listFailures -= 1;
        return new Response("database is down", { status: 500 });
      }
      return json(sessions);
    }
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
    if (path === "/api/mcp/servers") {
      mcpChecks += 1;
      return json([]);
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
  holdCreate = null;
  createRequested = false;
  listFailures = 0;
  listCalls = 0;
  mcpChecks = 0;
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
    sessions = [session("s1", "Plan my week"), session("s2", "Dentist"), session("s3", "Taxes")];
    localStorage.setItem(LEGACY_CHAT_SESSION_KEY, "s1");
    const { host } = await mount();
    await waitFor(() => historyButton(host, "Dentist") !== undefined, "the history to load");
    await waitFor(() => loaded.includes("s1"), "the first chat to load");

    historyButton(host, "Dentist")!.click();
    await waitFor(() => selectedTab(host) === "Dentist", "the new tab to be selected");
    expect(tabLabels(host)).toEqual(["Plan my week", "Dentist"]);
    // The history marks the chat on screen.
    expect(historyButton(host, "Dentist")!.getAttribute("aria-current")).toBe("true");
    expect(historyButton(host, "Plan my week")!.hasAttribute("aria-current")).toBe(false);
    await waitFor(() => loaded.includes("s2"), "the chat to load in its tab");

    historyButton(host, "Plan my week")!.click();
    await waitFor(() => selectedTab(host) === "Plan my week", "the open tab to be focused");
    expect(tabLabels(host)).toHaveLength(2);
    // A later load proves an unwanted re-read of the first chat had its chance to land.
    historyButton(host, "Taxes")!.click();
    await waitFor(() => loaded.includes("s3"), "a third chat to load");
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

  it("names a listed chat that had no title once a reply in it finishes", async () => {
    sessions = [session("s1", null)];
    localStorage.setItem(LEGACY_CHAT_SESSION_KEY, "s1");
    const { host } = await mount();
    await waitFor(() => loaded.includes("s1"), "the chat to load");
    await waitFor(() => tabLabels(host)[0] === "Untitled chat", "the untitled tab");

    await say(host, "Plan my week");
    await waitFor(() => selectedTab(host) === "Plan my week", "the tab to take its title");
  });

  it("doesn't re-read the history after a reply in a chat that has a name", async () => {
    sessions = [session("s1", "Plan my week")];
    localStorage.setItem(LEGACY_CHAT_SESSION_KEY, "s1");
    const props = {
      active: true,
      requestedSessionId: null,
      onRequestConsumed: noop,
      requestedArtifactId: null,
      onArtifactRequestConsumed: noop,
    };
    const { host, rerender } = await mount(props);
    await waitFor(() => loaded.includes("s1"), "the chat to load");
    await waitFor(() => tabLabels(host)[0] === "Plan my week", "the history to load");
    const before = listCalls;

    await say(host, "and next week?");
    await waitFor(
      () => visiblePanel(host).textContent?.includes("ok") ?? false,
      "the reply to arrive",
    );
    await waitFor(
      () => tabs(host)[0]!.querySelector(".animate-pulse") === null,
      "the reply to end",
    );
    // Coming back to the Chat tab re-reads the history once, which also gives
    // an unwanted re-read after the reply time to land.
    // Each render commits on its own, as a real tab switch would.
    flushSync(() => rerender(createElement(ChatTabs, { ...props, active: false })));
    flushSync(() => rerender(createElement(ChatTabs, props)));
    await waitFor(() => listCalls > before, "the history to be re-read");
    expect(listCalls).toBe(before + 1);
  });

  it("lists a chat a tab starts while its first reply is still running", async () => {
    scripted = [{ type: "delta", text: "before " }, { type: "wait" }, { type: "done" }];
    const { host } = await mount();
    await say(host, "Write a long answer");
    await waitFor(
      () => host.querySelectorAll("aside li").length === 1,
      "the new chat in the history",
    );
    expect(tabs(host)[0]!.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("re-reads the history when the Chat tab comes back on screen", async () => {
    const props = {
      active: true,
      requestedSessionId: null,
      onRequestConsumed: noop,
      requestedArtifactId: null,
      onArtifactRequestConsumed: noop,
    };
    const { host, rerender } = await mount(props);
    await waitFor(() => listCalls === 1, "the history to load");

    flushSync(() => rerender(createElement(ChatTabs, { ...props, active: false })));
    sessions = [session("s9", "From Telegram")];
    flushSync(() => rerender(createElement(ChatTabs, props)));
    await waitFor(() => historyButton(host, "From Telegram") !== undefined, "the new chat");
  });

  it("doesn't re-read the history when opening a chat it already lists", async () => {
    sessions = [session("s1", "Plan my week"), session("s2", "Dentist"), session("s3", "Taxes")];
    const { host } = await mount();
    await waitFor(() => historyButton(host, "Dentist") !== undefined, "the history to load");

    historyButton(host, "Dentist")!.click();
    await waitFor(() => loaded.includes("s2"), "the chat to load");
    // A later load gives an unwanted re-read from the first one time to land.
    historyButton(host, "Taxes")!.click();
    await waitFor(() => loaded.includes("s3"), "a second chat to load");
    expect(listCalls).toBe(1);
  });

  it("names the untitled chat whose reply finished, not another tab's", async () => {
    sessions = [session("s1", "Plan my week"), session("s2", null)];
    localStorage.setItem(
      CHAT_TABS_KEY,
      JSON.stringify({
        tabs: [
          { id: "a", sessionId: "s1" },
          { id: "b", sessionId: "s2" },
        ],
        activeId: "b",
      }),
    );
    const { host } = await mount();
    await waitFor(() => loaded.includes("s2"), "the chat to load");
    await waitFor(() => selectedTab(host) === "Untitled chat", "the untitled tab");

    await say(host, "Book a dentist visit");
    await waitFor(() => selectedTab(host) === "Book a dentist visit", "the tab to take its title");
  });

  it("checks MCP connections only from the tab on screen", async () => {
    sessions = [session("s1", "Plan my week"), session("s2", "Dentist")];
    localStorage.setItem(
      CHAT_TABS_KEY,
      JSON.stringify({
        tabs: [
          { id: "a", sessionId: "s1" },
          { id: "b", sessionId: "s2" },
        ],
        activeId: "b",
      }),
    );
    await mount();
    await waitFor(() => loaded.includes("s1") && loaded.includes("s2"), "both chats to load");
    await waitFor(() => mcpChecks > 0, "the on-screen tab's check");
    expect(mcpChecks).toBe(1);
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
    // The second tab waits on its own approval. Its bar arms after the hidden
    // one had, so a hidden bar that still listened would answer first.
    scripted = [
      {
        type: "tool_approval_request",
        id: "call-2",
        toolId: "mcp:server-uuid:create_page",
        name: "create_page",
        server: "Notion",
        args: { title: "notes" },
      },
      { type: "hang" },
    ];
    await say(host, "make a page");
    await waitFor(() => {
      pressA();
      return answered.includes("call-2");
    }, "the on-screen tab's approval to be answered");
    expect(answered).not.toContain("call-1");

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

  it("opens a chat clicked while the empty tab's first message waits for its session", async () => {
    sessions = [session("s1", "Plan my week")];
    let releaseCreate: () => void = () => {};
    holdCreate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const { host } = await mount();
    await waitFor(() => historyButton(host, "Plan my week") !== undefined, "the history to load");
    await say(host, "Book a dentist visit");
    await waitFor(() => createRequested, "the new chat's session to be requested");

    historyButton(host, "Plan my week")!.click();
    await waitFor(() => selectedTab(host) === "Plan my week", "the clicked chat's tab");
    expect(tabs(host)).toHaveLength(2);

    releaseCreate();
    await waitFor(
      () => tabLabels(host).includes("Book a dentist visit"),
      "the first tab to keep the chat it was starting",
    );
  });

  it("re-reads a requested chat that is already open, in its own tab", async () => {
    sessions = [session("s1", "Plan my week")];
    localStorage.setItem(LEGACY_CHAT_SESSION_KEY, "s1");
    const props = {
      active: true,
      requestedSessionId: null as string | null,
      onRequestConsumed: noop,
      requestedArtifactId: null,
      onArtifactRequestConsumed: noop,
    };
    const { host, rerender } = await mount(props);
    await waitFor(() => loaded.includes("s1"), "the chat to load");

    rerender(createElement(ChatTabs, { ...props, requestedSessionId: "s1" }));
    await waitFor(() => loaded.filter((id) => id === "s1").length === 2, "the chat to re-load");
    expect(tabLabels(host)).toEqual(["Plan my week"]);
  });

  it("shows a failed history load, and clears it once a later load works", async () => {
    listFailures = 1;
    const { host } = await mount();
    await waitFor(
      () => host.querySelector('aside [role="alert"]') !== null,
      "the history's error notice",
    );

    await say(host, "Book a dentist visit");
    await waitFor(
      () => historyButton(host, "Book a dentist visit") !== undefined,
      "the history to load",
    );
    expect(host.querySelector('aside [role="alert"]')).toBeNull();
  });

  it("remembers open tabs and whether the history is hidden", async () => {
    sessions = [session("s1", "Plan my week")];
    localStorage.setItem(LEGACY_CHAT_SESSION_KEY, "s1");
    const first = await mount();
    await waitFor(() => loaded.includes("s1"), "the chat to load");
    buttonLabelled(first.host, "New chat")!.click();
    await waitFor(() => tabs(first.host).length === 2, "a second tab");
    buttonLabelled(first.host, "Hide chat history")!.click();
    await waitFor(() => first.host.querySelector("aside") === null, "the history to hide");
    first.unmount();

    const second = await mount();
    expect(second.host.querySelector("aside")).toBeNull();
    expect(buttonLabelled(second.host, "Show chat history")).not.toBeNull();
    const saved = JSON.parse(localStorage.getItem(CHAT_TABS_KEY)!);
    expect(saved.tabs).toHaveLength(2);
    expect(saved.tabs[0].sessionId).toBe("s1");
    await waitFor(() => tabLabels(second.host).includes("Plan my week"), "the restored tab");
  });
});
