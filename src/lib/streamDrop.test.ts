import { describe, expect, it } from "bun:test";
import { describeStreamDrop, isConnectionDrop } from "./streamDrop";

const START = 1_000_000;
const context = {
  error: new TypeError("Load failed"),
  startedAt: START,
  lastEventType: "tool_call",
  lastEventAt: START + 5_000,
  now: START + 265_000,
};

describe("isConnectionDrop", () => {
  it("recognises WebKit's and Chromium's fetch failures", () => {
    expect(isConnectionDrop(new TypeError("Load failed"))).toBe(true);
    expect(isConnectionDrop(new TypeError("The network connection was lost."))).toBe(true);
    expect(isConnectionDrop(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("leaves other errors to the usual formatting", () => {
    expect(isConnectionDrop(new TypeError("undefined is not an object"))).toBe(false);
    expect(isConnectionDrop(new Error("Load failed"))).toBe(false);
    expect(isConnectionDrop("Load failed")).toBe(false);
  });
});

describe("describeStreamDrop", () => {
  it("says the sidecar restarted when it has been up for less than the turn", () => {
    const shown = describeStreamDrop(context, { status: "ok", service: "s", uptimeMs: 30_000 });
    expect(shown.message).toContain("restarted during this turn");
    expect(shown.detail).toContain("restarted 30s ago");
  });

  it("says the sidecar is down when the health check fails", () => {
    const shown = describeStreamDrop(context, new Error("connection refused"));
    expect(shown.message).toContain("isn't answering now");
    expect(shown.detail).toContain("connection refused");
  });

  it("records how far the turn got when the sidecar stayed up", () => {
    const shown = describeStreamDrop(context, {
      status: "ok",
      service: "s",
      uptimeMs: 3_600_000,
    });
    expect(shown.message).toContain("dropped mid-turn");
    expect(shown.detail).toContain("Browser error: TypeError: Load failed");
    expect(shown.detail).toContain("Turn ran for: 4m 25s");
    expect(shown.detail).toContain("Last event received: tool_call, 4m 20s before the drop");
    expect(shown.detail).toContain("did not restart");
  });
});
