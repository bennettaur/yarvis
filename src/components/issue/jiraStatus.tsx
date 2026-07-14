/**
 * Shared rendering for a JIRA workflow status, coloured by its category so a
 * row's state reads at a glance: grey for to-do, blue for in-progress, green for
 * done. Used by both the JIRA list rows and the detail view.
 */

/** Tailwind classes for a status pill, keyed by JIRA status category. */
export function statusCategoryClasses(category: string | undefined): string {
  switch (category) {
    case "done":
      return "bg-emerald-900 text-emerald-200";
    case "in_progress":
      return "bg-sky-900 text-sky-200";
    default:
      return "bg-zinc-700 text-zinc-300"; // "todo" and anything unknown
  }
}

export function StatusBadge({ name, category }: { name: string; category: string | undefined }) {
  if (!name) return null;
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${statusCategoryClasses(category)}`}
    >
      {name}
    </span>
  );
}
