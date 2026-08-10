import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { PrFile, PrRef, ReviewThread } from "../../lib/pr/types";
import { fakeExpansion } from "../../test/expansion";
import { renderToHtml } from "../../test/render";
import { DiffBody } from "./PrFileDiffs";

const prRef: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 1 };

const file: PrFile = {
  filename: "foo.ts",
  status: "modified",
  additions: 0,
  deletions: 2,
  patch: "",
};

const render = (
  patch: string,
  threads: ReviewThread[] = [],
  highlight?: { start: number; end: number } | null,
) =>
  renderToHtml(
    createElement(DiffBody, {
      prRef,
      file: { ...file, patch },
      threads,
      expansion: fakeExpansion(patch),
      highlight,
    }),
  );

describe("DiffBody comment-container rendering", () => {
  // The thread card's own border, not `font-sans` — that class is also on the
  // gap marker and the insight block, so a fixture containing either would make
  // the negative assertions below pass for the wrong reason.
  const CONTAINER_MARKER = "space-y-2 px-3 py-2 font-sans";

  // Deleted rows carry no right-side line number, so the empty comment
  // container must not render under them — otherwise its vertical padding
  // shows up as a blank gap between consecutive removed lines.
  it("renders no comment container under deleted lines when there are no threads", async () => {
    const patch = ["@@ -1,3 +1,1 @@", "-a", "-b", " c"].join("\n");
    const html = await render(patch);
    expect(html).not.toContain(CONTAINER_MARKER);
  });

  // Hunk headers also carry no right-side line number and must stay gap-free,
  // exactly like deleted lines — the guard keys off the missing line, not the
  // row kind.
  it("renders no comment container under added lines or hunk headers absent threads", async () => {
    const html = await render(["@@ -1,0 +1,2 @@", "+a", "+b"].join("\n"));
    expect(html).not.toContain(CONTAINER_MARKER);
  });

  // The gap markers size themselves from the hunk header, so the offer to see
  // more context is there before any file content has been fetched.
  it("offers to reveal the code above a hunk that does not start at line 1", async () => {
    const html = await render(["@@ -40,1 +40,1 @@", "+x"].join("\n"));
    expect(html).toContain("⋯ 39 lines");
  });

  it("offers nothing to reveal when the hunk covers the file from line 1", async () => {
    const html = await render(["@@ -1,1 +1,1 @@", "+x"].join("\n"));
    expect(html).not.toContain("⋯");
  });

  // The other half of the guard: a real thread on a commentable line must still
  // render its container, so the fix can't regress by suppressing every one.
  it("renders the comment container on a line that has a thread", async () => {
    const thread: ReviewThread = {
      path: file.filename,
      line: 2,
      isResolved: false,
      comments: [{ author: "octocat", body: "needs a guard", createdAt: "" }],
    };
    const html = await render(["@@ -1,2 +1,2 @@", " a", "+b"].join("\n"), [thread]);
    expect(html).toContain(CONTAINER_MARKER);
    expect(html).toContain("needs a guard");
  });
});

describe("DiffBody guided-review highlighting", () => {
  const patch = ["@@ -1,4 +1,4 @@", " a", "+b", "+c", " d"].join("\n");

  it("marks only the lines in the range", async () => {
    const html = await render(patch, [], { start: 2, end: 3 });
    // Three marked edges would mean the unmarked context lines got one too.
    expect(html.split("inset 3px").length - 1).toBe(2);
  });

  // The scroll target: without an anchor the jump lands on the file header and
  // the reader has to find the lines themselves.
  it("anchors the first line of the range for scrolling", async () => {
    const html = await render(patch, [], { start: 2, end: 3 });
    expect(html.split("data-pr-focus").length - 1).toBe(1);
  });

  it("marks nothing without a range", async () => {
    expect(await render(patch)).not.toContain("inset 3px");
    expect(await render(patch, [], null)).not.toContain("data-pr-focus");
  });

  // Deleted lines carry no right-side number, which is what the range is in.
  it("does not mark a deleted line", async () => {
    const deletions = ["@@ -1,2 +1,1 @@", " a", "-gone"].join("\n");
    expect(await render(deletions, [], { start: 1, end: 5 })).toContain("inset 3px");
    expect((await render(deletions, [], { start: 1, end: 5 })).split("inset 3px").length - 1).toBe(
      1,
    );
  });
});
