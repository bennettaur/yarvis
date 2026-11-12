import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { CHAT_TABS_KEY } from "../lib/chatTabs";
import { CHAT_TAB_SESSION_KEY } from "../lib/useChatThread";
import { resetChatApi, stubChatApi } from "../test/chatApi";
import { mountForInteraction, waitFor } from "../test/render";
import { resetSidecarApi, stubSidecarApi } from "../test/sidecarApi";
import ChatTabs from "./ChatTabs";

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
    if (path === "/api/voice/config") return new Response("none", { status: 404 });
    return new Response("unexpected request", { status: 404 });
  },
});

mock.module("@tauri-apps/api/core", () => ({ invoke: async () => ({ port: 1, token: "t" }) }));

stubChatApi({
  // The sidecar names a chat after its first prompt while the turn runs.
  streamChat: async function* (req: { sessionId: string; message: string }) {
    sessions = sessions.map((s) => (s.id === req.sessionId ? { ...s, title: req.message } : s));
    yield { type: "text", delta: "ok" };
  } as unknown as typeof import("../lib/chat").streamChat,
});

let unmount: (() => void) | null = null;

afterAll(() => {
  resetSidecarApi();
  resetChatApi();
});

afterEach(() => {
  unmount?.();
  unmount = null;
  sessions = [];
  loaded = [];
  localStorage.clear();
});

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

const tabLabels = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('[role="tab"]')).map((t) => t.textContent);
const selectedTab = (host: HTMLElement) =>
  host.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
const historyButton = (host: HTMLElement, title: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("aside button")).find(
    (b) => b.textContent === title,
  );
const buttonLabelled = (host: HTMLElement, label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe("ChatTabs", () => {
  it("opens the chat the Chat tab had open before it had tabs, named by its title", async () => {
    sessions = [session("s1", "Plan my week"), session("s2", "Dentist")];
    localStorage.setItem(CHAT_TAB_SESSION_KEY, "s1");
    const { host } = await mount();

    await waitFor(() => tabLabels(host).includes("Plan my week"), "the tab to take its title");
    expect(tabLabels(host)).toEqual(["Plan my week"]);
    expect(loaded).toContain("s1");
    // Every chat is listed in the history sidebar.
    expect(historyButton(host, "Dentist")).toBeDefined();
  });

  it("opens a chat from the history in a new tab, and focuses it when already open", async () => {
    sessions = [session("s1", "Plan my week"), session("s2", "Dentist")];
    localStorage.setItem(CHAT_TAB_SESSION_KEY, "s1");
    const { host } = await mount();
    await waitFor(() => historyButton(host, "Dentist") !== undefined, "the history to load");

    historyButton(host, "Dentist")!.click();
    await waitFor(() => selectedTab(host) === "Dentist", "the new tab to be selected");
    expect(tabLabels(host)).toEqual(["Plan my week", "Dentist"]);
    await waitFor(() => loaded.includes("s2"), "the chat to load in its tab");

    historyButton(host, "Plan my week")!.click();
    await waitFor(() => selectedTab(host) === "Plan my week", "the open tab to be focused");
    expect(tabLabels(host)).toHaveLength(2);
  });

  it("adds an empty tab and leaves one behind when the last tab closes", async () => {
    const { host } = await mount();
    expect(tabLabels(host)).toEqual(["New chat"]);

    buttonLabelled(host, "New chat")!.click();
    await waitFor(() => tabLabels(host).length === 2, "a second tab");

    buttonLabelled(host, "Close New chat")!.click();
    await waitFor(() => tabLabels(host).length === 1, "the tab to close");
    buttonLabelled(host, "Close New chat")!.click();
    await waitFor(() => tabLabels(host).length === 1, "an empty tab to remain");
    expect(tabLabels(host)).toEqual(["New chat"]);
  });

  it("names a new chat's tab once its first reply finishes", async () => {
    const { host } = await mount();
    const box = host.querySelector<HTMLTextAreaElement>('textarea[placeholder="Message..."]')!;
    await waitFor(
      () => host.querySelector<HTMLSelectElement>("select")?.value === "anthropic",
      "the provider list",
    );
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set as (
      v: string,
    ) => void;
    setter.call(box, "Book a dentist visit");
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => box.value === "Book a dentist visit", "the composer to take the text");
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent === "Send")!
      .click();

    await waitFor(() => selectedTab(host) === "Book a dentist visit", "the tab to take its title");
    await waitFor(
      () => historyButton(host, "Book a dentist visit") !== undefined,
      "the chat in the history",
    );
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
    localStorage.setItem(CHAT_TAB_SESSION_KEY, "s1");
    const first = await mount();
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
