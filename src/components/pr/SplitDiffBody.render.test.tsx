import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { PrFile, PrRef, ReviewThread } from "../../lib/pr/types";
import { renderToHtml } from "../../test/render";
import SplitDiffBody from "./SplitDiffBody";

const prRef: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 1 };

const file: PrFile = {
  filename: "foo.ts",
  status: "modified",
  additions: 0,
  deletions: 0,
  patch: "",
};

const render = (patch: string, threads: ReviewThread[] = []) =>
  renderToHtml(createElement(SplitDiffBody, { prRef, file: { ...file, patch }, patch, threads }));

describe("SplitDiffBody", () => {
  // The whole point of the split view: the old file's numbering on the left and
  // the new file's on the right, which diverge as soon as a hunk adds a line.
  it("renders both files' line numbers", async () => {
    const html = await render(["@@ -10,2 +20,2 @@", " a", "-old", "+new"].join("\n"));
    expect(html).toContain(">10<");
    expect(html).toContain(">20<");
    expect(html).toContain(">11<");
    expect(html).toContain(">21<");
  });

  it("strips the marker column from the code cells", async () => {
    const html = await render(["@@ -1,1 +1,1 @@", "-old()", "+new()"].join("\n"));
    expect(html).toContain(">old()<");
    expect(html).toContain(">new()<");
    expect(html).not.toContain(">-old()<");
    expect(html).not.toContain(">+new()<");
  });

  // Hunk headers belong to neither file, so they run the full width instead of
  // being pushed into one of the two columns.
  it("spans hunk headers across both columns", async () => {
    const html = await render(["@@ -1,1 +1,1 @@", "+a"].join("\n"));
    expect(html).toContain("col-span-4");
    expect(html).toContain("@@ -1,1 +1,1 @@");
  });

  // Three deletions across from one addition leaves two right-hand cells empty;
  // they get the filler background so the gap reads as "nothing here" rather
  // than as an unchanged blank line.
  it("fills the blank half of an uneven change", async () => {
    const html = await render(["@@ -1,3 +1,1 @@", "-a", "-b", "-c", "+d"].join("\n"));
    expect(html).toContain("bg-zinc-900/40");
  });

  const CONTAINER_MARKER = "font-sans";

  it("renders no comment container on lines without comments", async () => {
    const html = await render(["@@ -1,2 +1,2 @@", "-a", "+b"].join("\n"));
    expect(html).not.toContain(CONTAINER_MARKER);
  });

  it("anchors a thread to its right-side line", async () => {
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

  // Deleted lines only exist on the left, and neither provider accepts a
  // comment anchored there, so no composer is offered against them.
  it("offers the composer only where there is a right-side line", async () => {
    const html = await render(["@@ -1,2 +1,1 @@", "-a", "-b"].join("\n"));
    expect(html).not.toContain("Comment on this line");
  });
});
