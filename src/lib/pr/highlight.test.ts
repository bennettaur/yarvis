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
