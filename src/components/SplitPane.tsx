import { type ReactNode, useCallback, useRef, useState } from "react";

/**
 * "horizontal" = children sit side-by-side with a vertical divider you drag
 * left/right; "vertical" = children are stacked with a horizontal divider you
 * drag up/down. Named after the axis the children flow along, matching CSS
 * flex-direction rather than the divider's own orientation.
 */
export type SplitOrientation = "horizontal" | "vertical";

/**
 * Two panes separated by a draggable divider. Controlled: the caller owns
 * `ratio` (the fraction of the main axis given to the first pane, 0–1) and
 * persists it however it likes via `onRatioChange`. The second pane always
 * fills the remainder, so the two stay flush regardless of container size.
 *
 * Dragging uses pointer capture on the divider, so the drag keeps tracking even
 * as the pointer passes over a child that would otherwise swallow the events
 * (an xterm canvas, an iframe) — no global listeners or overlay needed.
 */
export default function SplitPane({
  orientation,
  ratio,
  onRatioChange,
  first,
  second,
  minRatio = 0.1,
  className = "",
}: {
  orientation: SplitOrientation;
  ratio: number;
  onRatioChange: (ratio: number) => void;
  first: ReactNode;
  second: ReactNode;
  /** Smallest fraction either pane may shrink to, clamping the drag. */
  minRatio?: number;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const horizontal = orientation === "horizontal";

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const el = containerRef.current;
      if (!el || !(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
      const rect = el.getBoundingClientRect();
      const raw = horizontal
        ? (e.clientX - rect.left) / rect.width
        : (e.clientY - rect.top) / rect.height;
      if (!Number.isFinite(raw)) return;
      onRatioChange(Math.min(1 - minRatio, Math.max(minRatio, raw)));
    },
    [horizontal, minRatio, onRatioChange],
  );

  const clamped = Math.min(1 - minRatio, Math.max(minRatio, ratio));

  return (
    <div
      ref={containerRef}
      className={`flex min-h-0 min-w-0 ${horizontal ? "flex-row" : "flex-col"} ${className}`}
    >
      <div className="min-h-0 min-w-0 shrink-0 grow-0" style={{ flexBasis: `${clamped * 100}%` }}>
        {first}
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-driven divider; keyboard resize isn't a workflow here */}
      <div
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          setDragging(false);
        }}
        onPointerCancel={() => setDragging(false)}
        aria-hidden="true"
        className={`group relative shrink-0 ${
          horizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize"
        } ${dragging ? "bg-indigo-500" : "bg-zinc-800 hover:bg-zinc-600"}`}
      >
        {/* Invisible hit area wider than the 1px seam so the divider is easy to grab. */}
        <div
          className={`absolute ${
            horizontal ? "inset-y-0 -left-1 -right-1" : "inset-x-0 -top-1 -bottom-1"
          }`}
        />
      </div>
      <div className="min-h-0 min-w-0 flex-1">{second}</div>
    </div>
  );
}

/**
 * A split ratio persisted in localStorage under `key`. Falls back to `initial`
 * when nothing valid is stored, so a fresh install or a corrupted value both
 * open at the default size.
 */
export function usePersistedRatio(key: string, initial: number): [number, (ratio: number) => void] {
  const [ratio, setRatio] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(key);
      const n = raw ? Number.parseFloat(raw) : Number.NaN;
      return Number.isFinite(n) ? n : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (r: number) => {
      setRatio(r);
      try {
        localStorage.setItem(key, String(r));
      } catch {
        // Private-mode / quota failures are non-fatal; the size just won't stick.
      }
    },
    [key],
  );
  return [ratio, set];
}
