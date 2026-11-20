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

interface FakeEmbeddingsOptions {
  /** Requests with more texts than this are refused. */
  maxInputs: number;
  /** Status the refusal is sent with. */
  refuseWith?: number;
  /** Answers this many requests with a 429 before behaving normally. */
  rateLimitFirst?: number;
  /** Leaves the last vector out of every answer. */
  dropLast?: boolean;
}

/**
 * A fake `/v1/embeddings` endpoint that refuses any request over `maxInputs`
 * texts, the way Vertex behind LiteLLM does. Each vector is the number in its
 * text ("t7" embeds as [7]) so order can be checked.
 */
function startEmbeddingsServer(opts: FakeEmbeddingsOptions) {
  const batchSizes: number[] = [];
  let rateLimitsLeft = opts.rateLimitFirst ?? 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { input } = (await req.json()) as { input: string[] };
      batchSizes.push(input.length);
      if (rateLimitsLeft > 0) {
        rateLimitsLeft -= 1;
        // A 1ms retry-after keeps the SDK's 2s default backoff out of the test.
        return Response.json(
          { error: { message: "slow down" } },
          { status: 429, headers: { "retry-after-ms": "1" } },
        );
      }
      if (input.length > opts.maxInputs) {
        return Response.json(
          { error: { message: `batchSize ${input.length} exceeds ${opts.maxInputs}` } },
          { status: opts.refuseWith ?? 400 },
        );
      }
      const answered = opts.dropLast ? input.slice(0, -1) : input;
      return Response.json({
        object: "list",
        data: answered.map((text, index) => ({
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
  let fake: ReturnType<typeof startEmbeddingsServer> | undefined;
  afterEach(() => {
    fake?.server.stop(true);
    fake = undefined;
  });

  function embedderAgainst(opts: FakeEmbeddingsOptions) {
    fake = startEmbeddingsServer(opts);
    const embedder = new OpenAICompatibleEmbedder({
      baseUrl: fake.baseUrl,
      model: "fake",
      dimensions: 1,
    });
    return { embedder, batchSizes: fake.batchSizes };
  }

  const texts = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
  const indexes = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("splits a large set into capped requests and keeps the order", async () => {
    const { embedder, batchSizes } = embedderAgainst({ maxInputs: 250 });

    const vecs = await embedder.embedMany(texts(348));

    expect(batchSizes).toEqual([100, 100, 100, 48]);
    expect(vecs.map((v) => v[0])).toEqual(indexes(348));
  });

  it.each([400, 413])("halves a batch refused with %i until it fits", async (status) => {
    const { embedder, batchSizes } = embedderAgainst({ maxInputs: 30, refuseWith: status });

    const vecs = await embedder.embedMany(texts(100));

    // Depth first: 100 is refused, then 50, so each 50 goes out as two 25s.
    expect(batchSizes).toEqual([100, 50, 25, 25, 50, 25, 25]);
    expect(vecs.map((v) => v[0])).toEqual(indexes(100));
  });

  it("keeps the order when a refused batch has an odd length", async () => {
    const { embedder } = embedderAgainst({ maxInputs: 10 });

    const vecs = await embedder.embedMany(texts(25));

    expect(vecs.map((v) => v[0])).toEqual(indexes(25));
  });

  it("still splits when the refusal follows a rate-limited attempt", async () => {
    const { embedder, batchSizes } = embedderAgainst({ maxInputs: 50, rateLimitFirst: 1 });

    const vecs = await embedder.embedMany(texts(100));

    expect(batchSizes).toEqual([100, 100, 50, 50]);
    expect(vecs.map((v) => v[0])).toEqual(indexes(100));
  });

  it("rethrows a refusal that is not about size without splitting", async () => {
    const { embedder, batchSizes } = embedderAgainst({ maxInputs: 0, refuseWith: 401 });

    await expect(embedder.embedMany(texts(10))).rejects.toThrow("batchSize 10 exceeds 0");
    expect(batchSizes).toEqual([10]);
  });

  it("gives up when a single text is refused", async () => {
    const { embedder, batchSizes } = embedderAgainst({ maxInputs: 0 });

    await expect(embedder.embedMany(texts(2))).rejects.toThrow("batchSize 1 exceeds 0");
    expect(batchSizes).toEqual([2, 1]);
  });

  it("fails when the backend returns fewer vectors than texts", async () => {
    const { embedder } = embedderAgainst({ maxInputs: 100, dropLast: true });

    await expect(embedder.embedMany(texts(5))).rejects.toThrow("returned 4 vectors for 5 texts");
  });
});
