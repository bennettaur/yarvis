import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { IssueRepo } from "../../lib/issues/types";

const repos: IssueRepo[] = [{ id: "r1", owner: "octo", repo: "web", name: "web" }];

/** Repos the fake sidecar reports as configured to pull issues. */
let configured: IssueRepo[] = repos;
const fetched: string[] = [];

// Stubbing the transport (rather than lib/issues/api) keeps the request paths
// the api client builds under test, matching the PR render tests.
mock.module("../../lib/api", () => ({
  sidecarFetch: async (path: string) => {
    fetched.push(path);
    const body = path.startsWith("/api/issues/github/repos") ? configured : [];
    return new Response(JSON.stringify(body), { status: 200 });
  },
  ensureOk: async (res: Response, context: string) => {
    if (!res.ok) throw new Error(`${context} -> ${res.status}`);
  },
  streamSSE: () => () => {},
}));

const { default: GithubIssuesView } = await import("./GithubIssuesView");

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(GithubIssuesView));
  await settle();
  return {
    host,
    cleanup: () => {
      root.unmount();
      host.remove();
    },
  };
}

const button = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label);

beforeEach(() => {
  fetched.length = 0;
  configured = repos;
});

describe("GithubIssuesView", () => {
  it("re-pulls the lists when Refresh is clicked", async () => {
    const { host, cleanup } = await mount();
    fetched.length = 0;
    button(host, "↻ Refresh")?.click();
    await settle();
    expect(fetched).toContain("/api/issues/github/assigned");
    expect(fetched).toContain("/api/issues/github/all");
    cleanup();
  });

  it("keeps Refresh reachable when no repo pulls issues yet", async () => {
    // Enabling "Pull issues" in Settings doesn't remount this view, so the
    // empty state needs its own way to re-pull.
    configured = [];
    const { host, cleanup } = await mount();
    expect(host.textContent).toContain("No repositories are set to pull issues");
    button(host, "↻ Refresh")?.click();
    await settle();
    expect(fetched.filter((p) => p === "/api/issues/github/repos").length).toBe(2);
    cleanup();
  });

  it("offers New issue only once a repo is configured", async () => {
    const { host, cleanup } = await mount();
    expect(button(host, "+ New issue")?.disabled).toBe(false);
    cleanup();

    configured = [];
    const empty = await mount();
    expect(button(empty.host, "+ New issue")).toBeUndefined();
    empty.cleanup();
  });
});
