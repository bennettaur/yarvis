import { afterEach, describe, expect, it } from "bun:test";
import { resetReviewApi, stubReviewApi } from "../test/reviewWorkspacesApi";
import { followAgentRun } from "./agentRunFollow";
import type { AgentRunEvent } from "./agentRuns";

afterEach(resetReviewApi);

const tool = (id: string): AgentRunEvent => ({
  type: "tool",
  id,
  name: "Read",
  summary: id,
  subagentId: null,
});

/** A run whose events are pushed by the test, and which ends when `end` is called. */
function controlledRun() {
  const opened: AbortSignal[] = [];
  const queue: AgentRunEvent[] = [];
  let wake = () => {};
  let ended = false;
  stubReviewApi({
    streamAgentRun: async function* (_id, signal) {
      if (signal) opened.push(signal);
      while (!signal?.aborted) {
        const next = queue.shift();
        if (next) yield next;
        else if (ended) return;
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal?.addEventListener("abort", () => resolve());
          });
      }
    },
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    opened,
    push: async (event: AgentRunEvent) => {
      queue.push(event);
      wake();
      await tick();
    },
    end: async () => {
      ended = true;
      wake();
      await tick();
    },
  };
}

describe("followAgentRun", () => {
  it("shares one stream between followers, replaying what a late one missed", async () => {
    const run = controlledRun();
    const first: string[] = [];
    const second: string[] = [];
    const ends: string[] = [];
    const stopFirst = followAgentRun("r1", {
      onEvent: (e) => e.type === "tool" && first.push(e.id),
      onEnd: () => ends.push("first"),
    });
    await run.push(tool("a"));
    const stopSecond = followAgentRun("r1", {
      onEvent: (e) => e.type === "tool" && second.push(e.id),
      onEnd: () => ends.push("second"),
    });
    await run.push(tool("b"));
    expect(run.opened).toHaveLength(1);
    expect(first).toEqual(["a", "b"]);
    expect(second).toEqual(["a", "b"]);
    await run.end();
    expect(ends).toEqual(["first", "second"]);
    stopFirst();
    stopSecond();
  });

  it("keeps the stream open until its last follower stops", async () => {
    const run = controlledRun();
    const ends: string[] = [];
    const stopFirst = followAgentRun("r2", { onEnd: () => ends.push("first") });
    const stopSecond = followAgentRun("r2", { onEnd: () => ends.push("second") });
    stopFirst();
    expect(run.opened[0]?.aborted).toBe(false);
    stopSecond();
    expect(run.opened[0]?.aborted).toBe(true);
    await run.end();
    expect(ends).toEqual([]);
  });

  it("opens a fresh stream for a run followed again after its stream ended", async () => {
    const run = controlledRun();
    const stop = followAgentRun("r3", { onEnd: () => {} });
    await run.end();
    stop();
    const again = followAgentRun("r3", { onEnd: () => {} });
    expect(run.opened).toHaveLength(2);
    again();
  });

  it("hands a lost stream's error to every follower", async () => {
    stubReviewApi({
      // biome-ignore lint/correctness/useYield: a stream that fails before its first event
      streamAgentRun: async function* () {
        throw new Error("connection reset");
      },
    });
    const errors: unknown[] = [];
    const stops = [
      followAgentRun("r4", { onEnd: (e) => errors.push(e) }),
      followAgentRun("r4", { onEnd: (e) => errors.push(e) }),
    ];
    await new Promise((r) => setTimeout(r, 0));
    expect(errors.map((e) => (e as Error).message)).toEqual([
      "connection reset",
      "connection reset",
    ]);
    for (const stop of stops) stop();
  });

  it("keeps a stream reopened while the last one winds down", async () => {
    // React's StrictMode mounts, unmounts and remounts: the first stream is
    // still closing when the second opens.
    const run = controlledRun();
    followAgentRun("r5", { onEnd: () => {} })();
    const again = followAgentRun("r5", { onEnd: () => {} });
    await new Promise((r) => setTimeout(r, 0));
    const third = followAgentRun("r5", { onEnd: () => {} });
    expect(run.opened).toHaveLength(2);
    expect(run.opened[1]?.aborted).toBe(false);
    again();
    third();
  });

  it("keeps the stream going for the others when one follower throws", async () => {
    const run = controlledRun();
    const seen: string[] = [];
    const ends: string[] = [];
    const stopBad = followAgentRun("r6", {
      onEvent: () => {
        throw new Error("view bug");
      },
      onEnd: () => ends.push("bad"),
    });
    const stopGood = followAgentRun("r6", {
      onEvent: (e) => e.type === "tool" && seen.push(e.id),
      onEnd: (e) => ends.push(e ? "good, with an error" : "good"),
    });
    await run.push(tool("a"));
    await run.push(tool("b"));
    await run.end();
    expect(seen).toEqual(["a", "b"]);
    expect(ends).toEqual(["bad", "good"]);
    stopBad();
    stopGood();
  });
});
