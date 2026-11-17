import { describe, expect, it } from "bun:test";
import { parsePatch } from "../pr/diff";
import { chapterRead, rowsInRange, storyChapters } from "./story";
import type { VerificationChangeMap } from "./verification";

const map: VerificationChangeMap = {
  intent: "Cache user lookups.",
  unmapped: ["README.md"],
  themes: [
    {
      title: "Cache lookups",
      description: "d",
      risk: "high",
      cohesion: "core",
      question: "",
      files: [{ path: "src/cache.ts" }],
    },
    {
      title: "Bump timeout",
      description: "d",
      risk: "low",
      cohesion: "outlier",
      question: "Why?",
      files: [{ path: "src/http.ts", lines: { start: 4, end: 4 } }],
    },
  ],
};

describe("the story's chapters", () => {
  it("follows the change map's order and closes with the files no theme names", () => {
    const chapters = storyChapters(map);
    expect(chapters.map((c) => [c.title, c.cohesion, c.files.map((f) => f.path)])).toEqual([
      ["Cache lookups", "core", ["src/cache.ts"]],
      ["Bump timeout", "outlier", ["src/http.ts"]],
      ["Everything else", null, ["README.md"]],
    ]);
    expect(storyChapters({ ...map, unmapped: [] })).toHaveLength(2);
  });

  it("counts a chapter read once every file in it is viewed", () => {
    const [first] = storyChapters(map);
    expect(chapterRead(first!, new Set())).toBe(false);
    expect(chapterRead(first!, new Set(["src/cache.ts"]))).toBe(true);
  });
});

describe("a file's part in a chapter", () => {
  const patch = [
    "diff --git a/f.ts b/f.ts",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    "@@ -20,2 +19,0 @@",
    "-gone",
    "-also gone",
    "@@ -40,2 +38,3 @@",
    " forty",
    "+added",
    " forty-one",
  ].join("\n");
  const rows = parsePatch(patch);
  const texts = (r: ReturnType<typeof parsePatch>) => r.map((row) => row.text);

  it("shows the whole patch, without git's header, when the theme covers the whole file", () => {
    expect(texts(rowsInRange(rows))).toEqual(texts(rows));
    expect(texts(rowsInRange(rows))[0]).toBe("@@ -1,3 +1,3 @@");
  });

  it("keeps only the hunks that touch the theme's lines, a removal by where it was", () => {
    expect(texts(rowsInRange(rows, { start: 38, end: 40 }))).toEqual([
      "@@ -40,2 +38,3 @@",
      " forty",
      "+added",
      " forty-one",
    ]);
    expect(texts(rowsInRange(rows, { start: 19, end: 21 }))).toEqual([
      "@@ -20,2 +19,0 @@",
      "-gone",
      "-also gone",
    ]);
    expect(rowsInRange(rows, { start: 100, end: 120 })).toEqual([]);
  });
});
