import { describe, expect, it } from "bun:test";
import { checkDiagram, parseElements } from "./diagram.ts";
import { describeScene } from "./scene.ts";

const scene = (elements: unknown[]) =>
  describeScene(checkDiagram({ elements: parseElements(elements) }));

const box = (id: string, x: number, y: number, extra: object = {}) => ({
  id,
  type: "rectangle",
  x,
  y,
  width: 100,
  height: 50,
  ...extra,
});

describe("what the agent sees of a diagram", () => {
  it("says where each element is, in drawing order, with the arrow's ends", () => {
    const s = scene([
      box("api", 0, 0, { label: { text: "API" } }),
      box("db", 300, 0),
      { id: "api-db", type: "arrow", start: { id: "api" }, end: { id: "db" } },
    ]);
    expect(s.elements).toEqual([
      'api: rectangle at (0, 0) 100x50 label "API"',
      "db: rectangle at (300, 0) 100x50",
      "api-db: arrow api -> db at (100, 25) 200x0",
    ]);
    expect(s.bounds).toBe("(0, 0) to (400, 50)");
    expect(s.problems).toEqual([]);
  });

  it("flags shapes that overlap, but not one drawn inside another", () => {
    const s = scene([
      box("a", 0, 0),
      box("b", 50, 25),
      box("zone", -50, -50, { width: 400, height: 300 }),
    ]);
    expect(s.problems).toEqual(["a and b overlap"]);
  });

  it("flags a label too long for its box, and gives the height it grows to", () => {
    const s = scene([box("a", 0, 0, { label: { text: "a long label ".repeat(8) } })]);
    expect(s.problems[0]).toMatch(/^a's label doesn't fit, so it grows to about \d+ tall/);
    expect(s.elements[0]).toMatch(/grown from 50 to fit its label/);
  });

  it("flags an arrow that passes through a shape it isn't bound to", () => {
    const s = scene([
      box("a", 0, 0),
      box("middle", 200, 0),
      box("b", 400, 0),
      { id: "a-b", type: "arrow", start: { id: "a" }, end: { id: "b" } },
    ]);
    expect(s.problems).toEqual(["arrow a-b crosses middle"]);
  });

  it("sizes a frame to its children when it has no size of its own", () => {
    const s = scene([
      box("a", 0, 0),
      box("b", 200, 100),
      { id: "f", type: "frame", name: "Backend", children: ["a", "b"] },
    ]);
    expect(s.elements[2]).toBe('f: frame "Backend" at (-10, -10) 320x170 holding a, b');
  });

  it("grows an ellipse more than a rectangle for the same label, since less of it holds text", () => {
    const text = "a label that needs a couple of lines";
    const s = scene([
      box("r", 0, 0, { width: 160, height: 60, label: { text } }),
      box("e", 0, 300, { type: "ellipse", width: 160, height: 60, label: { text } }),
    ]);
    const height = (line: string) => Number(line.match(/ \d+x(\d+)/)?.[1]);
    expect(height(s.elements[1]!)).toBeGreaterThan(height(s.elements[0]!));
  });

  it("fits a frame's unset fields to its children and the arrows bound to them", () => {
    const s = scene([
      box("a", 0, 0),
      box("out", 400, 0),
      { id: "a-out", type: "arrow", start: { id: "a" }, end: { id: "out" } },
      { id: "f", type: "frame", children: ["a"], x: -20, y: -20 },
    ]);
    // Placed where it says, and sized to span "a" and the arrow's end at x 400, padded by 10.
    expect(s.elements[3]).toBe("f: frame at (-20, -20) 420x70 holding a");
  });

  it("counts the problems past the first 25 rather than listing them", () => {
    const stacked = Array.from({ length: 10 }, (_, i) => box(`n${i}`, i * 10, 0));
    const s = scene(stacked);
    expect(s.problems).toHaveLength(26);
    expect(s.problems.at(-1)).toBe("...and 20 more");
  });
});
