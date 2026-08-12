import { describe, expect, it } from "bun:test";
import { textOf } from "../../test/render";
import { parsePatch } from "./diff";
import { cellHtml, highlightDiff, rowHtml } from "./highlight";

const rowsOf = (...lines: string[]) => parsePatch(lines.join("\n"));

/** The text a row's colored markup renders as. */
const text = (html: string | null) => textOf(html ?? "");

describe("highlightDiff", () => {
  it("colors a line by the file's grammar", () => {
    const rows = rowsOf("@@ -1,1 +1,1 @@", "+const a = 1;");
    const html = highlightDiff(rows, "src/a.ts").right(1);
    expect(html).toContain("hljs-keyword");
    expect(text(html)).toBe("const a = 1;");
  });

  it("leaves files it has no grammar for uncolored", () => {
    const rows = rowsOf("@@ -1,1 +1,1 @@", "+const a = 1;");
    expect(highlightDiff(rows, "notes.txt").right(1)).toBeNull();
  });

  // The old and new files are two different documents. Colored as one stream,
  // a deleted line and the addition that replaces it would be read as
  // consecutive code — an unterminated string on the left would then swallow
  // the line on the right.
  it("colors each side against its own file", () => {
    const rows = rowsOf(
      "@@ -1,2 +1,2 @@",
      '-const a = "unclosed;',
      "+const a = 1;",
      " const b = 2;",
    );
    const syntax = highlightDiff(rows, "a.ts");
    expect(syntax.right(1)).toContain("hljs-number");
    expect(text(syntax.right(1))).toBe("const a = 1;");
    expect(text(syntax.left(1))).toBe('const a = "unclosed;');
  });

  // A block comment opened above a hunk still colors the lines below it.
  it("carries a multi-line token across the rows it spans", () => {
    const rows = rowsOf("@@ -1,3 +1,3 @@", " /* one", "+   two", " */");
    const syntax = highlightDiff(rows, "a.ts");
    expect(syntax.right(1)).toContain("hljs-comment");
    expect(syntax.right(2)).toContain("hljs-comment");
  });

  it("has nothing for a line number the patch does not carry", () => {
    const syntax = highlightDiff(rowsOf("@@ -1,1 +1,1 @@", "+const a = 1;"), "a.ts");
    expect(syntax.right(99)).toBeNull();
    expect(syntax.right(null)).toBeNull();
  });
});

describe("rowHtml", () => {
  it("keeps the marker column ahead of the colored line", () => {
    const rows = rowsOf("@@ -1,1 +1,1 @@", "+const a = 1;");
    const html = rowHtml(rows[1], highlightDiff(rows, "a.ts"));
    expect(text(html)).toBe("+const a = 1;");
  });

  it("reads a deleted row against the old file", () => {
    const rows = rowsOf("@@ -1,1 +1,0 @@", "-const gone = 1;");
    const html = rowHtml(rows[1], highlightDiff(rows, "a.ts"));
    expect(text(html)).toBe("-const gone = 1;");
  });

  // Hunk headers and `\ No newline` markers are not source code, so there is
  // nothing to color and the views fall back to rendering them as text.
  it("colors nothing that is not a line of the file", () => {
    const rows = rowsOf("@@ -1,1 +1,1 @@", "+a", "\\ No newline at end of file");
    const syntax = highlightDiff(rows, "a.ts");
    expect(rowHtml(rows[0], syntax)).toBeNull();
    expect(rowHtml(rows[2], syntax)).toBeNull();
  });
});

describe("cellHtml", () => {
  it("picks the side the cell belongs to", () => {
    const rows = rowsOf("@@ -1,1 +1,1 @@", "-const old = 1;", "+const fresh = 2;");
    const syntax = highlightDiff(rows, "a.ts");
    expect(text(cellHtml({ kind: "del", text: "const old = 1;", line: 1 }, syntax))).toBe(
      "const old = 1;",
    );
    expect(text(cellHtml({ kind: "add", text: "const fresh = 2;", line: 1 }, syntax))).toBe(
      "const fresh = 2;",
    );
  });
});

describe("highlightDiff with the whole file", () => {
  // The reason the whole file is fetched at all. The hunk starts three lines
  // into a block comment, so nothing in the patch says the lexer is inside one.
  const headLines = [
    "/**",
    " * Reveals the code a patch left out, on demand.",
    " *",
    " * The file's full text is only fetched once the reader asks.",
    " */",
    "const reveal = 1;",
  ];
  // Every line carries the marker column on top of its own indentation, so the
  // context line for ` */` in the file is `  */` in the patch.
  const rows = rowsOf(
    "@@ -4,2 +4,2 @@",
    "- * The file's full text is fetched up front.",
    "+ * The file's full text is only fetched once the reader asks.",
    "  */",
  );

  it("colors a hunk that opens inside a block comment", () => {
    expect(highlightDiff(rows, "a.ts", headLines).right(4)).toContain("hljs-comment");
  });

  it("cannot tell it is in a comment from the patch alone", () => {
    expect(highlightDiff(rows, "a.ts").right(4)).not.toContain("hljs-comment");
  });

  // The old side comes from reversing the patch onto the new file, so it gets
  // the same whole-file context without a second fetch.
  it("colors the old side from the rebuilt file", () => {
    const left = highlightDiff(rows, "a.ts", headLines).left(4);
    expect(left).toContain("hljs-comment");
    expect(text(left)).toBe(" * The file's full text is fetched up front.");
  });

  // A patch the file does not corroborate must not color the old side against
  // lines it does not have. It drops to the patch's own fragments, which are
  // still self-consistent — so the line is colored, but without the context
  // that would have told the lexer it is inside a comment.
  it("falls back to the patch for the old side when the rebuild is declined", () => {
    const stale = ["/**", " * something else entirely", " */"];
    const left = highlightDiff(rows, "a.ts", stale).left(4);
    expect(left).not.toBeNull();
    expect(left).not.toContain("hljs-comment");
  });

  it("drops coloring for a file past the size cap", () => {
    const huge = Array.from({ length: 20_001 }, (_, i) => `const a${i} = ${i};`);
    expect(
      highlightDiff(rowsOf("@@ -1,1 +1,1 @@", " const a0 = 0;"), "a.ts", huge).right(1),
    ).toBeNull();
  });

  it("drops coloring for a minified file on one enormous line", () => {
    const minified = [`const a=${"1+".repeat(1_500)}1;`];
    expect(
      highlightDiff(rowsOf("@@ -1,1 +1,1 @@", ` ${minified[0]}`), "a.ts", minified).right(1),
    ).toBeNull();
  });
});
