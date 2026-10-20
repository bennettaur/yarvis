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
    const { json } = await schemaOf(withCallReason(archive));
    expect(json.required).toContain(CALL_REASON_FIELD);
    expect(json.required).toContain("workspaceId");
    expect(Object.keys(json.properties ?? {})).toContain(CALL_REASON_FIELD);
  });

  it("validates with the tool's own schema, defaults included, and keeps the reason", async () => {
    const { validate } = await schemaOf(withCallReason(archive));
    const result = await validate({ workspaceId: "w1", [CALL_REASON_FIELD]: "The user asked" });
    expect(result).toEqual({
      success: true,
      value: { workspaceId: "w1", keepBranches: true, [CALL_REASON_FIELD]: "The user asked" },
    });
  });

  it("refuses a call with no reason, or a reason too long to read at a glance", async () => {
    const { validate } = await schemaOf(withCallReason(archive));
    expect((await validate({ workspaceId: "w1" })).success).toBe(false);
    expect(
      (await validate({ workspaceId: "w1", [CALL_REASON_FIELD]: "x".repeat(301) })).success,
    ).toBe(false);
  });

  it("still refuses arguments the tool itself would refuse", async () => {
    const { validate } = await schemaOf(withCallReason(archive));
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
    const { json, validate } = await schemaOf(withCallReason(mcpTool));
    expect(json.required).toEqual(["channel", CALL_REASON_FIELD]);
    expect((await validate({ channel: "#x", [CALL_REASON_FIELD]: "asked to" })).success).toBe(true);
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
