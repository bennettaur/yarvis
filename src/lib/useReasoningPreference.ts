import { useCallback, useState } from "react";

/** Shared by both chat surfaces, so the choice follows the user between them. */
const REASONING_KEY = "yarvis.chat.reasoning";

/** Tooltip for the "Thinking" checkbox on both chat surfaces. */
export const REASONING_HINT =
  "Ask the model to show its reasoning before it answers. Only some models support it, and it can use more tokens and take longer.";

/**
 * Whether to ask the provider for the model's reasoning. Persisted because it
 * is a standing preference about how much the user wants to see, not a
 * per-message decision — and off by default, since thinking costs tokens and
 * latency on the providers that support it.
 */
export function useReasoningPreference(): [boolean, (value: boolean) => void] {
  const [reasoning, setReasoning] = useState(() => localStorage.getItem(REASONING_KEY) === "1");
  const set = useCallback((value: boolean) => {
    setReasoning(value);
    localStorage.setItem(REASONING_KEY, value ? "1" : "0");
  }, []);
  return [reasoning, set];
}
