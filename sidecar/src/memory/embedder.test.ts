import { afterEach, describe, expect, it } from "bun:test";
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
    attentionToken: "test-attention-token",
    mcpToken: "test-mcp-token",
    allowedOrigins: null,
    databaseUrl: undefined,
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets: {
      anthropicApiKey: undefined,
      geminiApiKey: undefined,
      githubToken: undefined,
      googleClientId: undefined,
      googleClientSecret: undefined,
      ...secrets,
    },
    customProviderSecrets: {},
    mcpSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
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

/**
 * A fake `/v1/embeddings` endpoint that refuses any request with more than
 * `maxInputs` texts, the way Vertex behind LiteLLM does. Each vector is the
 * number in its text ("t7" embeds as [7]) so order can be checked.
 */
function startEmbeddingsServer(maxInputs: number) {
  const batchSizes: number[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { input } = (await req.json()) as { input: string[] };
      batchSizes.push(input.length);
      if (input.length > maxInputs) {
        return Response.json(
          { error: { message: `batchSize ${input.length} exceeds ${maxInputs}` } },
          { status: 400 },
        );
      }
      return Response.json({
        object: "list",
        data: input.map((text, index) => ({
          object: "embedding",
          index,
          embedding: [Number(text.slice(1))],
        })),
        model: "fake",
        usage: { prompt_tokens: 0, total_tokens: 0 },
      });
    },
  });
  return { server, batchSizes, baseUrl: `http://127.0.0.1:${server.port}/v1` };
}

describe("OpenAICompatibleEmbedder.embedMany batching", () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  const texts = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

  it("splits a large set into capped requests and keeps the order", async () => {
    const fake = startEmbeddingsServer(250);
    stop = () => fake.server.stop(true);
    const e = new OpenAICompatibleEmbedder({ baseUrl: fake.baseUrl, model: "fake", dimensions: 1 });

    const vecs = await e.embedMany(texts(348));

    expect(fake.batchSizes).toEqual([100, 100, 100, 48]);
    expect(vecs.map((v) => v[0])).toEqual(texts(348).map((_, i) => i));
  });

  it("halves a batch the backend refuses until it fits", async () => {
    const fake = startEmbeddingsServer(30);
    stop = () => fake.server.stop(true);
    const e = new OpenAICompatibleEmbedder({ baseUrl: fake.baseUrl, model: "fake", dimensions: 1 });

    const vecs = await e.embedMany(texts(100));

    expect(fake.batchSizes).toEqual([100, 50, 25, 25, 50, 25, 25]);
    expect(vecs.map((v) => v[0])).toEqual(texts(100).map((_, i) => i));
  });

  it("gives up when a single text is refused", async () => {
    const fake = startEmbeddingsServer(0);
    stop = () => fake.server.stop(true);
    const e = new OpenAICompatibleEmbedder({ baseUrl: fake.baseUrl, model: "fake", dimensions: 1 });

    await expect(e.embedMany(texts(2))).rejects.toThrow("batchSize 1 exceeds 0");
    expect(fake.batchSizes).toEqual([2, 1]);
  });
});
