import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: undefined,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);
const headers = { Authorization: "Bearer test-token", "Content-Type": "application/json" };

let dir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yarvis-model-catalog-routes-"));
  originalPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

const put = (body: Record<string, unknown>) =>
  app.request("/api/model-catalog", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      providerId: "anthropic",
      modelId: "m",
      capabilities: ["chat"],
      ...body,
    }),
  });

type Saved = { compactAtTokens?: number };

describe("model catalogue compaction threshold", () => {
  it("saves a threshold and returns it in the listing", async () => {
    const res = await put({ compactAtTokens: 90_000 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Saved).compactAtTokens).toBe(90_000);

    const list = await app.request("/api/model-catalog", { headers });
    const body = (await list.json()) as { models: Saved[] };
    expect(body.models[0]?.compactAtTokens).toBe(90_000);
  });

  it("lists the bundled thresholds with the defaults", async () => {
    const list = await app.request("/api/model-catalog", { headers });
    const body = (await list.json()) as { defaults: Record<string, Saved[]> };
    expect(body.defaults.anthropic?.[0]?.compactAtTokens).toBeGreaterThan(0);
  });

  it.each([9_999, 2_000_001, 12_345.5, "90000"])("rejects a threshold of %p", async (bad) => {
    expect((await put({ compactAtTokens: bad })).status).toBe(400);
  });

  it("accepts the bounds, and a custom provider", async () => {
    expect((await put({ compactAtTokens: 10_000 })).status).toBe(200);
    expect((await put({ compactAtTokens: 2_000_000 })).status).toBe(200);
    expect((await put({ providerId: "custom:abc", compactAtTokens: 50_000 })).status).toBe(200);
  });

  it("keeps the saved value when a later save omits it, and clears it on null", async () => {
    await put({ compactAtTokens: 90_000 });
    const kept = (await (await put({ capabilities: ["chat", "vision"] })).json()) as Saved;
    expect(kept.compactAtTokens).toBe(90_000);

    const cleared = (await (await put({ compactAtTokens: null })).json()) as Saved;
    expect(cleared.compactAtTokens).toBeUndefined();
  });
});
