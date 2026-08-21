import { useEffect } from "react";
import { formatChord, SHORTCUT_GROUPS } from "./shortcuts";

/**
 * The keyboard cheat sheet: every shortcut in {@link SHORTCUT_GROUPS}, grouped
 * by where it applies. Opened from the nav rail or with Cmd+/, and closed by Esc
 * or a click outside, matching the other overlays.
 */
export default function ShortcutsOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
      {/* Clicking anywhere outside the panel closes it; a button keeps that
          keyboard-accessible, matching the Omni Chat overlay. */}
      <button
        type="button"
        aria-label="Close keyboard shortcuts"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/40"
      />
      <div className="relative z-10 flex max-h-[76vh] w-[720px] max-w-[92vw] flex-col gap-3 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-zinc-100 shadow-2xl">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-300">Keyboard shortcuts</span>
          <span className="ml-auto text-xs text-zinc-500">Esc to close</span>
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} className="flex flex-col gap-1.5">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {group.title}
              </h2>
              {group.shortcuts.map((shortcut) => (
                <div key={shortcut.description} className="flex items-baseline gap-3">
                  <kbd className="shrink-0 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-200">
                    {formatChord(shortcut.keys)}
                  </kbd>
                  <span className="text-xs text-zinc-400">{shortcut.description}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
