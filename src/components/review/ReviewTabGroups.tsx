import { type DragEvent, memo, type ReactNode, useCallback, useRef, useState } from "react";
import { renderTab, TAB_GLYPH, tabTitle, tabTooltip } from "./tabs/registry";
import {
  closeTab,
  focusTab,
  isStaticTab,
  moveTab,
  reorderInGroup,
  setFocusedGroup,
  setRatio,
  type TabGroup,
  type TabLayout,
} from "./tabs/tabLayout";
import {
  type DynamicTabKind,
  type PrColor,
  type TabContext,
  type TabSpec,
  tabId,
} from "./tabs/types";

/** Namespaced so a drop from anything else on the page is ignored. */
const TAB_DRAG_MIME = "application/x-yarvis-review-tab";

export interface TabOwner {
  color: PrColor;
  /** "repo#12", shown before titles when the workspace holds more than one PR. */
  label: string;
}

/** A tab id as it can appear in an element id. */
const domId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "-");
export const tabButtonId = (id: string) => `review-tab-${domId(id)}`;
export const tabPanelId = (id: string) => `review-panel-${domId(id)}`;

/** Smallest share of the width either group may be dragged down to. */
const MIN_RATIO = 0.2;

/**
 * A tab's body. Memoised on its spec and its PR's context, so a tab out of
 * sight is left alone while another tab is being used.
 */
const TabBody = memo(function TabBody({ spec, ctx }: { spec: TabSpec; ctx: TabContext }) {
  return <>{renderTab(spec, ctx)}</>;
});

/**
 * The tabbed editor area: one group of tabs, or two side by side. Every open
 * tab stays mounted while hidden, so switching back to a diff keeps its scroll
 * and its editor instead of building both again. The groups are siblings keyed
 * by their own stable key, so splitting, or folding a group away, never
 * remounts the other group's editors. Tabs drag within a strip to reorder,
 * onto the other group to move, and onto the right half of a lone group to
 * split.
 */
export default function ReviewTabGroups({
  layout,
  onChange,
  contextFor,
  ownerOf,
  showOwner,
  empty,
}: {
  layout: TabLayout;
  onChange: (update: (layout: TabLayout) => TabLayout) => void;
  /** Null when the PR is no longer in the workspace. */
  contextFor: (prId: string) => TabContext | null;
  ownerOf: (prId: string) => TabOwner | null;
  showOwner: boolean;
  empty: ReactNode;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const split = layout.groups.length > 1;
  const container = useRef<HTMLDivElement>(null);
  const setRatioFromPointer = useCallback(
    (clientX: number) => {
      const rect = container.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const raw = (clientX - rect.left) / rect.width;
      onChange((l) => setRatio(l, Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, raw))));
    },
    [onChange],
  );

  const children: ReactNode[] = [];
  layout.groups.forEach((group, index) => {
    if (index === 1) {
      children.push(<Divider key="divider" onDrag={setRatioFromPointer} />);
    }
    const first = split && index === 0;
    children.push(
      <div
        key={group.key}
        className={`min-h-0 min-w-0 ${first ? "shrink-0 grow-0" : "flex-1"}`}
        style={first ? { flexBasis: `${layout.ratio * 100}%` } : undefined}
      >
        <GroupView
          group={group}
          index={index}
          focused={split && layout.focusedGroup === index}
          canSplitHere={!split}
          dragging={dragging}
          onDragging={setDragging}
          onChange={onChange}
          contextFor={contextFor}
          ownerOf={ownerOf}
          showOwner={showOwner}
          empty={empty}
        />
      </div>,
    );
  });

  return (
    <div ref={container} className="flex h-full min-h-0 min-w-0">
      {children}
    </div>
  );
}

/** The draggable seam between the two groups, held with pointer capture like `SplitPane`'s. */
function Divider({ onDrag }: { onDrag: (clientX: number) => void }) {
  const [active, setActive] = useState(false);
  return (
    <div
      aria-hidden="true"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setActive(true);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) onDrag(e.clientX);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        setActive(false);
      }}
      onPointerCancel={() => setActive(false)}
      className={`relative w-px shrink-0 cursor-col-resize ${
        active ? "bg-indigo-500" : "bg-zinc-800 hover:bg-zinc-600"
      }`}
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}

function GroupView({
  group,
  index,
  focused,
  canSplitHere,
  dragging,
  onDragging,
  onChange,
  contextFor,
  ownerOf,
  showOwner,
  empty,
}: {
  group: TabGroup;
  index: number;
  focused: boolean;
  canSplitHere: boolean;
  dragging: string | null;
  onDragging: (id: string | null) => void;
  onChange: (update: (layout: TabLayout) => TabLayout) => void;
  contextFor: (prId: string) => TabContext | null;
  ownerOf: (prId: string) => TabOwner | null;
  showOwner: boolean;
  empty: ReactNode;
}) {
  const [over, setOver] = useState<{ id: string; side: "before" | "after" } | null>(null);
  const [splitHint, setSplitHint] = useState(false);

  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(TAB_DRAG_MIME);

  const dropOnTab = (e: DragEvent, targetId: string) => {
    const id = e.dataTransfer.getData(TAB_DRAG_MIME);
    setOver(null);
    onDragging(null);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    const side = over?.side ?? "before";
    onChange((l) => {
      const inThisGroup = l.groups[index]?.tabs.some((t) => tabId(t) === id);
      if (inThisGroup) return focusTab(reorderInGroup(l, index, id, targetId, side), id);
      const tabs = l.groups[index]?.tabs ?? [];
      const at = tabs.findIndex((t) => tabId(t) === targetId);
      const before = side === "before" ? targetId : tabs[at + 1] ? tabId(tabs[at + 1]!) : undefined;
      return moveTab(l, id, index, before);
    });
  };

  const dropOnBody = (e: DragEvent) => {
    const id = e.dataTransfer.getData(TAB_DRAG_MIME);
    const toNewGroup = splitHint;
    setSplitHint(false);
    onDragging(null);
    if (!id) return;
    e.preventDefault();
    onChange((l) => moveTab(l, id, toNewGroup ? 1 : index));
  };

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      onPointerDownCapture={() => onChange((l) => setFocusedGroup(l, index))}
    >
      <div
        className={`flex shrink-0 items-stretch overflow-x-auto border-b bg-zinc-950 ${
          focused ? "border-indigo-500/60" : "border-zinc-800"
        }`}
        role="tablist"
        onDragOver={(e) => {
          if (!accepts(e)) return;
          e.preventDefault();
        }}
        onDrop={dropOnBody}
      >
        {group.tabs.map((spec) => {
          const id = tabId(spec);
          const owner = ownerOf(spec.prId);
          const active = group.activeId === id;
          const title = tabTitle(spec);
          const full = tabTooltip(spec);
          const glyph = isStaticTab(spec) ? undefined : TAB_GLYPH[spec.kind as DynamicTabKind];
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: drag handlers on the wrapper; the inner buttons own click and keyboard activation.
            <div
              key={id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_DRAG_MIME, id);
                e.dataTransfer.effectAllowed = "move";
                onDragging(id);
              }}
              onDragEnd={() => {
                onDragging(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                if (!accepts(e)) return;
                e.preventDefault();
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const side = e.clientX < rect.left + rect.width / 2 ? "before" : "after";
                if (over?.id !== id || over.side !== side) setOver({ id, side });
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => dropOnTab(e, id)}
              onAuxClick={(e) => {
                // A middle click closes, as in a browser.
                if (e.button === 1) onChange((l) => closeTab(l, id));
              }}
              className={`group relative flex shrink-0 items-center border-l-2 ${
                owner?.color.border ?? "border-zinc-700"
              } ${
                active
                  ? "bg-zinc-900 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-900/50 hover:text-zinc-200"
              } ${dragging === id ? "opacity-50" : ""}`}
            >
              {over?.id === id && dragging !== id && (
                <span
                  aria-hidden
                  className={`pointer-events-none absolute inset-y-0 w-0.5 bg-indigo-400 ${
                    over.side === "before" ? "-left-0.5" : "-right-0.5"
                  }`}
                />
              )}
              {active && (
                <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-indigo-400" />
              )}
              <button
                type="button"
                role="tab"
                id={tabButtonId(id)}
                aria-controls={tabPanelId(id)}
                aria-selected={active}
                onClick={() => onChange((l) => focusTab(l, id))}
                title={owner ? `${owner.label} · ${full}` : full}
                className="flex max-w-56 items-center gap-1.5 truncate py-1.5 pl-2 pr-1 text-xs"
              >
                {showOwner && owner && (
                  <span className={`shrink-0 font-medium ${owner.color.text}`}>{owner.label}</span>
                )}
                {glyph && <span className={`shrink-0 ${glyph.className}`}>{glyph.glyph}</span>}
                <span className={`truncate ${isStaticTab(spec) ? "" : "font-mono"}`}>{title}</span>
              </button>
              <button
                type="button"
                onClick={() => onChange((l) => closeTab(l, id))}
                aria-label={`Close ${title}`}
                title="Close tab (⌘W)"
                className={`mr-1 rounded px-1 text-sm leading-none text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 ${
                  active ? "" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                }`}
              >
                ×
              </button>
            </div>
          );
        })}
        <div className="min-w-4 flex-1" />
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target for dragged tabs. */}
      <div
        className="relative min-h-0 flex-1"
        onDragOver={(e) => {
          if (!accepts(e)) return;
          e.preventDefault();
          if (!canSplitHere) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const right = e.clientX > rect.left + rect.width / 2;
          if (right !== splitHint) setSplitHint(right);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSplitHint(false);
        }}
        onDrop={dropOnBody}
      >
        {group.tabs.length === 0 && empty}
        {group.tabs.map((spec) => {
          const id = tabId(spec);
          const active = group.activeId === id;
          const ctx = contextFor(spec.prId);
          return (
            <div
              key={id}
              id={tabPanelId(id)}
              role="tabpanel"
              aria-labelledby={tabButtonId(id)}
              className={active ? "h-full" : "hidden"}
            >
              {ctx ? <TabBody spec={spec} ctx={ctx} /> : null}
            </div>
          );
        })}
        {splitHint && dragging && (
          <div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 border-2 border-indigo-500/60 bg-indigo-500/10" />
        )}
      </div>
    </div>
  );
}
