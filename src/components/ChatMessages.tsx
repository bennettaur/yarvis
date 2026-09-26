import { memo, type ReactNode } from "react";
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

/** An assistant turn: accent rule and label set it apart from the user's bubbles. */
function AssistantTurn({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-l-2 border-violet-500/50 pl-3 text-sm">
      <div className="mb-1 text-xs uppercase tracking-wide text-violet-300/70">{label}</div>
      {children}
    </div>
  );
}

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
 * called and, where the provider returns it, its reasoning. Without those, a
 * turn spent in tools is indistinguishable from a hung one.
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
      {messages.map((m, i) =>
        // Messages are append-only within a thread, so the index is stable.
        m.role === "assistant" ? (
          <AssistantTurn key={i} label={messageLabel(m.role, m.metadata)}>
            <TurnActivity activity={m.activity ?? []} thinking={m.reasoning} collapsed />
            <AssistantReply content={m.content} />
          </AssistantTurn>
        ) : (
          <div key={i} className="flex flex-col items-end text-sm">
            <div className="mb-1 text-xs uppercase tracking-wide text-sky-400/70">
              {messageLabel(m.role, m.metadata)}
            </div>
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm border border-sky-800/50 bg-sky-950/40 px-3 py-2 text-zinc-100">
              {m.content}
            </div>
          </div>
        ),
      )}
      {busy && (activity.length > 0 || thinking || streaming) && (
        <AssistantTurn label={messageLabel("assistant")}>
          {/* Open while tools are landing; folds once the reply text starts. */}
          <TurnActivity
            activity={activity}
            thinking={thinking}
            running
            collapsed={streaming !== ""}
          />
          {streaming && <AssistantReply content={streaming} />}
        </AssistantTurn>
      )}
      {!busy && streaming && (
        <AssistantTurn label={messageLabel("assistant")}>
          <AssistantReply content={streaming} />
        </AssistantTurn>
      )}
      {busy && !streaming && !thinking && activity.length === 0 && <ThinkingIndicator />}
    </>
  );
}
