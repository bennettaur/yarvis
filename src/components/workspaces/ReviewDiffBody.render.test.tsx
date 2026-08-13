import { afterEach, describe, expect, it } from "bun:test";
import type { CreateReviewCommentInput, ReviewComment } from "../../lib/workspaceReview";
import { mountForInteraction } from "../../test/render";
import ReviewDiffBody from "./ReviewDiffBody";

const PATCH = [
  "@@ -1,3 +1,5 @@",
  " const a = 1;",
  "+const b = 2;",
  "+const c = 3;",
  "-const gone = 0;",
  " const d = 4;",
].join("\n");

const COMMENT: ReviewComment = {
  id: "c-1",
  workspaceRepoId: "wr-1",
  path: "src/a.ts",
  startLine: 2,
  endLine: 3,
  commitSha: "abc1234def",
  body: "Fold these together.",
  resolvedAt: null,
  createdAt: "2026-06-01T09:00:00.000Z",
  updatedAt: "2026-06-01T09:00:00.000Z",
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

/** Mounts the body over one patch; every field has a default worth reading past. */
const render = async ({
  patch = PATCH,
  path = "src/a.ts",
  comments = [],
  onAdd = async () => {},
}: {
  patch?: string;
  path?: string;
  comments?: ReviewComment[];
  onAdd?: (input: CreateReviewCommentInput) => Promise<void>;
} = {}) => {
  const mounted = await mountForInteraction(
    <ReviewDiffBody
      patch={patch}
      path={path}
      workspaceRepoId="wr-1"
      comments={comments}
      onAdd={onAdd}
      onToggleResolved={() => {}}
      onDelete={() => {}}
    />,
  );
  unmount = mounted.unmount;
  return mounted.host;
};

const mount = async (
  comments: ReviewComment[],
  onAdd: (input: CreateReviewCommentInput) => Promise<void> = async () => {},
) => render({ comments, onAdd });

/** The line-number gutters, in render order — the drag handles under test. */
const gutters = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLElement>("span.cursor-ns-resize"),
];

/**
 * Presses on one gutter, moves to another, and releases — with nothing settling
 * in between, which is the point: the window `mouseup` is registered from the
 * mousedown handler itself, so even a release in the same tick is caught.
 *
 * The move is dispatched as `mouseover` because React synthesises `onMouseEnter`
 * from it; dispatching `mouseenter` directly reaches nothing and would leave
 * this passing as a single-line click.
 */
const drag = async (host: HTMLElement, fromIndex: number, toIndex: number) => {
  const cells = gutters(host);
  cells[fromIndex]?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  cells[toIndex]?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  await settle();
};

/**
 * Types into the open composer. React tracks the last value it wrote, so a
 * direct assignment looks like a no-op to it — go through the prototype setter
 * it doesn't shadow.
 */
const type = async (host: HTMLElement, text: string) => {
  const textarea = host.querySelector("textarea");
  if (!textarea) throw new Error("no composer is open");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
    textarea,
    text,
  );
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
};

describe("ReviewDiffBody", () => {
  it("hangs an existing comment under the last line of its range", async () => {
    const host = await mount([COMMENT]);
    expect(host.textContent).toContain("Fold these together.");
    expect(host.textContent).toContain("line 2-3");
  });

  it("opens a composer for the single line a plain click lands on", async () => {
    const host = await mount([]);
    await drag(host, 0, 0);
    expect(host.textContent).toContain("Line 1");
  });

  it("opens a composer covering every line a drag crossed", async () => {
    const host = await mount([]);
    // Gutter 0 is the context line 1; gutter 2 is the second added line, 3.
    await drag(host, 0, 2);
    expect(host.textContent).toContain("Lines 1–3");
  });

  it("saves the dragged range as the comment's line span", async () => {
    const saved: CreateReviewCommentInput[] = [];
    const host = await mount([], async (input) => {
      saved.push(input);
    });
    await drag(host, 1, 2);
    await type(host, "Squash these.");

    const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save comment");
    save?.click();
    await settle();

    expect(saved).toEqual([
      {
        workspaceRepoId: "wr-1",
        path: "src/a.ts",
        startLine: 2,
        endLine: 3,
        body: "Squash these.",
      },
    ]);
  });

  it("reads a drag up the gutter the same as a drag down it", async () => {
    const host = await mount([]);
    await drag(host, 2, 0);
    expect(host.textContent).toContain("Lines 1–3");
  });

  // A deleted line exists only in the old file, so there is no line in the
  // change to anchor a note to — the same side a PR review comments on.
  it("offers no comment handle on a deleted line", async () => {
    const host = await mount([]);
    // Four rows carry a right-hand line (1, 2, 3, 4); the deletion carries none.
    expect(gutters(host)).toHaveLength(4);
    expect(host.querySelectorAll('[aria-label="Comment on this line"]')).toHaveLength(4);
  });

  it("keeps the typed text and shows the reason when a save fails", async () => {
    const host = await mount([], async () => {
      throw new Error("sidecar is down");
    });
    await drag(host, 0, 0);
    await type(host, "Worth keeping.");

    const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save comment");
    save?.click();
    await settle();

    expect(host.textContent).toContain("sidecar is down");
    expect(host.querySelector("textarea")?.value).toBe("Worth keeping.");
    // Still offering to save, rather than stuck reading "Saving…".
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Save comment")).toBe(
      true,
    );
  });

  it("closes the composer on cancel without saving", async () => {
    const saved: CreateReviewCommentInput[] = [];
    const host = await mount([], async (input) => {
      saved.push(input);
    });
    await drag(host, 0, 0);
    await type(host, "Never mind.");

    const cancel = [...host.querySelectorAll("button")].find((b) => b.textContent === "Cancel");
    cancel?.click();
    await settle();

    expect(host.querySelector("textarea")).toBeNull();
    expect(saved).toEqual([]);
  });

  // Clicking a line number while a composer holds unsaved text would otherwise
  // move the composer and take the text with it.
  it("leaves an open composer alone when another line is clicked", async () => {
    const host = await mount([]);
    await drag(host, 0, 0);
    await type(host, "Half-written.");

    await drag(host, 2, 2);
    expect(host.textContent).toContain("Line 1");
    expect(host.querySelector("textarea")?.value).toBe("Half-written.");
  });

  it("says so when the file has no textual diff", async () => {
    const host = await render({ patch: "", path: "logo.png" });
    expect(host.textContent).toContain("No textual diff");
  });

  it("colors the code by the path the file was opened for", async () => {
    const host = await render({ path: "src/a.ts" });
    expect(host.innerHTML).toContain("hljs-keyword");
    // The coloring wraps each token in its own span, so what the line *says*
    // has to be read through the text rather than matched in the markup.
    expect(host.textContent).toContain("+const b = 2;");
  });

  it("renders a file it has no grammar for as plain text", async () => {
    const host = await render({ path: "notes.txt" });
    expect(host.innerHTML).not.toContain("hljs-");
    expect(host.textContent).toContain("+const b = 2;");
  });

  // A workspace diff arrives straight from `git diff`, header block and all.
  it("keeps git's file header out of the rendered rows", async () => {
    const host = await render({
      patch: ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", PATCH].join("\n"),
    });
    expect(host.textContent).not.toContain("diff --git");
    expect(host.textContent).not.toContain("+++ b/a.ts");
  });
});
