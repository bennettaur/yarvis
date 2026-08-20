import { useCallback, useEffect, useRef, useState } from "react";
import { clearDraft, draftKey, getDraft, setDraft, useDraft } from "../../lib/fileDrafts";
import {
  FileConflictError,
  type FileUnreadable,
  saveWorkspaceRepoFile,
  type WorkspaceFile,
  workspaceRepoFile,
} from "../../lib/workspaces";
import CodeEditor from "../editor/CodeEditor";

/**
 * A workspace editor tab's body: one file from a repo's worktree, opened for
 * editing.
 *
 * The file is read from disk rather than from git — the worktree is what the
 * agent session is also working in, so what the editor shows is what the agent
 * sees. That sharing is also why a save carries the hash the file was opened
 * with: an agent that rewrote the file between opening and saving would
 * otherwise have its work silently replaced. A refused save is recoverable
 * from here rather than fatal.
 *
 * The text being edited lives in `fileDrafts`, not in this component, so
 * switching tabs — which unmounts it — doesn't discard what has been typed.
 */

const UNREADABLE_REASON: Record<FileUnreadable, string> = {
  binary: "This is a binary file.",
  "too-large": "This file is too large to open in the editor.",
  encoding: "This file is not valid UTF-8, so editing it would rewrite the bytes we cannot read.",
};

export default function WorkspaceFileEditor({
  workspaceId,
  repoId,
  path,
}: {
  workspaceId: string;
  repoId: string;
  path: string;
}) {
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The in-flight guard is a ref as well as state: two Cmd+S presses in one
  // frame both read the same `saving` state, and the second would then save
  // against a hash the first has already superseded.
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Set when a save was refused because the file moved under us; cleared by
   *  reloading or by an explicit overwrite. */
  const [conflict, setConflict] = useState(false);

  const key = draftKey(workspaceId, repoId, path);
  const draft = useDraft(key);

  /** `live` is false once a newer read has been asked for, so two reads that
   *  resolve out of order can't leave the older one's file on screen. */
  const load = useCallback(
    async (live: () => boolean = () => true) => {
      try {
        const next = await workspaceRepoFile(workspaceId, repoId, path);
        if (!live()) return;
        setFile(next);
        setLoadError(null);
        // A buffer that outlived the tab was started from an older version of
        // the file. It is only safe to save once the user has been told, so the
        // banner is raised on the read rather than waiting for a refused save
        // that — carrying the fresh hash — would not be refused.
        const buffered = getDraft(key);
        if (buffered && buffered.baseHash !== next.hash) setConflict(true);
      } catch (e) {
        if (!live()) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    },
    [workspaceId, repoId, path, key],
  );

  useEffect(() => {
    let live = true;
    // Cleared before the read, not after it: a tab pointed at another file must
    // not spend the load showing the previous file's contents under the new
    // file's name, nor a conflict banner raised against a file it has left.
    setFile(null);
    setConflict(false);
    setSaveError(null);
    void load(() => live);
    return () => {
      live = false;
    };
  }, [load]);

  const editable = file !== null && file.unreadable === null && file.content !== null;
  const text = draft?.text ?? file?.content ?? "";
  const dirty = draft !== null;

  const onChange = (next: string) => {
    if (!file || file.hash === null) return;
    if (next === file.content) clearDraft(key);
    else setDraft(key, { text: next, baseHash: draft?.baseHash ?? file.hash });
  };

  /**
   * Writes the buffer back against `baseHash` — the hash the file was read with,
   * except on the overwrite path, which supplies a freshly-read one.
   *
   * Refuses to run while a save is in flight or with nothing edited: two saves
   * sharing a base hash means the second is refused as a conflict caused by the
   * first, reported as though the agent had done it.
   */
  const save = useCallback(
    async (baseHash: string | null) => {
      if (!editable || !file || !dirty || savingRef.current || baseHash === null) return;
      savingRef.current = true;
      setSaving(true);
      setSaveError(null);
      try {
        const result = await saveWorkspaceRepoFile(workspaceId, repoId, path, text, baseHash);
        setFile({ ...file, content: text, hash: result.hash, size: result.size });
        // Anything typed while the write was in flight is a newer edit than what
        // landed, so it stays a draft rather than being dropped on the return.
        if (getDraft(key)?.text === text) clearDraft(key);
        setConflict(false);
      } catch (e) {
        if (e instanceof FileConflictError) setConflict(true);
        else setSaveError(e instanceof Error ? e.message : String(e));
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [file, editable, dirty, text, workspaceId, repoId, path, key],
  );

  /** Re-reads the file, throwing away the unsaved buffer — the way out of a
   *  conflict when the version on disk is the one to keep. */
  const reload = async () => {
    clearDraft(key);
    setConflict(false);
    setSaveError(null);
    await load();
  };

  /** Takes the conflict head-on: re-read for the current hash, then save the
   *  buffer over it. Only reachable from the conflict banner, where what it
   *  discards has been named. */
  const overwrite = async () => {
    try {
      const current = await workspaceRepoFile(workspaceId, repoId, path);
      // Adopted even though the save may still fail: leaving `file` on a hash
      // disk has moved past means every later save is refused for a reason the
      // banner has already been through.
      setFile(current);
      await save(current.hash);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300" title={path}>
          {path}
          {dirty && <span className="ml-1.5 text-amber-400">●</span>}
        </span>
        <button
          type="button"
          onClick={() => void reload()}
          className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          {dirty ? "Revert" : "Reload"}
        </button>
        <button
          type="button"
          onClick={() => void save(draft?.baseHash ?? file?.hash ?? null)}
          disabled={!editable || !dirty || saving}
          className="shrink-0 rounded bg-indigo-600 px-2 py-0.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {conflict && (
        <div className="shrink-0 border-b border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
          <p>
            This file changed on disk after you opened it — most likely the agent working in this
            worktree. Your edits are still here.
          </p>
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              onClick={() => void reload()}
              className="rounded border border-amber-700 px-2 py-0.5 hover:bg-amber-900/50"
            >
              Discard mine, reload from disk
            </button>
            <button
              type="button"
              onClick={() => void overwrite()}
              className="rounded border border-amber-700 px-2 py-0.5 hover:bg-amber-900/50"
            >
              Overwrite with mine
            </button>
          </div>
        </div>
      )}
      {saveError && <p className="shrink-0 px-3 py-1 text-xs text-red-400">{saveError}</p>}

      <div className="min-h-0 flex-1">
        {loadError ? (
          <p className="p-3 text-xs text-red-400">{loadError}</p>
        ) : file === null ? (
          <p className="p-3 text-xs text-zinc-500">Loading…</p>
        ) : file.unreadable ? (
          <p className="p-3 text-xs text-zinc-500">
            {UNREADABLE_REASON[file.unreadable]} ({file.size.toLocaleString()} bytes)
          </p>
        ) : (
          <CodeEditor
            value={text}
            path={path}
            onChange={onChange}
            onSave={() => void save(draft?.baseHash ?? file.hash)}
          />
        )}
      </div>
    </div>
  );
}
