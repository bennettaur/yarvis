import { XIcon } from "lucide-react";
import { Component, lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { type Artifact, getArtifact, subscribeArtifact } from "../../lib/artifacts";
import { type DisplayError, formatError } from "../../lib/errors";
import ErrorNotice from "../ErrorNotice";
import LoadingIndicator from "../LoadingIndicator";
import Markdown from "../Markdown";

const ArtifactDiagram = lazy(() => import("./ArtifactDiagram"));

/** Keeps a diagram that fails to draw, or a chunk that won't load, from taking the chat down with it. */
class DiagramBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[artifacts] diagram failed:", error);
  }

  render() {
    if (this.state.failed) {
      return <p className="p-4 text-xs text-red-400">The diagram could not be drawn.</p>;
    }
    return this.props.children;
  }
}

/**
 * Follows one artifact: reads it, then re-reads it on each change the sidecar
 * signals. A signal that lands while a read is in flight queues one more read
 * rather than one per signal, so a burst of agent writes costs two fetches.
 */
function useLiveArtifact(id: string) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [deleted, setDeleted] = useState(false);

  useEffect(() => {
    setArtifact(null);
    setError(null);
    setDeleted(false);
    let cancelled = false;
    let inFlight = false;
    let again = false;

    const load = async () => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      try {
        do {
          again = false;
          const next = await getArtifact(id);
          if (cancelled) return;
          setArtifact(next);
          setError(null);
        } while (again && !cancelled);
      } catch (e) {
        if (!cancelled) setError(formatError(e));
      } finally {
        inFlight = false;
      }
    };

    void load();
    const unsubscribe = subscribeArtifact(id, {
      onChange: () => void load(),
      onDeleted: () => {
        if (!cancelled) setDeleted(true);
      },
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [id]);

  return { artifact, error, deleted };
}

/**
 * An artifact shown beside a chat, so the user can read what the agent wrote
 * (or watch a diagram change) while still talking to it. Markdown renders as
 * the chat does; a diagram is drawn in Excalidraw.
 */
export default function ArtifactPane({ id, onClose }: { id: string; onClose: () => void }) {
  const { artifact, error, deleted } = useLiveArtifact(id);

  let body: ReactNode;
  if (deleted) {
    body = <p className="p-4 text-sm text-zinc-500">This artifact was deleted.</p>;
  } else if (error && !artifact) {
    body = <ErrorNotice error={error} className="m-4" />;
  } else if (!artifact) {
    body = <LoadingIndicator label="Loading the artifact…" className="p-4 text-sm text-zinc-500" />;
  } else if (artifact.format === "excalidraw") {
    body = (
      <DiagramBoundary>
        <Suspense
          fallback={
            <LoadingIndicator label="Loading the diagram…" className="p-4 text-xs text-zinc-500" />
          }
        >
          <ArtifactDiagram content={artifact.content} />
        </Suspense>
      </DiagramBoundary>
    );
  } else {
    body = (
      <div className="h-full overflow-y-auto px-5 py-4">
        {artifact.content.trim() ? (
          // In-app links only when the user's own chat wrote it: an untrusted
          // artifact's links are third-party text, and go where they say.
          <Markdown allowAppLinks={!artifact.untrusted}>{artifact.content}</Markdown>
        ) : (
          <p className="text-sm text-zinc-500">Nothing written yet.</p>
        )}
      </div>
    );
  }

  return (
    <section
      aria-label={artifact ? `Artifact: ${artifact.title}` : "Artifact"}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-zinc-900/50"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">
          {artifact?.title ?? "Artifact"}
        </h2>
        {artifact?.untrusted && (
          <span
            title="Something other than you may have shaped this text, such as a web page or a heads-down pass."
            className="rounded border border-amber-800/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-400"
          >
            untrusted
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close artifact"
          title="Close artifact"
          className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        >
          <XIcon className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1">{body}</div>
    </section>
  );
}
