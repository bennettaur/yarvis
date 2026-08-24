import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { renderToHtml, textOf } from "../test/render";

const JOBS = [
  {
    name: "consolidate-events",
    description: "Every four hours, summarize the activity events not yet folded into memory.",
    schedule: { kind: "interval", everyMs: 4 * 60 * 60 * 1000 },
    lastStartedAt: "2026-08-24T12:00:00.000Z",
    lastFinishedAt: "2026-08-24T12:00:04.000Z",
    lastStatus: "ok",
    lastError: null,
    running: false,
    due: false,
  },
  {
    name: "cc-session-digest",
    description: "Overnight, summarize new or extended Claude Code sessions.",
    schedule: { kind: "daily", hour: 2 },
    lastStartedAt: null,
    lastFinishedAt: null,
    lastStatus: null,
    lastError: null,
    running: false,
    due: true,
  },
];

mock.module("../lib/api", () => ({
  sidecarFetch: async () =>
    new Response(JSON.stringify({ jobs: JOBS }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
}));

const JobsSection = (await import("./JobsSection")).default;

describe("JobsSection", () => {
  it("renders each job's schedule in plain words", async () => {
    const text = textOf(await renderToHtml(createElement(JobsSection)));
    expect(text).toContain("every 4h");
    expect(text).toContain("daily around 02:00");
  });

  it("distinguishes a job that has run from one that never has", async () => {
    const text = textOf(await renderToHtml(createElement(JobsSection)));
    expect(text).toContain("ok");
    expect(text).toContain("never run");
    expect(text).toContain("due");
  });
});
