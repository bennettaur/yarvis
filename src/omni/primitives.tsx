import { Children, isValidElement, type ReactNode } from "react";
import WidgetFrame, { MIN_PANE_PX } from "./WidgetFrame";

/**
 * Layout and text primitives for the Omni canvas. Row / Column / Grid fill the
 * canvas and share leftover space among their children when the layout is
 * small, but each widget pane keeps a usable height floor (see WidgetFrame), so
 * stacking many components grows the canvas and scrolls it rather than crushing
 * every pane. Dynamic spacing/columns use inline styles because Tailwind cannot
 * generate classes from runtime values.
 */

const DEFAULT_GAP = 6;

/**
 * The renderer hands us its internal element wrappers, not the rendered widgets
 * — the catalog element (with its `type` and resolved `props`) hangs off the
 * wrapper's `element` prop. This reaches through to inspect it.
 *
 * NOTE: `child.props.element` is an undocumented internal of @json-render's
 * Renderer, so this is a deliberate coupling point. If that wrapper shape ever
 * changes (e.g. a library upgrade), this returns null and panes fall back to
 * equal-flex sizing — a silent layout regression, not a crash. Revisit pane
 * classification here if @json-render is bumped.
 */
function catalogElement(
  child: ReactNode,
): { type?: string; props?: { height?: unknown } } | null {
  if (!isValidElement(child)) return null;
  return (child.props as { element?: { type?: string; props?: { height?: unknown } } })
    .element ?? null;
}

/** Text-like primitives size to their content rather than claiming a pane. */
function isContentSized(child: ReactNode): boolean {
  const type = catalogElement(child)?.type;
  return type === "Heading" || type === "Text" || type === "Divider";
}

/** A widget given an explicit `height` prop manages its own (fixed) height. */
function isFixedHeight(child: ReactNode): boolean {
  return typeof catalogElement(child)?.props?.height === "number";
}

/**
 * Wraps a layout child. Text-like primitives keep their natural height;
 * everything else is a flexible pane that grows to share the space (no
 * `min-h-0`, so it cannot shrink below its content's floor). When stacking
 * vertically, a fixed-height widget keeps exactly its height instead of being
 * stretched to an equal share.
 */
function pane(child: ReactNode, stackable: boolean) {
  if (isContentSized(child)) return <div className="min-w-0">{child}</div>;
  if (stackable && isFixedHeight(child)) {
    return <div className="min-w-0 shrink-0">{child}</div>;
  }
  return <div className="min-w-0 flex-1">{child}</div>;
}

export function Row({ gap, children }: { gap?: number; children?: ReactNode }) {
  return (
    <div className="flex min-h-full w-full" style={{ gap: gap ?? DEFAULT_GAP }}>
      {Children.map(children, (child) => pane(child, false))}
    </div>
  );
}

export function Column({ gap, children }: { gap?: number; children?: ReactNode }) {
  return (
    <div
      className="flex min-h-full w-full flex-col"
      style={{ gap: gap ?? DEFAULT_GAP }}
    >
      {Children.map(children, (child) => pane(child, true))}
    </div>
  );
}

export function Grid({
  columns,
  gap,
  children,
}: {
  columns?: number;
  gap?: number;
  children?: ReactNode;
}) {
  return (
    <div
      className="grid min-h-full w-full"
      style={{
        gridTemplateColumns: `repeat(${columns ?? 2}, minmax(0, 1fr))`,
        gridAutoRows: `minmax(${MIN_PANE_PX}px, 1fr)`,
        gap: gap ?? DEFAULT_GAP,
      }}
    >
      {Children.map(children, (child) => (
        <div className="min-h-0 min-w-0">{child}</div>
      ))}
    </div>
  );
}

export function Panel({
  title,
  name,
  height,
  children,
}: {
  title?: string;
  name?: string;
  height?: number;
  children?: ReactNode;
}) {
  return (
    <WidgetFrame title={title} name={name} height={height}>
      {children}
    </WidgetFrame>
  );
}

export function Heading({ text, level }: { text: string; level?: number }) {
  const size =
    level === 1
      ? "text-xl font-semibold"
      : level === 3
        ? "text-sm font-medium"
        : "text-base font-semibold";
  return <h2 className={`${size} tracking-tight text-zinc-100`}>{text}</h2>;
}

export function Text({ text, muted }: { text: string; muted?: boolean }) {
  return <p className={`text-sm ${muted ? "text-zinc-500" : "text-zinc-300"}`}>{text}</p>;
}

export function Divider() {
  return <hr className="border-zinc-800" />;
}
