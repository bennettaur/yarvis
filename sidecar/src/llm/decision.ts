import { generateText, Output } from "ai";
import { z } from "zod";
import type { Config } from "../config.ts";
import { readSection, withSection } from "../settings/store.ts";
import type { ModelSelection } from "./complexity.ts";
import { ollamaChat } from "./ollamaChat.ts";
import { availableProviders, resolveModelWithOllama, systemOneTargetFor } from "./providers.ts";
import { type SystemOneDecision, systemOneAsk } from "./systemOne.ts";

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
  /**
   * The same judgement as yes/no questions, for a System One model, which
   * can't answer to a schema. A request without this fails on a System One
   * model.
   */
  systemOne?: SystemOneDecision<T>;
  /** Injected by tests in place of the network. Used on the Ollama paths. */
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
  const systemOneTarget = await systemOneTargetFor(config, selection.provider, selection.model);
  if (systemOneTarget) {
    if (!request.systemOne) throw new Error("this decision can't be asked of a System One model");
    const probabilities = await systemOneAsk({
      target: systemOneTarget,
      state: request.prompt,
      questions: request.systemOne.questions,
      timeoutMs: DECISION_TIMEOUT_MS,
      signal,
      fetchImpl: request.fetchImpl,
    });
    return request.schema.parse(request.systemOne.toAnswer(probabilities));
  }

  const { model, ollama } = await resolveModelWithOllama(
    config,
    selection.provider,
    selection.model,
  );
  // Ollama's native API holds the answer to the schema; its OpenAI-compatible
  // endpoint, which `model` would use, only promises JSON.
  if (ollama) {
    const reply = await ollamaChat({
      target: ollama,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
      format: z.toJSONSchema(request.schema),
      // A judgement should come out the same way twice.
      options: { temperature: 0, num_ctx: OLLAMA_NUM_CTX, num_predict: OLLAMA_NUM_PREDICT },
      timeoutMs: DECISION_TIMEOUT_MS,
      signal,
      fetchImpl: request.fetchImpl,
    });
    return request.schema.parse(JSON.parse(reply.content));
  }

  const { output } = await generateText({
    model,
    system: request.system,
    prompt: request.prompt,
    output: Output.object({ schema: request.schema }),
    abortSignal: signal,
  });
  return output;
}
