import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { tool } from "ai";
import postgres from "postgres";
import { z } from "zod";
import { syncBuiltins } from "../agentTools/registry.ts";
import { setToolPolicy } from "../agentTools/store.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { HashEmbedder } from "../memory/embedder.ts";
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
