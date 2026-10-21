import { useEffect, useRef, useState } from "react";

/**
 * The workspace detail header's title, editable in place. Enter or leaving the
 * field saves, Escape cancels.
 */
export default function WorkspaceNameHeading({
  name,
  onRename,
}: {
  name: string;
  /** Saves the new name. A rejection keeps the field open with its message. */
  onRename: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True once a save or cancel has decided the edit, so the blur that follows
  // as the field unmounts doesn't save a second time. A failed save clears it,
  // so leaving the field tries again.
  const skipBlurSaveRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // The field only appears once the user has asked to edit, so taking focus is
  // expected. Via a ref because biome's a11y/noAutofocus rule flags `autoFocus`.
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const start = () => {
    skipBlurSaveRef.current = false;
    setDraft(name);
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    skipBlurSaveRef.current = true;
    setEditing(false);
    setError(null);
  };

  const save = async () => {
    if (busy) return;
    const next = draft.trim();
    // Nothing to save: treat it as Escape.
    if (!next || next === name) {
      cancel();
      return;
    }
    skipBlurSaveRef.current = true;
    setBusy(true);
    try {
      await onRename(next);
      setEditing(false);
      setError(null);
    } catch (e) {
      skipBlurSaveRef.current = false;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <>
        <h2 className="text-sm font-medium text-zinc-100">{name}</h2>
        <button
          type="button"
          onClick={start}
          title="Rename this workspace. Its folder and branch keep their current names."
          className="shrink-0 rounded px-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          Rename
        </button>
      </>
    );
  }

  return (
    <>
      <input
        ref={inputRef}
        aria-label="Workspace name"
        maxLength={200}
        value={draft}
        // Read-only rather than disabled while saving: disabling drops focus, and
        // a failed save should leave the field ready to retry or Escape.
        readOnly={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => {
          if (!skipBlurSaveRef.current) void save();
        }}
        className="min-w-0 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
      />
      {error && <span className="shrink-0 text-xs text-red-400">{error}</span>}
    </>
  );
}
