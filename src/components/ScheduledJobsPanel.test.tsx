import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { clearResourceCache } from "../lib/resourceCache";
import { mountForInteraction, renderToHtml, textOf } from "../test/render";

const JOB = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Morning sweep",
  description: "What is waiting for me",
  cron: "0 9 * * 1-5",
  prompt: "summarize what is waiting for me",
  enabled: true,
  target: { kind: "yarvis", specialist: null },
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T09:00:00.000Z",
};

const PAUSED_JOB = {
  ...JOB,
  id: "22222222-2222-2222-2222-222222222222",
  name: "Repo audit",
  enabled: false,
  target: { kind: "claude-code", cwd: "/Users/me/dev/app", model: null, permissionMode: "plan" },
};

const RUNS = [
  {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    jobId: JOB.id,
    trigger: "schedule",
    status: "ok",
    output: "Two PRs are waiting on you.",
    error: null,
    startedAt: "2026-09-21T09:00:00.000Z",
    finishedAt: "2026-09-21T09:00:12.000Z",
  },
  {
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    jobId: JOB.id,
    trigger: "manual",
    status: "error",
    output: null,
    error: "no chat model is configured",
    startedAt: "2026-09-20T09:00:00.000Z",
    finishedAt: "2026-09-20T09:00:01.000Z",
  },
];

/** Paths the panel asked for, so a test can assert what it did. */
const requested: string[] = [];

/** Bodies the panel sent, so a write test can read what it submitted. */
const sent: unknown[] = [];
/** Set by a test that wants the next write to fail. */
let writeFailure: string | null = null;

mock.module("../lib/api", () => ({
  sidecarInfo: async () => ({ port: 0, token: "test-token" }),
  sidecarFetch: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requested.push(`${method} ${path}`);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method !== "GET" && !path.endsWith("/run")) {
      if (typeof init?.body === "string") sent.push(JSON.parse(init.body));
      if (writeFailure) return json({ error: writeFailure }, 409);
      if (method === "DELETE") return json({ deleted: true });
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      return json({ job: { ...JOB, ...body } }, method === "POST" ? 201 : 200);
    }
    if (path.endsWith("/runs")) return json({ runs: RUNS });
    if (path.endsWith("/run")) return json({ ran: true, status: "ok", detail: "done" });
    if (path.startsWith("/api/specialists")) {
      return json({ specialists: [{ name: "planner", enabled: true }], problems: [], userDir: "" });
    }
    return json({
      jobs: [
        {
          job: JOB,
          nextRunAt: "2026-09-22T09:00:00.000Z",
          cronValid: true,
          lastRun: RUNS[0],
          running: false,
        },
        { job: PAUSED_JOB, nextRunAt: null, cronValid: true, lastRun: null, running: false },
      ],
    });
  },
}));

const ScheduledJobsPanel = (await import("./ScheduledJobsPanel")).default;

afterEach(() => {
  clearResourceCache();
  requested.length = 0;
  sent.length = 0;
  writeFailure = null;
});

/** Clicks the first button whose label contains `label`. */
function click(host: HTMLElement, label: string): void {
  [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label))?.click();
}

/** Types into the input or textarea whose placeholder contains `placeholder`. */
function type(host: HTMLElement, placeholder: string, value: string): void {
  const field = [...host.querySelectorAll("input, textarea")].find((f) =>
    (f as HTMLInputElement).placeholder?.includes(placeholder),
  ) as HTMLInputElement | HTMLTextAreaElement | undefined;
  if (!field) throw new Error(`no field with placeholder ${placeholder}`);
  const setter = Object.getOwnPropertyDescriptor(
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ScheduledJobsPanel", () => {
  it("lists each job with its agent and when it next runs", async () => {
    const text = textOf(await renderToHtml(createElement(ScheduledJobsPanel)));
    expect(text).toContain("Morning sweep");
    expect(text).toContain("Yarvis");
    expect(text).toContain("Claude Code");
    expect(text).toContain("next");
  });

  it("says a disabled job is paused rather than showing a next run", async () => {
    const text = textOf(await renderToHtml(createElement(ScheduledJobsPanel)));
    expect(text).toContain("paused");
  });

  it("shows nothing but the invitation until a job is picked", async () => {
    const text = textOf(await renderToHtml(createElement(ScheduledJobsPanel)));
    expect(text).toContain("Pick a job to see its runs");
    expect(text).not.toContain("Run history");
  });

  it("opens a job's editor and run history when it is selected", async () => {
    const { host, unmount } = await mountForInteraction(createElement(ScheduledJobsPanel));
    try {
      const jobButton = [...host.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Morning sweep"),
      );
      jobButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const text = host.textContent ?? "";
      expect(text).toContain("Run history");
      expect(text).toContain("manual");
      // The failure's reason is what a user opens the history for.
      expect(requested).toContain(`GET /api/jobs/agent-jobs/${JOB.id}/runs`);
    } finally {
      unmount();
    }
  });

  it("runs a job on demand and reports the outcome", async () => {
    const { host, unmount } = await mountForInteraction(createElement(ScheduledJobsPanel));
    try {
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent?.includes("Morning sweep"))
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 100));

      [...host.querySelectorAll("button")].find((b) => b.textContent === "Run now")?.click();
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(requested).toContain(`POST /api/jobs/agent-jobs/${JOB.id}/run`);
      expect(host.textContent).toContain("Finished.");
    } finally {
      unmount();
    }
  });

  it("creates a job from the editor", async () => {
    const { host, unmount } = await mountForInteraction(createElement(ScheduledJobsPanel));
    try {
      click(host, "New job");
      await settle(40);
      type(host, "Morning sweep", "Nightly audit");
      type(host, "What the agent should do", "check the release notes");
      await settle(40);
      click(host, "Create job");
      await settle();

      expect(requested).toContain("POST /api/jobs/agent-jobs");
      expect(sent[0]).toMatchObject({ name: "Nightly audit", prompt: "check the release notes" });
    } finally {
      unmount();
    }
  });

  it("refuses to submit a job with no prompt", async () => {
    const { host, unmount } = await mountForInteraction(createElement(ScheduledJobsPanel));
    try {
      click(host, "New job");
      await settle(40);
      type(host, "Morning sweep", "Nameless");
      await settle(40);
      const create = [...host.querySelectorAll("button")].find(
        (b) => b.textContent === "Create job",
      ) as HTMLButtonElement;
      expect(create.disabled).toBe(true);
    } finally {
      unmount();
    }
  });

  it("saves an edit to an existing job", async () => {
    const { host, unmount } = await mountForInteraction(createElement(ScheduledJobsPanel));
    try {
      click(host, "Morning sweep");
      await settle();
      click(host, "Save changes");
      await settle();
      expect(requested).toContain(`PUT /api/jobs/agent-jobs/${JOB.id}`);
    } finally {
      unmount();
    }
  });

  it("shows why a save was refused", async () => {
    const { host, unmount } = await mountForInteraction(createElement(ScheduledJobsPanel));
    try {
      click(host, "Morning sweep");
      await settle();
      writeFailure = "a job with that name already exists";
      click(host, "Save changes");
      await settle();
      expect(host.textContent).toContain("a job with that name already exists");
    } finally {
      unmount();
    }
  });

  it("asks twice before deleting a job", async () => {
    const { host, unmount } = await mountForInteraction(createElement(ScheduledJobsPanel));
    try {
      click(host, "Morning sweep");
      await settle();
      click(host, "Delete");
      await settle(40);
      expect(requested.some((r) => r.startsWith("DELETE"))).toBe(false);
      click(host, "Delete for good?");
      await settle();
      expect(requested).toContain(`DELETE /api/jobs/agent-jobs/${JOB.id}`);
    } finally {
      unmount();
    }
  });

  it("warns when a headless job is set to ask for nothing", async () => {
    const { host, unmount } = await mountForInteraction(createElement(ScheduledJobsPanel));
    try {
      click(host, "Repo audit");
      await settle();
      expect(host.textContent).not.toContain("unsupervised");

      const select = [...host.querySelectorAll("select")].find((s) =>
        [...s.options].some((o) => o.value === "bypassPermissions"),
      ) as HTMLSelectElement;
      select.value = "bypassPermissions";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await settle(40);
      expect(host.textContent).toContain("unsupervised");
    } finally {
      unmount();
    }
  });

  it("offers the Claude Code fields once that backend is chosen", async () => {
    const { host, unmount } = await mountForInteraction(createElement(ScheduledJobsPanel));
    try {
      [...host.querySelectorAll("button")].find((b) => b.textContent === "New job")?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(host.textContent).toContain("Specialist");

      [...host.querySelectorAll("button")]
        .find((b) => b.textContent?.includes("Repo audit"))
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(host.textContent).toContain("Working directory");
      expect(host.textContent).toContain("headless");
    } finally {
      unmount();
    }
  });
});
