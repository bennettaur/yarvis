import { readSection, withSection } from "../settings/store.ts";

/**
 * How much room one chat turn gets. Lives at the `chatConfig` key in
 * `~/.yarvis/settings.json`, beside the other structural settings: it decides
 * how the sidecar behaves rather than recording anything the user produced, and
 * a turn reads it on a path that must work whether or not Postgres is up.
 */

export interface ChatConfig {
  /** Tool-calling steps one turn may take before it is stopped. */
  maxSteps: number;
  /** Output tokens one reply may use. Null leaves the provider's own limit. */
  maxOutputTokens: number | null;
}

const SETTINGS_KEY = "chatConfig";

/**
 * Enough steps to finish the multi-step work the agent is asked for, and no
 * output cap. A turn that runs out of steps mid-chain ends with no reply at
 * all — the user has to ask it to continue, having already paid for the tool
 * calls — so the budget errs high; `stopWhen` is a runaway guard, not a
 * throttle. The output limit stays unset because the provider already has one
 * and a second, lower cap only truncates a long answer.
 */
export const DEFAULT_CHAT_CONFIG: ChatConfig = {
  maxSteps: 100,
  maxOutputTokens: null,
};

/** Ceilings the routes validate against, so a typo can't cost a fortune. */
export const MAX_STEPS_CEILING = 500;
export const MAX_OUTPUT_TOKENS_CEILING = 200_000;

/** Returns the stored budget merged over the defaults. */
export async function getChatConfig(): Promise<ChatConfig> {
  const stored = await readSection<Partial<ChatConfig>>(SETTINGS_KEY);
  if (!stored) return { ...DEFAULT_CHAT_CONFIG };
  return {
    maxSteps: stored.maxSteps ?? DEFAULT_CHAT_CONFIG.maxSteps,
    maxOutputTokens: stored.maxOutputTokens ?? DEFAULT_CHAT_CONFIG.maxOutputTokens,
  };
}

/** Stores the budget as the whole section, replacing whatever was there. */
export async function saveChatConfig(input: ChatConfig): Promise<ChatConfig> {
  return withSection<ChatConfig, ChatConfig>(SETTINGS_KEY, () => {
    const next: ChatConfig = {
      maxSteps: input.maxSteps,
      maxOutputTokens: input.maxOutputTokens ?? null,
    };
    return { next, result: next };
  });
}
