import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { getDb } from "../db/client.ts";
import { HashEmbedder } from "../memory/embedder.ts";
import {
  listRegistryTools,
  searchRegistry,
  setToolPolicy,
  syncToolSet,
  type ToolDescriptor,
} from "./store.ts";

/**
 * Registry store tests. Require a Postgres with pgvector (provided in CI). The
 * offline HashEmbedder keeps embedding deterministic and network-free.
 */
const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;
const embedder = new HashEmbedder();

function builtin(name: string, description: string): ToolDescriptor {
  return {
    id: `builtin:${name}`,
    source: "builtin",
    serverId: null,
    name,
    description,
    inputSchema: null,
  };
}

beforeEach(async () => {
  await sql`TRUNCATE agent_tools, mcp_servers RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

const builtinScope = {
  source: "builtin" as const,
  serverId: null,
  defaultPolicy: "always" as const,
};

describe("syncToolSet", () => {
  it("inserts new tools with the default policy", async () => {
    const res = await syncToolSet(
      db,
      embedder,
      [builtin("a", "alpha"), builtin("b", "beta")],
      builtinScope,
    );
    expect(res).toEqual({ inserted: 2, updated: 0, deleted: 0 });

    const rows = await listRegistryTools(db);
    expect(rows.map((r) => r.id).sort()).toEqual(["builtin:a", "builtin:b"]);
    expect(rows.every((r) => r.policy === "always")).toBe(true);
  });

  it("skips re-embedding unchanged tools on resync", async () => {
    const descriptors = [builtin("a", "alpha"), builtin("b", "beta")];
    await syncToolSet(db, embedder, descriptors, builtinScope);
    const res = await syncToolSet(db, embedder, descriptors, builtinScope);
    expect(res).toEqual({ inserted: 0, updated: 0, deleted: 0 });
  });

  it("updates changed tools while preserving their policy", async () => {
    await syncToolSet(db, embedder, [builtin("a", "alpha")], builtinScope);
    await setToolPolicy(db, "builtin:a", "search");

    const res = await syncToolSet(db, embedder, [builtin("a", "alpha v2")], builtinScope);
    expect(res).toEqual({ inserted: 0, updated: 1, deleted: 0 });

    const [row] = await listRegistryTools(db);
    expect(row?.description).toBe("alpha v2");
    expect(row?.policy).toBe("search"); // user-set policy survives resync
  });

  it("removes tools no longer present", async () => {
    await syncToolSet(db, embedder, [builtin("a", "alpha"), builtin("b", "beta")], builtinScope);
    const res = await syncToolSet(db, embedder, [builtin("a", "alpha")], builtinScope);
    expect(res.deleted).toBe(1);
    const rows = await listRegistryTools(db);
    expect(rows.map((r) => r.id)).toEqual(["builtin:a"]);
  });
});

describe("setToolPolicy", () => {
  it("updates the policy and returns the row", async () => {
    await syncToolSet(db, embedder, [builtin("a", "alpha")], builtinScope);
    const updated = await setToolPolicy(db, "builtin:a", "disabled");
    expect(updated?.policy).toBe("disabled");
    expect(await setToolPolicy(db, "builtin:missing", "always")).toBeNull();
  });
});

describe("searchRegistry", () => {
  it("returns only tools whose policy is 'search'", async () => {
    await syncToolSet(
      db,
      embedder,
      [builtin("always_tool", "always"), builtin("search_tool", "searchable")],
      builtinScope,
    );
    await setToolPolicy(db, "builtin:search_tool", "search");

    const hits = await searchRegistry(db, embedder, "anything", 10);
    expect(hits.map((h) => h.id)).toEqual(["builtin:search_tool"]);
    expect(hits[0]?.score).toBeGreaterThanOrEqual(0);
  });
});
