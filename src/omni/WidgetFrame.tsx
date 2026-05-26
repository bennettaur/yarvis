import type { ReactNode } from "react";

/**
 * Shared bordered, optionally-titled container for catalog widgets. Fills its
 * cell and scrolls its body, so it composes inside the filling layout
 * primitives (Row / Column / Grid). Flat edges to match the desktop shell.
 */
export default function WidgetFrame({
  title,
  bodyClassName = "",
  children,
}: {
  title?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col border border-zinc-800 bg-zinc-900/40">
      {title && (
        <div className="shrink-0 border-b border-zinc-800 px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
          {title}
        </div>
      )}
      <div className={`min-h-0 flex-1 overflow-auto ${bodyClassName}`}>{children}</div>
    </div>
  );
}
