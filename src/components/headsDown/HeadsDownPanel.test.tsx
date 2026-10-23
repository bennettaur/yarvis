import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { clearResourceCache } from "../../lib/resourceCache";
import { mountForInteraction, renderToHtml, textOf } from "../../test/render";
import type { LivePass } from "./useLivePass";

const RUN = {
  id: "run-1",
  focus: "Ship the billing PR",
  status: "active",
  startedAt: "2026-10-19T09:00:00.000Z",
  stoppedAt: null,
};

const QUESTION = {
  id: "q1",
  kind: "question",
  streamId: "s1",
  question: "Where should I ask for review?",
  situation: "The billing PR is ready",
  options: ["#billing-reviews", "Ask Sam"],
  action: null,
  toolArgs: null,
  status: "open",
  choice: null,
  answer: null,
  createdAt: "2026-10-19T10:00:00.000Z",
  answeredAt: null,
};

const APPROVAL = {
  ...QUESTION,
  id: "q2",
  kind: "approval",
  question: "Heads-down mode wants to run mcp:slack:post_message.",
  options: ["approve", "deny"],
  action: "mcp:slack:post_message",
  toolArgs: { channel: "#billing-reviews", text: "Could someone review this?" },
};

const STREAM = {
  id: "s1",
  title: "Ship the billing PR",
  summary: null,
  status: "waiting-on-user",
  priority: "high",
  nextAction: "Ask for review",
  waitingOn: "Where should I ask for review?",
  wakeAt: null,
  updatedAt: "2026-10-19T10:00:00.000Z",
  links: [
    {
      id: "l1",
      kind: "pr",
      ref: { kind: "pr", provider: "github", url: "https://github.com/acme/api/pull/12" },
      title: "Add invoices",
      state: "CI passing",
      observedAt: "2026-10-19T10:00:00.000Z",
    },
  ],
};

const PASS = {
  id: "p1",
  runId: "run-1",
  chatSessionId: "c1",
  startedAt: "2026-10-19T10:00:00.000Z",
  finishedAt: "2026-10-19T10:02:00.000Z",
  notes: "Asked where to request review.",
  sleepMinutes: 60,
  sleepReason: "every stream is waiting",
  error: null,
};

const CONFIG = {
  minSleepMinutes: 5,
  maxSleepMinutes: 120,
  idleSleepMinutes: 60,
  workingHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
  userAwayAfterMinutes: 120,
  provider: null,
  model: null,
};

const PROVIDERS = [
  {
    id: "anthropic",
    label: "Anthropic",
    available: true,
    models: [
      { id: "claude-opus-5-5", capabilities: ["chat"] },
      { id: "claude-haiku-5-5", capabilities: ["chat"] },
    ],
  },
];

/** Writes the page made, in order, with their bodies. */
const writes: { method: string; path: string; body: unknown }[] = [];

/** What the live stream sends when the page connects; empty means no stream. */
let streamFrames: unknown[] = [];

/** Yields the frames, then holds the stream open until the page aborts it. */
async function* frameStream(signal?: AbortSignal | null): AsyncGenerator<string> {
  for (const frame of streamFrames) yield JSON.stringify(frame);
  await new Promise<void>((resolve) => {
    if (!signal || signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

// Only the transport is stubbed; see ScheduledJobsPanel.test.tsx for why the
// rest of the module is kept.
const actualApi = await import("../../lib/api");
mock.module("../../lib/api", () => ({
  ...actualApi,
  sidecarInfo: async () => ({ port: 0, token: "test-token" }),
  // Stubbed directly: another file's mock of this module may be the one the
  // real streamSSE ends up calling, depending on test order.
  streamSSE: (path: string, init?: RequestInit) => {
    if (path === "/api/heads-down/stream" && streamFrames.length > 0) {
      return frameStream(init?.signal);
    }
    // No live updates: the stream ends at once, like the other files' stubs.
    return (async function* () {})();
  },
  sidecarFetch: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method !== "GET") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      writes.push({ method, path, body });
      if (path === "/api/heads-down/config") return json(body);
      if (path.startsWith("/api/heads-down/allowed-tools/")) return json({ ok: true });
      return json({ ...QUESTION, status: "answered" });
    }
    if (path === "/api/heads-down") {
      return json({
        run: RUN,
        lastPass: PASS,
        nextPassAt: "2026-10-19T11:02:00.000Z",
        openQuestionCount: 2,
      });
    }
    if (path === "/api/heads-down/questions") return json([QUESTION, APPROVAL]);
    if (path === "/api/work-streams") return json([STREAM]);
    if (path === "/api/heads-down/passes") return json([PASS]);
    if (path === "/api/heads-down/messages") return json([]);
    if (path === "/api/heads-down/config") return json(CONFIG);
    if (path.startsWith("/api/chat/providers")) return json(PROVIDERS);
    if (path === "/api/heads-down/auto-approvals") {
      return json([
        {
          ...APPROVAL,
          id: "q3",
          status: "answered",
          choice: "approve",
          answer: "Posts the review request the user asked for",
          answeredBy: "decision-model",
          answeredAt: "2026-10-19T10:05:00.000Z",
        },
      ]);
    }
    if (path === "/api/heads-down/allowed-tools") {
      return json([{ id: "mcp:slack:read_channel", name: "read_channel" }]);
    }
    // The live stream, and anything a later file asks for: fail rather than
    // hand a caller the wrong shape. The page reconnects later, which the test
    // ends before.
    return json({ error: `unexpected path: ${path}` }, 404);
  },
}));

const HeadsDownPanel = (await import("./HeadsDownPanel")).default;
const { applyPassEvent } = await import("./useLivePass");
const { linkLabel } = await import("./StreamList");

/** Mounted pages, unmounted after each test even when it fails part-way. */
const mounted: (() => void)[] = [];

async function mount() {
  const view = await mountForInteraction(createElement(HeadsDownPanel));
  mounted.push(view.unmount);
  return view.host;
}

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  clearResourceCache();
  writes.length = 0;
  streamFrames = [];
});

const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the page to show `text`, since the stream arrives on its own schedule. */
async function waitForText(host: HTMLElement, text: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!host.textContent?.includes(text) && Date.now() < deadline) await settle(20);
}

function buttonNamed(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!button) throw new Error(`no button "${label}"`);
  return button;
}

describe("HeadsDownPanel", () => {
  it("shows the run, what it needs, the streams and what it has done", async () => {
    const text = textOf(await renderToHtml(createElement(HeadsDownPanel)));

    expect(text).toContain("Heads down since");
    expect(text).toContain("Ship the billing PR");
    expect(text).toContain("Needs you (2)");
    expect(text).toContain("Where should I ask for review?");
    expect(text).toContain("Waiting on you");
    expect(text).toContain("pr: Add invoices · CI passing");
    expect(text).toContain("Asked where to request review.");
    expect(text).toContain("Approved on its own");
    expect(text).toContain("Posts the review request the user asked for");
  });

  it("sends the option the user picked", async () => {
    const host = await mount();
    buttonNamed(host, "#billing-reviews").click();
    await settle(50);

    expect(writes).toContainEqual({
      method: "POST",
      path: "/api/heads-down/questions/q1/answer",
      body: { choice: "#billing-reviews" },
    });
  });

  it("can allow an MCP tool for heads-down mode from its approval, and approves the call", async () => {
    const host = await mount();
    expect(host.textContent).toContain('"channel": "#billing-reviews"');
    buttonNamed(host, "Always allow this tool in heads-down mode").click();
    await settle();

    expect(writes).toEqual([
      {
        method: "PUT",
        path: "/api/heads-down/allowed-tools/mcp%3Aslack%3Apost_message",
        body: { allowed: true },
      },
      { method: "POST", path: "/api/heads-down/questions/q2/answer", body: { choice: "approve" } },
    ]);
  });
});

describe("HeadsDownPanel live", () => {
  it("shows the pass in flight as it works", async () => {
    streamFrames = [
      { type: "pass-started", passId: "p2" },
      {
        type: "pass-event",
        passId: "p2",
        event: { type: "tool_call", id: "c1", name: "list_work_streams" },
      },
    ];
    const host = await mount();
    await waitForText(host, "list_work_streams");

    expect(host.textContent).toContain("Working now");
    expect(host.textContent).toContain("list_work_streams");
  });
});

describe("HeadsDownSettings", () => {
  it("lists the MCP tools it may use without asking, and removes one", async () => {
    const host = await mount();
    buttonNamed(host, "Show settings").click();
    await settle(50);
    expect(host.textContent).toContain("read_channel");

    buttonNamed(host, "Remove").click();
    await settle();
    expect(writes).toContainEqual({
      method: "PUT",
      path: "/api/heads-down/allowed-tools/mcp%3Aslack%3Aread_channel",
      body: { allowed: false },
    });
  });

  it("saves the model passes run on", async () => {
    const host = await mount();
    buttonNamed(host, "Show settings").click();
    await settle(50);

    const provider = host.querySelector<HTMLSelectElement>('[aria-label="Heads-down provider"]');
    const model = host.querySelector<HTMLSelectElement>('[aria-label="Heads-down model"]');
    if (!provider || !model) throw new Error("no model picker");
    expect(provider.value).toBe("");
    expect(model.disabled).toBe(true);

    provider.value = "anthropic";
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(20);
    model.value = "claude-haiku-5-5";
    model.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(20);
    buttonNamed(host, "Save").click();
    await settle();

    expect(writes).toContainEqual({
      method: "PUT",
      path: "/api/heads-down/config",
      body: { ...CONFIG, provider: "anthropic", model: "claude-haiku-5-5" },
    });
  });
});

describe("applyPassEvent", () => {
  it("builds the live pass from its tool calls and results", () => {
    let live: LivePass = { passId: "p", activity: [], thinking: "", text: "" };
    live = applyPassEvent(live, { type: "tool_call", id: "c1", name: "list_work_streams" });
    live = applyPassEvent(live, { type: "tool_result", id: "c1", status: "ok", result: "[]" });
    live = applyPassEvent(live, { type: "delta", text: "Done." });

    expect(live.activity).toEqual([
      {
        id: "c1",
        name: "list_work_streams",
        server: undefined,
        args: undefined,
        status: "ok",
        result: "[]",
        durationMs: undefined,
      },
    ]);
    expect(live.text).toBe("Done.");
  });
});

describe("linkLabel", () => {
  it("says when a review request was sent", () => {
    const label = linkLabel({
      id: "l",
      kind: "review-request",
      ref: {
        kind: "review-request",
        channel: "slack",
        conversation: "#billing-reviews",
        messageRef: "1712345678.0001",
        sentAt: "2026-10-19T14:00:00.000Z",
      },
      title: null,
      state: "no reply yet",
      observedAt: null,
    });
    expect(label).toStartWith("review request, sent ");
    expect(label).toEndWith(": #billing-reviews · no reply yet");
  });
});
