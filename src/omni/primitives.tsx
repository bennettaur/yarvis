import { Children, type ReactNode } from "react";
import WidgetFrame from "./WidgetFrame";

/**
 * Layout and text primitives for the Omni canvas. Row / Column / Grid are
 * "splitter" layouts: they fill their parent and divide the space equally
 * among their children, so widgets dropped into them fill their pane. Dynamic
 * spacing/columns use inline styles because Tailwind cannot generate classes
 * from runtime values.
 */

const DEFAULT_GAP = 12;

/** Wrap each child so it claims an equal share of a flex container. */
function equalFlex(children: ReactNode) {
  return Children.map(children, (child) => (
    <div className="min-h-0 min-w-0 flex-1">{child}</div>
  ));
}

export function Row({ gap, children }: { gap?: number; children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 w-full" style={{ gap: gap ?? DEFAULT_GAP }}>
      {equalFlex(children)}
    </div>
  );
}

export function Column({ gap, children }: { gap?: number; children?: ReactNode }) {
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col"
      style={{ gap: gap ?? DEFAULT_GAP }}
    >
      {equalFlex(children)}
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
      className="grid h-full min-h-0 w-full"
      style={{
        gridTemplateColumns: `repeat(${columns ?? 2}, minmax(0, 1fr))`,
        gap: gap ?? DEFAULT_GAP,
      }}
    >
      {Children.map(children, (child) => (
        <div className="min-h-0 min-w-0">{child}</div>
      ))}
    </div>
  );
}

export function Panel({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <WidgetFrame title={title} bodyClassName="p-4">
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
