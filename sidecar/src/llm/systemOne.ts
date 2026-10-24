import { z } from "zod";
import { guardedFetch } from "../lib/guardedFetch.ts";
import type { SystemOneTarget } from "./providers.ts";

/**
 * A yes/no question (the API calls it `noul`), answered with the probability
 * of yes. `criteria` says what each answer means, so the model doesn't guess.
 */
export interface SystemOneNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

/** A judgement as named yes/no questions, and how their probabilities become the answer. */
export interface SystemOneDecision<T, K extends string = string> {
  questions: Record<K, SystemOneNoulQuestion>;
  toAnswer(probabilities: Record<K, number>): T;
}

export interface SystemOneRequest {
  target: SystemOneTarget;
  /** The context every question is asked about. */
  state: string;
  /** Keyed by name: letters, digits, `_`, `.` or `-`. */
  questions: Record<string, SystemOneNoulQuestion>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Injected by tests in place of the network. */
  fetchImpl?: typeof fetch;
}

const responseSchema = z.object({
  answers: z.record(z.string(), z.object({ noul: z.number().min(0).max(1) })),
});

/**
 * One call to Ollama's System One API (https://docs.ollama.com/api/systemone),
 * which answers typed questions about a shared state instead of generating
 * text. Returns each question's probability of yes, by name. Throws on a
 * non-OK status, a reply that is not System One's shape, or a missing answer.
 */
export async function systemOneAsk(request: SystemOneRequest): Promise<Record<string, number>> {
  const res = await guardedFetch(
    request.target.url,
    {
      method: "POST",
      headers: request.target.headers,
      body: JSON.stringify({
        model: request.target.model,
        state: request.state,
        questions: request.questions,
      }),
      signal: request.signal,
    },
    {
      fetchImpl: request.fetchImpl ?? fetch,
      timeoutMs: request.timeoutMs,
      allowLoopback: true,
      // The state is the user's conversation.
      sameOriginOnly: true,
      // The same check the provider's base URL gets everywhere else.
      staticCheckOnly: true,
    },
  );
  if (!res.ok) throw new Error(`System One call failed (${res.status})`);
  const { answers } = responseSchema.parse(await res.json());
  const probabilities: Record<string, number> = {};
  for (const name of Object.keys(request.questions)) {
    const answer = answers[name];
    if (!answer) throw new Error(`System One returned no answer for ${name}`);
    probabilities[name] = answer.noul;
  }
  return probabilities;
}
