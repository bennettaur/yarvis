import { useEffect, useMemo, useRef, useState } from "react";
import {
  type Artifact,
  type ArtifactSummary,
  type ArtifactWriter,
  deleteArtifact,
  deleteArtifacts,
  getArtifact,
  listArtifacts,
} from "../../lib/artifacts";
import { formatError } from "../../lib/errors";
import { requestOpenArtifact } from "../../lib/nav";
import { useCachedResource } from "../../lib/resourceCache";
import LoadingIndicator from "../LoadingIndicator";
import Markdown from "../Markdown";
import RefreshingIndicator from "../RefreshingIndicator";

/**
 * Documents the assistant wrote: morning briefs, reports, its own scratchpads.
 * Read-only apart from delete; the agent edits them through its tools.
 */

/** Stable identity so an unloaded resource doesn't re-render the list. */
const NO_ARTIFACTS: ArtifactSummary[] = [];

const WRITER_LABELS: Record<ArtifactWriter, string> = {
  chat: "Chat",
  "heads-down": "Heads-down",
  specialist: "Specialist or job",
};

export default function ArtifactsTab() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // A bulk delete can't be undone, so it takes a second click to confirm. The ids
  // are fixed when it asks, so a list refresh can't change what was agreed to.
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const listRes = useCachedResource<ArtifactSummary[]>("memory:artifacts", listArtifacts);
  const artifacts = listRes.data ?? NO_ARTIFACTS;
  const selected = artifacts.find((a) => a.id === selectedId) ?? null;
  // Only ticks on artifacts still listed count, so the number matches what's shown.
  const checkedIds = artifacts.filter((a) => checked.has(a.id)).map((a) => a.id);
  const allChecked = artifacts.length > 0 && checkedIds.length === artifacts.length;

  // The update time is in the key so an artifact the agent changed since it was
  // last opened is fetched again rather than served from the cache.
  const artifactRes = useCachedResource<Artifact>(
    selected ? `memory:artifact:${selected.id}:${selected.updatedAt}` : null,
    // Only runs while the key is set, which is only while one is selected.
    () => getArtifact(selected?.id ?? ""),
  );
  // Ticking boxes re-renders the tab; don't re-parse a long document each time.
  const content = artifactRes.data?.content;
  const isDiagram = artifactRes.data?.format === "excalidraw";
  const markdownBody = useMemo(() => {
    if (content === undefined) return null;
    if (isDiagram) {
      return <p className="text-sm text-zinc-500">A diagram. Open it beside the chat to see it.</p>;
    }
    return <Markdown>{content}</Markdown>;
  }, [content, isDiagram]);

  // Keyboard focus would otherwise drop to the page when the confirm buttons replace the one clicked.
  useEffect(() => {
    if (confirmIds) cancelRef.current?.focus();
  }, [confirmIds]);

  const toggle = (id: string) => {
    setConfirmIds(null);
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setConfirmIds(null);
    setChecked(allChecked ? new Set() : new Set(artifacts.map((a) => a.id)));
  };

  const removeIds = async (ids: string[], remove: () => Promise<unknown>) => {
    setDeleteError(null);
    setDeleting(true);
    try {
      await remove();
    } catch (err) {
      setDeleteError(formatError(err).message);
      return;
    } finally {
      setDeleting(false);
      setConfirmIds(null);
    }
    if (selectedId && ids.includes(selectedId)) setSelectedId(null);
    setChecked((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
    await listRes.refresh();
  };

  const removeOne = (id: string) => removeIds([id], () => deleteArtifact(id));
  const removeConfirmed = (ids: string[]) => removeIds(ids, () => deleteArtifacts(ids));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="mr-auto text-sm text-zinc-500">
          Documents the assistant wrote: briefs, reports and its own notes.
        </p>
        <RefreshingIndicator active={listRes.refreshing} />
      </div>

      {listRes.loading ? (
        <LoadingIndicator label="Loading artifacts…" />
      ) : artifacts.length === 0 ? (
        <p className="text-sm text-zinc-600">The assistant hasn't written anything yet.</p>
      ) : (
        <div className="flex gap-3">
          <div className="w-72 shrink-0 rounded-xl border border-zinc-800 bg-zinc-900/50">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs">
              <input
                type="checkbox"
                disabled={deleting}
                checked={allChecked}
                onChange={toggleAll}
                aria-label="Select all artifacts"
              />
              {confirmIds ? (
                <>
                  <span role="status" className="mr-auto text-zinc-300">
                    Delete {confirmIds.length} for good?
                  </span>
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={() => void removeConfirmed(confirmIds)}
                    className="rounded bg-red-600 px-2 py-0.5 text-white hover:bg-red-500 disabled:opacity-50"
                  >
                    Delete {confirmIds.length}
                  </button>
                  <button
                    ref={cancelRef}
                    type="button"
                    disabled={deleting}
                    onClick={() => setConfirmIds(null)}
                    className="text-zinc-400 hover:text-zinc-200"
                  >
                    Cancel
                  </button>
                </>
              ) : checkedIds.length === 0 ? (
                <span role="status" className="text-zinc-500">
                  Select to delete several
                </span>
              ) : (
                <>
                  <span role="status" className="mr-auto text-zinc-300">
                    {checkedIds.length} selected
                  </span>
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={() => setConfirmIds(checkedIds)}
                    className="text-red-400 hover:text-red-300 disabled:opacity-50"
                  >
                    Delete selected
                  </button>
                </>
              )}
            </div>
            <ul className="divide-y divide-zinc-800">
              {artifacts.map((artifact) => (
                <li key={artifact.id} className="flex items-start gap-2 px-3 py-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    disabled={deleting}
                    checked={checked.has(artifact.id)}
                    onChange={() => toggle(artifact.id)}
                    aria-label={`Select ${artifact.title}`}
                  />
                  <button
                    type="button"
                    onClick={() => setSelectedId(artifact.id)}
                    className={`min-w-0 flex-1 text-left ${
                      artifact.id === selectedId
                        ? "text-zinc-100"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    <p className="truncate text-sm">{artifact.title}</p>
                    <p className="text-xs text-zinc-600">
                      {WRITER_LABELS[artifact.createdBy]} ·{" "}
                      {new Date(artifact.updatedAt).toLocaleString()}
                      {artifact.untrusted && (
                        <span
                          className="ml-1 text-amber-500"
                          title="May contain text from a web page, ticket or message, not only from you"
                        >
                          · untrusted
                        </span>
                      )}
                    </p>
                  </button>
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={() => void removeOne(artifact.id)}
                    className="text-zinc-600 hover:text-red-400 disabled:opacity-50"
                    title="Delete"
                    aria-label={`Delete ${artifact.title}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="min-w-0 flex-1 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
            {!selected ? (
              <p className="text-sm text-zinc-600">Pick an artifact to read it.</p>
            ) : artifactRes.loading ? (
              <LoadingIndicator label="Loading…" />
            ) : artifactRes.data ? (
              <>
                <div className="flex items-start gap-2">
                  <h2 className="mr-auto text-base font-semibold text-zinc-100">
                    {artifactRes.data.title}
                  </h2>
                  <button
                    type="button"
                    onClick={() => requestOpenArtifact(selected.id)}
                    className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    Open beside chat
                  </button>
                </div>
                <p className="mb-2 text-xs text-zinc-500">
                  Source: {WRITER_LABELS[artifactRes.data.createdBy]}
                </p>
                {markdownBody}
              </>
            ) : null}
            {artifactRes.error && <p className="text-sm text-red-400">{artifactRes.error}</p>}
          </div>
        </div>
      )}

      {listRes.error && <p className="text-sm text-red-400">{listRes.error}</p>}
      {deleteError && (
        <p role="alert" className="text-sm text-red-400">
          {deleteError}
        </p>
      )}
    </div>
  );
}
