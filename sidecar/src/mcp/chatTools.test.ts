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
import { assembleAgentToolset, modelToolKey } from "./chatTools.ts";
import type { McpClientTool } from "./connectionManager.ts";
import { mountTools, unmountAll } from "./mountedTools.ts";

/**
 * Model tool keys, toolset assembly and the policy-driven active set. Assembly
 * requires Postgres with pgvector (CI). There are no MCP connections, so MCP
 * tools are injected as `liveTools` where a test needs them.
 */
const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;
const embedder = new HashEmbedder();

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

const fakeBuiltin = (name: string) =>
  tool({ description: name, inputSchema: z.object({}), execute: async () => ({ ok: true }) });

beforeEach(async () => {
  await sql`TRUNCATE agent_tools, mcp_servers RESTART IDENTITY CASCADE`;
  await syncBuiltins(db, embedder);
});

afterAll(async () => {
  await sql.end();
});

describe("modelToolKey", () => {
  const SERVER_ID = "907bd56b-f417-419e-92db-2f1e4e1aa0ce";

  it("keeps a built-in's bare name", () => {
    expect(modelToolKey("builtin:create_task")).toBe("create_task");
  });

  // Bedrock rejects a whole turn over one tool name it can't accept (#321).
  it("keeps a GitHub-length MCP tool name readable and provider-safe", () => {
    const key = modelToolKey(`mcp:${SERVER_ID}:github__update_pull_request`);
    expect(key).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(key).toEndWith("_github__update_pull_request");
  });

  it("replaces characters providers refuse in a tool name", () => {
    expect(modelToolKey(`mcp:${SERVER_ID}:pages.search`)).toMatch(
      /^mcp_[0-9a-f]{12}_pages_search$/,
    );
  });

  it("gives distinct keys to names that only differ past the cut", () => {
    const stem = "x".repeat(60);
    const a = modelToolKey(`mcp:${SERVER_ID}:${stem}_a`);
    expect(a).toHaveLength(64);
    expect(a).not.toBe(modelToolKey(`mcp:${SERVER_ID}:${stem}_b`));
  });

  it("gives distinct keys to the same tool name on two servers", () => {
    expect(modelToolKey(`mcp:${SERVER_ID}:search`)).not.toBe(
      modelToolKey("mcp:11111111-1111-4111-8111-111111111111:search"),
    );
  });
});

describe("assembleAgentToolset", () => {
  it("registers built-ins + meta tools and activates always-policy tools", async () => {
    unmountAll("sess-a");
    const builtinTools = {
      create_task: fakeBuiltin("create_task"),
      remember: fakeBuiltin("remember"),
    };
    const { tools, computeActiveTools } = await assembleAgentToolset({
      config,
      db,
      sessionId: "sess-a",
      builtinTools,
      approval: { onRequest: async () => {} },
    });
    expect(Object.keys(tools)).toContain("create_task");
    expect(Object.keys(tools)).toContain("search_tools");
    expect(Object.keys(tools)).toContain("mount_tools");

    const active = computeActiveTools();
    expect(active).toContain("create_task"); // built-ins default to "always"
    expect(active).toContain("search_tools"); // meta tools always active
  });

  it("excludes disabled tools and gates search-policy tools until mounted", async () => {
    unmountAll("sess-b");
    await setToolSettings(db, "builtin:create_task", { policy: "search" });
    await setToolSettings(db, "builtin:remember", { policy: "disabled" });
    const builtinTools = {
      create_task: fakeBuiltin("create_task"),
      remember: fakeBuiltin("remember"),
      take_note: fakeBuiltin("take_note"),
    };
    const { tools, computeActiveTools } = await assembleAgentToolset({
      config,
      db,
      sessionId: "sess-b",
      builtinTools,
      approval: { onRequest: async () => {} },
    });
    expect(Object.keys(tools)).not.toContain("remember"); // disabled → not registered
    expect(Object.keys(tools)).toContain("create_task"); // search-policy → registered

    expect(computeActiveTools()).not.toContain("create_task"); // not mounted yet
    mountTools("sess-b", ["builtin:create_task"]);
    expect(computeActiveTools()).toContain("create_task"); // mounted → active
  });

  it("offers a mounted MCP tool under a key the provider accepts", async () => {
    unmountAll("sess-mcp");
    const serverId = "907bd56b-f417-419e-92db-2f1e4e1aa0ce";
    const id = `mcp:${serverId}:github__update_pull_request`;
    await sql`
      INSERT INTO mcp_servers (id, name, transport, url)
      VALUES (${serverId}, 'github', 'http', 'https://mcp.example.com/mcp')
    `;
    await syncToolSet(
      db,
      embedder,
      [
        {
          id,
          source: "mcp",
          serverId,
          name: "github__update_pull_request",
          description: "",
          inputSchema: null,
        },
      ],
      { source: "mcp", serverId, defaultPolicy: "search" },
    );
    const { tools, computeActiveTools, registryIdByKey } = await assembleAgentToolset({
      config,
      db,
      sessionId: "sess-mcp",
      builtinTools: {},
      approval: { onRequest: async () => {} },
      liveTools: { [id]: fakeBuiltin("github__update_pull_request") as unknown as McpClientTool },
    });

    const result = await tools.mount_tools!.execute!({ ids: [id] }, {
      toolCallId: "mount-1",
      messages: [],
    } as never);

    const key = modelToolKey(id);
    expect(result).toMatchObject({ mounted: [{ id, callAs: key }] });
    expect(computeActiveTools()).toContain(key);
    expect(computeActiveTools().every((k) => /^[A-Za-z0-9_-]{1,64}$/.test(k))).toBe(true);
    expect(registryIdByKey.get(key)).toBe(id);
  });
});

/**
 * A turn the user spoke rather than typed puts the irreversible built-ins
 * behind the same approval prompt MCP tools use. `execute` is driven directly
 * here — going through a model would test the provider, not the gate.
 */
describe("assembleAgentToolset with confirmed built-ins", () => {
  const executeOptions = { toolCallId: "call-1", messages: [] } as never;

  async function run(
    name: string,
    opts: {
      confirmBuiltins?: ReadonlySet<string>;
      approval?: Parameters<typeof assembleAgentToolset>[0]["approval"];
      sessionId: string;
    },
  ) {
    const { tools } = await assembleAgentToolset({
      config,
      db,
      sessionId: opts.sessionId,
      builtinTools: { [name]: fakeBuiltin(name), create_task: fakeBuiltin("create_task") },
      approval: opts.approval,
      confirmBuiltins: opts.confirmBuiltins,
    });
    return tools;
  }

  it("runs a destructive tool once the user approves", async () => {
    const asked: string[] = [];
    const tools = await run("delete_task", {
      sessionId: "sess-voice-ok",
      confirmBuiltins: new Set(["delete_task"]),
      approval: {
        onRequest: async ({ toolCallId, id }) => {
          asked.push(id);
          resolveApproval(toolCallId, true);
        },
      },
    });

    const result = await tools.delete_task!.execute!({}, executeOptions);
    expect(asked).toEqual(["delete_task"]);
    expect(result).toEqual({ ok: true });
  });

  it("does not run it when the user denies", async () => {
    const tools = await run("delete_task", {
      sessionId: "sess-voice-deny",
      confirmBuiltins: new Set(["delete_task"]),
      approval: {
        onRequest: async ({ toolCallId }) => {
          resolveApproval(toolCallId, false);
        },
      },
    });

    const result = await tools.delete_task!.execute!({}, executeOptions);
    expect(result).toEqual({ denied: true, message: "The user denied this tool call." });
  });

  it("leaves tools outside the set unwrapped", async () => {
    const asked: string[] = [];
    const tools = await run("delete_task", {
      sessionId: "sess-voice-other",
      confirmBuiltins: new Set(["delete_task"]),
      approval: {
        onRequest: async ({ toolCallId, id }) => {
          asked.push(id);
          resolveApproval(toolCallId, true);
        },
      },
    });

    await tools.create_task!.execute!({}, executeOptions);
    expect(asked).toEqual([]);
  });

  it("runs destructive tools unprompted on a turn that wasn't spoken", async () => {
    const asked: string[] = [];
    const tools = await run("delete_task", {
      sessionId: "sess-typed",
      approval: {
        onRequest: async ({ toolCallId, id }) => {
          asked.push(id);
          resolveApproval(toolCallId, true);
        },
      },
    });

    await tools.delete_task!.execute!({}, executeOptions);
    expect(asked).toEqual([]);
  });

  it("drops a tool needing confirmation when there is no way to ask", async () => {
    const tools = await run("delete_task", {
      sessionId: "sess-no-channel",
      confirmBuiltins: new Set(["delete_task"]),
    });

    // Silently running it would be the one unacceptable outcome.
    expect(Object.keys(tools)).not.toContain("delete_task");
    expect(Object.keys(tools)).toContain("create_task");
  });
});
