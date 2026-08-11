import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { PrFile, PrRef } from "../../lib/pr/types";
import { prFile as file, setPrFiles } from "../../test/prFiles";
import { renderToHtml } from "../../test/render";

// Imported after the shared stub so its usePrFiles mock is in place.
const { default: PrFileDiffs } = await import("./PrFileDiffs");

const prRef: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 1 };

const render = (data: PrFile[]) => {
  setPrFiles(data);
  return renderToHtml(
    createElement(PrFileDiffs, { prRef, viewed: new Set<string>(), onToggleViewed: () => {} }),
  );
};

/** Filenames in the order their diff sections appear in the rendered output. */
const renderedOrder = (html: string) =>
  [...html.matchAll(/<summary[\s\S]*?<span[^>]*>([^<]+)<\/span>/g)].map((m) => m[1]);

/** The path each diff's anchor id is built from, in render order. */
const anchoredPaths = (html: string, { openOnly = false } = {}) =>
  [...html.matchAll(/<details id="prfile-gh-octo-repo-1-([^"]+)"( open="")?/g)]
    .filter((m) => !openOnly || m[2])
    .map((m) => m[1]);

describe("PrFileDiffs ordering", () => {
  // The bug this guards: the tree sorts its rows while the diff list used to
  // render whatever order the provider returned, so the two panes disagreed.
  it("renders diffs in the tree's order, not the provider's list order", async () => {
    const html = await render([
      file("z.ts"),
      file("src/b.ts"),
      file("a.ts"),
      file("src/a.ts"),
      file("docs/readme.md"),
    ]);
    expect(renderedOrder(html)).toEqual(["docs/readme.md", "src/a.ts", "src/b.ts", "a.ts", "z.ts"]);
  });

  // The other half of the contract: PrFileList scrolls to these ids, so they
  // have to name the file rather than its place in the provider's list.
  it("anchors each diff on the file's path", async () => {
    const html = await render([file("z.ts"), file("src/a.ts")]);
    expect(anchoredPaths(html)).toEqual(["src/a.ts", "z.ts"]);
  });

  // Only the first few files open on mount; "first" has to mean the rows at the
  // top of the tree, which are the ones actually on screen.
  it("opens the files at the top of the tree, not of the provider's list", async () => {
    const html = await render([
      file("z.ts"),
      file("y.ts"),
      file("x.ts"),
      file("w.ts"),
      file("src/a.ts"),
    ]);
    expect(anchoredPaths(html, { openOnly: true })).toEqual(["src/a.ts", "w.ts", "x.ts", "y.ts"]);
  });
});
