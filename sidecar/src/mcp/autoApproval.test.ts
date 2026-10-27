import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { type Tool, tool } from "ai";
import postgres from "postgres";
import { z } from "zod";
import { syncBuiltins } from "../agentTools/registry.ts";
import { setToolSettings, syncToolSet } from "../agentTools/store.ts";
import type { ToolCallReviewer } from "../chat/toolReview.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { HashEmbedder } from "../memory/embedder.ts";
import { resolveApproval } from "./approvals.ts";
import { assembleAgentToolset, modelToolKey } from "./chatTools.ts";
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

async function assemble(
  approval?: Parameters<typeof assembleAgentToolset>[0]["approval"],
  honourStandingConsent: boolean | (() => boolean) = true,
  reviewer?: ToolCallReviewer,
) {
  return assembleAgentToolset({
    config,
    db,
    sessionId: `sess-${crypto.randomUUID()}`,
    builtinTools: {},
    approval,
    honourStandingConsent,
    reviewer,
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

    await tools[modelToolKey(ASK_ID)]?.execute?.({}, executeOptions);
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

    const result = await tools[modelToolKey(AUTO_ID)]?.execute?.({}, executeOptions);
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

    await tools[modelToolKey(ASK_ID)]?.execute?.({}, executeOptions);
    expect(asked).toEqual([ASK_ID]);
  });

  // Consent was given about turns the user typed and read back. A spoken turn is
  // neither, so it asks again — the same reasoning that puts the destructive
  // built-ins behind a prompt for it.
  it("asks anyway on a turn the user didn't proof-read", async () => {
    await setToolSettings(db, AUTO_ID, { approval: "auto" });
    const asked: string[] = [];
    const { tools } = await assemble(
      {
        onRequest: async ({ toolCallId, id }) => {
          asked.push(id);
          resolveApproval(toolCallId, false);
        },
      },
      false,
    );

    await tools[modelToolKey(AUTO_ID)]?.execute?.({}, executeOptions);
    expect(asked).toEqual([AUTO_ID]);
  });

  // Once a turn has read a web page, the request reaching the tool may be the
  // page's, so consent stops applying from that point in the turn.
  it("asks again once the turn has read a web page", async () => {
    await setToolSettings(db, AUTO_ID, { approval: "auto" });
    const state = { readWebPage: false };
    const asked: string[] = [];
    const { tools } = await assemble(
      {
        onRequest: async ({ toolCallId, id }) => {
          asked.push(id);
          resolveApproval(toolCallId, true);
        },
      },
      () => !state.readWebPage,
    );

    const auto = tools[modelToolKey(AUTO_ID)];
    await auto?.execute?.({}, { toolCallId: "call-before", messages: [] } as never);
    expect(asked).toEqual([]);
    state.readWebPage = true;
    await auto?.execute?.({}, { toolCallId: "call-after", messages: [] } as never);
    expect(asked).toEqual([AUTO_ID]);
  });

  // Standing consent is consent to skip a prompt, not consent to run unwatched:
  // a surface with no channel to ask on still gets no MCP tools at all.
  it("does not reach a surface that could never have asked", async () => {
    await setToolSettings(db, AUTO_ID, { approval: "auto" });
    const { tools } = await assemble(undefined);
    expect(Object.keys(tools)).not.toContain(modelToolKey(AUTO_ID));
    expect(Object.keys(tools)).not.toContain(modelToolKey(ASK_ID));
  });

  // Consent was given for the tool as it was described then.
  it("is withdrawn when the server redefines the tool", async () => {
    await setToolSettings(db, AUTO_ID, { approval: "auto" });
    await syncToolSet(
      db,
      embedder,
      [
        {
          id: AUTO_ID,
          source: "mcp",
          serverId: SERVER_ID,
          name: "search_pages",
          description: "Search pages, and archive the ones you no longer need",
          inputSchema: null,
        },
      ],
      { source: "mcp", serverId: SERVER_ID, defaultPolicy: "always" },
    );

    const asked: string[] = [];
    const { tools } = await assemble({
      onRequest: async ({ toolCallId, id }) => {
        asked.push(id);
        resolveApproval(toolCallId, false);
      },
    });
    await tools[modelToolKey(AUTO_ID)]?.execute?.({}, executeOptions);
    expect(asked).toEqual([AUTO_ID]);
  });
});

describe("auto mode's decision model", () => {
  it("runs a call it approves without prompting", async () => {
    const reviewed: string[] = [];
    const asked: string[] = [];
    const { tools } = await assemble(
      { onRequest: async ({ id }) => void asked.push(id) },
      true,
      async ({ id }) => {
        reviewed.push(id);
        return true;
      },
    );

    const result = await tools[modelToolKey(ASK_ID)]?.execute?.({}, executeOptions);
    expect(result).toEqual({ ran: "write_page" });
    expect(reviewed).toEqual([ASK_ID]);
    expect(asked).toEqual([]);
  });

  it("asks the user when it does not approve", async () => {
    const asked: string[] = [];
    const { tools } = await assemble(
      {
        onRequest: async ({ toolCallId, id }) => {
          asked.push(id);
          resolveApproval(toolCallId, false);
        },
      },
      true,
      async () => false,
    );

    const result = await tools[modelToolKey(ASK_ID)]?.execute?.({}, executeOptions);
    expect(result).toMatchObject({ denied: true });
    expect(asked).toEqual([ASK_ID]);
  });

  it("is not asked on a turn the user didn't proof-read", async () => {
    const reviewed: string[] = [];
    const asked: string[] = [];
    const { tools } = await assemble(
      {
        onRequest: async ({ toolCallId, id }) => {
          asked.push(id);
          resolveApproval(toolCallId, false);
        },
      },
      false,
      async ({ id }) => {
        reviewed.push(id);
        return true;
      },
    );

    await tools[modelToolKey(ASK_ID)]?.execute?.({}, executeOptions);
    expect(reviewed).toEqual([]);
    expect(asked).toEqual([ASK_ID]);
  });

  // The built-ins that ask are the ones whose answer must come from the user.
  it("never reviews a built-in that has to be confirmed", async () => {
    const reviewed: string[] = [];
    const asked: string[] = [];
    const { tools } = await assembleAgentToolset({
      config,
      db,
      sessionId: `sess-${crypto.randomUUID()}`,
      builtinTools: { register_repo: liveTool("register_repo") as unknown as Tool },
      confirmBuiltins: new Set(["register_repo"]),
      approval: {
        onRequest: async ({ toolCallId, id }) => {
          asked.push(id);
          resolveApproval(toolCallId, false);
        },
      },
      reviewer: async ({ id }) => {
        reviewed.push(id);
        return true;
      },
      liveTools: {},
    });

    await tools.register_repo?.execute?.({}, executeOptions);
    expect(reviewed).toEqual([]);
    expect(asked).toEqual(["register_repo"]);
  });

  it("neither runs the call nor asks when the turn is stopped during the review", async () => {
    const controller = new AbortController();
    const asked: string[] = [];
    const { tools } = await assemble(
      { signal: controller.signal, onRequest: async ({ id }) => void asked.push(id) },
      true,
      async () => {
        controller.abort();
        return true;
      },
    );

    const result = await tools[modelToolKey(ASK_ID)]?.execute?.({}, executeOptions);
    expect(result).toMatchObject({ denied: true });
    expect(asked).toEqual([]);
  });
});

describe("the reason the model gives for a call", () => {
  it("reaches the reviewer and the approval prompt, and never the tool", async () => {
    let ran: unknown;
    const tools = {
      [ASK_ID]: tool({
        description: "write_page",
        inputSchema: z.object({ title: z.string() }),
        execute: async (args) => {
          ran = args;
          return { ok: true };
        },
      }) as unknown as McpClientTool,
    };
    const requests: { args: unknown; reason: string | null }[] = [];
    const reviewed: (string | null | undefined)[] = [];
    const reviewer: ToolCallReviewer = async (call) => {
      reviewed.push(call.reason);
      return false;
    };
    const { tools: assembled } = await assembleAgentToolset({
      config,
      db,
      sessionId: "s-reason",
      builtinTools: {},
      liveTools: tools,
      reviewer,
      approval: {
        onRequest: async ({ toolCallId, args, reason }) => {
          requests.push({ args, reason });
          resolveApproval(toolCallId, true);
        },
      },
    });

    await (assembled[modelToolKey(ASK_ID)] as Tool).execute!(
      { title: "notes", callReason: "The user asked for their notes in Notion" },
      { toolCallId: "reason-1", messages: [] } as never,
    );

    expect(reviewed).toEqual(["The user asked for their notes in Notion"]);
    expect(requests).toEqual([
      { args: { title: "notes" }, reason: "The user asked for their notes in Notion" },
    ]);
    expect(ran).toEqual({ title: "notes" });
  });
});
