import { describe, expect, it } from "bun:test";
import { baseFileLines } from "./baseFile";
import { parsePatch } from "./diff";

const head = (...lines: string[]) => lines;
const patch = (...lines: string[]) => parsePatch(lines.join("\n"));

describe("baseFileLines", () => {
  it("puts a replaced line back", () => {
    expect(
      baseFileLines(
        head("one", "TWO", "three"),
        patch("@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"),
      ),
    ).toEqual(["one", "two", "three"]);
  });

  it("takes added lines back out", () => {
    expect(
      baseFileLines(
        head("one", "two", "three"),
        patch("@@ -1,1 +1,3 @@", " one", "+two", "+three"),
      ),
    ).toEqual(["one"]);
  });

  it("puts deleted lines back", () => {
    expect(
      baseFileLines(
        head("one", "four"),
        patch("@@ -1,4 +1,2 @@", " one", "-two", "-three", " four"),
      ),
    ).toEqual(["one", "two", "three", "four"]);
  });

  it("carries the stretches between hunks through untouched", () => {
    const headLines = head("a", "B", "c", "d", "e", "F");
    const rows = patch("@@ -2,1 +2,1 @@", "-b", "+B", "@@ -6,1 +6,1 @@", "-f", "+F");
    expect(baseFileLines(headLines, rows)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  // `+n,0` marks an insertion point rather than a line the hunk covers, so the
  // hunk consumes nothing from the new file.
  it("handles a hunk that only deletes", () => {
    expect(baseFileLines(head("one", "two"), patch("@@ -2,1 +1,0 @@", "-gone"))).toEqual([
      "one",
      "gone",
      "two",
    ]);
  });

  it("rebuilds a file created by the change as empty", () => {
    expect(baseFileLines(head("one", "two"), patch("@@ -0,0 +1,2 @@", "+one", "+two"))).toEqual([]);
  });

  // The safety net. A provider truncates the patch of a large file, and the
  // content fetch can land on a newer commit than the diff was taken at —
  // colouring the old side against lines it does not have is worse than
  // leaving it plain.
  it("declines when the patch does not match the file it is applied to", () => {
    expect(
      baseFileLines(
        head("one", "SOMETHING ELSE", "three"),
        patch("@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"),
      ),
    ).toBeNull();
  });

  it("declines when a hunk reaches past the end of the file", () => {
    expect(
      baseFileLines(head("one"), patch("@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three")),
    ).toBeNull();
  });

  it("declines when the hunk header disagrees with the lines under it", () => {
    expect(
      baseFileLines(head("one", "two"), patch("@@ -1,9 +1,9 @@", " one", "-two", "+TWO")),
    ).toBeNull();
  });

  it("declines a patch whose first hunk header was cut off", () => {
    expect(baseFileLines(head("one"), patch("+one"))).toBeNull();
  });

  it("declines when hunks arrive out of order", () => {
    const rows = patch("@@ -5,1 +5,1 @@", "-e", "+E", "@@ -1,1 +1,1 @@", "-a", "+A");
    expect(baseFileLines(head("A", "b", "c", "d", "E"), rows)).toBeNull();
  });

  // "\ No newline at end of file" describes the line above rather than being
  // one, so a line-based rebuild has nothing to do with it.
  it("ignores the no-newline marker", () => {
    expect(
      baseFileLines(
        head("one", "TWO"),
        patch("@@ -1,2 +1,2 @@", " one", "-two", "\\ No newline at end of file", "+TWO"),
      ),
    ).toEqual(["one", "two"]);
  });

  // `git diff` ends its output with a newline, which leaves `parsePatch` a
  // final empty row. Caught by replaying real history through this function,
  // where it declined every patch.
  it("tolerates the empty row a trailing newline leaves behind", () => {
    const rows = parsePatch(["@@ -1,2 +1,2 @@", " one", "-two", "+TWO", ""].join("\n"));
    expect(baseFileLines(head("one", "TWO"), rows)).toEqual(["one", "two"]);
  });
});
