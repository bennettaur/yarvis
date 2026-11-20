import { describe, expect, it } from "bun:test";
import { RunAlreadyActiveError, RunRegistry, type RunRegistryOptions } from "./runRegistry.ts";

type Event = string;

function registry(options: Partial<RunRegistryOptions> = {}) {
  return new RunRegistry<Event>({ historyCap: 100, followerQueueCap: 100, ...options });
}

function collector() {
  const seen: Event[] = [];
  return { seen, emit: (event: Event) => void seen.push(event) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("forget", () => {
  it("drops a finished run's history and leaves a live one alone", async () => {
    const runs = registry({ keepFinishedMs: 60_000 });
    runs.start("done");
    runs.emit("done", "one");
    runs.finish("done");
    runs.start("live");
    runs.forget("done");
    runs.forget("live");
    expect(await runs.follow("done", () => {})).toBe(false);
    expect(runs.isLive("live")).toBe(true);
  });
});

describe("following a run", () => {
  it("replays what happened before the viewer joined, then streams the rest", async () => {
    const runs = registry();
    runs.start("run");
    runs.emit("run", "one");
    runs.emit("run", "two");

    const viewer = collector();
    const following = runs.follow("run", viewer.emit);
    runs.emit("run", "three");
    runs.finish("run");

    expect(await following).toBe(true);
    expect(viewer.seen).toEqual(["one", "two", "three"]);
  });

  it("serves every viewer the same stream", async () => {
    const runs = registry();
    runs.start("run");
    const early = collector();
    const earlyFollowing = runs.follow("run", early.emit);
    runs.emit("run", "one");
    const late = collector();
    const lateFollowing = runs.follow("run", late.emit);
    runs.emit("run", "two");
    runs.finish("run");
    await Promise.all([earlyFollowing, lateFollowing]);

    expect(early.seen).toEqual(["one", "two"]);
    expect(late.seen).toEqual(["one", "two"]);
  });

  it("keeps a slow viewer's events in order without holding up the others", async () => {
    const runs = registry();
    runs.start("run");
    const slow: Event[] = [];
    const slowFollowing = runs.follow("run", async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      slow.push(event);
    });
    const fast = collector();
    const fastFollowing = runs.follow("run", fast.emit);
    runs.emit("run", "one");
    runs.emit("run", "two");
    await tick();
    expect(fast.seen).toEqual(["one", "two"]);
    expect(slow.length).toBeLessThan(2);
    runs.finish("run");
    await Promise.all([slowFollowing, fastFollowing]);
    expect(slow).toEqual(["one", "two"]);
  });

  it("stops serving a viewer whose stream closed, without ending the run", async () => {
    const runs = registry();
    runs.start("run");
    const viewer = collector();
    const gone = new AbortController();
    const following = runs.follow("run", viewer.emit, gone.signal);
    runs.emit("run", "one");
    gone.abort();
    await following;
    runs.emit("run", "two");

    expect(viewer.seen).toEqual(["one"]);
    expect(runs.isLive("run")).toBe(true);
  });

  it("drops a viewer that falls too far behind, and keeps serving the rest", async () => {
    const runs = registry({ followerQueueCap: 2 });
    runs.start("run");
    const stuck = runs.follow("run", () => new Promise(() => {}));
    const fine = collector();
    const fineFollowing = runs.follow("run", fine.emit);
    // Spaced out, so the viewer that keeps up has drained between events.
    for (const event of ["a", "b", "c", "d"]) {
      runs.emit("run", event);
      await tick();
    }
    expect(fine.seen).toEqual(["a", "b", "c", "d"]);
    // The stuck viewer is detached; its follow waits only on its own write,
    // which never settles, and the run is unaffected.
    const outcome = await Promise.race([stuck.then(() => "ended"), tick().then(() => "pending")]);
    expect(outcome).toBe("pending");
    expect(runs.isLive("run")).toBe(true);
    runs.finish("run");
    await fineFollowing;
  });

  it("survives a viewer whose writes fail", async () => {
    const runs = registry();
    runs.start("run");
    const following = runs.follow("run", () => {
      throw new Error("stream closed");
    });
    runs.emit("run", "one");
    runs.finish("run");
    expect(await following).toBe(true);
  });

  it("answers false for a run it doesn't know", async () => {
    const viewer = collector();
    expect(await registry().follow("missing", viewer.emit)).toBe(false);
    expect(viewer.seen).toEqual([]);
  });

  it("replays only the tail of a long run", () => {
    const runs = registry({ historyCap: 3 });
    runs.start("run");
    for (const event of ["1", "2", "3", "4", "5"]) runs.emit("run", event);
    expect(runs.history("run")).toEqual(["3", "4", "5"]);
  });
});

describe("a finished run", () => {
  it("is forgotten at once by default", async () => {
    const runs = registry();
    runs.start("run");
    runs.emit("run", "one");
    runs.finish("run");
    expect(runs.isLive("run")).toBe(false);
    expect(await runs.follow("run", collector().emit)).toBe(false);
  });

  it("stays replayable for a while when asked to", async () => {
    const runs = registry({ keepFinishedMs: 60_000 });
    runs.start("run");
    runs.emit("run", "one");
    runs.finish("run");
    const viewer = collector();
    expect(await runs.follow("run", viewer.emit)).toBe(true);
    expect(viewer.seen).toEqual(["one"]);
    expect(runs.isLive("run")).toBe(false);
  });
});

describe("starting a run", () => {
  it("refuses a second run under the same key when asked to", () => {
    const runs = registry({ oneRunPerKey: true });
    runs.start("key");
    expect(() => runs.start("key")).toThrow(RunAlreadyActiveError);
    runs.finish("key");
    expect(() => runs.start("key")).not.toThrow();
  });

  it("lists what is in flight", () => {
    const runs = registry();
    runs.start("a");
    runs.start("b");
    runs.finish("a");
    expect(runs.liveKeys()).toEqual(["b"]);
  });
});

describe("cancelling a run", () => {
  it("aborts the signal the run was started with", () => {
    const runs = registry();
    const signal = runs.start("run");
    expect(runs.cancel("run")).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it("has nothing to cancel once the run has finished", () => {
    const runs = registry({ keepFinishedMs: 60_000 });
    runs.start("run");
    runs.finish("run");
    expect(runs.cancel("run")).toBe(false);
  });
});
