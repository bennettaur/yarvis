/**
 * A rough price list for estimating what a run spent before Claude Code says.
 *
 * Claude Code reports the real cost only on its final `result` line, so a run
 * that is cancelled, times out or crashes never does. Its `assistant` lines do
 * carry token usage, and this turns that into an estimate so such a run still
 * records roughly what it cost. Whenever the `result` line arrives its figure
 * replaces the estimate.
 *
 * USD per million tokens, first-party API rates (October 2026). Cache writes are
 * priced from the input rate (1.25x for the 5-minute TTL, 2x for one hour). A
 * model not listed here is priced at the most expensive rates listed, so an
 * unknown model overstates its cost rather than hiding it.
 */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
}

const RATES: [prefix: string, rates: Rates][] = [
  ["claude-fable-", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-mythos-", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2 }],
  ["claude-opus-", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet-", { input: 3, output: 15, cacheRead: 0.3 }],
  ["claude-haiku-5-5", { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  ["claude-haiku-", { input: 1, output: 5, cacheRead: 0.1 }],
];

const MOST_EXPENSIVE: Rates = { input: 10, output: 50, cacheRead: 1 };

export function ratesFor(model: string | null): Rates {
  if (!model) return MOST_EXPENSIVE;
  return RATES.find(([prefix]) => model.startsWith(prefix))?.[1] ?? MOST_EXPENSIVE;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

/** The estimated USD cost of one API response's usage. */
export function estimateCostUsd(model: string | null, usage: TokenUsage): number {
  const rates = ratesFor(model);
  const fiveMinute = usage.cache_creation?.ephemeral_5m_input_tokens;
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens;
  // Without the split, cache writes are priced at the dearer one-hour rate.
  const writeCost =
    fiveMinute !== undefined || oneHour !== undefined
      ? (fiveMinute ?? 0) * rates.input * 1.25 + (oneHour ?? 0) * rates.input * 2
      : (usage.cache_creation_input_tokens ?? 0) * rates.input * 2;
  const perMillion =
    (usage.input_tokens ?? 0) * rates.input +
    (usage.output_tokens ?? 0) * rates.output +
    (usage.cache_read_input_tokens ?? 0) * rates.cacheRead +
    writeCost;
  return perMillion / 1_000_000;
}
