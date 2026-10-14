import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setViewedSessions, setViewedWorkspace, type ViewedScope } from "./attentionScope";
import type { recordEvent } from "./events";
import {
  claimView,
  useWorkspaceViewEvents,
  VIEW_DWELL_MS,
  VIEW_THROTTLE_MS,
  viewedTab,
} from "./workspaceViews";

function scope(sessionKeys: string[]): ViewedScope {
  return { workspaceId: "w1", sessionKeys: new Set(sessionKeys), focused: true };
}

describe("viewedTab", () => {
  it("names the agent tab by its pinned session", () => {
    expect(viewedTab(scope(["ws-claude:w1"]), "w1")).toBe("agent");
  });

  it("names one of the workspace's own shells", () => {
    expect(viewedTab(scope(["ws:w1/t1/p1", "ws:w1/t1/p2"]), "w1")).toBe("terminal");
  });

  it("calls a tab with no session, or another workspace's session, other", () => {
    expect(viewedTab(scope([]), "w1")).toBe("other");
    expect(viewedTab(scope(["ws:w10/t1/p1", "ws-claude:w2"]), "w1")).toBe("other");
  });
});

describe("claimView", () => {
  it("records once per window for the same workspace and tab", () => {
    const recorded = new Map<string, number>();
    expect(claimView("w1:agent", 0, recorded)).toBe(true);
    expect(claimView("w1:agent", VIEW_THROTTLE_MS - 1, recorded)).toBe(false);
    expect(claimView("w1:terminal", 1, recorded)).toBe(true);
    expect(claimView("w1:agent", VIEW_THROTTLE_MS, recorded)).toBe(true);
  });
});

describe("useWorkspaceViewEvents", () => {
  let root: Root | null = null;
  let container: HTMLElement;
  const realHasFocus = document.hasFocus.bind(document);

  function Harness({ record }: { record: typeof recordEvent }) {
    useWorkspaceViewEvents("Login page", record);
    return null;
  }

  function mount(record: typeof recordEvent) {
    container = document.createElement("div");
    root = createRoot(container);
    act(() => root!.render(createElement(Harness, { record })));
  }

  function setFocused(focused: boolean) {
    document.hasFocus = () => focused;
    act(() => {
      window.dispatchEvent(new Event(focused ? "focus" : "blur"));
    });
  }

  const actFlag = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

  beforeEach(() => {
    actFlag.IS_REACT_ACT_ENVIRONMENT = true;
    jest.useFakeTimers();
    setFocused(true);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    setViewedWorkspace(null);
    setViewedSessions("ws:test", []);
    document.hasFocus = realHasFocus;
    jest.useRealTimers();
    delete actFlag.IS_REACT_ACT_ENVIRONMENT;
  });

  it("records one view after the workspace holds the screen", () => {
    const calls: unknown[][] = [];
    mount(async (...args) => {
      calls.push(args);
    });
    act(() => {
      setViewedWorkspace("hook-w1");
      setViewedSessions("ws:test", ["ws-claude:hook-w1"]);
    });
    act(() => jest.advanceTimersByTime(VIEW_DWELL_MS));
    expect(calls).toEqual([
      [
        "workspace.viewed",
        { workspaceId: "hook-w1", name: "Login page", tab: "agent" },
        "workspaces",
      ],
    ]);
  });

  it("records nothing when the user moves on before the dwell", () => {
    const calls: unknown[][] = [];
    mount(async (...args) => {
      calls.push(args);
    });
    act(() => setViewedWorkspace("hook-w2"));
    act(() => jest.advanceTimersByTime(VIEW_DWELL_MS - 1));
    act(() => setViewedWorkspace(null));
    act(() => jest.advanceTimersByTime(VIEW_DWELL_MS));
    expect(calls).toEqual([]);
  });

  it("records nothing while the window is in the background", () => {
    const calls: unknown[][] = [];
    mount(async (...args) => {
      calls.push(args);
    });
    setFocused(false);
    act(() => setViewedWorkspace("hook-w3"));
    act(() => jest.advanceTimersByTime(VIEW_DWELL_MS));
    expect(calls).toEqual([]);
  });
});
