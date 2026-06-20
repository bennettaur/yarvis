import { describe, expect, it } from "bun:test";
import type { Config } from "../config.ts";
import { EMBED_DIM } from "../db/schema.ts";
import {
  chooseEmbedder,
  GeminiEmbedder,
  HashEmbedder,
  OpenAICompatibleEmbedder,
} from "./embedder.ts";

/** Minimal config with no database and the given secrets. */
function configWith(secrets: Partial<Config["secrets"]> = {}): Config {
  return {
    port: 0,
    token: "t",
    tokenGenerated: true,
    allowedOrigins: null,
    databaseUrl: undefined,
    secrets: {
      anthropicApiKey: undefined,
      geminiApiKey: undefined,
      githubToken: undefined,
      googleClientId: undefined,
      googleClientSecret: undefined,
      ...secrets,
    },
    customProviderSecrets: {},
    embeddingsSecrets: { headers: {} },
  };
}

describe("embedder identities", () => {
  it("HashEmbedder fills the column dimension", () => {
    const e = new HashEmbedder();
    expect(e.dimensions).toBe(EMBED_DIM);
    expect(e.identity()).toEqual({ kind: "hash", model: "hash", dim: EMBED_DIM });
  });

  it("GeminiEmbedder truncates to the column dimension", () => {
    const e = new GeminiEmbedder("key");
    expect(e.dimensions).toBe(EMBED_DIM);
    expect(e.identity()).toEqual({
      kind: "gemini",
      model: "gemini-embedding-001",
      dim: EMBED_DIM,
    });
  });

  it("OpenAICompatibleEmbedder reflects its configured dimension and model", () => {
    const e = new OpenAICompatibleEmbedder({
      baseUrl: "http://localhost:11434/v1",
      model: "mxbai-embed-large",
      dimensions: EMBED_DIM,
    });
    expect(e.identity()).toEqual({
      kind: "openai-compatible",
      model: "mxbai-embed-large",
      dim: EMBED_DIM,
    });
  });
});

describe("chooseEmbedder (no database)", () => {
  it("falls back to the hash embedder with no secrets", async () => {
    const e = await chooseEmbedder(configWith());
    expect(e.kind).toBe("hash");
  });

  it("picks direct Gemini when a key is set", async () => {
    const e = await chooseEmbedder(configWith({ geminiApiKey: "key" }));
    expect(e.kind).toBe("gemini");
  });

  it("the chosen embedder's dimension always matches the column", async () => {
    const e = await chooseEmbedder(configWith({ geminiApiKey: "key" }));
    expect(e.dimensions).toBe(EMBED_DIM);
  });
});

describe("vector normalization", () => {
  it("produces unit-length vectors so cosine reduces to a dot product", async () => {
    const vec = await new HashEmbedder().embed("the quick brown fox");
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});
