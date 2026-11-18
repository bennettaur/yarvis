import { describe, expect, it } from "bun:test";
import { issueKey } from "./validation.ts";

describe("issueKey", () => {
  it("accepts a project key and number", () => {
    for (const key of ["PROJ-45", "ab_2-7", "X-1234"]) {
      expect(issueKey.safeParse(key).success).toBe(true);
    }
  });

  it("refuses anything that could carry extra path segments", () => {
    for (const key of ["PROJ-45/../x", "../PROJ-45", "PROJ-45?x=1", " PROJ-45", "PROJ-", "45"]) {
      expect(issueKey.safeParse(key).success).toBe(false);
    }
  });
});
