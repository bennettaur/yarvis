import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { AttentionItem } from "../../lib/attention";
import { HEADS_DOWN_CACHE_KEYS, type HeadsDownQuestion } from "../../lib/headsDown";
import { cachedFetch, primeCache } from "../../lib/resourceCache";
import { mountForInteraction, waitFor } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";
import HeadsDownQuestionDialog from "./HeadsDownQuestionDialog";

const OLDER: HeadsDownQuestion = {
  id: "q-older",
  kind: "question",
  streamId: "s1",
  question: "Which PR should go first?",
  situation: null,
  options: ["Billing", "Search"],
  action: null,
  toolArgs: null,
  status: "open",
  choice: null,
  answer: null,
  answeredBy: null,
  createdAt: "2026-10-19T09:00:00.000Z",
  answeredAt: null,
};

const CLICKED: HeadsDownQuestion = {
  ...OLDER,
  id: "q-clicked",
  kind: "approval",
  question: "Heads-down mode wants to run mcp:slack:post_message.",
  options: ["approve", "deny"],
  action: "mcp:slack:post_message",
  toolArgs: { channel: "#reviews" },
  createdAt: "2026-10-19T10:00:00.000Z",
};

const NEWEST: HeadsDownQuestion = {
  ...OLDER,
  id: "q-newest",
  question: "Should the search PR wait for the billing one?",
  options: ["Wait", "Go ahead"],
  createdAt: "2026-10-19T11:00:00.000Z",
};

const ITEM: AttentionItem = {
  id: "a1",
  seq: 1,
  source: "system",
  sessionKey: "heads-down:q-clicked",
  workspaceId: null,
  kind: "permission",
  title: "Heads down needs your approval",
  body: CLICKED.question,
  status: "pending",
  navTarget: { type: "heads-down" },
  createdAt: "2026-10-19T10:00:00.000Z",
  updatedAt: "2026-10-19T10:00:00.000Z",
};

let open: HeadsDownQuestion[] = [];
let failList = false;
// When set, the next list request waits for it before answering.
let nextListGate: Promise<void> | null = null;
let listsRequested = 0;
let listsAnswered = 0;
const writes: { method: string; path: string; body: unknown }[] = [];

stubSidecarApi({
  sidecarFetch: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    // QuestionCard names workspaces mentioned in the text.
    if (method === "GET" && path.startsWith("/api/workspaces")) return json([]);
    if (method === "GET" && path === "/api/heads-down/questions") {
      listsRequested++;
      const gate = nextListGate;
      nextListGate = null;
      if (gate) await gate;
      listsAnswered++;
      return failList ? json({ error: "sidecar down" }, 500) : json(open);
    }
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    writes.push({ method, path, body });
    const answered = path.match(/^\/api\/heads-down\/questions\/([^/]+)\/(answer|dismiss)$/);
    if (answered) {
      open = open.filter((q) => q.id !== answered[1]);
      return json(
        answered[2] === "answer" ? { ...OLDER, status: "answered" } : { dismissed: true },
      );
    }
    return json({ id: "x", allowed: true });
  },
});

let unmount: (() => void) | null = null;
let closed = 0;

afterEach(() => {
  unmount?.();
  unmount = null;
  open = [];
  failList = false;
  nextListGate = null;
  listsRequested = 0;
  listsAnswered = 0;
  writes.length = 0;
  closed = 0;
});

afterAll(() => resetSidecarApi());

async function mount(armingMs = 0): Promise<HTMLElement> {
  const mounted = await mountForInteraction(
    createElement(HeadsDownQuestionDialog, {
      item: ITEM,
      onClose: () => closed++,
      onOpenPage: () => {},
      armingMs,
    }),
  );
  unmount = mounted.unmount;
  return mounted.host;
}

/** Holds the next list request until the returned function is called. */
function holdNextList(): () => void {
  let release = () => {};
  nextListGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => release();
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

describe("HeadsDownQuestionDialog", () => {
  it("shows the clicked question first, with a count of the rest", async () => {
    // Newest first, as the sidecar lists them.
    open = [NEWEST, CLICKED, OLDER];
    const host = await mount();
    expect(host.textContent).toContain(CLICKED.question);
    expect(host.textContent).not.toContain(OLDER.question);
    expect(host.textContent).toContain("3 waiting");
  });

  it("walks through the rest oldest first, then closes", async () => {
    open = [NEWEST, CLICKED, OLDER];
    const host = await mount();

    button(host, "Approve this call").click();
    await waitFor(() => host.textContent?.includes(OLDER.question) ?? false, "the oldest question");
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/api/heads-down/questions/q-clicked/answer",
        body: { choice: "approve" },
      },
    ]);
    expect(closed).toBe(0);

    button(host, "Billing").click();
    await waitFor(
      () => host.textContent?.includes(NEWEST.question) ?? false,
      "the newest question",
    );
    expect(host.textContent).not.toContain("waiting");
    button(host, "Wait").click();
    await waitFor(() => closed === 1, "the dialog to close");
  });

  it("allows the tool for good, then approves the call", async () => {
    open = [CLICKED];
    const host = await mount();
    button(host, "Always allow this tool in heads-down mode").click();
    await waitFor(() => closed === 1, "the dialog to close");
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      "PUT /api/heads-down/allowed-tools/mcp%3Aslack%3Apost_message",
      "POST /api/heads-down/questions/q-clicked/answer",
    ]);
  });

  it("says so when nothing is open, without closing on its own", async () => {
    open = [];
    const host = await mount();
    expect(host.textContent).toContain("isn't waiting on you any more");
    expect(closed).toBe(0);
  });

  it("moves past an answered question when the reload fails", async () => {
    open = [CLICKED, OLDER];
    const host = await mount();
    failList = true;
    button(host, "Approve this call").click();
    await waitFor(() => host.querySelector('[role="alert"]') !== null, "the error");
    expect(host.textContent).not.toContain(CLICKED.question);
    expect(host.textContent).toContain(OLDER.question);
    expect(closed).toBe(0);
  });

  it("ignores clicks on each question until it is armed", async () => {
    open = [CLICKED, OLDER];
    const host = await mount(150);
    const card = () => host.querySelector('[data-testid="heads-down-card"]');
    expect(card()?.hasAttribute("inert")).toBe(true);
    await waitFor(() => card()?.hasAttribute("inert") === false, "the card to arm");

    button(host, "Approve this call").click();
    await waitFor(() => host.textContent?.includes(OLDER.question) ?? false, "the next question");
    expect(card()?.hasAttribute("inert")).toBe(true);
  });

  it("keeps the answered card inert while the list reloads", async () => {
    open = [CLICKED, OLDER];
    const host = await mount();
    const card = () => host.querySelector('[data-testid="heads-down-card"]');
    const release = holdNextList();

    button(host, "Approve this call").click();
    await waitFor(() => card()?.hasAttribute("inert") === true, "the card to go inert");
    expect(host.textContent).toContain(CLICKED.question);

    release();
    await waitFor(() => host.textContent?.includes(OLDER.question) ?? false, "the next question");
    await waitFor(() => card()?.hasAttribute("inert") === false, "the next card to arm");
  });

  it("tells the Heads down page to reload once a question is answered", async () => {
    open = [CLICKED, OLDER];
    primeCache(HEADS_DOWN_CACHE_KEYS.questions, "before the answer");
    const host = await mount();
    button(host, "Approve this call").click();
    await waitFor(() => host.textContent?.includes(OLDER.question) ?? false, "the next question");
    expect(await cachedFetch(HEADS_DOWN_CACHE_KEYS.questions, async () => "reloaded")).toBe(
      "reloaded",
    );
  });

  describe("a load that finishes after the dialog moved to another item", () => {
    const OLDER_ITEM: AttentionItem = { ...ITEM, id: "a2", sessionKey: "heads-down:q-older" };

    async function moveWhileFirstLoadWaits(): Promise<{ host: HTMLElement; release: () => void }> {
      open = [CLICKED, OLDER];
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      unmount = () => {
        root.unmount();
        host.remove();
      };
      const props = { onClose: () => closed++, onOpenPage: () => {}, armingMs: 0 };
      const release = holdNextList();
      root.render(createElement(HeadsDownQuestionDialog, { ...props, item: ITEM }));
      await waitFor(() => listsRequested === 1, "the first load to start");
      root.render(createElement(HeadsDownQuestionDialog, { ...props, item: OLDER_ITEM }));
      await waitFor(() => host.textContent?.includes(OLDER.question) ?? false, "the newer load");
      return { host, release };
    }

    // The stale response has no later event to wait on, so give it a moment to land.
    async function letStaleLoadLand(): Promise<void> {
      await waitFor(() => listsAnswered === 2, "the stale load");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    it("doesn't replace the newer list", async () => {
      const { host, release } = await moveWhileFirstLoadWaits();
      release();
      await letStaleLoadLand();
      expect(host.textContent).toContain(OLDER.question);
      expect(host.textContent).not.toContain(CLICKED.question);
    });

    it("doesn't show its error", async () => {
      const { host, release } = await moveWhileFirstLoadWaits();
      failList = true;
      release();
      await letStaleLoadLand();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.textContent).toContain(OLDER.question);
    });
  });

  it("closes on Escape without reporting done, and on no other key", async () => {
    open = [CLICKED];
    await mount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(closed).toBe(0);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(closed).toBe(1);
  });
});
