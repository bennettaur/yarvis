import { afterEach, describe, expect, it } from "bun:test";
import { createElement, type ReactElement } from "react";
import type { PrFile, PrRef, ReviewThread } from "../../lib/pr/types";
import { fakeExpansion } from "../../test/expansion";
import { mountForInteraction } from "../../test/render";
import { DiffBody } from "./PrFileDiffs";
import SplitDiffBody from "./SplitDiffBody";
import type { InsightsController } from "./usePrInsights";

/**
 * The per-line "?" and "+" are shared by the unified and split renderers, but
 * each supplies the hovered `group/line` from a different element — the row in
 * one, the gutter itself in the other. Both are driven from the same file, so
 * both are checked here rather than once in whichever renderer happens to have
 * a test file.
 *
 * These are structural assertions on Tailwind classes because the defect they
 * guard is layout, and a static DOM has no layout to measure: what can be
 * pinned is that the buttons hang off the floated cluster and that the cluster
 * has a `group/line` ancestor to reveal it. Both were silently breakable
 * otherwise.
 */

const prRef: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 1 };

const file: PrFile = {
  filename: "foo.ts",
  status: "modified",
  additions: 0,
  deletions: 0,
  patch: "",
};

/** Enough of a controller to make the "?" render; it is never driven here. */
const insights: InsightsController = {
  byPath: new Map(),
  loading: false,
  error: null,
  asking: null,
  openAsk: () => {},
  closeAsk: () => {},
  pending: false,
  submit: async () => {},
  post: async () => {},
  remove: async () => {},
};

// A four-digit right-hand line number: the width that used to leave the "?" no
// room in the gutter.
const PATCH = ["@@ -1,1 +1000,1 @@", "+a"].join("\n");

const bodies: [name: string, element: () => ReactElement][] = [
  [
    "unified",
    () =>
      createElement(DiffBody, {
        prRef,
        file: { ...file, patch: PATCH },
        threads: [] as ReviewThread[],
        expansion: fakeExpansion(PATCH),
        insights,
      }),
  ],
  [
    "split",
    () =>
      createElement(SplitDiffBody, {
        prRef,
        file: { ...file, patch: PATCH },
        threads: [] as ReviewThread[],
        expansion: fakeExpansion(PATCH),
        insights,
      }),
  ],
];

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

async function mount(element: ReactElement): Promise<HTMLElement> {
  const mounted = await mountForInteraction(element);
  cleanup = mounted.unmount;
  return mounted.host;
}

const button = (host: HTMLElement, label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`);

/** The floated cluster a button hangs off, or null if it is still in flow. */
const cluster = (el: Element | null) => el?.closest("span.absolute") ?? null;

describe.each(bodies)("line actions in the %s diff", (_name, element) => {
  it("hangs both buttons off one floated cluster", async () => {
    const host = await mount(element());
    const comment = button(host, "Comment on this line");
    const ask = button(host, "Ask about this line");
    expect(comment).not.toBeNull();
    expect(ask).not.toBeNull();

    const floated = cluster(comment);
    expect(floated).not.toBeNull();
    // Anchored past the gutter's right edge, which is what keeps the line
    // number from having to share its three rem with the buttons.
    expect(floated?.classList.contains("left-full")).toBe(true);
    expect(cluster(ask)).toBe(floated);
  });

  // Half a line box down, not half the row: in the split view a long line wraps
  // and makes its row several lines tall, and centring on the row would leave
  // the buttons stranded in the middle of the block instead of beside the
  // number they act on.
  it("anchors the cluster to the line's first visual row", async () => {
    const host = await mount(element());
    const floated = cluster(button(host, "Comment on this line"));
    expect(floated?.classList.contains("top-[0.8em]")).toBe(true);
    expect(floated?.classList.contains("top-1/2")).toBe(false);
  });

  // The reveal is a `group-hover/line:` on the cluster, so it is inert unless
  // something above it carries the matching named group — and that element
  // lives in a different file from the classes that depend on it.
  it("puts the cluster under a group/line ancestor", async () => {
    const host = await mount(element());
    const floated = cluster(button(host, "Comment on this line"));
    expect(floated?.closest("[class~='group/line']")).not.toBeNull();
  });

  // The buttons are the only way into the composer, and they are now behind a
  // wrapper that toggles `pointer-events` — worth pinning that clicking one
  // still reaches the handler.
  it("opens the composer from the + button", async () => {
    const host = await mount(element());
    expect(host.querySelector("textarea")).toBeNull();
    button(host, "Comment on this line")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.querySelector("textarea")?.placeholder).toBe("Leave a comment…");
  });
});
