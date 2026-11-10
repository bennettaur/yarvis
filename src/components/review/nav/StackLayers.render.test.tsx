import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { prStackKey } from "../../../lib/pr/cache";
import type { PrRef, PrStack, StackEntry } from "../../../lib/pr/types";
import { primeCache } from "../../../lib/resourceCache";
import { mountForInteraction, renderToHtml, textOf, waitFor } from "../../../test/render";
import StackLayers, { addableLayers, pickedByDefault } from "./StackLayers";

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

describe("addableLayers", () => {
  it("keeps open PRs the workspace doesn't hold, bottom first", () => {
    const layers = addableLayers(
      stackOf([
        entry(1, { state: "merged", merged: true }),
        entry(2),
        entry(3, { isCurrent: true }),
        entry(4, { state: "closed" }),
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

describe("pickedByDefault", () => {
  it("leaves approved layers unticked", () => {
    expect(pickedByDefault(entry(1))).toBe(true);
    expect(pickedByDefault(entry(1, { reviewDecision: "changes_requested" }))).toBe(true);
    expect(pickedByDefault(entry(1, { reviewDecision: "approved" }))).toBe(false);
  });
});

describe("StackLayers", () => {
  it("shows nothing when every other layer is already held", async () => {
    primeCache(prStackKey(ref(10)), stackOf([entry(10, { isCurrent: true }), entry(11)]));
    const html = await renderToHtml(
      createElement(StackLayers, {
        prRef: ref(10),
        held: new Set(["gh:o/r/10", "gh:o/r/11"]),
        onAdd: async () => {},
      }),
    );
    expect(textOf(html)).toBe("");
  });

  it("adds only the picked layers, skipping approved ones unless ticked", async () => {
    primeCache(
      prStackKey(ref(20)),
      stackOf([
        entry(19, { reviewDecision: "approved" }),
        entry(20, { isCurrent: true }),
        entry(21),
      ]),
    );
    const added: PrRef[][] = [];
    const mounted = await mountForInteraction(
      createElement(StackLayers, {
        prRef: ref(20),
        held: new Set(["gh:o/r/20"]),
        onAdd: async (refs) => {
          added.push(refs);
        },
      }),
    );
    unmount = mounted.unmount;
    const { host } = mounted;
    expect(host.textContent).toContain("Approved");
    const button = (label: string) =>
      [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith(label))!;

    expect(button("Add selected").textContent).toBe("Add selected (1)");
    button("Add selected").click();
    await waitFor(() => added.length === 1, "the first add");
    expect(added[0]).toEqual([ref(21)]);

    await waitFor(() => !button("Add all").disabled, "the first add to finish");
    button("Add all").click();
    await waitFor(() => added.length === 2, "the add-all");
    expect(added[1]).toEqual([ref(19), ref(21)]);
  });

  it("lets the reviewer tick an approved layer in", async () => {
    primeCache(
      prStackKey(ref(30)),
      stackOf([entry(29, { reviewDecision: "approved" }), entry(30, { isCurrent: true })]),
    );
    const added: PrRef[][] = [];
    const mounted = await mountForInteraction(
      createElement(StackLayers, {
        prRef: ref(30),
        held: new Set(["gh:o/r/30"]),
        onAdd: async (refs) => {
          added.push(refs);
        },
      }),
    );
    unmount = mounted.unmount;
    const { host } = mounted;
    host.querySelector<HTMLInputElement>("input[type=checkbox]")!.click();
    await waitFor(() => host.textContent?.includes("Add selected (1)") ?? false, "the tick");
    [...host.querySelectorAll("button")]
      .find((b) => b.textContent?.startsWith("Add selected"))!
      .click();
    await waitFor(() => added.length === 1, "the add");
    expect(added[0]).toEqual([ref(29)]);
  });
});
