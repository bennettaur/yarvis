import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { AttentionItem } from "../../lib/attention";
import type { HeadsDownQuestion } from "../../lib/headsDown";
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

  it("closes on Escape without reporting done", async () => {
    open = [CLICKED];
    await mount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(closed).toBe(1);
  });
});
