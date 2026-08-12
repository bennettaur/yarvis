import { useEffect, useRef } from "react";
import type { FindController } from "../../lib/find/useFind";

/**
 * The find-on-page bar: a floating search field pinned to the top-right of the
 * content region, in the place a browser puts its own. It owns no matching
 * logic — {@link FindController} does — and renders nothing while closed.
 *
 * Enter steps forward through the matches and Shift+Enter back, so the whole
 * search runs from the field without reaching for the buttons.
 */
export default function FindBar({ find }: { find: FindController }) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Cmd+F on an already-open bar re-focuses and selects, so the shortcut always
  // means "start a new search" rather than doing nothing the second time.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusToken is the trigger
  useEffect(() => {
    if (!find.open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [find.open, find.focusToken]);

  if (!find.open) return null;

  const status =
    find.query === ""
      ? ""
      : find.count === 0
        ? "No results"
        : `${find.activeIndex + 1}/${find.count}${find.truncated ? "+" : ""}`;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) find.previous();
      else find.next();
    } else if (e.key === "Escape") {
      e.preventDefault();
      find.close();
    }
  };

  return (
    <search
      aria-label="Find on page"
      className="fixed right-4 top-14 z-40 flex items-center gap-1 border border-zinc-700 bg-zinc-900 px-2 py-1.5 shadow-2xl"
    >
      <input
        ref={inputRef}
        value={find.query}
        onChange={(e) => find.setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find on page…"
        aria-label="Find on page"
        className="w-56 border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 placeholder:text-zinc-600"
      />
      <span
        role="status"
        className="w-20 shrink-0 text-right text-xs tabular-nums text-zinc-500"
        // The count changes on every keystroke; announcing each one would talk
        // over the typing.
        aria-live="off"
      >
        {status}
      </span>
      <BarButton
        label={find.caseSensitive ? "Match case: on" : "Match case: off"}
        onClick={find.toggleCaseSensitive}
        pressed={find.caseSensitive}
      >
        Aa
      </BarButton>
      <BarButton label="Previous match" onClick={find.previous}>
        ↑
      </BarButton>
      <BarButton label="Next match" onClick={find.next}>
        ↓
      </BarButton>
      <BarButton label="Close find" onClick={find.close}>
        ✕
      </BarButton>
    </search>
  );
}

function BarButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`shrink-0 border border-zinc-700 px-1.5 py-1 text-xs hover:bg-zinc-800 ${
        pressed ? "bg-indigo-600/30 text-indigo-200" : "text-zinc-400"
      }`}
    >
      {children}
    </button>
  );
}
