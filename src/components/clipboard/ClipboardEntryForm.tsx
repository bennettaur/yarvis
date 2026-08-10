import { useState } from "react";
import { type CreateClipboardEntryInput, CredentialRejectedError } from "../../lib/clipboard";

export interface ClipboardDraft {
  label: string;
  content: string;
  tags: string;
}

/**
 * Create/edit form for a clipboard entry. Tags are entered as a comma-separated
 * list — the sidecar normalizes case and duplicates, so this only has to split.
 *
 * A credential refusal is shown in the form rather than as a failure toast: the
 * user is mid-edit and the fix (don't save that here) belongs next to the field
 * that caused it.
 */
export default function ClipboardEntryForm({
  draft,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  draft: ClipboardDraft;
  submitLabel: string;
  onSubmit: (input: CreateClipboardEntryInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(draft.label);
  const [content, setContent] = useState(draft.content);
  const [tags, setTags] = useState(draft.tags);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setRefused(false);
    try {
      await onSubmit({
        label: label.trim(),
        content,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
    } catch (e) {
      setRefused(e instanceof CredentialRejectedError);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = label.trim().length > 0 && content.length > 0 && !busy;

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) void submit();
      }}
    >
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Label (what you'll search for)"
        aria-label="Entry label"
        className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600"
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="What gets copied"
        aria-label="Entry content"
        className="min-h-20 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-600"
      />
      <input
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        placeholder="Tags, comma separated"
        aria-label="Entry tags"
        className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600"
      />
      {error && (
        <p className={`text-xs ${refused ? "text-amber-300" : "text-red-400"}`}>
          {error}
          {refused && " The clipboard book isn't for secrets — keep those in the Keychain."}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-md border border-indigo-500/60 bg-indigo-600/20 px-2 py-1 text-xs text-indigo-200 disabled:opacity-40"
        >
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
