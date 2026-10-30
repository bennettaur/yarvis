import "@excalidraw/excalidraw/index.css";
import { convertToExcalidrawElements, Excalidraw } from "@excalidraw/excalidraw";
import { useMemo } from "react";
import { type PrGuideGraph, toExcalidrawSkeleton } from "../../lib/pr/flowDiagram";

/**
 * The guide's code graph drawn in Excalidraw. Loaded lazily by
 * `PrFlowDiagramSection`: Excalidraw is a large bundle, and most reviews never
 * open the diagram.
 *
 * Edits stay in this view. The diagram is drawn fresh from the stored graph
 * each time it opens, so rearranging boxes is a way to read it, not a change to
 * save.
 */
export default function PrFlowDiagram({ graph }: { graph: PrGuideGraph }) {
  const initialData = useMemo(
    () => ({
      elements: convertToExcalidrawElements(
        toExcalidrawSkeleton(graph) as Parameters<typeof convertToExcalidrawElements>[0],
      ),
      appState: { viewBackgroundColor: "transparent" },
      scrollToContent: true,
    }),
    [graph],
  );
  return (
    <div className="h-[480px] overflow-hidden rounded border border-zinc-800">
      <Excalidraw
        initialData={initialData}
        theme="dark"
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
      />
    </div>
  );
}
