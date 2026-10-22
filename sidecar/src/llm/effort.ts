import { type CallSettings, wrapLanguageModel } from "ai";
import { z } from "zod";
import type { LanguageModelObject } from "./providers.ts";

/**
 * How hard a model thinks before it answers. It is chosen wherever the model
 * is chosen rather than fixed on the model, since the right level depends on
 * the job: a tool-call judgement wants it low, a planning turn may want it high.
 *
 * These are the AI SDK's provider-neutral levels. For Anthropic, Bedrock and
 * Gemini the SDK maps each one onto that provider's own field, clamping a
 * level it doesn't have. The OpenAI SDK sends the level as-is, so a proxy's
 * model has to accept it. On a Claude model any level also turns thinking on.
 * Unset means the provider's default.
 */
export const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly NonNullable<CallSettings["reasoning"]>[];

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const reasoningEffortSchema = z.enum(REASONING_EFFORTS);

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * Wraps `model` so every call asks for `effort`, unless the call sets its own.
 *
 * `viaOpenAI` is for models the OpenAI SDK built. That SDK sends an effort only
 * to model ids it recognizes as reasoning models, and a proxy's alias for one
 * (say `bedrock-claude-opus-5-5`) never is, so `forceReasoning` vouches for it.
 * Forcing it would also move the system prompt to OpenAI's `developer` role,
 * which other backends may reject or ignore, so the prompt stays `system`.
 */
export function withEffort(
  model: LanguageModelObject,
  effort: ReasoningEffort,
  { viaOpenAI }: { viaOpenAI: boolean },
): LanguageModelObject {
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: async ({ params }) => ({
        ...params,
        reasoning: params.reasoning ?? effort,
        providerOptions: viaOpenAI
          ? {
              ...params.providerOptions,
              openai: {
                forceReasoning: true,
                systemMessageMode: "system",
                ...params.providerOptions?.openai,
              },
            }
          : params.providerOptions,
      }),
    },
  });
}
