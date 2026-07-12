import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { PrFile, PrRef } from "../../lib/pr/types";
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

const render = (patch: string) =>
  renderToHtml(createElement(DiffBody, { prRef, file: { ...file, patch }, patch, threads: [] }));

describe("DiffBody deleted-line rendering", () => {
  // Deleted rows carry no right-side line number, so the empty comment
  // container must not render under them — otherwise its vertical padding
  // shows up as a blank gap between consecutive removed lines.
  it("renders no comment container under deleted lines when there are no threads", async () => {
    const patch = ["@@ -1,3 +1,1 @@", "-a", "-b", " c"].join("\n");
    const html = await render(patch);
    // The comment container is the only element with the font-sans class.
    expect(html).not.toContain("font-sans");
  });

  it("treats added and deleted lines identically when there are no threads", async () => {
    const delHtml = await render(["@@ -1,2 +1,0 @@", "-a", "-b"].join("\n"));
    const addHtml = await render(["@@ -1,0 +1,2 @@", "+a", "+b"].join("\n"));
    expect(delHtml).not.toContain("font-sans");
    expect(addHtml).not.toContain("font-sans");
  });
});
