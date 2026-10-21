import { memo, type ReactNode, useState } from "react";
import { messageLabel, type ThreadMessage, type ToolActivity } from "../lib/chat";
import Markdown from "./Markdown";
import ThinkingIndicator from "./ThinkingIndicator";
import TurnActivity from "./TurnActivity";

/**
 * Memoized because the thread re-renders on every streamed token: without it,
 * each already-finished reply would be re-parsed by react-markdown per token.
 */
const AssistantReply = memo(function AssistantReply({ content }: { content: string }) {
  return (
    <Markdown className="text-zinc-100" allowAppLinks>
      {content}
    </Markdown>
  );
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

const ACTION_CLASS =
  "rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800";

/**
 * A user turn's bubble, with — when the thread can rewind — a way to send it
 * again as it was or edit it first. Either restarts the conversation from that
 * message, discarding what followed, so Edit asks for its own confirmation
 * step (Save) rather than acting on a stray keypress.
 */
function UserMessage({
  message,
  onRewind,
}: {
  message: ThreadMessage;
  onRewind?: (messageId: string, text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const id = message.id;
  const canRewind = message.role === "user" && id != null && onRewind != null;
  const label = messageLabel(message.role, message.metadata);

  if (draft !== null && canRewind) {
    return (
      <div className="flex flex-col items-end text-sm">
        <div className="mb-1 text-xs uppercase tracking-wide text-sky-400/70">{label}</div>
        <div className="w-full max-w-[85%] space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(8, draft.split("\n").length + 1)}
            aria-label="Edit message"
            className="w-full resize-y rounded-md border border-sky-800/50 bg-sky-950/40 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={!draft.trim()}
              onClick={() => {
                onRewind?.(id as string, draft);
                setDraft(null);
              }}
              className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              Save & resend
            </button>
            <button type="button" onClick={() => setDraft(null)} className={ACTION_CLASS}>
              Cancel
            </button>
          </div>
          <p className="text-right text-xs text-zinc-500">
            Replies after this message are discarded.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end text-sm">
      <div className="mb-1 text-xs uppercase tracking-wide text-sky-400/70">{label}</div>
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm border border-sky-800/50 bg-sky-950/40 px-3 py-2 text-zinc-100">
        {message.content}
      </div>
      {canRewind && (
        <div className="mt-1 flex gap-2">
          <button
            type="button"
            title="Send this message again, discarding everything after it"
            onClick={() => onRewind?.(id as string, message.content)}
            className={ACTION_CLASS}
          >
            Resend
          </button>
          <button
            type="button"
            title="Edit this message, then resend it"
            onClick={() => setDraft(message.content)}
            className={ACTION_CLASS}
          >
            Edit
          </button>
        </div>
      )}
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
 *
 * Passing `onRewind` lets the user resend or edit any persisted user message,
 * restarting the conversation from there.
 */
export default function ChatMessages({
  messages,
  streaming,
  busy,
  emptyHint,
  thinking = "",
  activity = [],
  onRewind,
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
  /** Restart from a user message, with its text as sent or as edited. Omit to hide the controls. */
  onRewind?: (messageId: string, text: string) => void;
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
          <UserMessage key={i} message={m} onRewind={busy ? undefined : onRewind} />
        ),
      )}
      {(busy || streaming) && (activity.length > 0 || thinking || streaming) && (
        // One element for the whole in-flight turn, so nothing remounts when
        // `busy` drops before the persisted message arrives.
        <AssistantTurn label={messageLabel("assistant")}>
          {/* Open while tools are landing; folds once the reply text starts. */}
          <TurnActivity
            activity={activity}
            thinking={thinking}
            running={busy}
            collapsed={streaming !== ""}
          />
          {streaming && <AssistantReply content={streaming} />}
        </AssistantTurn>
      )}
      {busy && !streaming && !thinking && activity.length === 0 && <ThinkingIndicator />}
    </>
  );
}
