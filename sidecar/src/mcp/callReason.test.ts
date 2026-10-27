import { describe, expect, it } from "bun:test";
import { asSchema, jsonSchema, type Tool, tool } from "ai";
import { z } from "zod";
import { CALL_REASON_FIELD, splitCallReason, withCallReason } from "./callReason.ts";

const archive = tool({
  description: "Archive a workspace",
  inputSchema: z.object({
    workspaceId: z.string(),
    keepBranches: z.boolean().default(true),
  }),
  execute: async () => ({ ok: true }),
});

async function schemaOf(t: Tool) {
  const schema = asSchema(t.inputSchema);
  return { json: await schema.jsonSchema, validate: schema.validate! };
}

describe("withCallReason", () => {
  it("asks the model for a reason alongside the tool's own arguments", async () => {
    const { json } = await schemaOf(withCallReason(archive).tool);
    expect(json.required).toContain(CALL_REASON_FIELD);
    expect(json.required).toContain("workspaceId");
    expect(Object.keys(json.properties ?? {})).toContain(CALL_REASON_FIELD);
  });

  it("validates with the tool's own schema, defaults included, and keeps the reason", async () => {
    const { validate } = await schemaOf(withCallReason(archive).tool);
    const result = await validate({ workspaceId: "w1", [CALL_REASON_FIELD]: "The user asked" });
    expect(result).toEqual({
      success: true,
      value: { workspaceId: "w1", keepBranches: true, [CALL_REASON_FIELD]: "The user asked" },
    });
  });

  it("refuses a call with no reason, or a reason too long to read at a glance", async () => {
    const { validate } = await schemaOf(withCallReason(archive).tool);
    expect((await validate({ workspaceId: "w1" })).success).toBe(false);
    expect(
      (await validate({ workspaceId: "w1", [CALL_REASON_FIELD]: "x".repeat(301) })).success,
    ).toBe(false);
  });

  it("still refuses arguments the tool itself would refuse", async () => {
    const { validate } = await schemaOf(withCallReason(archive).tool);
    expect((await validate({ [CALL_REASON_FIELD]: "because" })).success).toBe(false);
  });

  it("extends an MCP tool's JSON Schema the same way", async () => {
    const mcpTool = {
      description: "Post a message",
      inputSchema: jsonSchema({
        type: "object",
        properties: { channel: { type: "string" } },
        required: ["channel"],
      }),
      execute: async () => ({}),
    } as unknown as Tool;
    const { json, validate } = await schemaOf(withCallReason(mcpTool).tool);
    expect(json.required).toEqual(["channel", CALL_REASON_FIELD]);
    expect((await validate({ channel: "#x", [CALL_REASON_FIELD]: "asked to" })).success).toBe(true);
  });
});

describe("a tool that can't take a reason", () => {
  it("keeps its own callReason argument, and isn't asked for one", async () => {
    const own = tool({
      description: "Log why",
      inputSchema: z.object({ callReason: z.string() }),
      execute: async () => ({}),
    });
    const reasoned = withCallReason(own);
    const { json, validate } = await schemaOf(reasoned.tool);
    expect(await reasoned.takesReason()).toBe(false);
    expect(json.required).toEqual(["callReason"]);
    expect(await validate({ callReason: "its own value" })).toEqual({
      success: true,
      value: { callReason: "its own value" },
    });
  });

  it("is left as it was when its schema isn't a plain object", async () => {
    const union = {
      description: "Either",
      inputSchema: jsonSchema({ anyOf: [{ type: "object" }, { type: "string" }] }),
      execute: async () => ({}),
    } as unknown as Tool;
    const reasoned = withCallReason(union);
    expect(await reasoned.takesReason()).toBe(false);
    expect((await schemaOf(reasoned.tool)).json).toEqual({
      anyOf: [{ type: "object" }, { type: "string" }],
    });
  });
});

describe("the reason itself", () => {
  it("must have something to read, not just invisible characters", async () => {
    const { validate } = await schemaOf(withCallReason(archive).tool);
    expect((await validate({ workspaceId: "w1", callReason: "\u200b\u200b " })).success).toBe(
      false,
    );
  });
});

describe("splitCallReason", () => {
  it("takes the reason off the arguments the tool will run with", () => {
    expect(splitCallReason({ channel: "#x", [CALL_REASON_FIELD]: "asked to" })).toEqual({
      reason: "asked to",
      args: { channel: "#x" },
    });
    expect(splitCallReason({ channel: "#x" })).toEqual({ reason: null, args: { channel: "#x" } });
  });
});
