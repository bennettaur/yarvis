/** Styling and helpers shared by the Voice page's sections. */

export const CARD = "rounded-xl border border-zinc-800 bg-zinc-900/50 p-4";

export const FIELD =
  "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500";

export const BUTTON =
  "rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-40";

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
      {hint && <span className="text-xs text-zinc-600">{hint}</span>}
    </label>
  );
}
