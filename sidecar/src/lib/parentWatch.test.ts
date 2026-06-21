import { describe, expect, it } from "bun:test";
import { isOrphaned } from "./parentWatch.ts";

describe("isOrphaned", () => {
  it("is false while the parent is unchanged", () => {
    expect(isOrphaned(4242, 4242)).toBe(false);
  });

  it("is true once reparented (e.g. to launchd after the parent dies)", () => {
    expect(isOrphaned(4242, 1)).toBe(true);
    expect(isOrphaned(4242, 9999)).toBe(true);
  });
});
