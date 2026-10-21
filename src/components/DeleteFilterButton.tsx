const LABEL = "Delete this saved filter";

/** The ✕ beside a saved filter's name. Glyph-only, so it carries its own label. */
export default function DeleteFilterButton({ onDelete }: { onDelete: () => void | Promise<void> }) {
  return (
    <button
      type="button"
      onClick={() => void onDelete()}
      title={LABEL}
      aria-label={LABEL}
      className="text-zinc-600 hover:text-red-400"
    >
      ✕
    </button>
  );
}
