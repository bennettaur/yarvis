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
  pausedAt: null as string | null,
  stopAt: null as string | null,
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
  pausedAt: null,
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

const FAILED_PASS = {
  ...PASS,
  id: "p0",
  chatSessionId: "c0",
  startedAt: "2026-10-19T09:00:00.000Z",
  finishedAt: "2026-10-19T09:05:00.000Z",
  notes: null,
  error: "Overloaded (status 529)",
  callCount: 5,
  failedCalls: [
    { name: "post_message", server: "Slack", error: "channel_not_found", noResult: false },
    {
      name: "send_workspace_instruction",
      server: null,
      error: "The turn ended before this finished.",
      noResult: true,
    },
  ],
};

const CONFIG = {
  minSleepMinutes: 5,
  maxSleepMinutes: 120,
  idleSleepMinutes: 60,
  workingHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
  userAwayAfterMinutes: 120,
  provider: null,
  model: null,
  guidance: null,
  maxRoutinesPerPass: 2,
};

const ROUTINES = {
  routines: [
    {
      name: "meeting-alarms",
      description: "Sets an alarm for each meeting",
      everyMinutes: 180,
      workingHoursOnly: false,
      enabled: true,
      source: "builtin",
      lastDoneAt: null,
    },
  ],
  problems: [{ path: "/home/me/.yarvis/routines/x.md", message: "x.md: 'every' is required" }],
  userDir: "/home/me/.yarvis/routines",
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

/** The saved heads-down config the page loads; a test may replace it. */
let savedConfig: Omit<typeof CONFIG, "provider" | "model"> & {
  provider: string | null;
  model: string | null;
} = CONFIG;

/** The run the page loads; a test may replace it. */
let currentRun = RUN;

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
        run: currentRun,
        lastPass: PASS,
        nextPassAt: "2026-10-19T11:02:00.000Z",
        openQuestionCount: 2,
      });
    }
    if (path === "/api/heads-down/questions") return json([QUESTION, APPROVAL]);
    if (path === "/api/work-streams") return json([STREAM]);
    if (path === "/api/heads-down/passes") return json([PASS, FAILED_PASS]);
    if (path === "/api/heads-down/messages") return json([]);
    if (path === "/api/heads-down/config") return json(savedConfig);
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
    if (path === "/api/heads-down/routines") return json(ROUTINES);
    if (path === "/api/heads-down/allowed-tools") {
      return json([{ id: "mcp:slack:read_channel", name: "read_channel" }]);
    }
    // The live stream, and anything a later file asks for: fail rather than
    // hand a caller the wrong shape. The page reconnects later, which the test
    // ends before.
    return json({ error: `unexpected path: ${path}` }, 404);
  },
}));

const { default: HeadsDownPanel } = await import("./HeadsDownPanel");
const { nextOccurrence } = await import("../../lib/headsDown");
const { applyPassEvent, newLivePass } = await import("./useLivePass");
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
  savedConfig = CONFIG;
  currentRun = RUN;
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

  it("lists the routines, and a file that failed to load", async () => {
    const host = await mount();
    await waitForText(host, "meeting-alarms");

    expect(host.textContent).toContain("every 3h");
    expect(host.textContent).toContain("Not done yet");
    expect(host.textContent).toContain("x.md: 'every' is required");
    expect(host.textContent).toContain("/home/me/.yarvis/routines");
  });

  it("shows it is sleeping between passes", async () => {
    const host = await mount();

    expect(host.textContent).toContain("Sleeping until");
    expect(host.querySelector('[data-state="sleeping"]')).not.toBeNull();
  });

  it("shows what a failed pass did and which calls failed", async () => {
    const text = textOf(await renderToHtml(createElement(HeadsDownPanel)));

    expect(text).toContain("Overloaded (status 529)");
    expect(text).toContain("5 tool calls · 1 failed · 1 with no result");
    expect(text).toContain("Slack/post_message: channel_not_found");
    expect(text).toContain("send_workspace_instruction: no result");
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

describe("HeadsDownPanel pausing", () => {
  it("pauses the run, and shows a paused one with the way to resume it", async () => {
    const host = await mount();
    buttonNamed(host, "Pause").click();
    await settle(50);
    expect(writes).toContainEqual({ method: "POST", path: "/api/heads-down/pause", body: null });

    for (const unmount of mounted.splice(0)) unmount();
    clearResourceCache();
    currentRun = { ...RUN, pausedAt: "2026-10-19T12:00:00.000Z" };
    const text = textOf(await renderToHtml(createElement(HeadsDownPanel)));
    expect(text).toContain("Paused since");
    expect(text).toContain("Resume");
    expect(text).not.toContain("Sleeping until");
  });

  it("shows when the run stops, and clears it", async () => {
    currentRun = { ...RUN, stopAt: "2026-10-19T23:00:00.000Z" };
    const host = await mount();
    expect(host.textContent).toContain("Stops at");
    buttonNamed(host, "Clear").click();
    await settle(50);
    expect(writes).toContainEqual({
      method: "PUT",
      path: "/api/heads-down/stop-at",
      body: { stopAt: null },
    });
  });

  it("pauses a single work stream", async () => {
    const host = await mount();
    const pause = host.querySelector<HTMLButtonElement>('[aria-label="Pause Ship the billing PR"]');
    if (!pause) throw new Error("no pause button on the stream");
    pause.click();
    await settle(50);
    expect(writes).toContainEqual({
      method: "PATCH",
      path: "/api/work-streams/s1",
      body: { paused: true },
    });
  });

  it("picks the next time the clock reads the stop time", () => {
    const now = new Date(2026, 9, 19, 18, 0);
    expect(new Date(nextOccurrence("19:00", now))).toEqual(new Date(2026, 9, 19, 19, 0));
    expect(new Date(nextOccurrence("08:30", now))).toEqual(new Date(2026, 9, 20, 8, 30));
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
    expect(host.querySelector('[data-state="working"]')).not.toBeNull();
  });

  it("shows its latest thought folded to a line", async () => {
    streamFrames = [
      { type: "pass-started", passId: "p2" },
      {
        type: "pass-event",
        passId: "p2",
        event: { type: "reasoning", text: "Check the billing PR first.\nThen the docs." },
      },
    ];
    const host = await mount();
    await waitForText(host, "Thinking:");

    expect(host.querySelector("details")?.open).toBe(false);
    expect(host.textContent).toContain("Check the billing PR first.");
  });

  it("says it will try again only when the sidecar says it is retrying", async () => {
    streamFrames = [
      { type: "pass-started", passId: "p2" },
      {
        type: "pass-event",
        passId: "p2",
        event: { type: "error", message: "Overloaded", transient: true },
      },
      { type: "pass-retrying", passId: "p2", retryAt: "2026-10-19T10:00:30.000Z" },
    ];
    const host = await mount();
    await waitForText(host, "Trying again shortly.");

    expect(host.textContent).toContain("Overloaded Trying again shortly.");
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
    expect(model.value).toBe("claude-opus-5-5");
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

  it("saves the standing guidance every pass follows", async () => {
    const host = await mount();
    buttonNamed(host, "Show settings").click();
    await settle(50);

    const field = host.querySelector<HTMLTextAreaElement>('[aria-label="Standing guidance"]');
    if (!field) throw new Error("no guidance field");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      field,
      "Don't merge during market hours",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(20);
    buttonNamed(host, "Save").click();
    await settle();

    expect(writes).toContainEqual({
      method: "PUT",
      path: "/api/heads-down/config",
      body: { ...CONFIG, guidance: "Don't merge during market hours" },
    });
  });

  it("goes back to the default chat model", async () => {
    savedConfig = { ...CONFIG, provider: "anthropic", model: "claude-haiku-5-5" };
    const host = await mount();
    buttonNamed(host, "Show settings").click();
    await settle(50);

    const provider = host.querySelector<HTMLSelectElement>('[aria-label="Heads-down provider"]');
    const model = host.querySelector<HTMLSelectElement>('[aria-label="Heads-down model"]');
    if (!provider || !model) throw new Error("no model picker");
    expect(provider.value).toBe("anthropic");
    expect(model.value).toBe("claude-haiku-5-5");
    expect(host.textContent).not.toContain("passes will fail");

    provider.value = "";
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(20);
    buttonNamed(host, "Save").click();
    await settle();

    expect(writes).toContainEqual({
      method: "PUT",
      path: "/api/heads-down/config",
      body: { ...CONFIG, provider: null, model: null },
    });
  });

  it("keeps showing a saved model that left the catalogue", async () => {
    savedConfig = { ...CONFIG, provider: "openai", model: "gpt-x" };
    const host = await mount();
    buttonNamed(host, "Show settings").click();
    await settle(50);

    const provider = host.querySelector<HTMLSelectElement>('[aria-label="Heads-down provider"]');
    const model = host.querySelector<HTMLSelectElement>('[aria-label="Heads-down model"]');
    if (!provider || !model) throw new Error("no model picker");
    expect(provider.value).toBe("openai");
    expect(provider.selectedOptions[0]?.textContent).toBe("openai (unavailable)");
    expect(model.value).toBe("gpt-x");
    expect(host.textContent).toContain("passes will fail until you pick another");

    buttonNamed(host, "Save").click();
    await settle();
    expect(writes).toContainEqual({
      method: "PUT",
      path: "/api/heads-down/config",
      body: savedConfig,
    });
  });
});

describe("applyPassEvent", () => {
  it("builds the live pass from its tool calls and results", () => {
    let live: LivePass = newLivePass("p");
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

  it("keeps only the latest stretch of reasoning", () => {
    let live: LivePass = newLivePass("p");
    live = applyPassEvent(live, { type: "reasoning", text: "First " });
    live = applyPassEvent(live, { type: "reasoning", text: "idea." });
    live = applyPassEvent(live, { type: "tool_call", id: "c1", name: "list_work_streams" });
    expect(live).toMatchObject({ thought: "First idea.", isThinking: false });

    live = applyPassEvent(live, { type: "reasoning", text: "Second." });
    expect(live).toMatchObject({ thought: "Second.", isThinking: true });
  });

  it("shows an error without promising a retry, and clears it once work carries on", () => {
    let live: LivePass = { ...newLivePass("p"), retrying: true };
    live = applyPassEvent(live, { type: "error", message: "Overloaded", transient: true });
    expect(live).toMatchObject({ error: "Overloaded", retrying: false });

    live = { ...live, retrying: true };
    live = applyPassEvent(live, { type: "tool_call", id: "c1", name: "list_work_streams" });
    expect(live).toMatchObject({ error: null, retrying: false });
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
