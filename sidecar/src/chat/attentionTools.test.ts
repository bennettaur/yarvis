import { describe, expect, it } from "bun:test";
import { buildAttentionTool, newAttentionState } from "./attentionTools.ts";

// The AI SDK passes a second options argument to execute; tests don't need it.
const opts = { toolCallId: "test", messages: [] } as never;

describe("attention tool", () => {
  it("starts with no attention requested", () => {
    const state = newAttentionState();
    expect(state.requested).toBe(false);
    expect(state.reason).toBeNull();
  });

  it("records the reason when the model requests attention", async () => {
    const state = newAttentionState();
    const tools = buildAttentionTool(state);

    const result = await tools.request_attention.execute!({ reason: "PR comment posted" }, opts);

    expect(state.requested).toBe(true);
    expect(state.reason).toBe("PR comment posted");
    expect(result).toEqual({ acknowledged: true });
  });
});
