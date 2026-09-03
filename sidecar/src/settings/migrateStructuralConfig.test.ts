import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { migrateStructuralConfig } from "./migrateStructuralConfig.ts";
import { readSection } from "./store.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

let settingsDir: string;
let originalSettingsPath: string | undefined;

beforeEach(async () => {
  await sql`TRUNCATE custom_providers, provider_models, mcp_servers, voice_config,
    embeddings_config, wip_config, github_pr_config, job_config RESTART IDENTITY CASCADE`;
  settingsDir = await mkdtemp(join(tmpdir(), "yarvis-migrate-structural-"));
  originalSettingsPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
});

afterEach(async () => {
  if (originalSettingsPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalSettingsPath;
  await rm(settingsDir, { recursive: true, force: true });
});

afterAll(async () => {
  await sql.end();
});

async function seedAllTables(): Promise<void> {
  await db.insert(schema.customProviders).values({
    name: "litellm",
    baseUrl: "https://litellm.example.com/v1",
    apiKind: "openai",
    models: ["gpt-4o"],
    headerNames: ["X-Tenant"],
  });
  await db.insert(schema.providerModels).values([
    { providerId: "gemini", modelId: "gemini-9-flash", capabilities: ["chat"], sortOrder: 1 },
    { providerId: "gemini", modelId: "gemini-9-flash-tts", capabilities: ["tts"], sortOrder: 0 },
  ]);
  await db.insert(schema.mcpServers).values({
    name: "local-fs",
    transport: "stdio",
    command: "mcp-fs",
    args: ["--root", "/tmp"],
  });
  await db.insert(schema.voiceConfig).values({
    sttProvider: "gemini",
    sttModel: "gemini-3.5-flash",
    ttsProvider: "gemini",
    ttsModel: "gemini-2.5-flash-preview-tts",
  });
  await db.insert(schema.embeddingsConfig).values({
    baseUrl: "http://localhost:11434/v1",
    model: "nomic-embed-text",
    apiKind: "openai",
    dimensions: schema.EMBED_DIM,
  });
  await db.insert(schema.wipConfig).values({
    sources: { myPrs: false, starredPrs: true, issues: true, tasks: true, workspaces: true },
    issueLabels: ["in-progress"],
  });
  await db.insert(schema.githubPrConfig).values({
    reviewQuery: "is:open is:pr review-requested:@me",
    reviewingLookbackDays: 45,
  });
  await db.insert(schema.jobConfig).values({
    ccDigestEnabled: true,
    ccDigestProjectDirs: ["-Users-me-dev-app"],
  });
}

describe("migrateStructuralConfig", () => {
  it("copies every table into its settings.json section", async () => {
    await seedAllTables();
    await migrateStructuralConfig(db);

    const providers =
      await readSection<Record<string, { name: string; models: string[] }>>("customProviders");
    const [providerId, provider] = Object.entries(providers ?? {})[0]!;
    expect(provider.name).toBe("litellm");
    expect(provider.models).toEqual(["gpt-4o"]);
    expect(typeof providerId).toBe("string");

    const models =
      await readSection<Record<string, { modelId: string; sortOrder: number }[]>>("providerModels");
    expect(models?.gemini?.map((m) => m.modelId).sort()).toEqual([
      "gemini-9-flash",
      "gemini-9-flash-tts",
    ]);

    const servers =
      await readSection<Record<string, { name: string; command: string | null }>>("mcpServers");
    const server = Object.values(servers ?? {})[0];
    expect(server?.name).toBe("local-fs");
    expect(server?.command).toBe("mcp-fs");

    expect(await readSection<{ sttProvider: string }>("voiceConfig")).toMatchObject({
      sttProvider: "gemini",
    });
    expect(await readSection<{ model: string }>("embeddingsConfig")).toMatchObject({
      model: "nomic-embed-text",
    });
    expect(await readSection<{ issueLabels: string[] }>("wipConfig")).toMatchObject({
      issueLabels: ["in-progress"],
    });
    expect(await readSection<{ reviewingLookbackDays: number }>("githubPrConfig")).toMatchObject({
      reviewingLookbackDays: 45,
    });
    expect(await readSection<{ ccDigestEnabled: boolean }>("jobConfig")).toMatchObject({
      ccDigestEnabled: true,
    });

    expect(await readSection<boolean>("structuralSettingsMigrated")).toBe(true);
  });

  it("writes no section for a table with no rows", async () => {
    await migrateStructuralConfig(db);

    expect(await readSection("customProviders")).toBeUndefined();
    expect(await readSection("mcpServers")).toBeUndefined();
    expect(await readSection("voiceConfig")).toBeUndefined();
    expect(await readSection("jobConfig")).toBeUndefined();
    expect(await readSection<boolean>("structuralSettingsMigrated")).toBe(true);
  });

  it("never runs twice, even if the tables change in between", async () => {
    await seedAllTables();
    await migrateStructuralConfig(db);

    // A user edits their job config after the one-time copy; a second call
    // (e.g. a restart) must not re-copy the stale Postgres snapshot over it.
    const { saveJobConfig } = await import("../jobs/config.ts");
    await saveJobConfig({ ccDigestEnabled: false, ccDigestProjectDirs: [] });

    await migrateStructuralConfig(db);

    expect(await readSection<{ ccDigestEnabled: boolean }>("jobConfig")).toMatchObject({
      ccDigestEnabled: false,
    });
  });

  it("never writes a secret-shaped field into the file", async () => {
    await seedAllTables();
    await migrateStructuralConfig(db);

    const raw = JSON.stringify({
      customProviders: await readSection("customProviders"),
      mcpServers: await readSection("mcpServers"),
      embeddingsConfig: await readSection("embeddingsConfig"),
    });
    for (const forbidden of ["apiKey", "headers", "clientSecret", "token", "Authorization"]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
