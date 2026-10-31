import type { AgentEvent } from "../chat/agent.ts";
import { yarvisToolType } from "./classify.ts";
import { type ActivityType, reportYarvisActivity } from "./hub.ts";

/**
 * Passes a chat turn's events through unchanged, reporting each step to the
 * Agent Field page as it goes. `source` is the surface the turn came from, so
 * each surface orbits as its own node.
 */
export async function* reportTurnActivity(
  source: string,
  turn: AsyncGenerator<AgentEvent>,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const report = (type: ActivityType, label: string) => reportYarvisActivity(source, type, label);
  const toolNames = new Map<string, string>();

  report("prompt", `${source} turn`);
  for await (const event of turn) {
    switch (event.type) {
      case "tool_call":
        toolNames.set(event.id, event.name);
        report(yarvisToolType(event.name), event.name);
        break;
      case "tool_result":
        if (event.status === "error")
          report("error", `${toolNames.get(event.id) ?? "tool"} failed`);
        break;
      case "error":
        // A turn the user stopped isn't a failure worth a red flash.
        if (!signal?.aborted) report("error", "turn failed");
        break;
      case "done":
        report("done", "turn complete");
        break;
    }
    yield event;
  }
}
