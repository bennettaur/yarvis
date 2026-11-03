import "@excalidraw/excalidraw/index.css";
import { convertToExcalidrawElements, Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { diagramToSkeleton, parseDiagram } from "../../lib/artifactDiagram";

function toElements(content: string) {
  // Ids kept, so a redraw after the agent's edit updates elements rather than replacing them.
  return convertToExcalidrawElements(diagramToSkeleton(parseDiagram(content)), {
    regenerateIds: false,
  });
}

/** Excalidraw's main menu: its trigger button and the dropdown it opens. */
const inMenu = (target: EventTarget) =>
  target instanceof Element && target.closest(".main-menu-trigger, .dropdown-menu") !== null;

/**
 * A diagram artifact drawn in Excalidraw, redrawn each time the agent changes
 * it. Loaded lazily by `ArtifactPane`, since Excalidraw is a large bundle.
 *
 * View-only: the reader can pan, zoom and export. The agent owns the diagram,
 * so an edit here would be overwritten by its next change. Drops are blocked
 * too, since Excalidraw takes them even in view mode and a dropped file can
 * replace the scene.
 *
 * It follows the drawing with the viewport, zooming to fit after each change,
 * until the reader pans or zooms it themselves, on the canvas or with the zoom
 * buttons. Opening the menu to save an image doesn't count.
 */
export default function ArtifactDiagram({ content }: { content: string }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const readerMoved = useRef(false);
  // Only the first content seeds the scene; later content arrives through updateScene.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seeded once on mount
  const initialData = useMemo(
    () => ({ elements: toElements(content), appState: { viewBackgroundColor: "transparent" } }),
    [],
  );

  useEffect(() => {
    if (!api) return;
    api.updateScene({ elements: toElements(content) });
    if (readerMoved.current) return;
    const frame = requestAnimationFrame(() =>
      api.scrollToContent(undefined, { fitToContent: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [api, content]);

  return (
    <div
      className="h-full overflow-hidden"
      onPointerDownCapture={(e) => {
        if (!inMenu(e.target)) readerMoved.current = true;
      }}
      onWheelCapture={(e) => {
        if (!inMenu(e.target)) readerMoved.current = true;
      }}
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
        excalidrawAPI={setApi}
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
