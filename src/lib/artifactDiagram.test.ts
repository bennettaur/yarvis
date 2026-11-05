import { describe, expect, it } from "bun:test";
import { diagramToSkeleton } from "./artifactDiagram";

type Drawn = Record<string, unknown> & { id?: string; type: string };

const draw = (elements: unknown[]) =>
  diagramToSkeleton(JSON.stringify({ elements })) as unknown as Drawn[];

const box = { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 50 };

describe("diagramToSkeleton", () => {
  it("keeps a shape's geometry and style, and draws its label in Helvetica", () => {
    const [el] = draw([
      {
        ...box,
        backgroundColor: "#a5d8ff",
        fillStyle: "solid",
        roundness: { type: 3 },
        label: { text: "API", fontSize: 16 },
      },
    ]);
    expect(el).toEqual({
      ...box,
      backgroundColor: "#a5d8ff",
      fillStyle: "solid",
      roundness: { type: 3 },
      label: { text: "API", fontSize: 16, fontFamily: 2 },
    });
  });

  it("drops properties it doesn't keep, and values that aren't valid", () => {
    const [el] = draw([
      { ...box, link: "https://evil.example", customData: {}, strokeColor: "red", opacity: 900 },
    ]);
    expect(el).toEqual(box);
  });

  it("drops elements with no usable id, type or position", () => {
    expect(
      draw([
        { ...box, id: "a b" },
        { ...box, id: "img", type: "image" },
        { ...box, id: "nowhere", x: "0" },
        { id: "t", type: "text", x: 0, y: 0 },
      ]),
    ).toEqual([]);
  });

  it("keeps a label's newlines but strips other control characters and separators", () => {
    const [el] = draw([{ ...box, label: { text: "one\ntwo\u0007\u2028\u2029\u202e" } }]);
    expect(el?.label).toMatchObject({ text: "one\ntwo" });
  });

  it("binds an arrow only to shapes that are there", () => {
    const [, , arrow] = draw([
      box,
      { ...box, id: "b", x: 300 },
      {
        id: "a-b",
        type: "arrow",
        x: 100,
        y: 25,
        points: [
          [0, 0],
          [200, 10],
        ],
        start: { id: "a" },
        end: { id: "gone" },
      },
    ]);
    expect(arrow).toMatchObject({ x: 100, y: 25, width: 200, height: 10, start: { id: "a" } });
    expect(arrow).not.toHaveProperty("end");
  });

  it("keeps only children a frame can hold", () => {
    const [, frame] = draw([box, { id: "f", type: "frame", children: ["a", "f", "missing"] }]);
    expect(frame).toEqual({ id: "f", type: "frame", children: ["a"] });
  });

  it("leaves a frame child out when the child itself was dropped", () => {
    const drawn = draw([
      { ...box, width: -5 },
      { id: "f", type: "frame", children: ["a"] },
    ]);
    expect(drawn).toEqual([{ id: "f", type: "frame", children: [] }]);
  });

  it("draws a line as a path only, and a curve when it has roundness", () => {
    const [, line] = draw([
      box,
      {
        id: "l",
        type: "line",
        x: 0,
        y: 0,
        points: [
          [0, 0],
          [10, 5],
        ],
        start: { id: "a" },
        label: { text: "x" },
        roundness: { type: 2 },
      },
    ]);
    expect(line).toEqual({
      id: "l",
      type: "line",
      x: 0,
      y: 0,
      points: [
        [0, 0],
        [10, 5],
      ],
      width: 10,
      height: 5,
      roundness: { type: 2 },
    });
  });

  it("reads empty content as an empty diagram", () => {
    expect(diagramToSkeleton("")).toEqual([]);
  });
});
