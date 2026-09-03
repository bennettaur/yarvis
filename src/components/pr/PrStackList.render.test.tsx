import { afterEach, describe, expect, it } from "bun:test";
import type { PrStack, StackEntry } from "../../lib/pr/types";
import { mountForInteraction, renderToHtml, textOf } from "../../test/render";
import PrStackList from "./PrStackList";

const entry = (number: number, headRef: string, extra: Partial<StackEntry> = {}): StackEntry => ({
  ref: { provider: "github", owner: "o", repo: "r", number },
  number,
  title: `layer ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  baseRef: "",
  headRef,
  state: "open",
  merged: false,
  draft: false,
  queued: false,
  checks: { total: 1, success: 1, failure: 0, pending: 0 },
  reviewDecision: null,
  isCurrent: false,
  needsUpdate: false,
  statusKnown: true,
  ...extra,
});

const stack: PrStack = {
  trunk: "main",
  stackNumber: 7,
  truncated: false,
  entries: [
    entry(1, "auth", { merged: true }),
    entry(2, "api", { isCurrent: true, needsUpdate: true }),
    entry(3, "ui", { draft: true }),
  ],
};

describe("PrStackList", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  // The sidecar hands the stack over bottom-first because the trunk is the
  // anchor; every drawing of a stack puts the trunk at the bottom.
  it("draws the stack top-down with the trunk underneath", async () => {
    const text = textOf(await renderToHtml(<PrStackList stack={stack} />));
    const order = [text.indexOf("layer 3"), text.indexOf("layer 2"), text.indexOf("layer 1")];

    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The trunk is the floor, below every layer including the bottom one.
    expect(text.indexOf("auth")).toBeLessThan(text.lastIndexOf("main"));
  });

  it("shows each layer's state so the one holding the stack up is visible", async () => {
    const text = textOf(await renderToHtml(<PrStackList stack={stack} />));

    expect(text).toContain("merged");
    expect(text).toContain("draft");
  });

  it("marks where the reader is and which layer needs restacking", async () => {
    const text = textOf(await renderToHtml(<PrStackList stack={stack} />));

    expect(text).toContain("you are here");
    expect(text).toContain("needs restack");
  });

  // The whole row highlights on hover, so a click anywhere in it — the branch
  // name, the status, the padding — has to open the layer. Clicking the number
  // being the only thing that worked read as a click that got swallowed (#268).
  it("puts the whole row inside one click target", async () => {
    const { host, unmount } = await mountForInteraction(<PrStackList stack={stack} />);
    cleanup = unmount;
    const rows = [...host.querySelectorAll("li")];
    const target = rows[0]?.querySelector("button");

    expect(target?.textContent).toContain("layer 3");
    expect(target?.textContent).toContain("ui");
    expect(target?.textContent).toContain("draft");
  });

  it("opens the layer a click lands on", async () => {
    const opened: number[] = [];
    const { host, unmount } = await mountForInteraction(
      <PrStackList stack={stack} onOpen={(entry) => opened.push(entry.number)} />,
    );
    cleanup = unmount;
    // Top-down, so the first row is the top layer. Clicking the status line
    // rather than the title: both belong to the same target.
    const line = host.querySelectorAll("li")[0]?.querySelectorAll("button")[0];
    line?.click();

    expect(opened).toEqual([3]);
  });

  // `isCurrent` comes from whichever layer's fetch produced the list, so the
  // review page overrides it with the ref it is showing — otherwise the
  // highlight only catches up once that layer's own stack lands.
  it("marks the layer named by currentRef rather than the stack's own flag", async () => {
    const { host, unmount } = await mountForInteraction(
      // Layer 2 is the one the stack itself flags as current.
      <PrStackList stack={stack} currentRef={entry(3, "ui").ref} />,
    );
    cleanup = unmount;
    const marked = [...host.querySelectorAll('[aria-current="true"]')];

    expect(marked.length).toBe(1);
    expect(marked[0]?.textContent).toContain("layer 3");
    expect(marked[0]?.textContent).toContain("you are here");
  });

  // `gh stack` tracks a branch from the moment it is created, so a stack can
  // hold a layer with nothing to open yet.
  it("renders a branch with no pull request by its branch name", async () => {
    const noPr: PrStack = {
      ...stack,
      entries: [entry(1, "auth"), entry(0, "ui", { title: "", state: "none" })],
    };
    const html = await renderToHtml(<PrStackList stack={noPr} />);

    expect(textOf(html)).toContain("ui");
    expect(html).toContain("This branch has no PR yet");
  });
});
