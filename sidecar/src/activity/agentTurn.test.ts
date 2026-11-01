import { afterEach, describe, expect, it } from "bun:test";
import type { AgentEvent } from "../chat/agent.ts";
import { reportTurnActivity } from "./agentTurn.ts";
import { type ActivityEvent, subscribeActivity } from "./hub.ts";

async function* turnOf(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  yield* events;
}

let unsubscribe: (() => void) | undefined;
afterEach(() => unsubscribe?.());

function watch(): ActivityEvent[] {
  const seen: ActivityEvent[] = [];
  unsubscribe = subscribeActivity((event) => seen.push(event));
  return seen;
}

async function drain(turn: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of turn) out.push(event);
  return out;
}

describe("reportTurnActivity", () => {
  const events: AgentEvent[] = [
    { type: "tool_call", id: "1", name: "list_tasks" },
    { type: "tool_result", id: "1", status: "ok" },
    { type: "tool_call", id: "2", name: "create_task" },
    { type: "tool_result", id: "2", status: "error" },
    { type: "delta", text: "done" },
    { type: "done", text: "done" },
  ];

  it("passes the turn through unchanged", async () => {
    expect(await drain(reportTurnActivity("chat", turnOf(events)))).toEqual(events);
  });

  it("reports the prompt, each tool, a failed tool and the end of the turn", async () => {
    const seen = watch();
    await drain(reportTurnActivity("voice", turnOf(events)));
    expect(seen.map((e) => [e.type, e.label])).toEqual([
      ["prompt", "voice turn"],
      ["read", "list_tasks"],
      ["edit", "create_task"],
      ["error", "create_task failed"],
      ["done", "turn complete"],
    ]);
    expect(seen.every((e) => e.origin === "yarvis" && e.source === "voice")).toBe(true);
  });

  it("reports a turn that failed on its own as an error", async () => {
    const seen = watch();
    const running = new AbortController();
    await drain(
      reportTurnActivity("chat", turnOf([{ type: "error", message: "boom" }]), running.signal),
    );
    expect(seen.map((e) => [e.type, e.label])).toEqual([
      ["prompt", "chat turn"],
      ["error", "turn failed"],
    ]);
  });

  it("doesn't report a turn the user stopped as a failure", async () => {
    const seen = watch();
    const stopped = new AbortController();
    stopped.abort();
    await drain(
      reportTurnActivity(
        "chat",
        turnOf([{ type: "error", message: "Turn stopped." }]),
        stopped.signal,
      ),
    );
    expect(seen.map((e) => e.type)).toEqual(["prompt"]);
  });
});
