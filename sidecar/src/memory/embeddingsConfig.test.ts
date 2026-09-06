import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteEmbeddingsConfig,
  type EmbeddingsConfigInput,
  getEmbeddingsConfig,
  upsertEmbeddingsConfig,
} from "./embeddingsConfig.ts";

let dir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yarvis-embeddings-config-"));
  originalPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

function validConfig(overrides: Partial<EmbeddingsConfigInput> = {}): EmbeddingsConfigInput {
  return {
    baseUrl: "http://localhost:11434/v1",
    model: "mxbai-embed-large",
    apiKind: "openai",
    dimensions: 1024,
    headerNames: [],
    ...overrides,
  };
}

describe("embeddings config", () => {
  it("returns null before any provider is configured", async () => {
    expect(await getEmbeddingsConfig()).toBeNull();
  });

  it("stores a config and reads it back exactly", async () => {
    const input = validConfig();
    await upsertEmbeddingsConfig(input);
    expect(await getEmbeddingsConfig()).toEqual(input);
  });

  it("replaces the prior config in place across upserts", async () => {
    await upsertEmbeddingsConfig(validConfig({ model: "model-a" }));
    await upsertEmbeddingsConfig(validConfig({ model: "model-b" }));

    const stored = await getEmbeddingsConfig();
    expect(stored?.model).toBe("model-b");
  });

  it("returns the saved config from upsert", async () => {
    const input = validConfig();
    const result = await upsertEmbeddingsConfig(input);
    expect(result).toEqual(input);
  });

  it("deletes the stored config, reverting to unconfigured", async () => {
    await upsertEmbeddingsConfig(validConfig());

    expect(await deleteEmbeddingsConfig()).toBe(true);
    expect(await getEmbeddingsConfig()).toBeNull();
  });

  it("returns false deleting when nothing is configured", async () => {
    expect(await deleteEmbeddingsConfig()).toBe(false);
  });
});
