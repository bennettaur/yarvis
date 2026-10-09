import { TITLE_BAR } from "../components/AppWindow";

// The kinds the scenes use, copied from AttentionPanel's `KIND_DOT`, which isn't exported.
const KIND_DOT = {
  permission: "bg-amber-400",
  idle: "bg-amber-400",
  error: "bg-red-500",
  completed: "bg-emerald-500",
} as const;

export interface AttentionRow {
  kind: keyof typeof KIND_DOT;
  title: string;
  tabs: string;
  body: string;
  when: string;
}

const SectionHeader = ({ label, count }: { label: string; count: number }) => (
  <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
    <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</span>
    <span className="text-xs text-zinc-600">{count}</span>
  </div>
);

/**
 * The attention panel from `AttentionPanel`'s markup, sliding in from the
 * right. `slide` runs 0 (off screen) to 1 (open).
 */
export function AttentionPanel({
  rows,
  wip,
  slide,
}: {
  rows: AttentionRow[];
  wip: { kind: string; title: string; subtitle: string }[];
  slide: number;
}) {
  if (slide <= 0) return null;
  return (
    <div className="absolute inset-0 z-50" style={{ top: TITLE_BAR }}>
      <div className="absolute inset-0 bg-black/40" style={{ opacity: slide }} />
      <aside
        className="absolute inset-y-0 right-0 flex w-[420px] flex-col border-l border-zinc-800 bg-zinc-900 shadow-2xl"
        style={{ transform: `translateX(${(1 - slide) * 440}px)` }}
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 px-4">
          <span className="text-sm font-medium text-zinc-200">Attention</span>
          <span className="text-zinc-500">✕</span>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          <SectionHeader label="Needs you now" count={rows.length} />
          <ul className="divide-y divide-zinc-800">
            {rows.map((row) => (
              <li key={row.title} className="group flex items-start gap-3 px-4 py-3">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${KIND_DOT[row.kind]}`} />
                <div className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-zinc-100">{row.title}</span>
                  </div>
                  <div className="truncate text-xs text-zinc-500">{row.tabs}</div>
                  <div className="truncate text-xs text-zinc-400">{row.body}</div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">{row.when}</div>
                </div>
              </li>
            ))}
          </ul>
          <SectionHeader label="In progress" count={wip.length} />
          <ul className="divide-y divide-zinc-800">
            {wip.map((item) => (
              <li key={item.title}>
                <div className="flex w-full items-start gap-3 px-4 py-3 text-left">
                  <span className="mt-0.5 shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                    {item.kind}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-100">{item.title}</span>
                    <span className="block truncate text-xs text-zinc-500">{item.subtitle}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
