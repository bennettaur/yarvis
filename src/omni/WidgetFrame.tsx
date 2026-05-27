import type { ReactNode } from "react";

/**
 * Height floor for a widget pane (px). A pane fills its slot when there's room
 * and keeps this usable height when the canvas scrolls a tall stack. Shared
 * with the layout primitives' grid auto-rows.
 */
export const MIN_PANE_PX = 280;

/**
 * Shared bordered, optionally-titled container for catalog widgets. Fills its
 * cell and scrolls its body, so it composes inside the filling layout
 * primitives (Row / Column / Grid). Flat edges to match the desktop shell.
 *
 * `name` is the catalog component type, shown as a small badge in the top-right
 * corner so a generated Omni layout is legible at a glance — which block is
 * which widget.
 */
export default function WidgetFrame({
  title,
  name,
  height,
  bodyClassName = "p-1.5",
  children,
}: {
  title?: string;
  name?: string;
  /** Fixed height in px. When set, the frame keeps this height and scrolls its
   *  own body instead of filling/sharing the pane — so several frames can be
   *  scrolled independently. Unset, it fills its pane down to MIN_PANE_PX. */
  height?: number;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex w-full flex-col border border-indigo-700 bg-zinc-900/40 ${
        height ? "shrink-0" : "h-full"
      }`}
      style={height ? { height } : { minHeight: MIN_PANE_PX }}
    >
      {(title || name) && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-indigo-800 px-2 py-1">
          <span className="truncate text-xs font-medium uppercase tracking-wide text-zinc-400">
            {title}
          </span>
          {name && (
            <span className="shrink-0 rounded bg-indigo-950 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300">
              {name}
            </span>
          )}
        </div>
      )}
      <div className={`min-h-0 flex-1 overflow-auto ${bodyClassName}`}>{children}</div>
    </div>
  );
}
