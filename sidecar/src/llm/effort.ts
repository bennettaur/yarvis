import { wrapLanguageModel } from "ai";
import { z } from "zod";

/**
 * How hard a model thinks before it answers. It is chosen wherever the model
 * is chosen rather than fixed on the model, since the right level depends on
 * the job: a tool-call judgement wants it low, a planning turn may want it high.
 *
 * These are the AI SDK's provider-neutral levels. The SDK maps each one onto
 * the provider's own field (Anthropic's `effort`, Bedrock's
 * `maxReasoningEffort`, Gemini's `thinkingLevel`, OpenAI's `reasoning.effort`),
 * so no surface needs to know which provider it is talking to. Unset means the
 * provider's default.
 */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const reasoningEffortSchema = z.enum(REASONING_EFFORTS);

/** A model object, as opposed to a gateway model id string, which can't be wrapped. */
export type ProviderModel = Parameters<typeof wrapLanguageModel>[0]["model"];

/**
 * Wraps `model` so every call asks for `effort`, unless the call sets its own.
 *
 * `forceReasoning` is for models reached through the OpenAI SDK, which sends
 * an effort only to model ids it recognizes as reasoning models. A proxy's
 * alias for one (say `bedrock-claude-opus-5-5`) is never recognized, so the
 * caller's `reasoning` tag has to vouch for it instead.
 */
export function withEffort(
  model: ProviderModel,
  effort: ReasoningEffort,
  { forceReasoning = false }: { forceReasoning?: boolean } = {},
): ProviderModel {
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: async ({ params }) => ({
        ...params,
        reasoning: params.reasoning ?? effort,
        providerOptions: forceReasoning
          ? {
              ...params.providerOptions,
              openai: { forceReasoning: true, ...params.providerOptions?.openai },
            }
          : params.providerOptions,
      }),
    },
  });
}
