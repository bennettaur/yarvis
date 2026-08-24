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

const CONFIG = {
  config: { ccDigestEnabled: false, ccDigestProjectDirs: [] },
  availableProjectDirs: [{ dir: "-Users-me-dev-app", path: "/Users/me/dev/app" }],
};

mock.module("../lib/api", () => ({
  sidecarFetch: async (path: string) =>
    new Response(JSON.stringify(path.includes("/config") ? CONFIG : { jobs: JOBS }), {
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

  it("says the transcript digest is off and why, before offering projects", async () => {
    const html = await renderToHtml(createElement(JobsSection));
    const text = textOf(html);
    expect(text).toContain("Summarize my Claude Code sessions each night");
    expect(text).toContain("sent to your configured LLM provider");
    // Off, so the project list stays hidden until it is enabled.
    expect(text).not.toContain("/Users/me/dev/app");
    expect(html).toContain("checkbox");
  });
});
