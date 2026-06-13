import { useEffect } from "react";

/**
 * A snapshot of what the user is currently looking at, contributed by a view so
 * Omni Chat can hand it to the agent. `summary` is a short human-readable line
 * ("Reviewing PR #18 in owner/repo"); `details` carries any structured fields
 * worth passing through verbatim (urls, ids, dates).
 */
export interface PageContext {
  /** Stable id of the contributing view, e.g. "tab" or "prs". */
  source: string;
  summary: string;
  details?: Record<string, unknown>;
}

/**
 * Frontend registry of page-context contributors. Each mounted view registers a
 * builder that returns its current {@link PageContext} (or null when it has
 * nothing useful to add). When Omni Chat sends a message it calls
 * {@link collectContext} to gather every live snapshot and attaches them to the
 * request.
 *
 * To wire a new view, call the {@link useOmniChatContext} hook with a stable
 * source id and a builder over the state that describes what the user sees:
 *
 *   useOmniChatContext(
 *     "prs",
 *     () => (selected ? { source: "prs", summary: `Reviewing PR #${selected.number}` } : null),
 *     [selected],
 *   );
 *
 * That is the entire integration — new features become Omni Chat context with
 * one hook call.
 */
type ContextBuilder = () => PageContext | null;

/**
 * Cap on the rendered context string. Kept below the sidecar's 8000-char schema
 * limit so an unusually large snapshot degrades gracefully here instead of the
 * server rejecting the whole turn.
 */
const MAX_CONTEXT_CHARS = 7000;

const builders = new Map<string, ContextBuilder>();

export function registerContext(id: string, builder: ContextBuilder): () => void {
  builders.set(id, builder);
  return () => {
    // Only remove if this exact builder is still registered, so a re-register
    // from a remount that ran before this cleanup isn't clobbered.
    if (builders.get(id) === builder) builders.delete(id);
  };
}

/** Collects the current snapshot from every registered contributor. */
export function collectContext(): PageContext[] {
  const out: PageContext[] = [];
  for (const build of builders.values()) {
    const ctx = build();
    if (ctx) out.push(ctx);
  }
  return out;
}

/** Renders the collected contexts into the string sent to the agent. */
export function formatContext(contexts: PageContext[]): string | undefined {
  if (contexts.length === 0) return undefined;
  const rendered = contexts
    .map((ctx) => {
      const lines = [`[${ctx.source}] ${ctx.summary}`];
      if (ctx.details && Object.keys(ctx.details).length > 0) {
        lines.push(JSON.stringify(ctx.details));
      }
      return lines.join("\n");
    })
    .join("\n\n");
  return rendered.length > MAX_CONTEXT_CHARS
    ? `${rendered.slice(0, MAX_CONTEXT_CHARS)}\n…[context truncated]`
    : rendered;
}

/**
 * Registers a view's context builder for as long as the component is mounted.
 * Pass `deps` so the builder closure refreshes when the described state changes.
 */
export function useOmniChatContext(id: string, builder: ContextBuilder, deps: unknown[]): void {
  // The builder is re-registered when the caller's described state (deps)
  // changes; `id` is stable per call site, so forwarding deps verbatim is intended.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps is forwarded by design
  useEffect(() => registerContext(id, builder), deps);
}
