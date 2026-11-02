import { Component, lazy, type ReactNode, Suspense, useState } from "react";
import type { PrGuide } from "../../lib/pr/guide";
import LoadingIndicator from "../LoadingIndicator";

const PrFlowDiagram = lazy(() => import("./PrFlowDiagram"));

/**
 * Keeps a diagram that fails, a chunk that won't load or Excalidraw throwing
 * on odd model-written data, from taking the rest of the review down with it.
 */
class DiagramBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[pr] flow diagram failed:", error);
  }

  render() {
    if (this.state.failed) {
      return <p className="text-xs text-red-400">The diagram could not be drawn.</p>;
    }
    return this.props.children;
  }
}

/**
 * A folded section holding the flow diagram of a pull request's guide.
 *
 * The diagram mounts only once the section is opened, unlike a `<details>`,
 * whose children render while it is closed: that would fetch Excalidraw for
 * every review and lay its canvas out at zero size.
 */
export default function PrFlowDiagramSection({ guide }: { guide: PrGuide | null }) {
  const [open, setOpen] = useState(false);
  const graph = guide?.graph;
  if (!graph?.nodes.length) return null;
  const changed = graph.nodes.filter((n) => n.changed).length;

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="mb-2 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-zinc-500"
      >
        <span className={`text-zinc-600 transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
        Flow diagram
        <span className="font-normal normal-case text-zinc-600">
          · {graph.nodes.length} pieces of code, {changed} changed
          {guide?.stale ? " · out of date" : ""}
        </span>
      </button>
      {open && (
        <p className="mb-2 text-xs text-zinc-500">
          Drawn by the review agent from what it read in this pull request. It can be incomplete or
          wrong, and its labels come from code the author wrote.
        </p>
      )}
      {open && (
        <DiagramBoundary>
          <Suspense
            fallback={
              <LoadingIndicator label="Loading the diagram…" className="text-xs text-zinc-500" />
            }
          >
            <PrFlowDiagram graph={graph} />
          </Suspense>
        </DiagramBoundary>
      )}
    </section>
  );
}
