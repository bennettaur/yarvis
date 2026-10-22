import { describe, expect, it } from "bun:test";
import { selectionLines } from "./lineActions";
import type { EditorZone } from "./types";
import { diffZones, type LineChange, originalLineInModified, placeZones } from "./zones";

// Original 1-10 against a modified file where 3-4 were replaced by one line,
// 7 was deleted, and two lines were inserted after 9.
const CHANGES: LineChange[] = [
  {
    originalStartLineNumber: 3,
    originalEndLineNumber: 4,
    modifiedStartLineNumber: 3,
    modifiedEndLineNumber: 3,
  },
  {
    originalStartLineNumber: 7,
    originalEndLineNumber: 7,
    modifiedStartLineNumber: 5,
    modifiedEndLineNumber: 0,
  },
  {
    originalStartLineNumber: 9,
    originalEndLineNumber: 0,
    modifiedStartLineNumber: 7,
    modifiedEndLineNumber: 8,
  },
];

describe("originalLineInModified", () => {
  it("maps unchanged lines to their twins, shifted by the changes above", () => {
    expect(originalLineInModified(1, CHANGES)).toBe(1);
    expect(originalLineInModified(5, CHANGES)).toBe(4);
    expect(originalLineInModified(8, CHANGES)).toBe(6);
    expect(originalLineInModified(9, CHANGES)).toBe(7);
    expect(originalLineInModified(10, CHANGES)).toBe(10);
  });

  it("puts a replaced line after its replacement", () => {
    expect(originalLineInModified(3, CHANGES)).toBe(3);
    expect(originalLineInModified(4, CHANGES)).toBe(3);
  });

  it("puts a deleted line where the deletion happened", () => {
    expect(originalLineInModified(7, CHANGES)).toBe(5);
  });

  it("handles a deletion at the very top of the file", () => {
    // Original lines 1-2 removed; Monaco reports the modified side as "after line 0".
    const top: LineChange[] = [
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 0,
        modifiedEndLineNumber: 0,
      },
    ];
    expect(originalLineInModified(1, top)).toBe(0);
    expect(originalLineInModified(2, top)).toBe(0);
    expect(originalLineInModified(3, top)).toBe(1);
    expect(originalLineInModified(10, top)).toBe(8);
  });

  it("keeps the line above the file at 0", () => {
    expect(originalLineInModified(0, CHANGES)).toBe(0);
    expect(originalLineInModified(0, [])).toBe(0);
  });
});

describe("placeZones", () => {
  const zone = (id: string, side: "LEFT" | "RIGHT", afterLine: number): EditorZone => ({
    id,
    side,
    afterLine,
    render: () => null,
  });
  const zones = [zone("l", "LEFT", 7), zone("r", "RIGHT", 2)];

  it("keeps each zone on its own side when side by side", () => {
    const placed = placeZones(zones, true, CHANGES);
    expect(placed.get("l")).toEqual({ editor: "LEFT", afterLine: 7 });
    expect(placed.get("r")).toEqual({ editor: "RIGHT", afterLine: 2 });
  });

  it("moves left zones into the modified editor when inline", () => {
    const placed = placeZones(zones, false, CHANGES);
    expect(placed.get("l")).toEqual({ editor: "RIGHT", afterLine: 5 });
    expect(placed.get("r")).toEqual({ editor: "RIGHT", afterLine: 2 });
  });
});

describe("diffZones", () => {
  const same = (a: { line: number }, b: { line: number }) => a.line === b.line;

  it("adds new zones, removes gone ones and leaves unmoved ones alone", () => {
    const current = new Map([
      ["keep", { line: 1 }],
      ["gone", { line: 2 }],
      ["moved", { line: 3 }],
    ]);
    const next = new Map([
      ["keep", { line: 1 }],
      ["moved", { line: 4 }],
      ["new", { line: 5 }],
    ]);
    const { add, remove } = diffZones(current, next, same);
    expect(remove.sort()).toEqual(["gone", "moved"]);
    expect(add).toEqual([
      ["moved", { line: 4 }],
      ["new", { line: 5 }],
    ]);
  });
});

describe("selectionLines", () => {
  it("covers every line the selection touches", () => {
    expect(selectionLines({ startLineNumber: 2, endLineNumber: 4, endColumn: 3 })).toEqual({
      startLine: 2,
      endLine: 4,
    });
  });

  it("drops a last line reached only at its first column", () => {
    expect(selectionLines({ startLineNumber: 2, endLineNumber: 5, endColumn: 1 })).toEqual({
      startLine: 2,
      endLine: 4,
    });
  });

  it("keeps a one-line selection", () => {
    expect(selectionLines({ startLineNumber: 3, endLineNumber: 3, endColumn: 1 })).toEqual({
      startLine: 3,
      endLine: 3,
    });
  });
});
