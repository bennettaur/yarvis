import { useCallback, useState } from "react";
import type { ProviderInfo } from "./chat";

/**
 * How hard a model thinks before answering; mirrors the sidecar's
 * `ReasoningEffort`. Unset means the provider's default. The sidecar applies
 * it only to models tagged `reasoning`, so a stale choice is dropped there
 * rather than failing the call.
 */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};

/** Tooltip for every effort picker. */
export const EFFORT_HINT =
  "How hard the model thinks before it answers. Higher is slower and uses more tokens. Default leaves it to the provider.";

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Whether the catalogue tags this model `reasoning`, which is what offers an effort picker. */
export function modelTakesEffort(
  providers: ProviderInfo[],
  providerId: string,
  modelId: string,
): boolean {
  return (
    providers
      .find((p) => p.id === providerId)
      ?.models.find((m) => m.id === modelId)
      ?.capabilities.includes("reasoning") ?? false
  );
}

/**
 * Shared by every surface that uses the chat's provider/model keys (the Chat
 * tab, Omni Chat, the Omni view and the memory recap), so the effort follows
 * the model it was chosen for.
 */
export const CHAT_EFFORT_KEY = "yarvis.chat.effort";

/** The chat surfaces' saved effort, or undefined for the provider's default. */
export function readChatEffort(): ReasoningEffort | undefined {
  const stored = localStorage.getItem(CHAT_EFFORT_KEY) ?? "";
  return isReasoningEffort(stored) ? stored : undefined;
}

export function useChatEffort(): [
  ReasoningEffort | undefined,
  (value: ReasoningEffort | undefined) => void,
] {
  const [effort, setEffort] = useState(readChatEffort);
  const set = useCallback((value: ReasoningEffort | undefined) => {
    setEffort(value);
    if (value) localStorage.setItem(CHAT_EFFORT_KEY, value);
    else localStorage.removeItem(CHAT_EFFORT_KEY);
  }, []);
  return [effort, set];
}
