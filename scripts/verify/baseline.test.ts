import { describe, expect, it } from "bun:test";
import { compareRuns, parseJunit } from "./baseline.ts";

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
      { file: "src/a.test.ts", name: "sum > adds & returns", outcome: "pass" },
      { file: "src/a.test.ts", name: "sum > rejects", outcome: "fail" },
      { file: "src/a.test.ts", name: "sum > later", outcome: "skip" },
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
