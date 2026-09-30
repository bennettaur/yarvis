import { describe, expect, it } from "bun:test";
import { parseInstance } from "./instances.ts";

describe("parseInstance", () => {
  it("accepts a complete entry", () => {
    const entry = { name: "main", port: 8765, token: "t", pid: 42 };
    expect(parseInstance(entry)).toEqual(entry);
  });

  it("refuses an entry with a bad port, pid or missing field", () => {
    expect(parseInstance({ name: "a", port: 0, token: "t", pid: 1 })).toBeNull();
    expect(parseInstance({ name: "a", port: 70000, token: "t", pid: 1 })).toBeNull();
    expect(parseInstance({ name: "a", port: 1, token: "t", pid: -1 })).toBeNull();
    expect(parseInstance({ port: 1, token: "t", pid: 1 })).toBeNull();
    expect(parseInstance(null)).toBeNull();
  });
});
