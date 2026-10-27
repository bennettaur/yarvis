import { describe, expect, it } from "bun:test";
import { quickInfoHover } from "./quickInfo";

const span = { start: 0, length: 3 };

describe("quickInfoHover", () => {
  it("shows the signature, then the JSDoc and its tags", () => {
    const parts = quickInfoHover({
      textSpan: span,
      displayParts: [{ text: "function " }, { text: "add" }, { text: "(a: number): number" }],
      documentation: [{ text: "Adds numbers." }],
      tags: [
        { name: "param", text: [{ text: "a" }, { text: "the first" }] },
        { name: "deprecated", text: "use plus" },
        { name: "internal" },
      ],
    });
    expect(parts.map((p) => p.value)).toEqual([
      "```typescript\nfunction add(a: number): number\n```\n",
      "Adds numbers.\n\n*@param*`a` — the first  \n\n*@deprecated* — use plus  \n\n*@internal*",
    ]);
  });

  it("leaves out the prose when there is none", () => {
    const parts = quickInfoHover({ textSpan: span, displayParts: [{ text: "const x: 1" }] });
    expect(parts).toHaveLength(1);
  });

  it("keeps an image in the JSDoc from rendering and grants no trust or HTML", () => {
    const [, prose] = quickInfoHover({
      textSpan: span,
      displayParts: [{ text: "add" }],
      documentation: [{ text: "![t](https://evil.example/p.png)" }],
      tags: [{ name: "see", text: [{ text: "![u][r]" }] }],
    });
    expect(prose).toEqual({
      value: "!\\[t](https://evil.example/p.png)\n\n*@see* — !\\[u][r]",
      isTrusted: false,
      supportHtml: false,
    });
  });
});
