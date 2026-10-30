import { useState } from "react";
import {
  type Artifact,
  type ArtifactSummary,
  deleteArtifact,
  getArtifact,
  listArtifacts,
} from "../../lib/artifacts";
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

export default function ArtifactsTab() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const listRes = useCachedResource<ArtifactSummary[]>("memory:artifacts", listArtifacts);
  const artifacts = listRes.data ?? NO_ARTIFACTS;
  const selected = artifacts.find((a) => a.id === selectedId) ?? null;

  // The update time is in the key so an artifact the agent changed since it was
  // last opened is fetched again rather than served from the cache.
  const artifactRes = useCachedResource<Artifact>(
    selected ? `memory:artifact:${selected.id}:${selected.updatedAt}` : null,
    () => getArtifact(selected!.id),
  );

  const remove = async (id: string) => {
    setDeleteError(null);
    try {
      await deleteArtifact(id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (selectedId === id) setSelectedId(null);
    await listRes.refresh();
  };

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
          <ul className="w-64 shrink-0 divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
            {artifacts.map((artifact) => (
              <li key={artifact.id} className="flex items-start gap-2 px-3 py-2">
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
                    {new Date(artifact.updatedAt).toLocaleString()}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => void remove(artifact.id)}
                  className="text-zinc-600 hover:text-red-400"
                  title="Delete"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>

          <div className="min-w-0 flex-1 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
            {!selected ? (
              <p className="text-sm text-zinc-600">Pick an artifact to read it.</p>
            ) : artifactRes.loading ? (
              <LoadingIndicator label="Loading…" />
            ) : artifactRes.data ? (
              <>
                <h2 className="mb-2 text-base font-semibold text-zinc-100">
                  {artifactRes.data.title}
                </h2>
                <Markdown>{artifactRes.data.content}</Markdown>
              </>
            ) : null}
            {artifactRes.error && <p className="text-sm text-red-400">{artifactRes.error}</p>}
          </div>
        </div>
      )}

      {listRes.error && <p className="text-sm text-red-400">{listRes.error}</p>}
      {deleteError && <p className="text-sm text-red-400">{deleteError}</p>}
    </div>
  );
}
