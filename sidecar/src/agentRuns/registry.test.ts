import { describe, expect, it } from "bun:test";
import type { AgentRunEvent } from "./events.ts";
import { AgentRunRegistry, RUN_HISTORY_CAP } from "./registry.ts";

const status = (message: string): AgentRunEvent => ({ type: "status", message });
const done: AgentRunEvent = { type: "done", status: "succeeded", error: null };

function collector() {
  const seen: AgentRunEvent[] = [];
  return { seen, emit: (event: AgentRunEvent) => void seen.push(event) };
}

describe("following a run", () => {
  it("replays what happened before the viewer joined, then streams the rest", async () => {
    const registry = new AgentRunRegistry();
    registry.start("run");
    registry.emit("run", status("one"));
    registry.emit("run", status("two"));

    const viewer = collector();
    const following = registry.follow("run", viewer.emit);
    registry.emit("run", status("three"));
    registry.emit("run", done);
    registry.finish("run");

    expect(await following).toBe(true);
    expect(viewer.seen).toEqual([status("one"), status("two"), status("three"), done]);
  });

  it("serves every viewer the same stream", async () => {
    const registry = new AgentRunRegistry();
    registry.start("run");
    const early = collector();
    const earlyFollowing = registry.follow("run", early.emit);
    registry.emit("run", status("one"));
    const late = collector();
    const lateFollowing = registry.follow("run", late.emit);
    registry.emit("run", done);
    registry.finish("run");
    await Promise.all([earlyFollowing, lateFollowing]);

    expect(early.seen).toEqual([status("one"), done]);
    expect(late.seen).toEqual([status("one"), done]);
  });

  it("keeps a slow viewer's events in order without holding up the others", async () => {
    const registry = new AgentRunRegistry();
    registry.start("run");
    const slow: AgentRunEvent[] = [];
    const slowFollowing = registry.follow("run", async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      slow.push(event);
    });
    const fast = collector();
    const fastFollowing = registry.follow("run", fast.emit);
    registry.emit("run", status("one"));
    registry.emit("run", status("two"));
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(fast.seen).toEqual([status("one"), status("two")]);
    expect(slow.length).toBeLessThan(2);
    registry.finish("run");
    await Promise.all([slowFollowing, fastFollowing]);
    expect(slow).toEqual([status("one"), status("two")]);
  });

  it("stops serving a viewer whose stream closed, without ending the run", async () => {
    const registry = new AgentRunRegistry();
    registry.start("run");
    const viewer = collector();
    const gone = new AbortController();
    const following = registry.follow("run", viewer.emit, gone.signal);
    registry.emit("run", status("one"));
    gone.abort();
    await following;
    registry.emit("run", status("two"));

    expect(viewer.seen).toEqual([status("one")]);
    expect(registry.isLive("run")).toBe(true);
  });

  it("survives a viewer whose writes fail", async () => {
    const registry = new AgentRunRegistry();
    registry.start("run");
    const following = registry.follow("run", () => {
      throw new Error("stream closed");
    });
    registry.emit("run", status("one"));
    registry.finish("run");
    expect(await following).toBe(true);
  });

  it("answers false for a run that isn't live", async () => {
    const registry = new AgentRunRegistry();
    const viewer = collector();
    expect(await registry.follow("missing", viewer.emit)).toBe(false);
    expect(viewer.seen).toEqual([]);
  });

  it("replays only the tail of a long run", () => {
    const registry = new AgentRunRegistry();
    registry.start("run");
    for (let i = 0; i < RUN_HISTORY_CAP + 10; i++) registry.emit("run", status(String(i)));
    const history = registry.history("run");
    expect(history).toHaveLength(RUN_HISTORY_CAP);
    expect(history[0]).toEqual(status("10"));
  });
});

describe("cancelling a run", () => {
  it("aborts the signal the run was started with", () => {
    const registry = new AgentRunRegistry();
    const signal = registry.start("run");
    expect(registry.cancel("run")).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it("has nothing to cancel once the run has finished", () => {
    const registry = new AgentRunRegistry();
    registry.start("run");
    registry.finish("run");
    expect(registry.cancel("run")).toBe(false);
  });
});
