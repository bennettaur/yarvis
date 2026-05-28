import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { embed, embedMany } from "ai";
import type { Config } from "../config.ts";
import { EMBED_DIM } from "../db/schema.ts";

/** Turns text into a fixed-dimension vector for similarity search. */
export interface Embedder {
  readonly dimensions: number;
  readonly kind: string;
  embed(text: string): Promise<number[]>;
  /** Embeds many texts at once (one provider call where supported). */
  embedMany(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic, offline fallback embedder. Hashes tokens into a fixed number
 * of buckets (bag-of-words) and L2-normalizes, so texts sharing words land
 * close in cosine space. Crude, but works with no API key and is reproducible
 * for tests.
 */
export class HashEmbedder implements Embedder {
  readonly dimensions = EMBED_DIM;
  readonly kind = "hash";

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
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

/** Google Gemini embeddings (text-embedding-004 → 768 dims). */
export class GeminiEmbedder implements Embedder {
  readonly dimensions = EMBED_DIM;
  readonly kind = "gemini";
  private model;

  constructor(apiKey: string) {
    this.model = createGoogleGenerativeAI({ apiKey }).textEmbeddingModel("text-embedding-004");
  }

  async embed(text: string): Promise<number[]> {
    const { embedding } = await embed({ model: this.model, value: text });
    return embedding;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    const { embeddings } = await embedMany({ model: this.model, values: texts });
    return embeddings;
  }
}

/**
 * Picks the best available embedder: Gemini when a key is configured,
 * otherwise the offline hash fallback. The chosen embedder must stay
 * consistent for a given store so stored vectors remain comparable.
 */
export function chooseEmbedder(config: Config): Embedder {
  if (config.secrets.geminiApiKey) {
    return new GeminiEmbedder(config.secrets.geminiApiKey);
  }
  return new HashEmbedder();
}
