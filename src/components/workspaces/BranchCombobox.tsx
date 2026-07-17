import { useEffect, useId, useMemo, useState } from "react";

// An empty branch value means "cut a fresh branch" rather than checking one out.
const NEW_BRANCH_LABEL = "New branch";

type BranchList = string[] | "loading" | "error";

export type BranchOption = { label: string; value: string };

/**
 * Builds the option list for a query: the "New branch" reset followed by the
 * branches matching the typed text (case-insensitive substring). A query equal
 * to the committed value counts as "not searching", so the full list shows once
 * a branch is picked.
 */
export function filterBranches(branches: BranchList, query: string, value: string): BranchOption[] {
  const list = Array.isArray(branches) ? branches : [];
  const normalizedQuery = query.trim().toLowerCase();
  const searching = normalizedQuery !== "" && normalizedQuery !== value.toLowerCase();
  const matches = searching
    ? list.filter((branch) => branch.toLowerCase().includes(normalizedQuery))
    : list;
  return [
    { label: NEW_BRANCH_LABEL, value: "" },
    ...matches.map((branch) => ({ label: branch, value: branch })),
  ];
}

/**
 * A text-filterable branch picker: the user can type to search the repo's
 * remote branches instead of scrolling a plain dropdown. The committed value is
 * always either an existing branch name or "" (the "New branch" default) — the
 * typed text is a search query, not a free-form branch name.
 */
export default function BranchCombobox({
  branches,
  value,
  onChange,
}: {
  branches: BranchList;
  value: string;
  onChange: (value: string) => void;
}) {
  const loading = branches === "loading";
  const errored = branches === "error";

  // `query` holds the text in the input; it diverges from the committed `value`
  // only while the user is actively typing a search.
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // Unique per instance so multiple repos rendering the form don't collide on
  // the same DOM id for the aria-controls / active-descendant wiring.
  const listId = useId();
  const optionId = (index: number) => `${listId}-opt-${index}`;

  // Keep the input showing the committed branch whenever the field isn't being
  // edited, so an external change (or a revert on blur) stays reflected.
  useEffect(() => {
    if (!open) setQuery(value);
  }, [value, open]);

  const options = useMemo(() => filterBranches(branches, query, value), [branches, query, value]);

  // Scroll the highlighted option into view when keyboard navigation moves it
  // past the listbox's fixed-height scroll window.
  useEffect(() => {
    if (open)
      document.getElementById(`${listId}-opt-${highlight}`)?.scrollIntoView({ block: "nearest" });
  }, [open, highlight, listId]);

  const close = () => {
    setOpen(false);
    setQuery(value);
  };

  const commit = (next: string) => {
    onChange(next);
    setQuery(next);
    setOpen(false);
  };

  const openList = () => {
    setOpen(true);
    setHighlight(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      openList();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((index) => Math.min(index + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((index) => Math.max(index - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = options[highlight];
      if (picked) commit(picked.value);
    } else if (e.key === "Escape") {
      close();
    }
  };

  // filterBranches always prepends the "New branch" reset, so a lone option
  // means the query matched none of the available branches.
  const noMatches = options.length === 1;

  return (
    <div className="relative flex-1">
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? optionId(highlight) : undefined}
        value={query}
        disabled={loading || errored}
        placeholder={NEW_BRANCH_LABEL}
        onFocus={openList}
        // Close and revert when focus leaves the field (click-away or Tab-out).
        // Options commit on mousedown with preventDefault, so a pick keeps focus
        // and never triggers this blur.
        onBlur={close}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
        className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm outline-none focus:border-zinc-500 disabled:opacity-60"
      />
      {open && !loading && !errored && (
        <div
          id={listId}
          role="listbox"
          className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-md border border-zinc-700 bg-zinc-800 py-1 shadow-lg"
        >
          {options.map((option, index) => (
            <button
              key={option.value || "__new__"}
              id={optionId(index)}
              type="button"
              role="option"
              aria-selected={option.value === value}
              // Commit on mousedown so it fires before the input's blur.
              onMouseDown={(e) => {
                e.preventDefault();
                commit(option.value);
              }}
              onMouseEnter={() => setHighlight(index)}
              className={`block w-full px-2 py-1 text-left text-sm ${
                index === highlight ? "bg-zinc-700 text-zinc-100" : "text-zinc-300"
              } ${option.value === "" ? "italic text-zinc-400" : ""}`}
            >
              {option.label}
            </button>
          ))}
          {noMatches && <p className="px-2 py-1 text-sm text-zinc-500">No matching branches</p>}
        </div>
      )}
    </div>
  );
}
