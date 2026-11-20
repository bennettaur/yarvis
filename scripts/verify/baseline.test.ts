import { describe, expect, it } from "bun:test";
import { compareRuns, isTouched, parseJunit, testSpans } from "./baseline.ts";

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="src/a.test.ts" file="src/a.test.ts">
    <testcase name="adds &amp; returns" classname="sum" file="src/a.test.ts" line="3" />
    <testcase name="rejects" classname="sum" file="src/a.test.ts" line="7">
      <failure type="AssertionError" />
    </testcase>
    <testcase name="later" classname="sum" file="src/a.test.ts" line="9">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>`;

describe("parseJunit", () => {
  it("reads each testcase's outcome", () => {
    expect(parseJunit(JUNIT, "")).toEqual([
      { file: "src/a.test.ts", name: "sum > adds & returns", outcome: "pass", line: 3 },
      { file: "src/a.test.ts", name: "sum > rejects", outcome: "fail", line: 7 },
      { file: "src/a.test.ts", name: "sum > later", outcome: "skip", line: 9 },
    ]);
  });

  it("prefixes the file with the suite directory", () => {
    expect(parseJunit(JUNIT, "sidecar")[0].file).toBe("sidecar/src/a.test.ts");
  });
});

describe("compareRuns", () => {
  const test = (name: string, outcome: "pass" | "fail" | "skip") => ({
    file: "a.test.ts",
    name,
    outcome,
    line: null,
  });

  it("sorts tests by whether they catch the change being reverted", () => {
    const head = [test("new", "pass"), test("old", "pass"), test("broken", "fail")];
    const base = [test("new", "fail"), test("old", "pass")];
    expect(compareRuns(head, base)).toEqual({
      detecting: 1,
      notDetecting: ["a.test.ts > old"],
      failingOnHead: ["a.test.ts > broken"],
    });
  });

  it("counts a test missing on the base as detecting, since its file couldn't load there", () => {
    expect(compareRuns([test("new", "pass")], []).detecting).toBe(1);
  });
});

const SOURCE = `import { describe, expect, it, test } from "bun:test";

describe("outer", () => {
  beforeEach(() => reset());
  it("first", () => {
    expect(1).toBe(1);
  });
  test.each([1, 2])("each %p", (n) => {
    expect(n).toBeGreaterThan(0);
  });
});
`;

describe("testSpans", () => {
  it("finds every it and test call, including test.each's outer call", () => {
    expect(testSpans(SOURCE, "a.test.ts")).toEqual([
      [5, 7],
      [8, 10],
    ]);
  });

  it("parses JSX in a .tsx file", () => {
    const source = 'it("renders", () => {\n  render(<Panel open />);\n});\n';
    expect(testSpans(source, "a.test.tsx")).toEqual([[1, 3]]);
  });

  it("returns null for a file it can't parse", () => {
    expect(testSpans("it(", "a.test.ts")).toBeNull();
  });
});

describe("isTouched", () => {
  const spans = testSpans(SOURCE, "a.test.ts");

  it("counts an edit inside the test's call", () => {
    expect(isTouched(5, spans, [[6, 6]])).toBe(true);
  });

  it("ignores edits outside it: imports, hooks, other tests", () => {
    expect(
      isTouched(5, spans, [
        [1, 1],
        [4, 4],
        [9, 9],
      ]),
    ).toBe(false);
  });

  it("uses test.each's outer call, not just the table", () => {
    expect(isTouched(8, spans, [[9, 9]])).toBe(true);
  });

  it("counts a deletion only when both lines around it are in the test", () => {
    expect(isTouched(5, spans, [[5, 6]])).toBe(true);
    expect(isTouched(5, spans, [[7, 8]])).toBe(false);
  });

  it("counts a test it can't place, so nothing is hidden", () => {
    expect(isTouched(null, spans, [])).toBe(true);
    expect(isTouched(5, null, [])).toBe(true);
    expect(isTouched(2, spans, [])).toBe(true);
  });
});
