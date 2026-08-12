import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToHtml } from "../../test/render";
import DiffView from "./DiffView";

const render = (patch: string, path: string) =>
  renderToHtml(createElement(DiffView, { patch, path }));

const stripTags = (html: string) => html.replace(/<[^>]*>/g, "");

describe("DiffView", () => {
  const patch = ["@@ -1,2 +1,2 @@", "-const a = 1;", "+const a = 2;"].join("\n");

  it("colors the code by the path it was opened for", async () => {
    const html = await render(patch, "src/lib/a.ts");
    expect(html).toContain("hljs-keyword");
    expect(stripTags(html)).toContain("+const a = 2;");
    expect(stripTags(html)).toContain("-const a = 1;");
  });

  it("renders a file it has no grammar for as plain text", async () => {
    const html = await render(patch, "notes.txt");
    expect(html).not.toContain("hljs-");
    expect(html).toContain("+const a = 2;");
  });

  // The workspace diff arrives straight from `git diff`, header block and all.
  it("keeps git's file header out of the rendered rows", async () => {
    const html = await render(
      ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", patch].join("\n"),
      "a.ts",
    );
    expect(stripTags(html)).not.toContain("diff --git");
    expect(stripTags(html)).not.toContain("+++ b/a.ts");
  });

  it("says so when there is no diff to show", async () => {
    const html = await render("", "a.ts");
    expect(html).toContain("No textual diff");
  });
});
