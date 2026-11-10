import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { PrRef, PrStack, StackEntry } from "../../../lib/pr/types";
import { mountForInteraction, waitFor } from "../../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../../test/sidecarApi";
import StackLayers, { addableLayers, notInStack, pickedByDefault } from "./StackLayers";

const ref = (number: number): PrRef => ({ provider: "github", owner: "o", repo: "r", number });

const entry = (number: number, extra: Partial<StackEntry> = {}): StackEntry => ({
  ref: ref(number),
  number,
  title: `Layer ${number}`,
  url: "",
  baseRef: "",
  headRef: "",
  state: "open",
  merged: false,
  draft: false,
  queued: false,
  checks: { total: 0, success: 0, failure: 0, pending: 0 },
  reviewDecision: null,
  isCurrent: false,
  needsUpdate: false,
  statusKnown: true,
  ...extra,
});

const stackOf = (entries: StackEntry[]): PrStack => ({
  trunk: "main",
  entries,
  stackNumber: null,
  truncated: false,
});

let unmount = () => {};
afterEach(() => unmount());
afterAll(resetSidecarApi);

/**
 * Answers the stack lookups from `stacks`, keyed by PR number, and records
 * which numbers were asked for. Each test uses its own numbers, since the
 * answers are cached per PR.
 */
function serveStacks(stacks: Record<number, PrStack>): number[] {
  const asked: number[] = [];
  stubSidecarApi({
    sidecarFetch: async (path: string) => {
      const number = Number(new URL(path, "http://x").searchParams.get("number"));
      asked.push(number);
      return Response.json({ stack: stacks[number] ?? null });
    },
  });
  return asked;
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith(label))!;

describe("addableLayers", () => {
  it("keeps open PRs the workspace doesn't hold, bottom first", () => {
    const layers = addableLayers(
      stackOf([
        entry(1, { state: "merged", merged: true }),
        entry(2),
        entry(3, { isCurrent: true }),
        entry(4, { state: "closed" }),
        // Number 0: a branch with no pull request.
        entry(0, { state: "none" }),
        entry(5, { draft: true }),
      ]),
      new Set(["gh:o/r/3"]),
    );
    expect(layers.map((e) => e.number)).toEqual([2, 5]);
  });

  it("finds nothing when there is no stack", () => {
    expect(addableLayers(null, new Set())).toEqual([]);
  });
});

describe("notInStack", () => {
  it("drops the PRs a stack lists, keeping the order of the rest", () => {
    const stack = stackOf([entry(1), entry(2), entry(0, { state: "none" })]);
    expect(notInStack([ref(2), ref(9), ref(1), ref(8)], stack)).toEqual([ref(9), ref(8)]);
    expect(notInStack([ref(2)], null)).toEqual([ref(2)]);
  });
});

describe("pickedByDefault", () => {
  it("leaves approved layers unticked", () => {
    expect(pickedByDefault(entry(1))).toBe(true);
    expect(pickedByDefault(entry(1, { reviewDecision: "changes_requested" }))).toBe(true);
    expect(pickedByDefault(entry(1, { reviewDecision: "approved" }))).toBe(false);
  });
});

describe("StackLayers", () => {
  const mount = async (
    refs: PrRef[],
    held: string[],
    { adding = false, onAdd = async (_refs: PrRef[]) => {} } = {},
  ) => {
    const mounted = await mountForInteraction(
      createElement(StackLayers, { refs, heldRefKeys: new Set(held), adding, onAdd }),
    );
    unmount = mounted.unmount;
    return mounted.host;
  };
  const pickers = (host: HTMLElement) => host.querySelectorAll('section[aria-label="Stack"]');

  it("looks a stack up once, however many of its layers the workspace holds", async () => {
    const stack = stackOf([entry(10), entry(11), entry(12), entry(13)]);
    const asked = serveStacks({ 11: stack, 13: stack, 20: stackOf([entry(20), entry(21)]) });
    const host = await mount([ref(11), ref(13), ref(20)], ["gh:o/r/11", "gh:o/r/13", "gh:o/r/20"]);
    await waitFor(() => pickers(host).length === 2, "a picker per stack");
    expect(asked).toEqual([11, 20]);
    expect(pickers(host)[0]!.textContent).toContain("2 not added");
    expect(pickers(host)[1]!.textContent).toContain("1 not added");
  });

  it("shows nothing when every other layer is already held", async () => {
    serveStacks({ 30: stackOf([entry(30), entry(31)]) });
    const host = await mount([ref(30), ref(31)], ["gh:o/r/30", "gh:o/r/31"]);
    expect(pickers(host).length).toBe(0);
  });

  it("adds only the picked layers, skipping approved ones unless ticked", async () => {
    serveStacks({
      40: stackOf([entry(39, { reviewDecision: "approved" }), entry(40), entry(41)]),
    });
    const added: PrRef[][] = [];
    const host = await mount([ref(40)], ["gh:o/r/40"], {
      onAdd: async (refs) => {
        added.push(refs);
      },
    });
    await waitFor(() => pickers(host).length === 1, "the picker");
    expect(host.textContent).toContain("Approved");

    expect(button(host, "Add selected").textContent).toBe("Add selected (1)");
    button(host, "Add selected").click();
    await waitFor(() => added.length === 1, "the first add");
    expect(added[0]).toEqual([ref(41)]);

    button(host, "Add all").click();
    await waitFor(() => added.length === 2, "the add-all");
    expect(added[1]).toEqual([ref(39), ref(41)]);
  });

  it("lets the reviewer tick an approved layer in", async () => {
    serveStacks({ 50: stackOf([entry(49, { reviewDecision: "approved" }), entry(50)]) });
    const added: PrRef[][] = [];
    const host = await mount([ref(50)], ["gh:o/r/50"], {
      onAdd: async (refs) => {
        added.push(refs);
      },
    });
    await waitFor(() => pickers(host).length === 1, "the picker");
    host.querySelector<HTMLInputElement>("input[type=checkbox]")!.click();
    await waitFor(
      () => button(host, "Add selected").textContent === "Add selected (1)",
      "the tick",
    );
    button(host, "Add selected").click();
    await waitFor(() => added.length === 1, "the add");
    expect(added[0]).toEqual([ref(49)]);
  });

  it("locks every control while an add is running", async () => {
    serveStacks({ 60: stackOf([entry(60), entry(61)]) });
    const host = await mount([ref(60)], ["gh:o/r/60"], { adding: true });
    await waitFor(() => pickers(host).length === 1, "the picker");
    expect(button(host, "Add selected").disabled).toBe(true);
    expect(button(host, "Add all").disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>("input[type=checkbox]")!.disabled).toBe(true);
  });
});
