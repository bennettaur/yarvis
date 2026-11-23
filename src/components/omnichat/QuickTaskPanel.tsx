import { useEffect, useRef, useState } from "react";
import {
  createQuickTask,
  proposeQuickTask,
  type QuickTaskKind,
  type QuickTaskProposal,
  type WorkStreamLinkRef,
} from "../../lib/headsDown";
import { collectContext, formatContext } from "../../lib/omniChatContext";

const KINDS: { value: QuickTaskKind; label: string }[] = [
  { value: "general", label: "General" },
  { value: "ship", label: "Ship (get it merged)" },
  { value: "watch", label: "Watch (tell me when)" },
];

const PRIORITIES = ["urgent", "high", "medium", "low"] as const;

function linkLabel(ref: WorkStreamLinkRef, title?: string): string {
  if (title) return title;
  switch (ref.kind) {
    case "pr":
      return ref.url;
    case "ticket":
      return ref.key;
    case "workspace":
      return "Workspace";
    default:
      return ref.kind;
  }
}

/**
 * Omni Chat's "send to heads down" mode: one line becomes a proposed work
 * stream the user edits, and nothing is created until they confirm.
 */
export default function QuickTaskPanel({
  open,
  provider,
  model,
}: {
  open: boolean;
  provider: string;
  model: string;
}) {
  const [message, setMessage] = useState("");
  const [proposal, setProposal] = useState<QuickTaskProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) messageRef.current?.focus();
  }, [open]);

  const parse = async () => {
    const text = message.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const contexts = collectContext();
      const workspaceId = contexts.find((c) => c.source === "workspaces")?.details?.workspaceId;
      setProposal(
        await proposeQuickTask({
          message: text,
          workspaceId: typeof workspaceId === "string" ? workspaceId : undefined,
          screen: formatContext(contexts),
          provider,
          model,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!proposal || busy) return;
    setBusy(true);
    setError(null);
    try {
      const stream = await createQuickTask(proposal);
      setSaved(stream.title);
      setProposal(null);
      setMessage("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const patch = (changes: Partial<QuickTaskProposal>) =>
    setProposal((p) => (p ? { ...p, ...changes } : p));

  const field = "rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100";

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-zinc-400">
        One line for heads-down mode, like "get this PR merged". The workspace, PRs and screen you
        are on go along as context.
      </p>
      <textarea
        ref={messageRef}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void parse();
          }
        }}
        placeholder="What should heads-down mode take on?"
        className={`${field} min-h-20`}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void parse()}
          disabled={busy || !message.trim() || !provider}
          className="rounded-md border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
        >
          {busy && !proposal ? "Parsing…" : "Parse"}
        </button>
        {saved && <span className="text-xs text-emerald-400">Added “{saved}”.</span>}
      </div>

      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}

      {proposal && (
        <div className="flex flex-col gap-2 rounded-lg border border-zinc-700 bg-zinc-950/50 p-3">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Title
            <input
              value={proposal.title}
              onChange={(e) => patch({ title: e.target.value })}
              className={field}
            />
          </label>
          <div className="flex gap-2">
            <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
              Kind
              <select
                value={proposal.kind}
                onChange={(e) => patch({ kind: e.target.value as QuickTaskKind })}
                className={field}
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
              Priority
              <select
                value={proposal.priority}
                onChange={(e) =>
                  patch({ priority: e.target.value as QuickTaskProposal["priority"] })
                }
                className={field}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Focus
            <textarea
              value={proposal.focus}
              onChange={(e) => patch({ focus: e.target.value })}
              className={`${field} min-h-16`}
            />
          </label>
          <div className="flex flex-col gap-1 text-xs text-zinc-400">
            Links
            {proposal.links.length === 0 && <span className="text-zinc-500">None</span>}
            {proposal.links.map((link, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: the list only shrinks, in place
                key={i}
                className="flex items-center justify-between gap-2 rounded border border-zinc-800 px-2 py-1"
              >
                <span className="min-w-0 truncate text-zinc-200">
                  {link.ref.kind}: {linkLabel(link.ref, link.title)}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${linkLabel(link.ref, link.title)}`}
                  onClick={() => patch({ links: proposal.links.filter((_, j) => j !== i) })}
                  className="text-zinc-500 hover:text-zinc-200"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setProposal(null)}
              className="rounded-md border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={busy || !proposal.title.trim()}
              className="rounded-md bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              Add to heads down
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
