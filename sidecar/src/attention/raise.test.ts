import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  buildAttentionTools,
  MAX_RAISES_PER_TURN,
  newAttentionState,
} from "../chat/attentionTools.ts";
import type { AttentionItemRow } from "../db/schema.ts";
import * as schema from "../db/schema.ts";
import { askUser } from "../headsDown/attention.ts";
import { createStream, linkToStream, updateStream } from "../workStreams/service.ts";
import { streamCategory, workspaceCategory } from "./category.ts";
import { subscribe } from "./hub.ts";
import { raiseAttention, resolveRaisedAttention } from "./raise.ts";
import { listAttention } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(async () => {
  await sql`TRUNCATE attention_items, workspaces, work_streams, heads_down_questions RESTART IDENTITY CASCADE`;
  await sql`INSERT INTO workspaces (id, name, slug, status, root_path)
            VALUES (${WORKSPACE_ID}, 'ws', 'ws', 'active', '/tmp/ws')`;
});

afterAll(async () => {
  await sql.end();
});

// The AI SDK passes a second options argument to execute; tests don't need it.
const opts = { toolCallId: "test", messages: [] } as never;

describe("raiseAttention", () => {
  it("stores the item with its category and kind, and publishes it", async () => {
    const seen: AttentionItemRow[] = [];
    const unsubscribe = subscribe((item) => seen.push(item));
    try {
      const item = await raiseAttention(db, {
        category: "review",
        kind: "action",
        title: "Review ready",
        body: "Add ordering",
        navTarget: { type: "pr", owner: "o", repo: "r", number: 1 },
      });
      expect(item).toMatchObject({
        category: "review",
        kind: "action",
        source: "system",
        status: "pending",
        navTarget: { type: "pr", owner: "o", repo: "r", number: 1 },
      });
      expect(seen.map((i) => i.id)).toEqual([item.id]);
    } finally {
      unsubscribe();
    }
  });

  it("updates the pending item raised under the same dedupe key", async () => {
    const first = await raiseAttention(db, {
      category: "build",
      kind: "message",
      title: "CI",
      body: "running",
      dedupeKey: "ci:o/r#1",
    });
    const second = await raiseAttention(db, {
      category: "build",
      kind: "message",
      title: "CI",
      body: "green",
      dedupeKey: "ci:o/r#1",
    });
    expect(second.id).toBe(first.id);
    const pending = await listAttention(db, { status: "pending" });
    expect(pending.map((i) => i.body)).toEqual(["green"]);
  });

  it("moves a re-raised item to its new category", async () => {
    await raiseAttention(db, { category: "build", kind: "action", title: "x", dedupeKey: "k" });
    await raiseAttention(db, { category: "review", kind: "action", title: "x", dedupeKey: "k" });
    const pending = await listAttention(db, { status: "pending" });
    expect(pending.map((i) => i.category)).toEqual(["review"]);
  });

  it("follows a re-raised item's risk level, and clears it when none is given", async () => {
    const raise = (risk?: "low" | "high") =>
      raiseAttention(db, { category: "review", kind: "action", title: "x", dedupeKey: "k", risk });
    expect((await raise("low")).risk).toBe("low");
    expect((await raise("high")).risk).toBe("high");
    expect((await raise()).risk).toBeNull();
  });

  it("keeps items without a dedupe key apart", async () => {
    await raiseAttention(db, { category: "general", kind: "message", title: "one" });
    await raiseAttention(db, { category: "general", kind: "message", title: "two" });
    expect(await listAttention(db, { status: "pending" })).toHaveLength(2);
  });

  it("resolves what was raised under a key, and nothing else", async () => {
    await raiseAttention(db, { category: "review", kind: "action", title: "a", dedupeKey: "a" });
    const other = await raiseAttention(db, {
      category: "review",
      kind: "action",
      title: "b",
      dedupeKey: "b",
    });
    await resolveRaisedAttention(db, "a");
    const pending = await listAttention(db, { status: "pending" });
    expect(pending.map((i) => i.id)).toEqual([other.id]);
  });
});

describe("raise_attention tool", () => {
  const tools = () => buildAttentionTools(newAttentionState(), db);

  it("raises an item as the assistant", async () => {
    const result = await tools().raise_attention.execute!(
      {
        category: "slack",
        kind: "message",
        title: "Reply waiting",
        body: "Sam asked about the deploy",
        dedupeKey: "slack:C1/123",
      },
      opts,
    );
    const [item] = await listAttention(db, { status: "pending" });
    expect(result).toEqual({ id: item!.id });
    // The title is the app's; the model's heading leads the body.
    expect(item).toMatchObject({
      source: "chat-agent",
      category: "slack",
      kind: "message",
      title: "Note from Yarvis",
      body: "Reply waiting\nSam asked about the deploy",
    });
  });

  it("stops raising after the per-turn cap", async () => {
    const raise = tools().raise_attention;
    const call = (n: number) =>
      raise.execute!({ category: "general", kind: "action", title: `item ${n}` }, opts);
    for (let n = 0; n < MAX_RAISES_PER_TURN; n++) await call(n);
    expect(await call(99)).toHaveProperty("error");
    expect(await listAttention(db, { status: "pending" })).toHaveLength(MAX_RAISES_PER_TURN);
  });

  it("can't rewrite an item the app raised under the same key", async () => {
    const own = await raiseAttention(db, {
      category: "review",
      kind: "action",
      title: "Review ready",
      dedupeKey: "pr:o/r#1",
    });
    await tools().raise_attention.execute!(
      { category: "review", kind: "action", title: "Something else", dedupeKey: "pr:o/r#1" },
      opts,
    );
    const pending = await listAttention(db, { status: "pending" });
    expect(pending).toHaveLength(2);
    expect(pending.find((i) => i.id === own.id)?.title).toBe("Review ready");
  });

  it("refuses a category that doesn't exist and a malformed target", () => {
    const schema = tools().raise_attention.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ category: "urgent", kind: "action", title: "x" }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        category: "review",
        kind: "action",
        title: "x",
        navTarget: { type: "workspace", workspaceId: "not-a-uuid" },
      }).success,
    ).toBe(false);
  });
});

describe("categories from work streams", () => {
  it("gives a workspace's sessions build when no stream says otherwise", async () => {
    expect(await workspaceCategory(db, WORKSPACE_ID)).toBe("build");
    expect(await workspaceCategory(db, null)).toBe("build");
  });

  it("gives a workspace's sessions its open stream's category", async () => {
    const stream = await createStream(db, { title: "Review Sam's PR", category: "review" });
    await linkToStream(db, stream.id, { ref: { kind: "workspace", workspaceId: WORKSPACE_ID } });
    expect(await workspaceCategory(db, WORKSPACE_ID)).toBe("review");

    await updateStream(db, stream.id, { status: "done" });
    expect(await workspaceCategory(db, WORKSPACE_ID)).toBe("build");
  });

  it("reads null for a stream with no category or none at all", async () => {
    const stream = await createStream(db, { title: "Untagged" });
    expect(await streamCategory(db, stream.id)).toBeNull();
    expect(await streamCategory(db, null)).toBeNull();
  });

  it("files a heads-down question under its stream's category, else general", async () => {
    const stream = await createStream(db, { title: "Answer Sam", category: "slack" });
    await askUser(db, { kind: "question", question: "Reply now?", streamId: stream.id });
    await askUser(db, { kind: "question", question: "Which repo?" });
    const pending = await listAttention(db, { status: "pending" });
    const byBody = Object.fromEntries(pending.map((i) => [i.body, i.category]));
    expect(byBody).toEqual({ "Reply now?": "slack", "Which repo?": "general" });
  });
});
