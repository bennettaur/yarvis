import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { tool } from "ai";
import postgres from "postgres";
import { z } from "zod";
import { syncBuiltins } from "../agentTools/registry.ts";
import { setToolSettings, syncToolSet } from "../agentTools/store.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { HashEmbedder } from "../memory/embedder.ts";
import { resolveApproval } from "./approvals.ts";
import { assembleAgentToolset } from "./chatTools.ts";
import type { McpClientTool } from "./connectionManager.ts";

/**
 * Standing consent for one MCP tool. There are no connections in a test, so the
 * live tools are injected and `execute` is driven directly — going through a
 * model would test the provider, not the gate.
 */

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;
const embedder = new HashEmbedder();

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const ASK_ID = `mcp:${SERVER_ID}:write_page`;
const AUTO_ID = `mcp:${SERVER_ID}:search_pages`;

const liveTool = (name: string) =>
  tool({
    description: name,
    inputSchema: z.object({}),
    execute: async () => ({ ran: name }),
  }) as unknown as McpClientTool;

const liveTools = { [ASK_ID]: liveTool("write_page"), [AUTO_ID]: liveTool("search_pages") };

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};

const executeOptions = { toolCallId: "call-1", messages: [] } as never;

beforeEach(async () => {
  await sql`TRUNCATE agent_tools, mcp_servers RESTART IDENTITY CASCADE`;
  await sql`
    INSERT INTO mcp_servers (id, name, transport, url)
    VALUES (${SERVER_ID}, 'notion', 'http', 'https://mcp.example.com/mcp')
  `;
  await syncBuiltins(db, embedder);
  await syncToolSet(
    db,
    embedder,
    [
      {
        id: ASK_ID,
        source: "mcp",
        serverId: SERVER_ID,
        name: "write_page",
        description: "",
        inputSchema: null,
      },
      {
        id: AUTO_ID,
        source: "mcp",
        serverId: SERVER_ID,
        name: "search_pages",
        description: "",
        inputSchema: null,
      },
    ],
    { source: "mcp", serverId: SERVER_ID, defaultPolicy: "always" },
  );
});

afterAll(async () => {
  await sql.end();
});

async function assemble(approval?: Parameters<typeof assembleAgentToolset>[0]["approval"]) {
  return assembleAgentToolset({
    config,
    db,
    sessionId: `sess-${crypto.randomUUID()}`,
    builtinTools: {},
    approval,
    liveTools,
  });
}

describe("auto-approved MCP tools", () => {
  it("asks before every call by default", async () => {
    const asked: string[] = [];
    const { tools } = await assemble({
      onRequest: async ({ toolCallId, id }) => {
        asked.push(id);
        resolveApproval(toolCallId, true);
      },
    });

    await tools[ASK_ID]?.execute?.({}, executeOptions);
    expect(asked).toEqual([ASK_ID]);
  });

  it("runs a tool the user marked auto without prompting", async () => {
    await setToolSettings(db, AUTO_ID, { approval: "auto" });
    const asked: string[] = [];
    const { tools } = await assemble({
      onRequest: async ({ id }) => {
        asked.push(id);
      },
    });

    const result = await tools[AUTO_ID]?.execute?.({}, executeOptions);
    expect(result).toEqual({ ran: "search_pages" });
    expect(asked).toEqual([]);
  });

  it("leaves the other tools on the same server asking", async () => {
    await setToolSettings(db, AUTO_ID, { approval: "auto" });
    const asked: string[] = [];
    const { tools } = await assemble({
      onRequest: async ({ toolCallId, id }) => {
        asked.push(id);
        resolveApproval(toolCallId, false);
      },
    });

    await tools[ASK_ID]?.execute?.({}, executeOptions);
    expect(asked).toEqual([ASK_ID]);
  });

  // Standing consent is consent to skip a prompt, not consent to run unwatched:
  // a surface with no channel to ask on still gets no MCP tools at all.
  it("does not reach a surface that could never have asked", async () => {
    await setToolSettings(db, AUTO_ID, { approval: "auto" });
    const { tools } = await assemble(undefined);
    expect(Object.keys(tools)).not.toContain(AUTO_ID);
    expect(Object.keys(tools)).not.toContain(ASK_ID);
  });
});
