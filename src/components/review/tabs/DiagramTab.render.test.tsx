import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { primeCache } from "../../../lib/resourceCache";
import type { ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";
import type {
  ChecklistItem,
  ChecklistRun,
  VerificationChecklist,
  VerificationFlow,
} from "../../../lib/reviewWorkspaces/verification";
import { mountForInteraction, textOf, waitFor } from "../../../test/render";
import { resetReviewApi, stubReviewApi } from "../../../test/reviewWorkspacesApi";
import DiagramTab from "./DiagramTab";
import { verificationKey } from "./reviewData";
import type { TabContext, TabSpec } from "./types";

const pr = {
  id: "pr1",
  ref: { provider: "github", owner: "octo", repo: "repo", number: 7 },
  status: "ready",
  worktreeStatus: "ready",
  headSha: "h".repeat(40),
  mergeBaseSha: "b".repeat(40),
} as ReviewWorkspacePr;

let opened: TabSpec[] = [];
const ctx: TabContext = {
  workspaceId: "ws",
  pr,
  prRef: pr.ref,
  diffMode: "split",
  openTab: (tab) => opened.push(tab),
  openSetup: () => {},
};

let unmount = () => {};
afterEach(() => {
  unmount();
  resetReviewApi();
  opened = [];
});

const flow: VerificationFlow = {
  title: "How an order is saved",
  explanation: "POST /orders validates, then writes.",
  mermaid: "",
};

const run = (over: Partial<ChecklistRun> = {}): ChecklistRun => ({
  id: "r1",
  status: "succeeded",
  live: false,
  headSha: pr.headSha,
  current: true,
  error: null,
  costUsd: 0.12,
  startedAt: "2026-11-15T00:00:00Z",
  finishedAt: null,
  ...over,
});

/** A checklist with only its flow item, in the state `item` gives. */
const checklist = (
  item: Partial<ChecklistItem>,
  withFlow = item.result != null,
): VerificationChecklist => ({
  headSha: pr.headSha,
  themes: [{ id: "understand", label: "Understand the change" }],
  items: [
    {
      section: "flow",
      theme: "understand",
      label: "Flow diagram",
      description: "The whole flow the change sits in.",
      latest: null,
      result: null,
      ...item,
    },
  ],
  report: withFlow ? ({ mustRead: [], flow } as never) : null,
  size: null,
  namedTickets: [],
});

async function mount(state: VerificationChecklist) {
  primeCache(verificationKey(pr.id), state);
  const mounted = await mountForInteraction(createElement(DiagramTab, { ctx }));
  unmount = mounted.unmount;
  return mounted.host;
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label);

describe("DiagramTab", () => {
  it("shows the checklist's diagram, and opens the checklist to run another", async () => {
    const host = await mount(checklist({ latest: run(), result: run() }));
    const text = textOf(host.innerHTML);
    expect(text).toContain("How an order is saved");
    expect(text).toContain("at hhhhhhh · $0.12");
    expect(text).not.toContain("older head");
    button(host, "Open checklist")?.click();
    expect(opened).toEqual([{ kind: "verification", prId: "pr1" }]);
  });

  it("points at the checklist before the diagram has run", async () => {
    const host = await mount(checklist({}));
    expect(textOf(host.innerHTML)).toContain(
      "No diagram yet. Run Flow diagram from the verification checklist",
    );
  });

  it("follows a running check to its diagram", async () => {
    let done = false;
    stubReviewApi({
      verificationChecklist: async () =>
        done
          ? checklist({ latest: run(), result: run() })
          : checklist({ latest: run({ status: "running", live: true }) }),
    });
    const host = await mount(checklist({ latest: run({ status: "running", live: true }) }));
    expect(textOf(host.innerHTML)).toContain("Tracing the flow");
    done = true;
    // The checklist is re-read every 3s while the check runs.
    await waitFor(
      () => textOf(host.innerHTML).includes("How an order is saved"),
      "the diagram",
      5_000,
    );
  }, 8_000);

  it("says another instance is drawing it", async () => {
    const host = await mount(checklist({ latest: run({ status: "running", live: false }) }));
    expect(textOf(host.innerHTML)).toContain("Being drawn by another Yarvis instance");
  });

  it("keeps the last diagram under a failed re-run, marked as an older head's", async () => {
    const older = "g".repeat(40);
    const host = await mount(
      checklist({
        latest: run({ id: "r2", status: "failed", error: "timed out" }),
        result: run({ headSha: older, current: false }),
      }),
    );
    const text = textOf(host.innerHTML);
    expect(text).toContain("The last run failed: timed out");
    expect(text).toContain("Below is the last diagram, from ggggggg");
    expect(text).toContain("This diagram is for an older head");
    expect(text).toContain("How an order is saved");
  });

  it("says a run was cancelled, and keeps the last diagram under it", async () => {
    const host = await mount(
      checklist({
        latest: run({ id: "r2", status: "cancelled" }),
        result: run({ headSha: "g".repeat(40), current: false }),
      }),
    );
    const text = textOf(host.innerHTML);
    expect(text).toContain("The last run was cancelled. Below is the last diagram, from ggggggg");
    expect(text).not.toContain("failed");
    expect(text).toContain("How an order is saved");
  });

  it("marks a diagram made for an older head", async () => {
    const host = await mount(
      checklist({ latest: run({ current: false }), result: run({ current: false }) }),
    );
    const text = textOf(host.innerHTML);
    expect(text).toContain("This diagram is for an older head");
    expect(text).not.toContain("Below is the last diagram");
  });

  it("keeps the last diagram on screen while a re-run draws the next", async () => {
    const host = await mount(
      checklist({ latest: run({ id: "r2", status: "running", live: true }), result: run() }),
    );
    const text = textOf(host.innerHTML);
    expect(text).toContain("Tracing the flow… Below is the last diagram, from hhhhhhh");
    expect(text).toContain("How an order is saved");
  });

  it("says when the last run gave no diagram", async () => {
    const host = await mount(checklist({ latest: run({ id: "r2" }), result: null }));
    expect(textOf(host.innerHTML)).toContain("The last run gave no diagram.");
  });
});
