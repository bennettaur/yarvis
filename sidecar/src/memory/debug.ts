import { describeError } from "../llm/errors.ts";

/**
 * Verbose tracing for the memory subsystem (embedder selection, provider calls,
 * store operations, health). Gated behind YARVIS_DEBUG_MEMORY so it stays silent
 * in normal use. Enable with `YARVIS_DEBUG_MEMORY=1`: the Tauri core forwards the
 * flag to the sidecar it spawns, and standalone `bun run` reads it directly.
 *
 * The flag is read at call time (not import time) so toggling it — and the
 * tests that exercise it — take effect without reloading the module.
 */
export function memoryDebugEnabled(): boolean {
  const v = process.env.YARVIS_DEBUG_MEMORY;
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

/** Subsystem tag for a debug line: the embedder vs the surrounding store. */
type DebugScope = "memory" | "embedder";

/** Logs a memory-subsystem debug line when tracing is enabled; otherwise a no-op. */
export function memoryDebug(scope: DebugScope, message: string): void {
  if (memoryDebugEnabled()) console.log(`[${scope}] ${message}`);
}

/**
 * Times an embedding provider call and logs its shape (via `summarize`) plus
 * latency — or the redacted error on failure — then returns the result
 * untouched. When tracing is off the call runs with no added work.
 */
export async function traceEmbedCall<T>(
  label: string,
  run: () => Promise<T>,
  summarize: (result: T) => string,
): Promise<T> {
  if (!memoryDebugEnabled()) return run();
  const start = performance.now();
  try {
    const result = await run();
    const ms = Math.round(performance.now() - start);
    memoryDebug("embedder", `${label} -> ${summarize(result)} (${ms}ms)`);
    return result;
  } catch (e) {
    const ms = Math.round(performance.now() - start);
    // describeError keeps the human-readable message but strips urls / response
    // bodies that can carry the API key or other secrets.
    memoryDebug("embedder", `${label} FAILED (${ms}ms): ${describeError(e)}`);
    throw e;
  }
}

/** Describes a single embedding vector: its dimension and L2 norm. */
export function vectorSummary(vec: number[]): string {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return `dim=${vec.length} norm=${norm.toFixed(2)}`;
}

/** A short, single-line preview of user text for a debug line. */
export function preview(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
