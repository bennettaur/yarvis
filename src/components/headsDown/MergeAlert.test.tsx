import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { AttentionItem, AttentionNavTarget } from "../../lib/attention";
import { mountForInteraction, waitFor } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";

const MERGE: AttentionItem = {
  id: "a1",
  seq: 2,
  source: "system",
  sessionKey: "heads-down-merge:acme/infra#7",
  workspaceId: null,
  kind: "info",
  title: "Heads down is merging acme/infra#7",
  body: "Bump the load balancer timeout",
  status: "pending",
  navTarget: { type: "pr", owner: "acme", repo: "infra", number: 7 },
  payload: {
    headsDownMerge: {
      repo: "acme/infra",
      number: 7,
      title: "Bump the load balancer timeout",
      risk: "high",
      why: "You approved it when I asked.",
    },
  },
  createdAt: "2026-10-22T15:00:00Z",
  updatedAt: "2026-10-22T15:00:00Z",
};

/** An older merge the backstop raised, for a call that didn't name its repo. */
const UNANNOUNCED: AttentionItem = {
  ...MERGE,
  id: "a3",
  seq: 1,
  sessionKey: "heads-down-merge:#9",
  title: "Heads down is merging #9",
  body: null,
  navTarget: { type: "heads-down" },
  payload: { headsDownMerge: { repo: "", number: 9, risk: "unknown", why: "Merged unannounced." } },
};

/** An ordinary bell item, which mustn't pop up. */
const OTHER: AttentionItem = {
  ...MERGE,
  id: "a2",
  seq: 1,
  sessionKey: "heads-down:q1",
  title: "Heads down has a question",
  payload: null,
};

/** A merge held back for open review feedback, waiting on the user's answer. */
const HELD: AttentionItem = {
  ...MERGE,
  id: "a4",
  seq: 3,
  sessionKey: "heads-down:q9",
  kind: "permission",
  title: "Heads down needs your approval",
  body: "Merge acme/billing#12? It has open review feedback.",
  navTarget: { type: "heads-down" },
  payload: {
    headsDownMergeReview: {
      questionId: "q9",
      unchecked: null,
      prs: [
        {
          repo: "acme/billing",
          number: 12,
          title: "Bill monthly",
          workspaceId: "w1",
          handedOff: true,
          threads: [
            {
              path: "src/billing.ts",
              line: 10,
              outdated: false,
              author: "sam",
              body: "This drops the retry.",
              replies: 1,
            },
          ],
          threadCount: 1,
          threadsTruncated: false,
          changesRequestedBy: ["sam"],
          fromOutsiders: false,
        },
      ],
    },
  },
};

type HeldPr = Record<string, unknown>;

/** HELD with its one PR changed, or a review payload of its own. */
function held(id: string, pr: HeldPr, review: HeldPr = {}): AttentionItem {
  const base = (HELD.payload as { headsDownMergeReview: { prs: HeldPr[] } }).headsDownMergeReview;
  return {
    ...HELD,
    id,
    sessionKey: `heads-down:${id}`,
    payload: {
      headsDownMergeReview: {
        ...base,
        questionId: id,
        prs: [{ ...base.prs[0], ...pr }],
        ...review,
      },
    },
  };
}

let pending: AttentionItem[] = [];
const patches: { path: string; body: unknown }[] = [];
const posts: { path: string; body: unknown }[] = [];
/** What answering a question returns. */
let answerResponse = () => new Response("{}", { headers: { "content-type": "application/json" } });

stubSidecarApi({
  // Held open until the store stops, so it doesn't loop on reconnects.
  streamSSE: (_path: string, init?: RequestInit) =>
    (async function* () {
      await new Promise<void>((resolve) => {
        const signal = init?.signal;
        if (!signal || signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    })(),
  sidecarFetch: async (path: string, init?: RequestInit) => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (init?.method === "POST") {
      posts.push({ path, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
      return answerResponse();
    }
    if (init?.method === "PATCH") {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      patches.push({ path, body });
      const id = path.slice(path.lastIndexOf("/") + 1);
      const item = pending.find((p) => p.id === id) ?? MERGE;
      return json({ ...item, status: body?.status });
    }
    if (path.startsWith("/api/attention")) return json(pending);
    return new Response("{}", { status: 404 });
  },
});

const MergeAlert = (await import("./MergeAlert")).default;

const mounted: (() => void)[] = [];
const opened: AttentionItem[] = [];
const navigated: AttentionNavTarget[] = [];

async function mount(armingMs = 0) {
  const view = await mountForInteraction(
    createElement(MergeAlert, {
      onOpen: (item: AttentionItem) => opened.push(item),
      onNavigate: (target: AttentionNavTarget) => navigated.push(target),
      armingMs,
    }),
  );
  mounted.push(view.unmount);
  return view.host;
}

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  pending = [];
  patches.length = 0;
  posts.length = 0;
  opened.length = 0;
  navigated.length = 0;
  answerResponse = () => new Response("{}", { headers: { "content-type": "application/json" } });
});

describe("MergeAlert", () => {
  it("pops up a pending merge with its risk, and ignores other bell items", async () => {
    pending = [MERGE, OTHER];
    const host = await mount();

    const dialog = host.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Heads down is merging a PR");
    expect(dialog?.textContent).toContain("acme/infra#7");
    expect(dialog?.textContent).toContain("Heads down rates it high risk");
    expect(dialog?.textContent).toContain("PR title: Bump the load balancer timeout");
    expect(dialog?.textContent).toContain("You approved it when I asked.");
    expect(dialog?.textContent).not.toContain("more merge");
  });

  it("clears the item when dismissed", async () => {
    pending = [MERGE];
    const host = await mount();

    [...host.querySelectorAll("button")].find((b) => b.textContent === "Got it")?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(patches).toEqual([{ path: "/api/attention/a1", body: { status: "dismissed" } }]);
  });

  it("closes on Escape without letting the key reach a dialog underneath", async () => {
    pending = [MERGE];
    const host = await mount();
    let reachedBelow = false;
    const below = () => {
      reachedBelow = true;
    };
    window.addEventListener("keydown", below);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    window.removeEventListener("keydown", below);

    expect(reachedBelow).toBe(false);
    expect(patches).toEqual([{ path: "/api/attention/a1", body: { status: "dismissed" } }]);
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("opens the PR the merge is for", async () => {
    pending = [MERGE];
    const host = await mount();

    const open = [...host.querySelectorAll("button")].find((b) => b.textContent === "Open PR");
    open?.click();

    expect(opened.map((item) => item.id)).toEqual(["a1"]);
  });

  it("shows the next merge once the first is dismissed", async () => {
    pending = [MERGE, UNANNOUNCED];
    const host = await mount();
    expect(host.textContent).toContain("1 more merge to look at.");

    [...host.querySelectorAll("button")].find((b) => b.textContent === "Got it")?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const dialog = host.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("#9");
    expect(dialog?.textContent).toContain("Risk not assessed");
    expect(dialog?.textContent).toContain("Open Heads down");
    expect(dialog?.textContent).not.toContain("more merge");
  });

  it("ignores a merge payload that didn't come from heads-down mode", async () => {
    pending = [{ ...MERGE, source: "claude-hook" }];
    const host = await mount();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("shows nothing when no merge is waiting", async () => {
    pending = [OTHER];
    const host = await mount();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  });
});

describe("MergeAlert with a merge held for review feedback", () => {
  const button = (host: HTMLElement, text: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === text);

  it("shows the feedback ahead of merge announcements", async () => {
    pending = [MERGE, HELD];
    const host = await mount();

    const dialog = host.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Heads down wants to merge a PR with open feedback");
    expect(dialog?.textContent).toContain("acme/billing#12");
    expect(dialog?.textContent).toContain("This drops the retry.");
    expect(dialog?.textContent).toContain("src/billing.ts:10");
    expect(dialog?.textContent).toContain("Changes requested by sam");
    expect(dialog?.textContent).toContain("Its workspace was asked to address this");
    expect(dialog?.textContent).not.toContain("Heads down is merging a PR");
  });

  it("says when the PR couldn't be checked, without claiming feedback", async () => {
    pending = [
      {
        ...HELD,
        payload: { headsDownMergeReview: { questionId: "q9", unchecked: "no token", prs: [] } },
      },
    ];
    const host = await mount();
    const dialog = host.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("couldn't check for feedback");
    expect(dialog?.textContent).toContain("no token");
    expect(dialog?.textContent).not.toContain("with open feedback");
  });

  const dialogText = (host: HTMLElement) =>
    host.querySelector('[role="alertdialog"]')?.textContent ?? "";

  it("approves the merge", async () => {
    pending = [HELD];
    const host = await mount();
    button(host, "Approve merge")?.click();
    await waitFor(() => posts.length === 1, "the answer");

    expect(posts).toEqual([
      { path: "/api/heads-down/questions/q9/answer", body: { choice: "approve" } },
    ]);
    expect(navigated).toEqual([]);
  });

  it("denies it and opens the PR to review, leaving the item settled by the answer", async () => {
    pending = [HELD];
    const host = await mount();
    button(host, "Review, don't merge")?.click();
    await waitFor(() => navigated.length === 1, "the PR to open");

    expect(posts).toEqual([
      { path: "/api/heads-down/questions/q9/answer", body: { choice: "deny" } },
    ]);
    expect(navigated).toEqual([{ type: "pr", owner: "acme", repo: "billing", number: 12 }]);
    // Marking it read would undo the resolve the answer made.
    expect(patches).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("can't be answered by a click that lands as it appears", async () => {
    pending = [HELD];
    // Never arms during the test, so how long mounting takes doesn't matter.
    const host = await mount(60_000);
    expect(button(host, "Approve merge")?.disabled).toBe(true);
    expect(button(host, "Review, don't merge")?.disabled).toBe(true);
    button(host, "Approve merge")?.click();
    button(host, "Review, don't merge")?.click();
    expect(posts).toEqual([]);
  });

  it("arms after a moment with focus on Review", async () => {
    pending = [HELD];
    const host = await mount(50);
    await waitFor(() => button(host, "Approve merge")?.disabled === false, "the buttons to arm");
    expect(document.activeElement).toBe(button(host, "Review, don't merge") ?? null);
    button(host, "Approve merge")?.click();
    await waitFor(() => posts.length === 1, "the answer");
  });

  it("goes to the Heads down page on Review when there's no PR to open", async () => {
    pending = [held("q18", {}, { unchecked: "no token", prs: [] })];
    const host = await mount();
    button(host, "Review, don't merge")?.click();
    await waitFor(() => navigated.length === 1, "the page to open");
    expect(posts).toEqual([
      { path: "/api/heads-down/questions/q18/answer", body: { choice: "deny" } },
    ]);
    expect(navigated).toEqual([{ type: "heads-down" }]);
  });

  it("shows why an answer failed and lets the user try again", async () => {
    answerResponse = () =>
      new Response(JSON.stringify({ error: "already answered" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    pending = [HELD];
    const host = await mount();
    button(host, "Approve merge")?.click();
    await waitFor(() => dialogText(host).includes("already answered"), "the error");

    expect(button(host, "Approve merge")?.disabled).toBe(false);
    expect(button(host, "Review, don't merge")?.disabled).toBe(false);
    expect(navigated).toEqual([]);
  });

  it("puts it away on Escape without answering, and shows the next alert", async () => {
    pending = [MERGE, HELD];
    const host = await mount();
    let reachedBelow = false;
    const below = (e: KeyboardEvent) => {
      if (e.key === "Escape") reachedBelow = true;
    };
    window.addEventListener("keydown", below);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(dialogText(host)).toContain("with open feedback");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    window.removeEventListener("keydown", below);
    await waitFor(() => dialogText(host).includes("Heads down is merging a PR"), "the alert");

    expect(reachedBelow).toBe(false);
    expect(posts).toEqual([]);
    expect(patches).toEqual([]);
  });

  it("puts away one held merge and shows the next", async () => {
    pending = [HELD, held("q10", { repo: "acme/web", number: 3 })];
    const host = await mount();
    expect(dialogText(host)).toContain("acme/billing#12");
    expect(dialogText(host)).toContain("1 more merge waiting on you.");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await waitFor(() => dialogText(host).includes("acme/web#3"), "the next held merge");
    expect(dialogText(host)).not.toContain("more merge");
  });

  it("says whether anyone was asked to address the feedback", async () => {
    const cases: [HeldPr, string][] = [
      [{ workspaceId: null, handedOff: false }, "No workspace has this PR"],
      [{ handedOff: false }, "Its workspace couldn't be asked"],
      [{ handedOff: false, fromOutsiders: true }, "may be from people outside the repo"],
    ];
    for (const [pr, text] of cases) {
      pending = [held("q11", pr)];
      const host = await mount();
      expect(dialogText(host)).toContain(text);
      for (const unmount of mounted.splice(0)) unmount();
    }
  });

  it("says when there are more threads than it shows", async () => {
    pending = [held("q12", { threadCount: 3, changesRequestedBy: [] })];
    let host = await mount();
    expect(dialogText(host)).toContain("2 more unresolved threads on the PR.");
    expect(dialogText(host)).not.toContain("Changes requested");
    for (const unmount of mounted.splice(0)) unmount();

    pending = [held("q13", { threadsTruncated: true })];
    host = await mount();
    expect(dialogText(host)).toContain("may have more threads that couldn't be loaded");
  });

  it("ignores a held merge that didn't come from heads-down mode, or isn't well-formed", async () => {
    const bad: AttentionItem[] = [
      { ...HELD, source: "claude-hook" },
      { ...HELD, kind: "info" },
      { ...HELD, sessionKey: "ws:1" },
      held("q14", {}, { questionId: 9 }),
      held("q15", {}, { prs: "acme/billing#12" }),
      held("q16", { threads: undefined }),
      held("q17", { changesRequestedBy: undefined }),
      held("q19", { number: "12" }),
    ];
    for (const item of bad) {
      pending = [item];
      const host = await mount();
      expect(host.querySelector('[role="alertdialog"]')).toBeNull();
      for (const unmount of mounted.splice(0)) unmount();
    }
  });
});

afterAll(resetSidecarApi);
