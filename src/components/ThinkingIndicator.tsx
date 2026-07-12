/** A small spinning ring, sized to sit inline with a line of text. */
export function Spinner() {
  return (
    <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-600 border-t-indigo-400" />
  );
}

/**
 * The placeholder assistant row shown after a message is sent but before the
 * first token streams back, so the wait for the LLM never looks like a stall.
 * Matches the streamed-message layout (an "assistant" label above the body) so
 * it reads as the reply taking shape.
 */
export default function ThinkingIndicator() {
  return (
    <div className="text-sm">
      <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">assistant</div>
      <div className="flex items-center gap-2 text-zinc-400">
        <Spinner />
        Thinking…
      </div>
    </div>
  );
}
