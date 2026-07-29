import { memo } from "react";
import { messageLabel } from "../lib/chat";
import type { ThreadMessage } from "../lib/useChatThread";
import Markdown from "./Markdown";
import ThinkingIndicator from "./ThinkingIndicator";

/**
 * Assistant replies are rendered as markdown; anything the user (or a relayed
 * Telegram sender) wrote is shown verbatim, so literal underscores, asterisks
 * and hashes in a prompt survive instead of being parsed as formatting.
 */
const MessageBody = memo(function MessageBody({
  messageRole,
  content,
}: {
  messageRole: string;
  content: string;
}) {
  if (messageRole !== "assistant") {
    return <div className="whitespace-pre-wrap text-zinc-100">{content}</div>;
  }
  return <Markdown className="text-sm text-zinc-100">{content}</Markdown>;
});

/**
 * The body of a chat thread — persisted turns, the in-flight reply, and the
 * waiting indicator. Shared by the Chat tab and the Omni Chat overlay; each
 * owns its own scroll container and sizing around this.
 */
export default function ChatMessages({
  messages,
  streaming,
  busy,
  emptyHint,
}: {
  messages: ThreadMessage[];
  /** Text accumulated for the reply currently streaming in, if any. */
  streaming: string;
  busy: boolean;
  emptyHint: string;
}) {
  return (
    <>
      {messages.length === 0 && !streaming && <p className="text-sm text-zinc-600">{emptyHint}</p>}
      {messages.map((m, i) => (
        // Messages are append-only within a thread, so the index is stable.
        <div key={i} className="text-sm">
          <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
            {messageLabel(m.role, m.metadata)}
          </div>
          <MessageBody messageRole={m.role} content={m.content} />
        </div>
      ))}
      {streaming && (
        <div className="text-sm">
          <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">assistant</div>
          <MessageBody messageRole="assistant" content={streaming} />
        </div>
      )}
      {busy && !streaming && <ThinkingIndicator />}
    </>
  );
}
