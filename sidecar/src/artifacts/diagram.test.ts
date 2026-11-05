import { describe, expect, it } from "bun:test";
import {
  applyDiagramChanges,
  checkDiagram,
  type Diagram,
  DiagramError,
  diagramChangesSchema,
  type LinearElement,
  MAX_DIAGRAM_ELEMENTS,
  onlyAdds,
  outlinePoint,
  parseDiagram,
  parseElements,
} from "./diagram.ts";

const box = (id: string, x: number, y: number, extra: object = {}) => ({
  id,
  type: "rectangle" as const,
  x,
  y,
  width: 100,
  height: 50,
  ...extra,
});

const base: Diagram = checkDiagram({
  elements: [
    box("api", 0, 0, { label: { text: "API" } }),
    box("db", 300, 0),
    { id: "api-db", type: "arrow", start: { id: "api" }, end: { id: "db" } },
  ],
});

const arrow = (d: Diagram, id: string) =>
  d.elements.find((e) => e.id === id) as LinearElement | undefined;

describe("checking a diagram", () => {
  it("draws an arrow bound at both ends straight between the shapes' outlines", () => {
    expect(arrow(base, "api-db")).toMatchObject({
      x: 100,
      y: 25,
      points: [
        [0, 0],
        [200, 0],
      ],
    });
  });

  it("keeps an unbound arrow where it was drawn", () => {
    const d = checkDiagram({
      elements: [
        {
          id: "free",
          type: "line",
          x: 5,
          y: 6,
          points: [
            [0, 0],
            [10, 20],
            [30, 0],
          ],
        },
      ],
    });
    expect(arrow(d, "free")).toMatchObject({
      x: 5,
      y: 6,
      points: [
        [0, 0],
        [10, 20],
        [30, 0],
      ],
    });
  });

  it("refuses duplicate ids, a binding to something that isn't a shape, and an arrow with no position", () => {
    expect(() => checkDiagram({ elements: [box("a", 0, 0), box("a", 1, 1)] })).toThrow(
      /two elements/,
    );
    expect(() =>
      checkDiagram({
        elements: [
          { id: "t", type: "text", x: 0, y: 0, text: "hi" },
          box("b", 0, 0),
          { id: "e", type: "arrow", start: { id: "t" }, end: { id: "b" } },
        ],
      }),
    ).toThrow(/not a rectangle, ellipse or diamond/);
    expect(() =>
      checkDiagram({ elements: [box("b", 0, 0), { id: "e", type: "arrow", start: { id: "b" } }] }),
    ).toThrow(/needs start and end shapes, or x, y and points/);
  });

  it("refuses a frame holding something missing, a frame, or a child of another frame", () => {
    const frame = (id: string, children: string[]) => ({ id, type: "frame" as const, children });
    expect(() => checkDiagram({ elements: [frame("f", ["nope"])] })).toThrow(/not an element/);
    expect(() => checkDiagram({ elements: [frame("f", []), frame("g", ["f"])] })).toThrow(
      /not an element/,
    );
    expect(() =>
      checkDiagram({ elements: [box("a", 0, 0), frame("f", ["a"]), frame("g", ["a"])] }),
    ).toThrow(/two frames/);
  });

  it("caps the elements a diagram adds up to", () => {
    const many = Array.from({ length: MAX_DIAGRAM_ELEMENTS + 1 }, (_, i) => box(`n${i}`, i, 0));
    expect(() => checkDiagram({ elements: many })).toThrow(/at most/);
  });

  it("reads empty content as an empty diagram", () => {
    expect(parseDiagram("")).toEqual({ elements: [] });
  });
});

describe("outline points", () => {
  it("meets an ellipse and a diamond on their outlines, not their boxes", () => {
    const shape = { x: 0, y: 0, width: 200, height: 100 };
    // Toward a point up and to the right, so the box corner and outline differ.
    const toward = { x: 200, y: -50 };
    const ellipse = outlinePoint({ ...shape, type: "ellipse" }, toward);
    expect(((ellipse.x - 100) / 100) ** 2 + ((ellipse.y - 50) / 50) ** 2).toBeCloseTo(1);
    const diamond = outlinePoint({ ...shape, type: "diamond" }, toward);
    expect(Math.abs(diamond.x - 100) / 100 + Math.abs(diamond.y - 50) / 50).toBeCloseTo(1);
  });
});

describe("parsing what a tool call sent", () => {
  it("drops properties it doesn't know, such as a link", () => {
    const [el] = parseElements([{ ...box("a", 0, 0), link: "https://evil.example", seed: 4 }]);
    expect(el).not.toHaveProperty("link");
    expect(el).not.toHaveProperty("seed");
  });

  it("names the element and the property that is wrong", () => {
    expect(() => parseElements([{ id: "a", type: "rectangle", x: 0, y: 0, width: 10 }])).toThrow(
      /element "a": height/,
    );
    expect(() => parseElements([box("b", 0, 0, { backgroundColor: "blue" })])).toThrow(/hex code/);
  });

  it("refuses ids that aren't plain", () => {
    for (const id of ["a b", 'x"y', "api;", "", "a".repeat(65)]) {
      expect(() => parseElements([box(id, 0, 0)])).toThrow(DiagramError);
    }
  });

  it("refuses oversized text, far coordinates and huge sizes", () => {
    expect(() => parseElements([box("a", 0, 0, { label: { text: "x".repeat(501) } })])).toThrow();
    expect(() => parseElements([box("a", 100_001, 0)])).toThrow();
    expect(() => parseElements([box("a", 0, 0, { width: 5_001 })])).toThrow();
  });

  it("caps how many elements one change sends", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`);
    expect(
      diagramChangesSchema.safeParse({ upsert: ids(MAX_DIAGRAM_ELEMENTS).map((id) => ({ id })) })
        .success,
    ).toBe(true);
    expect(
      diagramChangesSchema.safeParse({
        upsert: ids(MAX_DIAGRAM_ELEMENTS + 1).map((id) => ({ id })),
      }).success,
    ).toBe(false);
    expect(diagramChangesSchema.safeParse({ remove: ids(MAX_DIAGRAM_ELEMENTS + 1) }).success).toBe(
      false,
    );
  });
});

describe("diagram changes", () => {
  it("merges an upsert into the element with that id and keeps its other properties", () => {
    const next = applyDiagramChanges(base, { upsert: [{ id: "db", backgroundColor: "#a5d8ff" }] });
    expect(next.elements[1]).toEqual({ ...box("db", 300, 0), backgroundColor: "#a5d8ff" });
  });

  it("clears a property sent as null", () => {
    const next = applyDiagramChanges(base, { upsert: [{ id: "api", label: null }] });
    expect(next.elements[0]).not.toHaveProperty("label");
  });

  it("moves a bound arrow with the shape it is bound to", () => {
    const next = applyDiagramChanges(base, { upsert: [{ id: "db", y: 200 }] });
    expect(arrow(next, "api-db")?.points?.[1]?.[1]).toBeGreaterThan(0);
  });

  it("adds a new element, which needs a type and what that type requires", () => {
    const next = applyDiagramChanges(base, {
      upsert: [{ id: "note", type: "text", x: 0, y: 100, text: "Reads only" }],
    });
    expect(next.elements.map((e) => e.id)).toEqual(["api", "db", "api-db", "note"]);
    expect(() => applyDiagramChanges(base, { upsert: [{ id: "new", x: 1 }] })).toThrow(
      /needs a type/,
    );
    expect(() =>
      applyDiagramChanges(base, { upsert: [{ id: "new", type: "rectangle", x: 1, y: 1 }] }),
    ).toThrow(/element "new": width/);
  });

  it("won't change an element's type in place", () => {
    expect(() => applyDiagramChanges(base, { upsert: [{ id: "db", type: "ellipse" }] })).toThrow(
      /remove it and add it again/,
    );
  });

  it("removes a shape's arrows with it, and drops it from its frame", () => {
    const framed = applyDiagramChanges(base, {
      upsert: [{ id: "f", type: "frame", children: ["api", "db"] }],
    });
    const next = applyDiagramChanges(framed, { remove: ["db"] });
    expect(next.elements.map((e) => e.id)).toEqual(["api", "f"]);
    expect(next.elements[1]).toMatchObject({ children: ["api"] });
  });

  it("removes before it upserts, so an element can be replaced in one call", () => {
    const next = applyDiagramChanges(base, {
      remove: ["db"],
      upsert: [{ ...box("db", 0, 200), type: "ellipse" }],
    });
    expect(next.elements.find((e) => e.id === "db")).toMatchObject({ type: "ellipse", y: 200 });
  });

  it("tells additions apart from changes to what is there", () => {
    expect(onlyAdds(base, { upsert: [{ id: "new" }] })).toBe(true);
    expect(onlyAdds(base, { upsert: [{ id: "api", x: 4 }] })).toBe(false);
    expect(onlyAdds(base, { remove: ["api-db"] })).toBe(false);
    // One new element beside one existing one is still a change to what is there.
    expect(onlyAdds(base, { upsert: [{ id: "new" }, { id: "api", x: 4 }] })).toBe(false);
  });
});
