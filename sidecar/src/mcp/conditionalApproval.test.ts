import { describe, expect, it } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import { resolveApproval } from "./approvals.ts";
import { wrapToolWithConditionalApproval } from "./chatTools.ts";

/**
 * Asking only when a condition holds at call time. Driven through `execute`
 * directly, with no database: the wrapper doesn't touch the registry.
 */

const inner = tool({
  description: "fetch",
  inputSchema: z.object({ url: z.string() }),
  execute: async ({ url }) => ({ ran: url }),
});

let calls = 0;
const options = () => ({ toolCallId: `cond-${++calls}`, messages: [] }) as never;

function execute(t: unknown, args: unknown) {
  return (t as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, options());
}

describe("wrapToolWithConditionalApproval", () => {
  const needsApproval = (args: unknown) => (args as { url: string }).url !== "https://given.test/";

  it("runs without asking when the condition doesn't hold", async () => {
    const asked: unknown[] = [];
    const wrapped = wrapToolWithConditionalApproval(
      "read_web_page",
      inner,
      { onRequest: async ({ args }) => void asked.push(args) },
      needsApproval,
    );
    expect(await execute(wrapped, { url: "https://given.test/" })).toEqual({
      ran: "https://given.test/",
    });
    expect(asked).toEqual([]);
  });

  it("asks when it does, and shows the user the arguments", async () => {
    const asked: unknown[] = [];
    const wrapped = wrapToolWithConditionalApproval(
      "read_web_page",
      inner,
      {
        onRequest: async ({ toolCallId, args }) => {
          asked.push(args);
          resolveApproval(toolCallId, true);
        },
      },
      needsApproval,
    );
    expect(await execute(wrapped, { url: "https://evil.test/?q=x" })).toEqual({
      ran: "https://evil.test/?q=x",
    });
    expect(asked).toEqual([{ url: "https://evil.test/?q=x" }]);
  });

  it("does not run when the user denies", async () => {
    const wrapped = wrapToolWithConditionalApproval(
      "read_web_page",
      inner,
      { onRequest: async ({ toolCallId }) => void resolveApproval(toolCallId, false) },
      needsApproval,
    );
    expect(await execute(wrapped, { url: "https://evil.test/" })).toEqual({
      denied: true,
      message: "The user denied this tool call.",
    });
  });

  it("refuses rather than runs when the surface can't ask", async () => {
    const wrapped = wrapToolWithConditionalApproval(
      "read_web_page",
      inner,
      undefined,
      needsApproval,
    );
    expect(await execute(wrapped, { url: "https://evil.test/" })).toMatchObject({
      needsApproval: true,
    });
    expect(await execute(wrapped, { url: "https://given.test/" })).toEqual({
      ran: "https://given.test/",
    });
  });

  it("checks the condition on each call, so it can change partway through a turn", async () => {
    const state = { tainted: false };
    const wrapped = wrapToolWithConditionalApproval(
      "delete_task",
      inner,
      undefined,
      () => state.tainted,
    );
    expect(await execute(wrapped, { url: "a" })).toEqual({ ran: "a" });
    state.tainted = true;
    expect(await execute(wrapped, { url: "b" })).toMatchObject({ needsApproval: true });
  });
});
