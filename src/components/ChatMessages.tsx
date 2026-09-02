import { memo } from "react";
import { messageLabel, type ThreadMessage, type ToolActivity } from "../lib/chat";
import Markdown from "./Markdown";
import ThinkingIndicator from "./ThinkingIndicator";
import TurnActivity from "./TurnActivity";

/**
 * Memoized because the thread re-renders on every streamed token: without it,
 * each already-finished reply would be re-parsed by react-markdown per token.
 */
const AssistantReply = memo(function AssistantReply({ content }: { content: string }) {
  return <Markdown className="text-zinc-100">{content}</Markdown>;
});

/**
 * The body of a chat thread — persisted turns, the in-flight reply, and the
 * waiting indicator. Shared by the Chat tab and the Omni Chat overlay; each
 * owns its own scroll container and sizing around this.
 *
 * Assistant replies are rendered as markdown. Anything the user (or a relayed
 * Telegram sender) wrote stays verbatim, so literal underscores, asterisks and
 * hashes in a prompt survive instead of being parsed as formatting.
 *
 * A reply is preceded by what the assistant did to produce it — the tools it
 * called and, where the provider returns it, its reasoning. Waiting with no
 * sign of either is what made a working turn look like a hung one.
 */
export default function ChatMessages({
  messages,
  streaming,
  busy,
  emptyHint,
  thinking = "",
  activity = [],
}: {
  messages: ThreadMessage[];
  /** Text accumulated for the reply currently streaming in, if any. */
  streaming: string;
  busy: boolean;
  emptyHint: string;
  /** Reasoning accumulated for the in-flight turn. */
  thinking?: string;
  /** Tools the in-flight turn has called so far. */
  activity?: ToolActivity[];
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
          {m.role === "assistant" ? (
            <>
              <TurnActivity activity={m.activity ?? []} thinking={m.reasoning} />
              <AssistantReply content={m.content} />
            </>
          ) : (
            <div className="whitespace-pre-wrap text-zinc-100">{m.content}</div>
          )}
        </div>
      ))}
      {busy && (activity.length > 0 || thinking) && (
        <TurnActivity activity={activity} thinking={thinking} running />
      )}
      {streaming && (
        <div className="text-sm">
          <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
            {messageLabel("assistant")}
          </div>
          <AssistantReply content={streaming} />
        </div>
      )}
      {busy && !streaming && !thinking && activity.length === 0 && <ThinkingIndicator />}
    </>
  );
}
