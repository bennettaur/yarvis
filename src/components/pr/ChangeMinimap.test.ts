import { describe, expect, it } from "bun:test";
import { parsePatch } from "../../lib/pr/diff";
import { expandAllGaps, expandRows, toFileLines } from "../../lib/pr/expand";
import { changeBands } from "./ChangeMinimap";

const bandsFor = (patch: string, totalLines: number) =>
  changeBands(expandRows(parsePatch(patch), [], new Map()), totalLines);

describe("changeBands", () => {
  it("places a change at its position in the file", () => {
    // One added line at 51 of 100 sits halfway down.
    const bands = bandsFor(["@@ -51,1 +51,1 @@", "+x"].join("\n"), 100);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.top).toBe(50);
    expect(bands[0]!.added).toBe(true);
  });

  it("merges consecutive changed lines into one band", () => {
    const bands = bandsFor(["@@ -1,3 +1,3 @@", "+a", "+b", "+c"].join("\n"), 100);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.height).toBe(3);
  });

  it("keeps changes in separate parts of the file apart", () => {
    const patch = ["@@ -10,1 +10,1 @@", "+a", "@@ -90,1 +90,1 @@", "+b"].join("\n");
    const bands = bandsFor(patch, 100);
    expect(bands.map((b) => b.top)).toEqual([9, 89]);
  });

  // A single changed line in a large file is a fraction of a percent tall and
  // would otherwise render as nothing at all.
  it("floors a band at a visible height", () => {
    const bands = bandsFor(["@@ -500,1 +500,1 @@", "+x"].join("\n"), 5000);
    expect(bands[0]!.height).toBeGreaterThan(0.5);
  });

  // A run that only deletes still marks the spot, coloured to say so.
  it("marks a deletion-only change in red", () => {
    const bands = bandsFor(["@@ -10,2 +9,0 @@", "-a", "-b"].join("\n"), 100);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.added).toBe(false);
  });

  // The whole-file view carries no `@@` headers, so a deletion-only hunk — the
  // one case whose position the header used to supply — has to take its place
  // from the revealed line above it instead.
  it("places a deletion-only change with the headers gone", () => {
    const lines = toFileLines(Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n"));
    const rows = parsePatch(["@@ -5,2 +4,0 @@", "-a", "-b"].join("\n"));
    const bands = changeBands(expandRows(rows, lines, expandAllGaps(rows, lines.length)), 10);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.top).toBe(40);
  });

  it("has nothing to draw for a file of unknown length", () => {
    expect(bandsFor(["@@ -1,1 +1,1 @@", "+x"].join("\n"), 0)).toEqual([]);
  });
});
