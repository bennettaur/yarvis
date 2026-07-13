import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { PrFile, PrRef, ReviewThread } from "../../lib/pr/types";
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

const render = (patch: string, threads: ReviewThread[] = []) =>
  renderToHtml(createElement(DiffBody, { prRef, file: { ...file, patch }, patch, threads }));

describe("DiffBody comment-container rendering", () => {
  // The comment container is the only element with the font-sans class, so its
  // presence in the rendered HTML is a reliable proxy for "a container rendered".
  const CONTAINER_MARKER = "font-sans";

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
