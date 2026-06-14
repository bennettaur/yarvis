import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { embed, embedMany } from "ai";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { EMBED_DIM } from "../db/schema.ts";
import { getEmbeddingsConfig } from "./embeddingsConfig.ts";

/**
 * Identifies which model produced a vector. Stamped onto every memory so we can
 * detect when the active embedder no longer matches stored memories — vectors
 * from different models (or dimensions) aren't comparable, so a switch needs a
 * re-embed before recall is meaningful again.
 */
export interface EmbedderIdentity {
  kind: string;
  model: string;
  dim: number;
}

/** Turns text into a fixed-dimension vector for similarity search. */
export interface Embedder {
  readonly dimensions: number;
  readonly kind: string;
  /** A stable identity for this embedder, recorded on each memory it produces. */
  identity(): EmbedderIdentity;
  /** Embeds a document being stored. */
  embed(text: string): Promise<number[]>;
  /**
   * Embeds a search query. Most embedders treat this identically to `embed`;
   * providers with asymmetric retrieval modes (Gemini's task types) embed
   * queries differently from documents so the two compare well in cosine space.
   */
  embedQuery(text: string): Promise<number[]>;
  /** Embeds many documents at once (one provider call where supported). */
  embedMany(texts: string[]): Promise<number[][]>;
}

/** Default direct-Gemini embedding model (the gemini-embedding-* family). */
const GEMINI_MODEL = "gemini-embedding-001";

/**
 * L2-normalizes a vector so cosine similarity reduces to a dot product. A
 * zero vector is returned unchanged (its norm is 0).
 */
function l2normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/**
 * Deterministic, offline fallback embedder. Hashes tokens into a fixed number
 * of buckets (bag-of-words) and L2-normalizes, so texts sharing words land
 * close in cosine space. Crude, but works with no API key and is reproducible
 * for tests. Sized to EMBED_DIM so its vectors fit the column.
 */
export class HashEmbedder implements Embedder {
  readonly dimensions = EMBED_DIM;
  readonly kind = "hash";

  identity(): EmbedderIdentity {
    return { kind: this.kind, model: "hash", dim: this.dimensions };
  }

  async embed(text: string): Promise<number[]> {
    const vec = new Array<number>(this.dimensions).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const token of tokens) {
      let hash = 2166136261;
      for (let i = 0; i < token.length; i++) {
        hash ^= token.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      vec[Math.abs(hash) % this.dimensions]! += 1;
    }
    return l2normalize(vec);
  }

  // No document/query asymmetry: hashing is symmetric.
  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

/**
 * Google Gemini embeddings via the gemini-embedding-* family. The model emits
 * Matryoshka vectors, truncated to EMBED_DIM through `outputDimensionality`.
 * Truncated vectors below the native size are not unit-length, so we re-normalize
 * for cosine search. Documents and queries use distinct retrieval task types so
 * the two embed into a compatible space.
 */
export class GeminiEmbedder implements Embedder {
  readonly dimensions = EMBED_DIM;
  readonly kind = "gemini";
  readonly model = GEMINI_MODEL;
  private embeddingModel;

  constructor(apiKey: string) {
    this.embeddingModel = createGoogleGenerativeAI({ apiKey }).textEmbeddingModel(this.model);
  }

  identity(): EmbedderIdentity {
    return { kind: this.kind, model: this.model, dim: this.dimensions };
  }

  /** Shared call options: truncate to EMBED_DIM for the given retrieval role. */
  private providerOptions(taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY") {
    return { google: { outputDimensionality: this.dimensions, taskType } };
  }

  async embed(text: string): Promise<number[]> {
    const { embedding } = await embed({
      model: this.embeddingModel,
      value: text,
      providerOptions: this.providerOptions("RETRIEVAL_DOCUMENT"),
    });
    return l2normalize(embedding);
  }

  async embedQuery(text: string): Promise<number[]> {
    const { embedding } = await embed({
      model: this.embeddingModel,
      value: text,
      providerOptions: this.providerOptions("RETRIEVAL_QUERY"),
    });
    return l2normalize(embedding);
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    const { embeddings } = await embedMany({
      model: this.embeddingModel,
      values: texts,
      providerOptions: this.providerOptions("RETRIEVAL_DOCUMENT"),
    });
    return embeddings.map(l2normalize);
  }
}

export interface OpenAICompatibleEmbedderOptions {
  baseUrl: string;
  model: string;
  dimensions: number;
  apiKey?: string;
  headers?: Record<string, string>;
}

/**
 * Embeddings via any OpenAI-compatible `/v1/embeddings` endpoint: the user's
 * proxy or a local Ollama server (`http://localhost:11434/v1`, no key needed).
 * The dimension is supplied by config since it varies by model.
 */
export class OpenAICompatibleEmbedder implements Embedder {
  readonly dimensions: number;
  readonly kind = "openai-compatible";
  readonly model: string;
  private embeddingModel;

  constructor(opts: OpenAICompatibleEmbedderOptions) {
    this.dimensions = opts.dimensions;
    this.model = opts.model;
    this.embeddingModel = createOpenAI({
      baseURL: opts.baseUrl,
      // Some gateways (and Ollama) don't require a key; the OpenAI SDK still
      // wants a non-empty value, so fall back to a harmless placeholder.
      apiKey: opts.apiKey ?? "no-key",
      headers: opts.headers,
    }).textEmbeddingModel(opts.model);
  }

  identity(): EmbedderIdentity {
    return { kind: this.kind, model: this.model, dim: this.dimensions };
  }

  /**
   * Requests the target dimension via the OpenAI `dimensions` param. Models that
   * support Matryoshka truncation (Qwen3, OpenAI text-embedding-3) honor it
   * directly; a LiteLLM-fronted Gemini model maps it to `output_dimensionality`.
   */
  private providerOptions() {
    return { openai: { dimensions: this.dimensions } };
  }

  async embed(text: string): Promise<number[]> {
    const { embedding } = await embed({
      model: this.embeddingModel,
      value: text,
      providerOptions: this.providerOptions(),
    });
    return embedding;
  }

  // No document/query asymmetry over the OpenAI-compatible API.
  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    const { embeddings } = await embedMany({
      model: this.embeddingModel,
      values: texts,
      providerOptions: this.providerOptions(),
    });
    return embeddings;
  }
}

/**
 * Picks the active embedder, in order of preference:
 *   1. the configured embeddings provider (LiteLLM / OpenAI-compatible, e.g. Qwen3),
 *   2. direct Gemini, when a key is set,
 *   3. the offline hash fallback.
 *
 * The chosen embedder's output dimension must equal EMBED_DIM (the column
 * dimension); a mismatch is a configuration error surfaced clearly rather than
 * left to fail deep in an insert. Reads the provider config from the database,
 * so it is async.
 */
export async function chooseEmbedder(config: Config, db?: Db): Promise<Embedder> {
  const embedder = await selectEmbedder(config, db);
  if (embedder.dimensions !== EMBED_DIM) {
    throw new Error(
      `embedding dimension mismatch: ${embedder.kind} produces ${embedder.dimensions}-dim ` +
        `vectors but the memories column expects ${EMBED_DIM}. Configure a model whose ` +
        `dimension is ${EMBED_DIM} (or change EMBED_DIM and re-embed).`,
    );
  }
  return embedder;
}

async function selectEmbedder(config: Config, db?: Db): Promise<Embedder> {
  if (db) {
    const cfg = await getEmbeddingsConfig(db);
    if (cfg) {
      return new OpenAICompatibleEmbedder({
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        dimensions: cfg.dimensions,
        apiKey: config.embeddingsSecrets.apiKey,
        headers: config.embeddingsSecrets.headers,
      });
    }
  }
  if (config.secrets.geminiApiKey) {
    return new GeminiEmbedder(config.secrets.geminiApiKey);
  }
  return new HashEmbedder();
}
