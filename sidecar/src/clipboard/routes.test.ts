import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });

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
const app = createApp(config);
const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

async function createEntry(body: Record<string, unknown>): Promise<Response> {
  return app.request("/api/clipboard/entries", {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await sql`TRUNCATE clipboard_entries RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("clipboard routes", () => {
  it("requires authentication", async () => {
    expect((await app.request("/api/clipboard/entries")).status).toBe(401);
    expect(
      (
        await app.request("/api/clipboard/scan", {
          method: "POST",
          body: JSON.stringify({ items: [] }),
        })
      ).status,
    ).toBe(401);
  });

  it("creates and lists entries", async () => {
    const create = await createEntry({
      label: "Staging identity",
      content: "3f8a1c22-9b4e-4d2f-8a6c-1e5b7d9f0a31",
      tags: ["staging"],
    });
    expect(create.status).toBe(201);

    const list = await app.request("/api/clipboard/entries", { headers: auth });
    expect(((await list.json()) as unknown[]).length).toBe(1);
  });

  it("narrows the list by query", async () => {
    await createEntry({ label: "Staging identity", content: "abc-123" });
    await createEntry({ label: "Pods", content: "kubectl get pods" });

    const list = await app.request("/api/clipboard/entries?query=kubectl", { headers: auth });
    const entries = (await list.json()) as Array<{ label: string }>;
    expect(entries.map((e) => e.label)).toEqual(["Pods"]);
  });

  it("rejects an invalid create body", async () => {
    const res = await createEntry({ content: "no label" });
    expect(res.status).toBe(400);
  });

  it("refuses a credential with 422 and names the pattern", async () => {
    const res = await createEntry({
      label: "prod key",
      content: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; secret: { kind: string } };
    expect(body.secret.kind).toBe("github-token");
    // The refusal must not echo the credential back to the caller.
    expect(body.error).not.toContain("ghp_");
  });

  it("updates, marks used, and deletes an entry", async () => {
    const created = (await (
      await createEntry({ label: "Pods", content: "kubectl get pods" })
    ).json()) as {
      id: string;
    };

    const patch = await app.request(`/api/clipboard/entries/${created.id}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ pinned: true }),
    });
    expect(((await patch.json()) as { pinned: boolean }).pinned).toBe(true);

    const used = await app.request(`/api/clipboard/entries/${created.id}/used`, {
      method: "POST",
      headers: auth,
    });
    expect(((await used.json()) as { useCount: number }).useCount).toBe(1);

    const del = await app.request(`/api/clipboard/entries/${created.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(del.status).toBe(200);

    const list = await app.request("/api/clipboard/entries", { headers: auth });
    expect((await list.json()) as unknown[]).toBeEmpty();
  });

  it("404s on an unknown entry", async () => {
    const missing = "3f8a1c22-9b4e-4d2f-8a6c-1e5b7d9f0a31";
    const res = await app.request(`/api/clipboard/entries/${missing}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(res.status).toBe(404);
  });

  it("scans a batch of clipboard history without storing it", async () => {
    const res = await app.request("/api/clipboard/scan", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        items: [
          { id: "1", text: "kubectl get pods" },
          { id: "2", text: "AKIAIOSFODNN7EXAMPLE" },
        ],
      }),
    });
    const body = (await res.json()) as {
      flagged: Array<{ id: string; kind: string; reason: string }>;
    };
    expect(body.flagged).toEqual([
      { id: "2", kind: "aws-access-key-id", reason: "looks like an AWS access key id" },
    ]);

    const list = await app.request("/api/clipboard/entries", { headers: auth });
    expect((await list.json()) as unknown[]).toBeEmpty();
  });

  it("serves the scan route with no database configured", async () => {
    const dbless = createApp({ ...config, databaseUrl: undefined });
    const res = await dbless.request("/api/clipboard/scan", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ items: [{ id: "1", text: "AKIAIOSFODNN7EXAMPLE" }] }),
    });
    expect(res.status).toBe(200);
    expect((await dbless.request("/api/clipboard/entries", { headers: auth })).status).toBe(503);
  });
});
