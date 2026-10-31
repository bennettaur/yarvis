import { Loader } from "./ai-elements/loader";
import { Message, MessageContent, MessageLabel } from "./ai-elements/message";

/**
 * The placeholder assistant turn shown after a message is sent but before the
 * first token streams back, so the wait for the LLM never looks like a stall.
 * Laid out like a reply (label above the body) so it reads as the reply taking
 * shape. Every chat thread uses this one, so they all wait the same way.
 */
export default function ThinkingIndicator() {
  return (
    <Message from="assistant">
      <MessageLabel>assistant</MessageLabel>
      <MessageContent>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader />
          Thinking…
        </div>
      </MessageContent>
    </Message>
  );
}
