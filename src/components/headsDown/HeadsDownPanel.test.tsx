import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { clearResourceCache } from "../../lib/resourceCache";
import { mountForInteraction, renderToHtml, textOf, waitFor } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";
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

const WORKSPACE_ID = "0b8f3c1e-2d4a-4e6b-9c7d-1a2b3c4d5e6f";

const QUESTION = {
  id: "q1",
  kind: "question",
  streamId: "s1",
  question: "Where should I ask for review?",
  situation: `The billing PR in ${WORKSPACE_ID} is ready`,
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
  kind: "work",
  title: "Ship the billing PR",
  summary: null,
  status: "waiting-on-user",
  priority: "high",
  nextAction: `Ask for review of ${WORKSPACE_ID.toUpperCase()}`,
  waitingOn: "Where should I ask for review?",
  wakeAt: null,
  pausedAt: null,
  watchCondition: null,
  watchEveryMinutes: null,
  expiresAt: null,
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
    {
      id: "l2",
      kind: "workspace",
      ref: { kind: "workspace", workspaceId: WORKSPACE_ID },
      title: null,
      state: "session idle",
      observedAt: "2026-10-19T10:00:00.000Z",
    },
  ],
};

const WATCH = {
  ...STREAM,
  id: "s2",
  kind: "watch",
  title: "Alex's PRs",
  status: "waiting-on-others",
  nextAction: null,
  waitingOn: null,
  watchCondition: "Alex merged acme/billing#41",
  watchEveryMinutes: 180,
  expiresAt: "2026-10-26T10:00:00.000Z",
  links: [],
};

const PASS = {
  id: "p1",
  runId: "run-1",
  chatSessionId: "c1",
  startedAt: "2026-10-19T10:00:00.000Z",
  finishedAt: "2026-10-19T10:02:00.000Z",
  notes: `Asked where to request review. Workspace \`${WORKSPACE_ID}\` is idle.`,
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
  passTimeoutMinutes: 20,
  provider: null,
  model: null,
  guidance: null,
  maxRoutinesPerPass: 2,
  shipMonitorWindowMinutes: 60,
  shipCheckEveryMinutes: 15,
  alwaysOn: false,
  nightShift: null,
  nightShiftMinSleepMinutes: 120,
  maxPassesPerDay: null,
};

/** What the settings form sends: always-on only when the user changed it. */
const { alwaysOn: _alwaysOn, ...SENT } = CONFIG;

const ROUTINE_BASE = {
  workingHoursOnly: false,
  nightShift: "run",
  enabled: true,
  once: false,
  source: "builtin",
  path: null as string | null,
  tools: [] as string[],
  config: {} as Record<string, string | string[]>,
  lastDoneAt: null as string | null,
  nextPass: false,
  queued: false,
  dueAt: null as string | null,
  heldBy: null as string | null,
};

const ROUTINES = {
  routines: [
    {
      ...ROUTINE_BASE,
      name: "meeting-alarms",
      description: "Sets an alarm for each meeting",
      everyMinutes: 180,
      body: "Read the calendar and set alarms.",
      nextPass: true,
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      ...ROUTINE_BASE,
      name: "standup",
      description: "Drafts my standup",
      everyMinutes: 24 * 60,
      workingHoursOnly: true,
      source: "user",
      path: "/home/me/.yarvis/routines/standup.md",
      body: "Draft my standup.",
      lastDoneAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      dueAt: new Date(Date.now() + 22 * 60 * 60_000).toISOString(),
    },
    {
      ...ROUTINE_BASE,
      name: "triage",
      description: "Triages my inbox",
      everyMinutes: 45,
      nightShift: "skip",
      source: "user",
      path: "/home/me/.yarvis/routines/triage.md",
      tools: ["slack_read_channel", "post_message"],
      config: { channels: ["#eng", "#ops"], handle: "@sam" },
      body: "Read the channels.",
      queued: true,
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      ...ROUTINE_BASE,
      name: "meeting-notes",
      description: "Reads meeting notes",
      everyMinutes: 240,
      workingHoursOnly: true,
      enabled: false,
      body: "Read meeting notes.",
      heldBy: "off",
    },
  ],
  problems: [{ path: "/home/me/.yarvis/routines/x.md", message: "x.md: 'every' is required" }],
  userDir: "/home/me/.yarvis/routines",
  maxRoutinesPerPass: 1,
};

/** What the routines list and its reload answer; null makes that call fail, "hang" never answers. */
let routinesAnswer: unknown = ROUTINES;
let reloadAnswer: unknown = ROUTINES;
const DEFAULT_MODEL = { provider: "anthropic", model: "claude-haiku-5-5", source: "default" };
/** The model the page state names; null for none available. */
let stateModel: unknown = DEFAULT_MODEL;
let passesAnswer: unknown[] = [PASS, FAILED_PASS];

/** What adding, turning on or off, or deleting a routine answers; null makes it fail. */
let routineWriteAnswer: unknown = ROUTINES;

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

/** What the review stream route answers; a test may replace it. */
let reviewStream: unknown = { maxReady: 5, slots: [], backlog: [] };

/** The run the page loads; a test may replace it. */
let currentRun: typeof RUN | null = RUN;
let passCounts = { passesToday: 4, maxPassesPerDay: null as number | null };

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

stubSidecarApi({
  // Stubbed directly: the real streamSSE calls the real sidecarFetch, not the
  // stub below.
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
      if (path === "/api/heads-down/routines/reload") {
        if (reloadAnswer === "hang") return new Promise<Response>(() => {});
        return reloadAnswer ? json(reloadAnswer) : json({ error: "disk on fire" }, 500);
      }
      if (path === "/api/heads-down/routines" || path.startsWith("/api/heads-down/routines/")) {
        return routineWriteAnswer ? json(routineWriteAnswer) : json({ error: "name taken" }, 400);
      }
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
        model: stateModel,
        ...passCounts,
      });
    }
    if (path === "/api/heads-down/questions") return json([QUESTION, APPROVAL]);
    if (path === "/api/work-streams") return json([STREAM, WATCH]);
    if (path === "/api/workspaces") return json([{ id: WORKSPACE_ID, name: "Billing invoices" }]);
    if (path === "/api/heads-down/passes") return json(passesAnswer);
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
    if (path === "/api/heads-down/routines") {
      if (routinesAnswer === "hang") return new Promise<Response>(() => {});
      return routinesAnswer ? json(routinesAnswer) : json({ error: "disk on fire" }, 500);
    }
    if (path === "/api/review-prep/stream") return json(reviewStream);
    if (path === "/api/heads-down/allowed-tools") {
      return json([{ id: "mcp:slack:read_channel", name: "read_channel" }]);
    }
    // The live stream, and anything else: fail rather than hand a caller the
    // wrong shape. The page reconnects later, which the test
    // ends before.
    return json({ error: `unexpected path: ${path}` }, 404);
  },
});

const { default: HeadsDownPanel } = await import("./HeadsDownPanel");
const { nextOccurrence } = await import("../../lib/headsDown");
const { applyPassEvent, newLivePass } = await import("./useLivePass");
const { linkLabel, ShipStages } = await import("./StreamList");
const { routineStatus } = await import("./RoutineList");
const { onOpenWorkspace } = await import("../../lib/nav");

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
  passCounts = { passesToday: 4, maxPassesPerDay: null };
  routinesAnswer = ROUTINES;
  reloadAnswer = ROUTINES;
  routineWriteAnswer = ROUTINES;
  stateModel = DEFAULT_MODEL;
  passesAnswer = [PASS, FAILED_PASS];
  reviewStream = { maxReady: 5, slots: [], backlog: [] };
});

const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the page to show `text`, since the stream arrives on its own schedule. */
async function waitForText(host: HTMLElement, text: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!host.textContent?.includes(text) && Date.now() < deadline) await settle(20);
}

/** Waits for the page to have sent a request, since the click only starts it. */
async function waitForWrite(method: string, path: string) {
  await waitFor(
    () => writes.some((w) => w.method === method && w.path === path),
    `${method} ${path}`,
  );
}

/** Opens a tab of the page by its label; a tab may show a count after it. */
async function openTab(host: HTMLElement, label: string) {
  const deadline = Date.now() + 2000;
  let tab: HTMLElement | undefined;
  while (!tab && Date.now() < deadline) {
    tab = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) =>
      t.textContent?.startsWith(label),
    );
    if (!tab) await settle(20);
  }
  if (!tab) throw new Error(`no tab "${label}"`);
  tab.click();
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
    expect(text).toContain("Watching for: Alex merged acme/billing#41 · checks every 3h · until");
    expect(text).not.toContain("Watching for: null");
    expect(text).toContain("Asked where to request review.");
    expect(text).toContain("Approved on its own");
    expect(text).toContain("Posts the review request the user asked for");
  });

  it("counts today's passes, against the daily limit when there is one", async () => {
    const host = await mount();
    await waitForText(host, "Passes today: 4");
    for (const unmount of mounted.splice(0)) unmount();
    clearResourceCache();
    passCounts = { passesToday: 40, maxPassesPerDay: 40 };
    const limited = await mount();
    await waitForText(limited, "Passes today: 40 of 40");
    expect(limited.textContent).toContain("Reached today's pass limit");
  });

  it("shows the review stream: what holds a slot, with its risk, and the backlog", async () => {
    reviewStream = {
      maxReady: 2,
      slots: [
        { pr: "api#1", state: "ready", risk: "high" },
        { pr: "api#2", state: "verifying", risk: null },
        { pr: "api#3", state: "queued", risk: null },
      ],
      backlog: [
        { pr: "web#9", backloggedAt: "2026-10-19T09:00:00.000Z" },
        { pr: "web#4", backloggedAt: "2026-10-19T09:30:00.000Z" },
      ],
    };
    const host = await mount();
    await waitForText(host, "Review stream");
    const text = host.textContent ?? "";
    expect(text).toContain("3 of 2 prepared (a stack started past the limit) · 2 in the backlog");
    const row = [...host.querySelectorAll("li")].find((li) => li.textContent?.includes("api#1"));
    expect(row?.textContent).toContain("ready for review");
    expect(row?.textContent).toContain("High risk");
    expect(text.indexOf("web#9")).toBeLessThan(text.indexOf("web#4"));
  });

  it("leaves the review stream out until review prep has a PR", async () => {
    const host = await mount();
    // The routine count on its tab comes from the same load as everything else.
    await waitForText(host, "Routines3");
    expect(host.textContent).not.toContain("Review stream");
  });

  it("names the model passes run on, and whether it is the saved one or the default", async () => {
    const host = await mount();
    await waitForText(host, "Model:");
    expect(host.textContent).toContain(
      "Model: claude-haiku-5-5 (anthropic, the default chat model)",
    );
  });

  it("says when the model is saved in Settings, and when none is available", async () => {
    stateModel = { provider: "anthropic", model: "claude-opus-5-5", source: "saved" };
    const saved = await mount();
    await waitForText(saved, "Model:");
    expect(saved.textContent).toContain("Model: claude-opus-5-5 (anthropic, set in Settings)");
    for (const unmount of mounted.splice(0)) unmount();
    clearResourceCache();
    stateModel = null;
    const none = await mount();
    await waitForText(none, "Model:");
    expect(none.textContent).toContain("Model: none available. Add a provider key in Settings.");
  });

  it("shows the latest three passes on the overview, and the rest on History", async () => {
    passesAnswer = [1, 2, 3, 4, 5].map((n) => ({
      ...PASS,
      id: `p${n}`,
      notes: `Pass number ${n}.`,
    }));
    const host = await mount();
    await waitForText(host, "Show 2 earlier passes");
    expect(host.textContent).toContain("Pass number 3.");
    expect(host.textContent).not.toContain("Pass number 4.");
    buttonNamed(host, "Show 2 earlier passes").click();
    await waitForText(host, "Pass number 5.");
    const selected = host.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected?.textContent).toStartWith("History");
  });

  it("puts the routines, history and settings on their own tabs", async () => {
    const host = await mount();
    await waitForText(host, "Work streams");
    expect(host.textContent).not.toContain("meeting-alarms");
    expect(host.textContent).not.toContain("Always on");
    // Routines that are on are counted on the tab.
    const tabs = [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(["Overview", "Routines3", "History2", "Settings"]);
    await openTab(host, "Routines");
    expect(host.textContent).toContain("meeting-alarms");
    expect(host.textContent).not.toContain("Work streams");
  });

  it("lists the routines with where each stands, and a file that failed to load", async () => {
    const host = await mount();
    await openTab(host, "Routines");
    await waitForText(host, "meeting-alarms");
    const row = (name: string) =>
      [...host.querySelectorAll("li")].find((li) =>
        li.querySelector(".font-mono")?.textContent?.startsWith(name),
      );
    const text = (name: string) => row(name)?.textContent ?? "";

    expect(host.textContent).toContain("Next pass runs: meeting-alarms.");
    expect(host.textContent).toContain("Up to 1 per pass");
    expect(text("meeting-alarms")).toContain("every 3h");
    expect(text("meeting-alarms")).toContain("Runs on the next pass");
    expect(text("meeting-alarms")).not.toContain("yours");
    expect(text("standup")).toContain("yoursevery 1d, working hours");
    expect(text("standup")).toContain("Due in 22 hours");
    expect(text("triage")).toContain("every 45m, skip at night");
    expect(text("triage")).toContain("Due, waiting for a free slot");
    expect(text("meeting-notes")).toContain("Off: ships turned off");
    expect(host.textContent).toContain("Off (1)");
    expect(host.textContent).toContain("On (3)");
    expect(host.textContent).toContain("x.md: 'every' is required");
    expect(host.textContent).toContain("/home/me/.yarvis/routines");
    // Details stay folded until opened.
    expect(text("triage")).not.toContain("Read the channels.");

    row("triage")?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
    await waitForText(host, "Read the channels.");
    expect(text("triage")).toContain("Tools: slack_read_channel, post_message");
    expect(text("triage")).toContain("channels: #eng, #ops");
    expect(text("triage")).toContain("handle: @sam");
    expect(text("triage")).toContain("Not done in the last 30 days");
    expect(text("triage")).toContain("/home/me/.yarvis/routines/triage.md");
  });

  it("says when heads-down mode is off, since no routine runs then", async () => {
    currentRun = null as never;
    const host = await mount();
    await openTab(host, "Routines");
    await waitForText(host, "meeting-alarms");
    expect(host.textContent).toContain("Heads-down mode is off, so no routine runs");
  });

  it("turns a routine on and off, and deletes the user's own file once confirmed", async () => {
    const host = await mount();
    await openTab(host, "Routines");
    await waitForText(host, "meeting-notes");
    const row = (name: string) =>
      [...host.querySelectorAll("li")].find((li) =>
        li.querySelector(".font-mono")?.textContent?.startsWith(name),
      ) as HTMLElement;

    buttonNamed(row("meeting-notes"), "Turn on").click();
    await waitForWrite("PUT", "/api/heads-down/routines/meeting-notes/enabled");
    expect(writes).toContainEqual({
      method: "PUT",
      path: "/api/heads-down/routines/meeting-notes/enabled",
      body: { enabled: true },
    });
    // One change at a time: the buttons wait for the one in flight.
    await waitFor(() => !buttonNamed(row("standup"), "Turn off").disabled, "buttons free");
    buttonNamed(row("standup"), "Turn off").click();
    await waitForWrite("PUT", "/api/heads-down/routines/standup/enabled");
    expect(writes).toContainEqual({
      method: "PUT",
      path: "/api/heads-down/routines/standup/enabled",
      body: { enabled: false },
    });

    await waitFor(() => !buttonNamed(row("standup"), "Turn off").disabled, "buttons free");
    row("standup").querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
    await waitForText(host, "Delete file");
    buttonNamed(row("standup"), "Delete file").click();
    await waitForText(host, "Yes, delete");
    expect(writes.some((w) => w.method === "DELETE")).toBe(false);
    buttonNamed(row("standup"), "Yes, delete").click();
    await waitForWrite("DELETE", "/api/heads-down/routines/standup");
    expect(writes).toContainEqual({
      method: "DELETE",
      path: "/api/heads-down/routines/standup",
      body: null,
    });
  });

  it("adds a one-off routine, and shows why one was refused", async () => {
    const host = await mount();
    await openTab(host, "Routines");
    await waitForText(host, "meeting-alarms");
    buttonNamed(host, "Add routine").click();
    await waitFor(() => host.querySelector('[aria-label="Routine name"]') !== null, "the form");

    const field = <T extends HTMLElement>(label: string) => {
      const el = host.querySelector<T>(`[aria-label="${label}"]`);
      if (!el) throw new Error(`no field ${label}`);
      return el;
    };
    const type = (label: string, value: string) => {
      const el = field<HTMLInputElement | HTMLTextAreaElement>(label);
      const proto = Object.getPrototypeOf(el);
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    type("Routine name", "check-release");
    type("Routine description", "Checks the release channel");
    type("Routine tools", "slack_read_channel, ");
    type("Routine instructions", "Tell me what shipped.");
    const once = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1];
    once?.click();
    await waitFor(() => once?.checked === true, "once picked");

    routineWriteAnswer = null;
    buttonNamed(host, "Save routine").click();
    await waitForText(host, "name taken");
    expect(writes).toContainEqual({
      method: "POST",
      path: "/api/heads-down/routines",
      body: {
        name: "check-release",
        description: "Checks the release channel",
        once: true,
        tools: ["slack_read_channel"],
        body: "Tell me what shipped.",
      },
    });

    routineWriteAnswer = ROUTINES;
    buttonNamed(host, "Save routine").click();
    await waitFor(() => host.querySelector('[aria-label="Routine name"]') === null, "form closed");
  });

  it("reloads the routine files, and says when that fails", async () => {
    reloadAnswer = {
      ...ROUTINES,
      routines: [...ROUTINES.routines, { ...ROUTINES.routines[1], name: "focus-time" }],
    };
    const host = await mount();
    await openTab(host, "Routines");
    await waitForText(host, "meeting-alarms");

    buttonNamed(host, "Reload files").click();
    await waitForText(host, "focus-time");
    expect(host.textContent).toContain("focus-time");
    expect(writes).toContainEqual({
      method: "POST",
      path: "/api/heads-down/routines/reload",
      body: null,
    });

    reloadAnswer = null;
    buttonNamed(host, "Reload files").click();
    await waitForText(host, "disk on fire");
    expect(host.textContent).toContain("disk on fire");

    // A reload that works clears the last one's error.
    reloadAnswer = ROUTINES;
    buttonNamed(host, "Reload files").click();
    await settle(20);
    expect(host.textContent).not.toContain("disk on fire");

    // One reload at a time: the button waits for the one running.
    reloadAnswer = "hang";
    buttonNamed(host, "Reload files").click();
    await settle(20);
    expect(buttonNamed(host, "Reload files").disabled).toBe(true);
  });

  it("says the routines are loading until they arrive", async () => {
    routinesAnswer = "hang";
    const host = await mount();
    await waitForText(host, "Heads down since");
    await openTab(host, "Routines");
    const section = [...host.querySelectorAll("section")].find((s) =>
      s.textContent?.startsWith("Routines"),
    );
    expect(section?.textContent).toContain("Loading…");
    expect(section?.textContent).not.toContain("Couldn't load");
  });

  it("says when the routines couldn't load, and retries from the reload button", async () => {
    routinesAnswer = null;
    const host = await mount();
    await openTab(host, "Routines");
    await waitForText(host, "Couldn't load the routines");
    expect(host.textContent).toContain("Couldn't load the routines");
    expect(host.textContent).not.toContain("Loading…");

    buttonNamed(host, "Reload files").click();
    await waitForText(host, "meeting-alarms");
    expect(host.textContent).not.toContain("Couldn't load the routines");
  });

  it("names the workspaces it mentions by id and opens them on click", async () => {
    const opened: string[] = [];
    const stop = onOpenWorkspace((request) => opened.push(request.id));
    try {
      const host = await mount();
      await waitForText(host, "workspace: Billing invoices");

      expect(host.textContent).toContain("workspace: Billing invoices · session idle");
      expect(host.textContent).toContain("Workspace Billing invoices is idle.");
      expect(host.textContent).not.toContain(WORKSPACE_ID);

      expect(host.textContent).toContain("The billing PR in Billing invoices is ready");
      expect(host.textContent).toContain("Next: Ask for review of Billing invoices");

      buttonNamed(host, "workspace: Billing invoices · session idle").click();
      const noteLink = [...host.querySelectorAll("a")].find(
        (a) => a.textContent === "Billing invoices",
      );
      expect(noteLink).toBeDefined();
      noteLink?.click();
      // The question's situation and the stream's next step.
      const mentions = [...host.querySelectorAll("button")].filter(
        (b) => b.textContent === "Billing invoices",
      );
      expect(mentions).toHaveLength(2);
      for (const mention of mentions) mention.click();
      expect(opened).toEqual([WORKSPACE_ID, WORKSPACE_ID, WORKSPACE_ID, WORKSPACE_ID]);
    } finally {
      stop();
    }
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

  it("clears old work from a paused run once the user confirms", async () => {
    const running = await mount();
    expect([...running.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Clear old work",
    );
    for (const unmount of mounted.splice(0)) unmount();
    clearResourceCache();

    currentRun = { ...RUN, pausedAt: "2026-10-19T12:00:00.000Z" };
    const host = await mount();
    buttonNamed(host, "Clear old work").click();
    await settle(20);
    expect(writes).toEqual([]);
    buttonNamed(host, "Yes, clear").click();
    await settle(50);
    expect(writes).toContainEqual({ method: "POST", path: "/api/heads-down/clear", body: null });
  });

  it("keeps the focus the user typed when they clear old work with heads-down off", async () => {
    currentRun = null;
    const host = await mount();
    const focus = host.querySelector<HTMLInputElement>('[aria-label="Focus"]');
    if (!focus) throw new Error("no focus input");
    // React tracks the value itself, so set it through the native setter for onChange to fire.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      focus,
      "Ship billing",
    );
    focus.dispatchEvent(new Event("input", { bubbles: true }));
    buttonNamed(host, "Clear old work").click();
    await settle(20);
    buttonNamed(host, "Cancel").click();
    await settle(20);
    expect(writes).toEqual([]);

    buttonNamed(host, "Clear old work").click();
    await settle(20);
    buttonNamed(host, "Yes, clear").click();
    await settle(50);
    expect(writes).toContainEqual({ method: "POST", path: "/api/heads-down/clear", body: null });
    expect(focus.value).toBe("Ship billing");
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
    await openTab(host, "Settings");
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
    await openTab(host, "Settings");
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
      body: { ...SENT, provider: "anthropic", model: "claude-haiku-5-5" },
    });
  });

  it("saves the standing guidance every pass follows", async () => {
    const host = await mount();
    await openTab(host, "Settings");
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
      body: { ...SENT, guidance: "Don't merge during market hours" },
    });
  });

  it("saves how long a pass may run", async () => {
    const host = await mount();
    await openTab(host, "Settings");
    await settle(50);

    const field = [...host.querySelectorAll("label")]
      .find((l) => l.textContent?.startsWith("Longest a pass may run"))
      ?.querySelector("input");
    if (!field) throw new Error("no pass timeout field");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "90");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    // A field with no most allowed takes any number at or above its least.
    const longestSleep = [...host.querySelectorAll("label")]
      .find((l) => l.textContent?.startsWith("Longest sleep"))
      ?.querySelector("input");
    if (!longestSleep) throw new Error("no longest sleep field");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      longestSleep,
      "600",
    );
    longestSleep.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(20);
    buttonNamed(host, "Save").click();
    await settle();

    expect(writes).toContainEqual({
      method: "PUT",
      path: "/api/heads-down/config",
      body: { ...SENT, passTimeoutMinutes: 90, maxSleepMinutes: 600 },
    });
  });

  it("saves 0 routines per pass, and ignores a number past the most allowed", async () => {
    const host = await mount();
    await openTab(host, "Settings");
    await settle(50);

    const field = [...host.querySelectorAll("label")]
      .find((l) => l.textContent?.startsWith("Routines per pass"))
      ?.querySelector("input");
    if (!field) throw new Error("no routines per pass field");
    const type = async (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(20);
    };
    const saved = async () => {
      buttonNamed(host, "Save").click();
      await settle();
      return writes.filter((w) => w.path === "/api/heads-down/config").pop()?.body;
    };
    await type("0");
    await type("-1");
    expect(await saved()).toEqual({ ...SENT, maxRoutinesPerPass: 0 });
    await type("10");
    await type("11");
    expect(await saved()).toEqual({ ...SENT, maxRoutinesPerPass: 10 });
  });

  it("saves always-on, a daily pass limit and night-shift hours", async () => {
    const host = await mount();
    await openTab(host, "Settings");
    await settle(50);
    const checkbox = (label: string) => {
      const input = [...host.querySelectorAll("label")]
        .find((l) => l.textContent?.startsWith(label))
        ?.querySelector<HTMLInputElement>("input[type=checkbox]");
      if (!input) throw new Error(`no ${label} checkbox`);
      return input;
    };
    checkbox("Always on").click();
    checkbox("Limit passes per day").click();
    checkbox("Night shift").click();
    await settle(20);
    buttonNamed(host, "Save").click();
    await settle();

    expect(writes).toContainEqual({
      method: "PUT",
      path: "/api/heads-down/config",
      body: {
        ...SENT,
        alwaysOn: true,
        maxPassesPerDay: 100,
        nightShift: { start: "23:00", end: "07:00" },
      },
    });
  });

  it("doesn't send always-on unless it was changed, so a stale form can't turn it back on", async () => {
    // Stop turned it off on the server after this form loaded it as on.
    savedConfig = { ...CONFIG, alwaysOn: true };
    const host = await mount();
    await openTab(host, "Settings");
    await settle(50);
    buttonNamed(host, "Save").click();
    await settle();
    const body = writes.filter((w) => w.path === "/api/heads-down/config").pop()?.body;
    expect(body).not.toHaveProperty("alwaysOn");
  });

  it("goes back to the default chat model", async () => {
    savedConfig = { ...CONFIG, provider: "anthropic", model: "claude-haiku-5-5" };
    const host = await mount();
    await openTab(host, "Settings");
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
      body: { ...SENT, provider: null, model: null },
    });
  });

  it("keeps showing a saved model that left the catalogue", async () => {
    savedConfig = { ...CONFIG, provider: "openai", model: "gpt-x" };
    const host = await mount();
    await openTab(host, "Settings");
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
      body: { ...SENT, provider: "openai", model: "gpt-x" },
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
  it("names a workspace by its current name, and says only what it is when unknown", () => {
    const link = {
      id: "l",
      kind: "workspace" as const,
      ref: { kind: "workspace" as const, workspaceId: WORKSPACE_ID },
      title: null,
      state: null,
      observedAt: null,
    };
    expect(linkLabel(link, new Map([[WORKSPACE_ID, "Billing invoices"]]))).toBe(
      "workspace: Billing invoices",
    );
    expect(linkLabel(link, new Map())).toBe("workspace");
  });

  it("says when a review request was sent", () => {
    const label = linkLabel(
      {
        ref: {
          kind: "review-request",
          channel: "slack",
          conversation: "#billing-reviews",
          messageRef: "1712345678.0001",
          sentAt: "2026-10-19T14:00:00.000Z",
        },
        title: null,
        state: "no reply yet",
      },
      new Map(),
    );
    expect(label).toStartWith("review request, sent ");
    expect(label).toEndWith(": #billing-reviews · no reply yet");
  });
});

describe("ShipStages", () => {
  it("shows each stage, where the stream is, and the last thing it saw", async () => {
    const html = await renderToHtml(
      createElement(ShipStages, {
        ship: {
          repo: "acme/api",
          number: 12,
          url: "https://github.com/acme/api/pull/12",
          stage: "monitor_production",
          stages: {
            ci: { status: "done", at: "2026-11-23T10:00:00.000Z" },
            staging_test: { status: "skipped", at: "2026-11-23T11:00:00.000Z" },
            deploy: { status: "failed", at: "2026-11-23T12:00:00.000Z" },
          },
          monitorUntil: "2026-11-23T16:00:00.000Z",
          log: [
            {
              at: "2026-11-23T15:00:00.000Z",
              stage: "monitor_production",
              text: "error rate flat",
            },
          ],
        },
      }),
    );
    const text = textOf(html);
    expect(text).toContain("Staging test (skipped)");
    expect(text).toContain("Deploy (failed)");
    expect(text).toContain("Watching production until");
    expect(text).toContain("Last logged (Watch production): error rate flat");
    expect(html).toMatch(/aria-current="step"[^>]*>Watch production</);
  });
});

afterAll(resetSidecarApi);

describe("routineStatus", () => {
  const base = {
    ...ROUTINE_BASE,
    name: "x",
    description: "x",
    everyMinutes: 60,
    body: "x",
  } as never;
  const status = (over: Record<string, unknown>) =>
    routineStatus({ ...(base as object), ...over } as never).label;

  it("says why a routine waits, or that it's done", () => {
    expect(status({ heldBy: "working-hours" })).toBe("Waits for working hours");
    expect(status({ heldBy: "night-shift" })).toBe("Skipped during night shift");
    expect(
      status({ heldBy: "retry", dueAt: new Date(Date.now() + 30 * 60_000).toISOString() }),
    ).toBe("Didn't finish last time; tries again in 30 minutes");
    expect(status({ enabled: false, source: "user" })).toBe("Off in your file");
    expect(status({ enabled: false, source: "builtin" })).toBe("Off: ships turned off");
    expect(status({ once: true, dueAt: null })).toBe("Done");
  });
});
