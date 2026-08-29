import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { PrsPlace } from "../lib/pr/panelState";
import { renderToHtml } from "../test/render";
import PrsPanel from "./PrsPanel";

const STORAGE_KEY = "yarvis.prs.place";

const MY_PR = {
  number: 7,
  title: "Teach the parser about tabs",
  url: "https://github.com/octo/repo/pull/7",
  owner: "octo",
  repo: "repo",
  author: "octo",
  draft: false,
  state: "open",
  createdAt: "2026-06-01T09:00:00.000Z",
  updatedAt: "2026-06-01T09:00:00.000Z",
};

const REVIEWING_PR = { ...MY_PR, number: 9, title: "Drop the legacy shim" };

const summaryOf = (raw: typeof MY_PR) => ({
  ref: { provider: "github" as const, owner: raw.owner, repo: raw.repo, number: raw.number },
  title: raw.title,
  url: raw.url,
  author: raw.author,
  draft: raw.draft,
  state: raw.state,
  createdAt: raw.createdAt,
  updatedAt: raw.updatedAt,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** UI event types posted during a render, so tests can assert on `pr.viewed`. */
let recordedEvents: string[] = [];

// GitHub is the configured provider throughout; Azure is not, which is what
// lets the last test exercise a remembered Azure place going stale.
mock.module("../lib/api", () => ({
  sidecarFetch: async (path: string, init?: RequestInit) => {
    if (path === "/api/events") {
      recordedEvents.push(JSON.parse(String(init?.body)).type);
      return json({ ok: true });
    }
    if (path === "/api/github/viewer") return json({ login: "octo" });
    if (path.startsWith("/api/github/search")) return json([MY_PR]);
    if (path === "/api/github/config")
      return json({ reviewQuery: "is:open", reviewingLookbackDays: 7 });
    if (path === "/api/github/reviewing")
      return json({
        inProgress: [{ summary: summaryOf(REVIEWING_PR), merged: false, myReviewStates: [] }],
        complete: [],
      });
    // The PR status route is `refApiPath` itself, with no suffix.
    if (/^\/api\/github\/pr\/[^/]+\/[^/]+\/\d+$/.test(path))
      return json({
        mergeable: true,
        mergeableState: "clean",
        checks: { total: 0, success: 0, failure: 0, pending: 0 },
      });
    if (path.endsWith("/detail"))
      return json({
        number: MY_PR.number,
        title: MY_PR.title,
        body: "",
        state: MY_PR.state,
        draft: false,
        author: MY_PR.author,
        baseRef: "main",
        headRef: "topic",
        fromFork: false,
        headSha: "abc123",
        additions: 0,
        deletions: 0,
        mergeable: "MERGEABLE",
        mergeMethods: [],
        autoMergeEnabled: false,
        canEnableAutoMerge: false,
        canDisableAutoMerge: false,
        checks: [],
        reviewThreads: [],
        reviewers: [],
      });
    if (path.startsWith("/api/pr/insights")) return json({ insights: [] });
    if (path.startsWith("/api/azure")) return json({ error: "no pat" }, 401);
    return json([]);
  },
  streamSSE: async function* () {},
}));

function storePlace(place: PrsPlace): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(place));
}

const readPlace = (): PrsPlace => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");

/** The list nav is absent while the detail view is up, so it tells the two apart. */
const LIST_NAV = "Needs review";

describe("PrsPanel place", () => {
  beforeEach(() => {
    localStorage.clear();
    recordedEvents = [];
  });

  it("opens on 'My PRs' when there's no remembered place", async () => {
    const html = await renderToHtml(<PrsPanel persistPlace />);

    expect(html).toContain(MY_PR.title);
    expect(html).not.toContain(REVIEWING_PR.title);
  });

  it("reopens the list the user left on", async () => {
    storePlace({ provider: "github", tab: "reviewing", selected: null });

    const html = await renderToHtml(<PrsPanel persistPlace />);

    expect(html).toContain(REVIEWING_PR.title);
  });

  it("reopens the PR the user was reading", async () => {
    storePlace({ provider: "github", tab: "mine", selected: summaryOf(MY_PR) });

    const html = await renderToHtml(<PrsPanel persistPlace />);

    expect(html).toContain(MY_PR.title);
    expect(html).not.toContain(LIST_NAV);
  });

  it("doesn't count reopening a remembered PR as viewing it", async () => {
    storePlace({ provider: "github", tab: "mine", selected: summaryOf(MY_PR) });

    await renderToHtml(<PrsPanel persistPlace />);

    // Otherwise every app-tab round-trip logs the same PR again, and the
    // Reviewing list reads those events to decide what's in progress.
    expect(recordedEvents).not.toContain("pr.viewed");
  });

  it("counts a PR another tab asked us to open as viewing it", async () => {
    await renderToHtml(<PrsPanel persistPlace requestedPr={summaryOf(MY_PR)} />);

    expect(recordedEvents).toContain("pr.viewed");
  });

  it("remembers the place it restored", async () => {
    const place: PrsPlace = { provider: "github", tab: "review", selected: null };
    storePlace(place);

    await renderToHtml(<PrsPanel persistPlace />);

    expect(readPlace()).toEqual(place);
  });

  it("ignores a remembered place when persistence is off", async () => {
    storePlace({ provider: "github", tab: "reviewing", selected: summaryOf(MY_PR) });

    const html = await renderToHtml(<PrsPanel />);

    expect(html).toContain(LIST_NAV);
    expect(html).not.toContain(REVIEWING_PR.title);
  });

  it("leaves the remembered place alone when persistence is off", async () => {
    const place: PrsPlace = { provider: "github", tab: "reviewing", selected: null };
    storePlace(place);

    await renderToHtml(<PrsPanel />);

    expect(readPlace()).toEqual(place);
  });

  it("drops a remembered PR whose provider is no longer configured", async () => {
    storePlace({
      provider: "azure",
      tab: "mine",
      selected: {
        ref: { provider: "azure", org: "acme", project: "Shop", repo: "web", prId: 42 },
        title: "Fix the cart",
        url: "https://dev.azure.com/acme/Shop/_git/web/pullrequest/42",
        author: "someone",
        draft: false,
        state: "active",
        createdAt: "2026-06-01T09:00:00.000Z",
        updatedAt: "2026-06-01T09:00:00.000Z",
      },
    });

    const html = await renderToHtml(<PrsPanel persistPlace />);

    // Fell back to the configured provider's list rather than stranding the
    // user on a detail view Azure can no longer load.
    expect(html).toContain(LIST_NAV);
    expect(html).toContain(MY_PR.title);
    expect(readPlace().selected).toBeNull();
  });
});
