import { describe, expect, it } from "bun:test";
import { parseNumstat } from "./collect.ts";

describe("parseNumstat", () => {
  it("reads additions and deletions per file", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\n10\t0\tdocs/b.md\n")).toEqual([
      { path: "src/a.ts", additions: 3, deletions: 1 },
      { path: "docs/b.md", additions: 10, deletions: 0 },
    ]);
  });

  it("counts a binary file as zero lines", () => {
    expect(parseNumstat("-\t-\tpublic/icon.png")).toEqual([
      { path: "public/icon.png", additions: 0, deletions: 0 },
    ]);
  });
});
