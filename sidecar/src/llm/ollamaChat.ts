import { z } from "zod";
import { guardedFetch } from "../lib/guardedFetch.ts";
import type { OllamaChatTarget } from "./providers.ts";

/** A message in Ollama's native chat shape. */
export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** On an assistant message: the tool calls it made, arguments as an object. */
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  /** On a tool message: which tool produced it. */
  tool_name?: string;
}

export interface OllamaChatRequest {
  target: OllamaChatTarget;
  messages: OllamaMessage[];
  /** JSON schema the reply is constrained to. */
  format: unknown;
  options: { num_ctx: number; num_predict: number; temperature?: number };
  timeoutMs: number;
  /** Cancels the call; also bounds reading the body, which outlives guardedFetch's own deadline. */
  signal?: AbortSignal;
  /** Injected by tests in place of the network. */
  fetchImpl?: typeof fetch;
}

export interface OllamaChatReply {
  content: string;
  /** The reply stopped at `num_predict`, so it is likely incomplete. */
  truncated: boolean;
}

const responseSchema = z.object({
  message: z.object({ content: z.string() }),
  done_reason: z.string().optional(),
});

/**
 * One non-streaming call to Ollama's native `/api/chat`, with `format` set so
 * decoding is held to a JSON schema. Its OpenAI-compatible endpoint only
 * promises JSON, not the schema, which matters for a small model. Throws on a
 * non-OK status or a reply that is not Ollama's shape; the content itself is
 * left for the caller to parse.
 */
export async function ollamaChat(request: OllamaChatRequest): Promise<OllamaChatReply> {
  const res = await guardedFetch(
    request.target.url,
    {
      method: "POST",
      headers: request.target.headers,
      body: JSON.stringify({
        model: request.target.model,
        messages: request.messages,
        format: request.format,
        stream: false,
        options: request.options,
      }),
      signal: request.signal,
    },
    {
      fetchImpl: request.fetchImpl ?? fetch,
      timeoutMs: request.timeoutMs,
      allowLoopback: true,
      // The body is the user's conversation or code.
      sameOriginOnly: true,
      // The same check the provider's base URL gets everywhere else.
      staticCheckOnly: true,
    },
  );
  if (!res.ok) throw new Error(`Ollama chat call failed (${res.status})`);
  const { message, done_reason } = responseSchema.parse(await res.json());
  return { content: message.content, truncated: done_reason === "length" };
}
