import { describe, expect, it } from "bun:test";
import {
  activeMounted,
  MOUNT_TTL_MS,
  mountTools,
  unmountAll,
  unmountTools,
} from "./mountedTools.ts";

// Each test uses a distinct session id since the store is process-global. Times
// are passed explicitly to exercise the TTL deterministically.
describe("mountedTools", () => {
  it("mounts and lists active tool ids", () => {
    mountTools("s1", ["mcp:a:x", "builtin:remember"]);
    expect(activeMounted("s1").sort()).toEqual(["builtin:remember", "mcp:a:x"]);
  });

  it("unmounts specific ids", () => {
    mountTools("s2", ["a", "b"]);
    unmountTools("s2", ["a"]);
    expect(activeMounted("s2")).toEqual(["b"]);
  });

  it("unmounts everything with unmountAll", () => {
    mountTools("s3", ["a", "b"]);
    unmountAll("s3");
    expect(activeMounted("s3")).toEqual([]);
  });

  it("expires entries past the TTL", () => {
    mountTools("s4", ["a"], 0);
    expect(activeMounted("s4", 0)).toEqual(["a"]);
    expect(activeMounted("s4", MOUNT_TTL_MS + 1)).toEqual([]);
  });
});
