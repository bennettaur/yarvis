import { Loader } from "./ai-elements/loader";
import { Message, MessageContent, MessageLabel } from "./ai-elements/message";

/** A small spinning ring, sized to sit inline with a line of text. */
export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-600 border-t-indigo-400"
    />
  );
}

/**
 * The placeholder assistant turn shown after a message is sent but before the
 * first token streams back, so the wait for the LLM never looks like a stall.
 * Laid out like a reply (label above the body) so it reads as the reply taking
 * shape. Every chat thread uses this one, so they all wait the same way.
 */
export default function ThinkingIndicator({ label = "assistant" }: { label?: string }) {
  return (
    <Message from="assistant">
      <MessageLabel>{label}</MessageLabel>
      <MessageContent>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader size={14} />
          Thinking…
        </div>
      </MessageContent>
    </Message>
  );
}
