import { afterAll, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { saveGuide, setGuideProgress } from "../pr/guides.ts";
import type { PrRef } from "../pr/types.ts";
import { DEFAULT_WIP_CONFIG, saveWipConfig } from "./config.ts";
import { createWipRoutes } from "./routes.ts";
import type { WipItem } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

afterAll(async () => {
  await saveWipConfig(DEFAULT_WIP_CONFIG);
  await sql.end();
});

function config(databaseUrl: string | undefined): Config {
  return {
    port: 0,
    token: "test-token",
    tokenGenerated: false,
    attentionToken: "test-attention-token",
    mcpToken: "test-mcp-token",
    allowedOrigins: null,
    databaseUrl,
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets: {},
    customProviderSecrets: {},
    mcpSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
  };
}

describe("wip routes", () => {
  it("returns 503 when no database is configured", async () => {
    const app = createWipRoutes(config(undefined));
    const res = await app.request("/");
    expect(res.status).toBe(503);
  });
});

describe("guided reviews in the WIP list", () => {
  const ref = (number: number): PrRef => ({ provider: "github", owner: "o", repo: "r", number });
  const step = { path: "a.ts", startLine: null, endLine: null, explanation: "x" };
  const reviews = async () => {
    const res = await createWipRoutes(config(url)).request("/");
    return ((await res.json()) as WipItem[]).filter((i) => i.source === "review");
  };

  it("lists unfinished guides, and none once the source is off", async () => {
    await sql`TRUNCATE pr_guides`;
    const headSha = "a".repeat(40);
    await saveGuide(db, { ref: ref(1), headSha, steps: [step, step, step], title: "Reading" });
    await saveGuide(db, { ref: ref(2), headSha, steps: [step, step], title: "Read" });
    await setGuideProgress(db, ref(2), 1);
    await saveGuide(db, { ref: ref(3), headSha, steps: [step], title: "One step" });

    expect((await reviews()).map((i) => i.title)).toEqual(["Reading"]);

    await saveWipConfig({
      ...DEFAULT_WIP_CONFIG,
      sources: { ...DEFAULT_WIP_CONFIG.sources, reviews: false },
    });
    expect(await reviews()).toEqual([]);
  });
});
