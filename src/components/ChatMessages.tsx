import { MessageSquareIcon, PencilIcon, RotateCcwIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { messageLabel, type ThreadMessage, type ToolActivity } from "../lib/chat";
import { ConversationEmptyState } from "./ai-elements/conversation";
import { Loader } from "./ai-elements/loader";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "./ai-elements/message";
import TurnActivity from "./TurnActivity";
import { Button } from "./ui/button";

function SpeakerLabel({ children }: { children: string }) {
  return <div className="text-xs tracking-wide text-muted-foreground uppercase">{children}</div>;
}

/** An assistant turn: what it did to get there, then the reply. */
function AssistantTurn({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Message from="assistant">
      <SpeakerLabel>{label}</SpeakerLabel>
      <MessageContent>{children}</MessageContent>
    </Message>
  );
}

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
      <Message from="user">
        <SpeakerLabel>{label}</SpeakerLabel>
        <div className="w-full max-w-[85%] space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(8, draft.split("\n").length + 1)}
            aria-label="Edit message"
            className="w-full resize-y rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground outline-none focus:border-ring"
          />
          <div className="flex justify-end gap-2">
            <Button
              size="xs"
              disabled={!draft.trim()}
              onClick={() => {
                onRewind?.(id as string, draft);
                setDraft(null);
              }}
            >
              Save & resend
            </Button>
            <Button size="xs" variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
          <p className="text-right text-xs text-muted-foreground">
            Replies after this message are discarded.
          </p>
        </div>
      </Message>
    );
  }

  return (
    <Message from="user">
      <SpeakerLabel>{label}</SpeakerLabel>
      <MessageContent className="max-w-[85%] whitespace-pre-wrap">{message.content}</MessageContent>
      {canRewind && (
        // Revealed on hover or keyboard focus, so a long thread isn't a column of buttons.
        <MessageActions className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <MessageAction
            size="icon-xs"
            tooltip="Send this message again, discarding everything after it"
            label="Resend"
            onClick={() => onRewind?.(id as string, message.content)}
          >
            <RotateCcwIcon />
          </MessageAction>
          <MessageAction
            size="icon-xs"
            tooltip="Edit this message, then resend it"
            label="Edit"
            onClick={() => setDraft(message.content)}
          >
            <PencilIcon />
          </MessageAction>
        </MessageActions>
      )}
    </Message>
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
      {messages.length === 0 && !streaming && (
        <ConversationEmptyState
          icon={<MessageSquareIcon className="size-6" />}
          description={emptyHint}
        />
      )}
      {messages.map((m, i) =>
        // Messages are append-only within a thread, so the index is stable.
        m.role === "assistant" ? (
          <AssistantTurn key={i} label={messageLabel(m.role, m.metadata)}>
            <TurnActivity activity={m.activity ?? []} thinking={m.reasoning} collapsed />
            <MessageResponse>{m.content}</MessageResponse>
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
          {streaming && <MessageResponse>{streaming}</MessageResponse>}
        </AssistantTurn>
      )}
      {busy && !streaming && !thinking && activity.length === 0 && (
        // Matches the reply's layout so the wait reads as the reply taking shape.
        <AssistantTurn label={messageLabel("assistant")}>
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader size={14} />
            Thinking…
          </div>
        </AssistantTurn>
      )}
    </>
  );
}
