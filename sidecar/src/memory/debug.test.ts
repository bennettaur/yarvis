import { afterEach, describe, expect, it } from "bun:test";
import { memoryDebugEnabled, preview, traceEmbedCall, vectorSummary } from "./debug.ts";

const ORIGINAL = process.env.YARVIS_DEBUG_MEMORY;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.YARVIS_DEBUG_MEMORY;
  else process.env.YARVIS_DEBUG_MEMORY = ORIGINAL;
});

describe("memoryDebugEnabled", () => {
  it("is off when unset or falsy", () => {
    for (const value of [undefined, "", "0", "false"]) {
      if (value === undefined) delete process.env.YARVIS_DEBUG_MEMORY;
      else process.env.YARVIS_DEBUG_MEMORY = value;
      expect(memoryDebugEnabled()).toBe(false);
    }
  });

  it("is on for any other value", () => {
    for (const value of ["1", "true", "yes"]) {
      process.env.YARVIS_DEBUG_MEMORY = value;
      expect(memoryDebugEnabled()).toBe(true);
    }
  });
});

describe("vectorSummary", () => {
  it("reports dimension and L2 norm", () => {
    expect(vectorSummary([3, 4])).toBe("dim=2 norm=5.00");
    expect(vectorSummary([1, 0, 0])).toBe("dim=3 norm=1.00");
  });
});

describe("preview", () => {
  it("collapses whitespace and truncates", () => {
    expect(preview("hello   world\n  again")).toBe("hello world again");
    expect(preview("abcdef", 3)).toBe("abc…");
  });
});

describe("traceEmbedCall", () => {
  it("returns the call result unchanged whether tracing is on or off", async () => {
    delete process.env.YARVIS_DEBUG_MEMORY;
    expect(await traceEmbedCall("off", async () => [1, 2], vectorSummary)).toEqual([1, 2]);
    process.env.YARVIS_DEBUG_MEMORY = "1";
    expect(await traceEmbedCall("on", async () => [3, 4], vectorSummary)).toEqual([3, 4]);
  });

  it("propagates errors from the wrapped call", async () => {
    process.env.YARVIS_DEBUG_MEMORY = "1";
    const failing = traceEmbedCall(
      "boom",
      async () => {
        throw new Error("provider down");
      },
      vectorSummary,
    );
    await expect(failing).rejects.toThrow("provider down");
  });
});
