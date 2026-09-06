import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { getDb } from "../db/client.ts";
import { agentTools } from "../db/schema.ts";
import {
  connectionError,
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  updateMcpServer,
} from "./service.ts";

/**
 * How a failed connect is described to the user. Pure — no DB, no network.
 */
describe("connectionError", () => {
  it("carries the cause, which is where the useful half lives", () => {
    // The MCP client library reports a response its schema rejected as a bare
    // "Failed to parse server response" and puts what was actually wrong in the
    // cause, so reporting only the message tells the user nothing.
    const error = new Error("Failed to parse server response", {
      cause: new Error("tools.0.inputSchema.type: expected 'object', received undefined"),
    });
    expect(connectionError(error)).toBe(
      "Failed to parse server response: tools.0.inputSchema.type: expected 'object', received undefined",
    );
  });

  it("is just the message when there is no cause", () => {
    expect(connectionError(new Error("fetch failed"))).toBe("fetch failed");
  });

  it("keeps the http status the client library attaches", () => {
    const error = Object.assign(new Error("Forbidden"), { statusCode: 403 });
    expect(connectionError(error)).toBe("Forbidden (status 403)");
  });

  it("redacts credentials that a server echoed back into its complaint", () => {
    const error = new Error("bad response", {
      cause: new Error("rejected authorization: Bearer sk-ant-abcdef0123456789xyz"),
    });
    const message = connectionError(error);
    expect(message).not.toContain("sk-ant-abcdef0123456789xyz");
    expect(message).toBe("bad response: rejected authorization: Bearer [redacted]");
  });

  it("redacts a bare token that isn't behind an authorization header", () => {
    const error = new Error("bad response", {
      cause: new Error("unknown key ghp_abcdefghij0123456789 in payload"),
    });
    expect(connectionError(error)).toBe("bad response: unknown key [redacted-token] in payload");
  });

  it("bounds a cause long enough to swamp the UI", () => {
    const error = new Error("bad response", { cause: new Error("x".repeat(1000)) });
    // The prefix plus the 300-character cap, and nothing like the full 1000.
    expect(connectionError(error).length).toBe("bad response: ".length + 300);
  });

  it("survives something thrown that isn't an Error", () => {
    expect(connectionError("plain string")).toBe("plain string");
  });
});

/**
 * MCP-server CRUD, backed by `~/.yarvis/settings.json` — no Postgres needed.
 */
describe("mcp server CRUD", () => {
  let dir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yarvis-mcp-service-"));
    originalPath = process.env.YARVIS_SETTINGS_PATH;
    process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
    else process.env.YARVIS_SETTINGS_PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  });

  it("lists no servers when none exist", async () => {
    expect(await listMcpServers()).toEqual([]);
  });

  it("creates a server and reads it back by id", async () => {
    const created = await createMcpServer({
      name: "remote",
      transport: "http",
      url: "https://mcp.example.com/sse",
      headerNames: ["X-Tenant"],
    });
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("remote");
    expect(created.enabled).toBe(true);
    expect(created.createdAt).toBe(created.updatedAt);

    const fetched = await getMcpServer(created.id);
    expect(fetched).toEqual(created);
  });

  it("returns null for an unknown id", async () => {
    expect(await getMcpServer("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("lists servers sorted by name", async () => {
    await createMcpServer({ name: "zeta", transport: "stdio", command: "npx" });
    await createMcpServer({ name: "alpha", transport: "stdio", command: "npx" });
    const rows = await listMcpServers();
    expect(rows.map((r) => r.name)).toEqual(["alpha", "zeta"]);
  });

  it("merges a patch and bumps updatedAt", async () => {
    const created = await createMcpServer({
      name: "remote",
      transport: "http",
      url: "https://mcp.example.com/sse",
    });
    const updated = await updateMcpServer(created.id, { enabled: false });
    expect(updated?.enabled).toBe(false);
    expect(updated?.name).toBe("remote"); // untouched fields survive the merge
    expect(updated).not.toBeNull();
    expect(updated!.updatedAt >= created.updatedAt).toBe(true);
  });

  it("returns null updating an unknown id", async () => {
    expect(
      await updateMcpServer("00000000-0000-0000-0000-000000000000", { enabled: false }),
    ).toBeNull();
  });

  it("does not disturb other servers in the same section", async () => {
    const a = await createMcpServer({ name: "a", transport: "stdio", command: "npx" });
    const b = await createMcpServer({ name: "b", transport: "stdio", command: "npx" });
    await updateMcpServer(a.id, { enabled: false });
    expect((await getMcpServer(b.id))?.enabled).toBe(true);
  });
});

/**
 * `deleteMcpServer` still needs Postgres to clean up the `agent_tools` rows
 * the removed foreign key used to cascade away.
 */
describe("deleteMcpServer", () => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
  const sql = postgres(url, { max: 1 });
  const db = getDb(url).db;

  let dir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yarvis-mcp-service-delete-"));
    originalPath = process.env.YARVIS_SETTINGS_PATH;
    process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
    await sql`TRUNCATE agent_tools RESTART IDENTITY CASCADE`;
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
    else process.env.YARVIS_SETTINGS_PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await sql.end();
  });

  it("removes the server and cascades its agent_tools rows", async () => {
    const server = await createMcpServer({
      name: "remote",
      transport: "http",
      url: "https://mcp.example.com/sse",
    });
    await db.insert(agentTools).values({
      id: `mcp:${server.id}:do_thing`,
      source: "mcp",
      serverId: server.id,
      name: "do_thing",
      description: "",
      contentHash: "hash",
    });

    const ok = await deleteMcpServer(db, server.id);
    expect(ok).toBe(true);
    expect(await getMcpServer(server.id)).toBeNull();

    const rows = await db.select().from(agentTools).where(eq(agentTools.serverId, server.id));
    expect(rows).toEqual([]);
  });

  it("returns false, and leaves agent_tools alone, for an unknown server", async () => {
    await db.insert(agentTools).values({
      id: "mcp:unrelated:tool",
      source: "mcp",
      serverId: "00000000-0000-0000-0000-000000000000",
      name: "tool",
      description: "",
      contentHash: "hash",
    });

    const ok = await deleteMcpServer(db, "11111111-1111-1111-1111-111111111111");
    expect(ok).toBe(false);

    const rows = await db.select().from(agentTools);
    expect(rows).toHaveLength(1);
  });
});
