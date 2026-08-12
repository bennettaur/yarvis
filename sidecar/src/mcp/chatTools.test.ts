import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { tool } from "ai";
import postgres from "postgres";
import { z } from "zod";
import { syncBuiltins } from "../agentTools/registry.ts";
import { setToolPolicy } from "../agentTools/store.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { HashEmbedder } from "../memory/embedder.ts";
import { resolveApproval } from "./approvals.ts";
import { assembleAgentToolset } from "./chatTools.ts";
import { mountTools, unmountAll } from "./mountedTools.ts";

/**
 * Toolset assembly + policy-driven active set. Requires Postgres with pgvector
 * (CI). MCP live tools are empty (no connections), so this focuses on the
 * built-in policy paths.
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
    await setToolPolicy(db, "builtin:create_task", "search");
    await setToolPolicy(db, "builtin:remember", "disabled");
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
