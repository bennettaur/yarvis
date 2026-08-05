import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import {
  CredentialRejectedError,
  createEntry,
  deleteEntry,
  listEntries,
  markEntryUsed,
  scanTexts,
  updateEntry,
} from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  await sql`TRUNCATE clipboard_entries RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("clipboard service", () => {
  it("creates an entry with sensible defaults", async () => {
    const entry = await createEntry(db, {
      label: "Staging identity",
      content: "3f8a1c22-9b4e-4d2f-8a6c-1e5b7d9f0a31",
    });
    expect(entry.id).toBeString();
    expect(entry.tags).toEqual([]);
    expect(entry.pinned).toBe(false);
    expect(entry.useCount).toBe(0);
    expect(entry.lastUsedAt).toBeNull();
  });

  it("normalizes tags to lowercase without duplicates", async () => {
    const entry = await createEntry(db, {
      label: "Pods",
      content: "kubectl get pods",
      tags: [" K8s ", "k8s", "CLI", ""],
    });
    expect(entry.tags.toSorted()).toEqual(["cli", "k8s"]);
  });

  it("refuses to store text that looks like a credential", async () => {
    const create = createEntry(db, {
      label: "totally fine",
      content: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    });
    await expect(create).rejects.toBeInstanceOf(CredentialRejectedError);
    expect(await listEntries(db)).toBeEmpty();
  });

  it("refuses an edit that turns an entry into a credential", async () => {
    const entry = await createEntry(db, { label: "Notes", content: "nothing to see" });
    const update = updateEntry(db, entry.id, {
      content: "postgres://yarvis:hunter2@localhost:5432/db",
    });
    await expect(update).rejects.toBeInstanceOf(CredentialRejectedError);
  });

  it("searches label, content, and tags case-insensitively", async () => {
    await createEntry(db, { label: "Staging identity", content: "abc-123", tags: ["staging"] });
    await createEntry(db, { label: "Pods", content: "kubectl get pods", tags: ["k8s"] });

    expect((await listEntries(db, { query: "identity" })).length).toBe(1);
    expect((await listEntries(db, { query: "KUBECTL" })).length).toBe(1);
    expect((await listEntries(db, { query: "k8s" })).length).toBe(1);
    expect((await listEntries(db, { query: "nothing here" })).length).toBe(0);
  });

  it("orders pinned first, then most recently used", async () => {
    const cold = await createEntry(db, { label: "Cold", content: "one" });
    const used = await createEntry(db, { label: "Used", content: "two" });
    const pinned = await createEntry(db, { label: "Pinned", content: "three", pinned: true });
    await markEntryUsed(db, used.id);

    const labels = (await listEntries(db)).map((e) => e.label);
    expect(labels).toEqual(["Pinned", "Used", "Cold"]);
    // Guard against the fixtures drifting into a different ordering by accident.
    expect([cold.pinned, pinned.pinned]).toEqual([false, true]);
  });

  it("counts uses and stamps when an entry was last copied", async () => {
    const entry = await createEntry(db, { label: "Pods", content: "kubectl get pods" });
    await markEntryUsed(db, entry.id);
    const used = await markEntryUsed(db, entry.id);
    expect(used?.useCount).toBe(2);
    expect(used?.lastUsedAt).not.toBeNull();
    // Copying is not an edit.
    expect(used?.updatedAt.getTime()).toBe(entry.updatedAt.getTime());
  });

  it("returns null for missing rows rather than throwing", async () => {
    const missing = "3f8a1c22-9b4e-4d2f-8a6c-1e5b7d9f0a31";
    expect(await updateEntry(db, missing, { label: "x" })).toBeNull();
    expect(await markEntryUsed(db, missing)).toBeNull();
    expect(await deleteEntry(db, missing)).toBeNull();
  });

  it("flags only the credential-shaped items in a scan batch", () => {
    const flagged = scanTexts([
      { id: "a", text: "kubectl get pods" },
      { id: "b", text: "AKIAIOSFODNN7EXAMPLE" },
      { id: "c", text: "https://github.com/bennettaur/yarvis" },
    ]);
    expect(flagged.map((f) => f.id)).toEqual(["b"]);
    expect(flagged[0]?.kind).toBe("aws-access-key-id");
  });
});
