import { afterEach, describe, expect, it } from "bun:test";
import {
  attentionSurfaceOf,
  parseSessionId,
  sessionId,
  sessionTabTitle,
  storageKeyFor,
} from "./sessionIds";

// One happy-dom is shared across every test file, so surface state written here
// would otherwise leak into unrelated suites.
const written: string[] = [];
function persistSurface(surfaceKey: string, raw: string) {
  const key = storageKeyFor(surfaceKey);
  written.push(key);
  localStorage.setItem(key, raw);
}

afterEach(() => {
  for (const key of written.splice(0)) localStorage.removeItem(key);
});

describe("parseSessionId", () => {
  it("round-trips a derived pane id", () => {
    expect(parseSessionId(sessionId("ws:w1", "t1", "p1"))).toEqual({
      surfaceKey: "ws:w1",
      tabId: "t1",
      paneId: "p1",
    });
  });

  it("rejects ids that aren't pane ids", () => {
    expect(parseSessionId("ws-claude:w1")).toBeNull();
    expect(parseSessionId("ws-run:repo-1")).toBeNull();
    expect(parseSessionId("ws:w1/t1")).toBeNull();
    expect(parseSessionId("ws:w1//p1")).toBeNull();
  });
});

describe("attentionSurfaceOf", () => {
  it("routes both workspace session shapes to the workspaces view", () => {
    expect(attentionSurfaceOf("ws-claude:w1")).toBe("workspace");
    expect(attentionSurfaceOf("ws:w1/t1/p1")).toBe("workspace");
  });

  it("routes the standalone Terminal tab's own sessions to it", () => {
    expect(attentionSurfaceOf("tab:terminal/t1/p1")).toBe("terminal");
  });

  it("has nowhere to send a session no view can display", () => {
    expect(attentionSurfaceOf("omni:s1/t1/p1")).toBeNull();
    expect(attentionSurfaceOf("ws-run:repo-1")).toBeNull();
  });
});

describe("sessionTabTitle", () => {
  it("names the tab a pane lives in, from the surface's persisted state", () => {
    persistSurface("ws:w1", JSON.stringify({ tabs: [{ id: "t1", title: "Server" }] }));
    expect(sessionTabTitle("ws:w1/t1/p1")).toBe("Server");
    expect(sessionTabTitle("ws:w1/t9/p1")).toBeNull();
  });

  it("names a pinned Claude session without any persisted state", () => {
    expect(sessionTabTitle("ws-claude:w1")).toBe("Claude");
  });

  it("returns null rather than throwing on unusable state", () => {
    persistSurface("ws:bad", "{not json");
    expect(sessionTabTitle("ws:bad/t1/p1")).toBeNull();
    expect(sessionTabTitle("ws:missing/t1/p1")).toBeNull();
  });
});
