import "@excalidraw/excalidraw/index.css";
import { convertToExcalidrawElements, Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import { useMemo } from "react";
import { type PrGuideGraph, toExcalidrawSkeleton } from "../../lib/pr/flowDiagram";

/**
 * The guide's code graph drawn in Excalidraw. Loaded lazily by
 * `PrFlowDiagramSection`: Excalidraw is a large bundle, and most reviews never
 * open the diagram.
 *
 * Read-only: the reader can pan, zoom and export it, but not edit it. Its
 * text comes from an untrusted pull request, so nothing else is offered. View
 * mode stops editing and pasting, and drops are blocked here, since Excalidraw
 * takes them even in view mode and a dropped file can replace the scene.
 */
export default function PrFlowDiagram({ graph }: { graph: PrGuideGraph }) {
  const initialData = useMemo(
    () => ({
      elements: convertToExcalidrawElements(toExcalidrawSkeleton(graph)),
      appState: { viewBackgroundColor: "transparent" },
    }),
    [graph],
  );
  return (
    <div
      className="h-[480px] overflow-hidden rounded border border-zinc-800"
      onDragOverCapture={(e) => e.preventDefault()}
      onDropCapture={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Excalidraw
        initialData={initialData}
        theme="dark"
        viewModeEnabled
        // Zoomed to fit, so a wide graph opens whole rather than cut off at 100%.
        excalidrawAPI={(api) =>
          requestAnimationFrame(() => api.scrollToContent(undefined, { fitToContent: true }))
        }
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
      >
        {/* In place of the default menu, which links out to Excalidraw's site and socials. */}
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
        </MainMenu>
      </Excalidraw>
    </div>
  );
}
