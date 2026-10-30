import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { AttentionItem } from "../../lib/attention";
import { mountForInteraction } from "../../test/render";
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

let pending: AttentionItem[] = [];
const patches: { path: string; body: unknown }[] = [];

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

async function mount() {
  const view = await mountForInteraction(
    createElement(MergeAlert, { onOpen: (item: AttentionItem) => opened.push(item) }),
  );
  mounted.push(view.unmount);
  return view.host;
}

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  pending = [];
  patches.length = 0;
  opened.length = 0;
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

afterAll(resetSidecarApi);
