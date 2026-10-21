import { generateText, Output } from "ai";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { CustomProviderRow } from "../customProviders/service.ts";
import { guardedFetch } from "../lib/guardedFetch.ts";
import { readSection, withSection } from "../settings/store.ts";
import type { ModelSelection } from "./complexity.ts";
import { availableProviders, findCustomProvider, ollamaUrl, resolveModel } from "./providers.ts";

/**
 * The decision model: one model, tagged `decision` in the catalogue, that
 * answers structured yes/no judgements for the rest of the app. Its selection
 * and the features that use it live under the `decisionModel` key in
 * `~/.yarvis/settings.json`, beside `complexityModels`, so a change applies to
 * the next call with no restart.
 */

export interface DecisionModelConfig {
  model: ModelSelection | null;
  /** Let the decision model approve an MCP tool call before the user is asked. */
  autoApproveTools: boolean;
  /**
   * Let it approve an MCP tool call a heads-down pass would otherwise queue for
   * the user, when the user has approved that tool in related situations
   * before. Separate from `autoApproveTools`: nobody is watching a pass.
   */
  autoApproveHeadsDown: boolean;
}

export const DEFAULT_DECISION_MODEL_CONFIG: DecisionModelConfig = {
  model: null,
  autoApproveTools: false,
  autoApproveHeadsDown: false,
};

const SETTINGS_KEY = "decisionModel";

/**
 * Long enough for a small local model to load and answer, short enough that a
 * stuck one falls back to the user's prompt before they wonder what happened.
 */
const DECISION_TIMEOUT_MS = 20_000;

/**
 * Ollama's context window for a decision call. Its default can be smaller than
 * a review prompt, and Ollama drops the overflow from the front without an
 * error — which is where the instructions sit.
 */
const OLLAMA_NUM_CTX = 8192;

/** A verdict is a few booleans and a sentence; anything longer is a model looping. */
const OLLAMA_NUM_PREDICT = 256;

export async function getDecisionModelConfig(): Promise<DecisionModelConfig> {
  const stored = await readSection<Partial<DecisionModelConfig>>(SETTINGS_KEY);
  return { ...DEFAULT_DECISION_MODEL_CONFIG, ...stored };
}

/** Merges the given fields onto the stored config; `model: null` clears the selection. */
export async function saveDecisionModelConfig(
  input: Partial<DecisionModelConfig>,
): Promise<DecisionModelConfig> {
  return withSection<Partial<DecisionModelConfig>, DecisionModelConfig>(SETTINGS_KEY, (current) => {
    const next = { ...DEFAULT_DECISION_MODEL_CONFIG, ...current, ...input };
    return { next, result: next };
  });
}

/**
 * The saved decision model, or null when none is saved or it is no longer a
 * usable `decision` model — untagged in the catalogue, or its provider lost its
 * key. A safety check has to run on the model the user chose for the job.
 */
export async function resolveDecisionModel(
  config: Config,
  selection: ModelSelection | null,
): Promise<ModelSelection | null> {
  if (!selection) return null;
  const provider = (await availableProviders(config, "decision")).find(
    (p) => p.id === selection.provider,
  );
  const usable = provider?.available && provider.models.some((m) => m.id === selection.model);
  return usable ? selection : null;
}

export interface DecisionRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Cancels the call along with the turn it serves. */
  signal?: AbortSignal;
  /** Injected by tests in place of the network. Used on the Ollama path. */
  fetchImpl?: typeof fetch;
}

/**
 * Asks the decision model for an answer shaped like `schema`. Throws on any
 * failure, including an answer that doesn't match the schema, so the caller
 * decides what a missing answer means.
 */
export async function decide<T>(
  config: Config,
  selection: ModelSelection,
  request: DecisionRequest<T>,
): Promise<T> {
  const signal = AbortSignal.any(
    [AbortSignal.timeout(DECISION_TIMEOUT_MS), request.signal].filter(
      (s): s is AbortSignal => s !== undefined,
    ),
  );
  const custom = await findCustomProvider(selection.provider);
  // Ollama's native API has no effort level, so a saved one is not sent there.
  if (custom?.apiKind === "ollama") {
    return decideWithOllama(config, custom, selection.model, request, signal);
  }

  const model = await resolveModel(config, selection.provider, selection.model, {
    effort: selection.effort,
  });
  const { output } = await generateText({
    model,
    system: request.system,
    prompt: request.prompt,
    output: Output.object({ schema: request.schema }),
    abortSignal: signal,
  });
  return output;
}

const ollamaChatResponseSchema = z.object({
  message: z.object({ content: z.string() }),
});

/**
 * Ollama's native `/api/chat`, which takes a JSON schema as `format` and
 * constrains decoding to it. Its OpenAI-compatible endpoint only promises JSON,
 * not this schema, which matters for a small model.
 */
async function decideWithOllama<T>(
  config: Config,
  row: CustomProviderRow,
  modelId: string,
  request: DecisionRequest<T>,
  signal: AbortSignal,
): Promise<T> {
  const secrets = config.customProviderSecrets[row.id] ?? { headers: {} };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...secrets.headers,
  };
  if (secrets.apiKey) headers.Authorization = `Bearer ${secrets.apiKey}`;

  const res = await guardedFetch(
    ollamaUrl(row.baseUrl, "/api/chat"),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.prompt },
        ],
        format: z.toJSONSchema(request.schema),
        stream: false,
        // A judgement should come out the same way twice.
        options: { temperature: 0, num_ctx: OLLAMA_NUM_CTX, num_predict: OLLAMA_NUM_PREDICT },
      }),
      // Also bounds reading the body, which outlives guardedFetch's own deadline.
      signal,
    },
    {
      fetchImpl: request.fetchImpl ?? fetch,
      timeoutMs: DECISION_TIMEOUT_MS,
      allowLoopback: true,
      // The body is the user's conversation.
      sameOriginOnly: true,
    },
  );
  if (!res.ok) {
    throw new Error(`decision model call failed (${res.status})`);
  }
  const { message } = ollamaChatResponseSchema.parse(await res.json());
  return request.schema.parse(JSON.parse(message.content));
}
