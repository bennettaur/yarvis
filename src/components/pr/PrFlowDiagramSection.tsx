import { lazy, Suspense, useState } from "react";
import type { PrGuide } from "../../lib/pr/guide";

const PrFlowDiagram = lazy(() => import("./PrFlowDiagram"));

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
        <Suspense fallback={<p className="text-xs text-zinc-500">Loading the diagram…</p>}>
          <PrFlowDiagram graph={graph} />
        </Suspense>
      )}
    </section>
  );
}
