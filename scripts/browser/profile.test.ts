import { describe, expect, it } from "bun:test";
import { cleanName, MAX_NAME_CHARS } from "../../extension/profile.js";

describe("cleanName", () => {
  it("trims, drops control characters and caps the length", () => {
    expect(cleanName("  work\n")).toBe("work");
    expect(cleanName("\u001bwork")).toBe("work");
    expect(cleanName("x".repeat(100))).toHaveLength(MAX_NAME_CHARS);
  });

  it("refuses a name with nothing left in it", () => {
    expect(cleanName("   ")).toBeNull();
    expect(cleanName("\n\t")).toBeNull();
  });
});
