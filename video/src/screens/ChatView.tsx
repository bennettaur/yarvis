import type { ReactNode } from "react";
import { useCurrentFrame } from "remotion";
import ChatComposer from "../../../src/components/ChatComposer";
import ChatMessages from "../../../src/components/ChatMessages";
import ToolApprovalBar from "../../../src/components/ToolApprovalBar";
import type { PendingApproval } from "../../../src/lib/chat";
import { chatAt, type ScriptTurn } from "../lib/chatScript";
import { noop } from "../lib/style";
import { withCaret } from "../lib/timing";

const SELECT_CLASS = "rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm";

/**
 * The Chat tab's layout from `ChatPanel`, holding the real `ChatMessages`,
 * `ToolApprovalBar` and `ChatComposer`, driven by a scripted conversation.
 * The thread is pinned to its bottom edge so new turns push old ones up, as
 * the app's auto-scroll does.
 */
export function ChatView({
  turns,
  session = "Week of Oct 5",
  approvals = [],
  footer,
}: {
  turns: ScriptTurn[];
  session?: string;
  approvals?: PendingApproval[];
  /** Replaces the area under the composer, e.g. the voice controls. */
  footer?: ReactNode;
}) {
  const frame = useCurrentFrame();
  const chat = chatAt(turns, frame);
  const draft = withCaret(chat.draft, frame);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm">New chat</span>
        <span className={SELECT_CLASS}>{session} ▾</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-1 text-xs text-zinc-400">
            <span className="inline-block h-3 w-3 border border-zinc-600 bg-zinc-800" />
            Thinking
          </span>
          <span className={SELECT_CLASS}>Anthropic ▾</span>
          <span className={SELECT_CLASS}>claude-sonnet-5 ▾</span>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="space-y-4">
          <ChatMessages
            messages={chat.messages}
            streaming={chat.streaming}
            busy={chat.busy}
            activity={chat.activity}
            emptyHint="Start a conversation."
          />
        </div>
      </div>
      {/* `visible` only gates the A and D shortcuts: the bar still renders, and
          with nothing to answer the shortcuts must stay off. */}
      <ToolApprovalBar approvals={approvals} onRespond={noop} visible={false} />
      <ChatComposer
        value={draft}
        onChange={noop}
        onSubmit={noop}
        busy={chat.busy}
        onStop={noop}
        placeholder="Message..."
        submitLabel="Send"
        maxHeight={360}
      />
      {footer}
    </div>
  );
}
