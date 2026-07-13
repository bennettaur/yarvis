import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { createAttention, listAttention, updateAttentionStatus } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  await sql`TRUNCATE attention_items RESTART IDENTITY CASCADE`;
});

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

  it("filters by the seq cursor", async () => {
    const a = await createAttention(db, { ...base, sessionKey: "ws-claude:a" });
    const b = await createAttention(db, { ...base, sessionKey: "ws-claude:b" });
    const after = await listAttention(db, { since: a.seq, ascending: true });
    expect(after.map((r) => r.id)).toEqual([b.id]);
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
