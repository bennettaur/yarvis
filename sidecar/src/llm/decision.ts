import { generateText, Output } from "ai";
import { z } from "zod";
import type { Config } from "../config.ts";
import { type CustomProviderRow, listCustomProviders } from "../customProviders/service.ts";
import { readSection, withSection } from "../settings/store.ts";
import { guardedFetch } from "../voice/speech.ts";
import type { ModelSelection } from "./complexity.ts";
import { CUSTOM_PROVIDER_PREFIX, resolveModel } from "./providers.ts";

/**
 * The decision model: one model, tagged `decision` in the catalogue, that
 * answers structured yes/no judgements for the rest of the app. Its selection
 * and the features that use it live under the `decisionModel` key in
 * `~/.yarvis/settings.json`, beside `complexityModels`, so a change applies to
 * the next call with no restart.
 */

export interface DecisionConfig {
  model: ModelSelection | null;
  /**
   * Let the decision model approve an MCP tool call before the user is asked.
   * Only an approval skips the prompt: a refusal, an error or a timeout still
   * asks the user.
   */
  autoApproveTools: boolean;
}

export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  model: null,
  autoApproveTools: false,
};

const SETTINGS_KEY = "decisionModel";

/**
 * Long enough for a small local model to load and answer, short enough that a
 * stuck one falls back to the user's prompt before they wonder what happened.
 */
export const DECISION_TIMEOUT_MS = 20_000;

export async function getDecisionConfig(): Promise<DecisionConfig> {
  const stored = await readSection<Partial<DecisionConfig>>(SETTINGS_KEY);
  return { ...DEFAULT_DECISION_CONFIG, ...stored };
}

/** Merges the given fields onto the stored config; `model: null` clears the selection. */
export async function saveDecisionConfig(input: Partial<DecisionConfig>): Promise<DecisionConfig> {
  return withSection<Partial<DecisionConfig>, DecisionConfig>(SETTINGS_KEY, (current) => {
    const next = { ...DEFAULT_DECISION_CONFIG, ...current, ...input };
    return { next, result: next };
  });
}

export interface DecisionRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Cancels the call along with the turn it serves. Ollama calls are bounded by `timeoutMs` alone. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injected by tests in place of the network. */
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
  const timeoutMs = request.timeoutMs ?? DECISION_TIMEOUT_MS;
  const ollama = await ollamaProvider(selection.provider);
  if (ollama) return decideWithOllama(config, ollama, selection.model, request, timeoutMs);

  const model = await resolveModel(config, selection.provider, selection.model);
  const signals = [AbortSignal.timeout(timeoutMs), request.signal].filter(
    (s): s is AbortSignal => s !== undefined,
  );
  const { output } = await generateText({
    model,
    system: request.system,
    prompt: request.prompt,
    output: Output.object({ schema: request.schema }),
    abortSignal: AbortSignal.any(signals),
  });
  return request.schema.parse(output);
}

async function ollamaProvider(providerId: string): Promise<CustomProviderRow | null> {
  if (!providerId.startsWith(CUSTOM_PROVIDER_PREFIX)) return null;
  const id = providerId.slice(CUSTOM_PROVIDER_PREFIX.length);
  const row = (await listCustomProviders()).find((r) => r.id === id);
  return row?.apiKind === "ollama" ? row : null;
}

const ollamaChatResponse = z.object({
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
  timeoutMs: number,
): Promise<T> {
  const secrets = config.customProviderSecrets[row.id] ?? { headers: {} };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...secrets.headers,
  };
  if (secrets.apiKey) headers.Authorization = `Bearer ${secrets.apiKey}`;

  const res = await guardedFetch(
    `${row.baseUrl.replace(/\/+$/, "")}/api/chat`,
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
        options: { temperature: 0 },
      }),
    },
    { fetchImpl: request.fetchImpl ?? fetch, timeoutMs, allowLoopback: true },
  );
  if (!res.ok) {
    throw new Error(`decision model call failed (${res.status})`);
  }
  const { message } = ollamaChatResponse.parse(await res.json());
  return request.schema.parse(JSON.parse(message.content));
}
