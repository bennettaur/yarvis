import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import {
  clearAttentionScope,
  createAttention,
  listAttention,
  updateAttentionStatus,
} from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  await sql`TRUNCATE attention_items, workspaces RESTART IDENTITY CASCADE`;
});

/** A workspace row the FK on attention_items.workspace_id can reference. */
async function seedWorkspace(id: string, name: string) {
  await sql`INSERT INTO workspaces (id, name, slug, status, root_path)
            VALUES (${id}, ${name}, ${name}, 'active', '/tmp/ws')`;
}

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";

afterAll(async () => {
  await sql.end();
});

const base = {
  source: "claude-hook" as const,
  sessionKey: "ws-claude:w1",
  kind: "permission" as const,
  title: "Fix API",
};

describe("attention service", () => {
  it("coalesces a re-prompt into one pending row per (session, kind)", async () => {
    await createAttention(db, { ...base, body: "first" });
    await createAttention(db, { ...base, body: "second" });

    const pending = await listAttention(db, { status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.body).toBe("second");
  });

  it("keeps distinct kinds for the same session as separate items", async () => {
    await createAttention(db, { ...base, kind: "permission" });
    await createAttention(db, { ...base, kind: "idle" });
    expect(await listAttention(db, { status: "pending" })).toHaveLength(2);
  });

  it("resolves a session's other pending items when it completes", async () => {
    await createAttention(db, { ...base, kind: "permission" });
    await createAttention(db, { ...base, kind: "completed", title: "Done" });

    const pending = await listAttention(db, { status: "pending" });
    // The permission prompt is superseded; only the completion remains pending.
    expect(pending.map((p) => p.kind)).toEqual(["completed"]);
    const resolved = await listAttention(db, { status: "resolved" });
    expect(resolved.map((p) => p.kind)).toEqual(["permission"]);
  });

  it("does not coalesce sourceless items (null sessionKey)", async () => {
    await createAttention(db, { source: "chat-agent", kind: "info", title: "Chat" });
    await createAttention(db, { source: "chat-agent", kind: "info", title: "Chat" });
    expect(await listAttention(db, { status: "pending" })).toHaveLength(2);
  });

  it("lists newest-first by the seq cursor", async () => {
    const a = await createAttention(db, { ...base, sessionKey: "ws-claude:a" });
    const b = await createAttention(db, { ...base, sessionKey: "ws-claude:b" });
    const pending = await listAttention(db, { status: "pending" });
    expect(pending.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it("stamps readAt and resolvedAt on status changes", async () => {
    const item = await createAttention(db, base);
    const read = await updateAttentionStatus(db, item.id, "read");
    expect(read?.status).toBe("read");
    expect(read?.readAt).not.toBeNull();

    const dismissed = await updateAttentionStatus(db, item.id, "dismissed");
    expect(dismissed?.resolvedAt).not.toBeNull();
  });
});

describe("clearAttentionScope", () => {
  it("clears every pending item a workspace raised, whichever session raised it", async () => {
    await seedWorkspace(WORKSPACE_ID, "Fix API");
    await createAttention(db, {
      ...base,
      workspaceId: WORKSPACE_ID,
      sessionKey: `ws-claude:${WORKSPACE_ID}`,
    });
    await createAttention(db, {
      ...base,
      workspaceId: WORKSPACE_ID,
      sessionKey: `ws:${WORKSPACE_ID}/t2/p1`,
      kind: "idle",
    });
    const untouched = await createAttention(db, { ...base, sessionKey: "ws-claude:other" });

    const cleared = await clearAttentionScope(db, { workspaceId: WORKSPACE_ID }, "read");
    expect(cleared).toHaveLength(2);
    expect(cleared.every((row) => row.readAt !== null)).toBe(true);

    const pending = await listAttention(db, { status: "pending" });
    expect(pending.map((p) => p.id)).toEqual([untouched.id]);
  });

  it("clears just one session when scoped to it", async () => {
    await createAttention(db, { ...base, sessionKey: "tab:terminal/t1/p1" });
    await createAttention(db, { ...base, sessionKey: "tab:terminal/t2/p1" });

    await clearAttentionScope(db, { sessionKey: "tab:terminal/t1/p1" }, "dismissed");
    const pending = await listAttention(db, { status: "pending" });
    expect(pending.map((p) => p.sessionKey)).toEqual(["tab:terminal/t2/p1"]);
  });

  it("leaves already-cleared items alone and matches nothing for an empty scope", async () => {
    const item = await createAttention(db, base);
    await updateAttentionStatus(db, item.id, "dismissed");

    expect(await clearAttentionScope(db, { sessionKey: base.sessionKey }, "read")).toHaveLength(0);
    expect(await clearAttentionScope(db, {}, "read")).toHaveLength(0);
  });
});
