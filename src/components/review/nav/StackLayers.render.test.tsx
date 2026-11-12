import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement, useState } from "react";
import { usePrStack } from "../../../lib/pr/cache";
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
function serveStacks(stacks: Record<number, PrStack | "fail">): number[] {
  const asked: number[] = [];
  stubSidecarApi({
    sidecarFetch: async (path: string) => {
      const number = Number(new URL(path, "http://x").searchParams.get("number"));
      asked.push(number);
      const stack = stacks[number];
      if (stack === "fail") return Response.json({ error: "rate limited" }, { status: 502 });
      return Response.json({ stack: stack ?? null });
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
  /** Holds the ticks the way ReviewNav does, so a click changes what renders. */
  function Harness(props: {
    refs: PrRef[];
    held: string[];
    adding: boolean;
    onAdd: (refs: PrRef[]) => Promise<void>;
  }) {
    const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
    return createElement(StackLayers, {
      refs: props.refs,
      heldRefKeys: new Set(props.held),
      adding: props.adding,
      overrides,
      onToggle: (key, picked) => setOverrides((prev) => new Map(prev).set(key, picked)),
      onAdd: props.onAdd,
    });
  }
  const mount = async (
    refs: PrRef[],
    held: string[],
    { adding = false, onAdd = async (_refs: PrRef[]) => {} } = {},
  ) => {
    const mounted = await mountForInteraction(
      createElement(Harness, { refs, held, adding, onAdd }),
    );
    unmount = mounted.unmount;
    return mounted.host;
  };
  const pickers = (host: HTMLElement) => host.querySelectorAll('section[aria-label="Stack"]');
  const listed = (picker: Element) =>
    [...picker.querySelectorAll("li")].map((li) => li.textContent?.match(/#\d+/)?.[0]);

  it("looks a stack up once, however many of its layers the workspace holds", async () => {
    const stack = stackOf([entry(10), entry(11), entry(12), entry(13)]);
    const asked = serveStacks({ 11: stack, 13: stack, 20: stackOf([entry(20), entry(21)]) });
    const host = await mount([ref(11), ref(13), ref(20)], ["gh:o/r/11", "gh:o/r/13", "gh:o/r/20"]);
    await waitFor(() => pickers(host).length === 2, "a picker per stack");
    expect(asked).toEqual([11, 20]);
    expect(listed(pickers(host)[0]!)).toEqual(["#10", "#12"]);
    expect(listed(pickers(host)[1]!)).toEqual(["#21"]);
  });

  it("leaves out a stack whose other layers are all held", async () => {
    const asked = serveStacks({
      30: stackOf([entry(30), entry(31)]),
      32: stackOf([entry(32), entry(33)]),
    });
    const host = await mount([ref(30), ref(31), ref(32)], ["gh:o/r/30", "gh:o/r/31", "gh:o/r/32"]);
    // Stacks load in order, so the second one's picker means the first has answered.
    await waitFor(() => pickers(host).length === 1, "the second stack's picker");
    expect(listed(pickers(host)[0]!)).toEqual(["#33"]);
    expect(asked).toEqual([30, 32]);
  });

  it("stops looking stacks up once a lookup fails", async () => {
    const asked = serveStacks({ 70: "fail", 71: stackOf([entry(70), entry(71), entry(72)]) });
    // Joins the picker's load of the same stack and shows when it fails. The
    // picker sees the failure in the same render, and any lookup it went on to
    // start would begin in that render's effects, before the probe's text is read.
    function FailureProbe() {
      const { error } = usePrStack(ref(70));
      return createElement("p", { id: "probe" }, error ?? "");
    }
    const mounted = await mountForInteraction(
      createElement(
        "div",
        null,
        createElement(StackLayers, {
          refs: [ref(70), ref(71)],
          heldRefKeys: new Set(["gh:o/r/70", "gh:o/r/71"]),
          adding: false,
          overrides: new Map(),
          onToggle: () => {},
          onAdd: async () => {},
        }),
        createElement(FailureProbe),
      ),
    );
    unmount = mounted.unmount;
    const probe = mounted.host.querySelector("#probe")!;
    await waitFor(() => probe.textContent !== "", "the failed lookup");
    expect(asked).toEqual([70]);
    expect(pickers(mounted.host).length).toBe(0);
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
    const badges = [...host.querySelectorAll("li")].map((li) =>
      li.textContent?.includes("Approved"),
    );
    expect(badges).toEqual([true, false]);

    expect(button(host, "Add selected").textContent).toBe("Add selected (1)");
    button(host, "Add selected").click();
    await waitFor(() => added.length === 1, "the first add");
    expect(added[0]).toEqual([ref(41)]);

    button(host, "Add all").click();
    await waitFor(() => added.length === 2, "the add-all");
    expect(added[1]).toEqual([ref(39), ref(41)]);
  });

  it("lets the reviewer tick an approved layer in, and won't add when nothing is ticked", async () => {
    serveStacks({ 50: stackOf([entry(49, { reviewDecision: "approved" }), entry(50), entry(51)]) });
    const added: PrRef[][] = [];
    const host = await mount([ref(50)], ["gh:o/r/50"], {
      onAdd: async (refs) => {
        added.push(refs);
      },
    });
    await waitFor(() => pickers(host).length === 1, "the picker");
    const [approved, open] = [...host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    open!.click();
    await waitFor(() => button(host, "Add selected").disabled, "nothing ticked");
    approved!.click();
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
