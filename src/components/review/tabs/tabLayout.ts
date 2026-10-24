import { reorderTabs } from "../../shell/terminalTabs/reorderTabs";
import { type DynamicTabKind, type StaticTabKind, type TabSpec, tabId } from "./types";

/**
 * The open tabs of a review workspace: one group, or two side by side. Pure
 * data and functions, like the terminal surface's `paneTree`, so the rules —
 * a tab is open at most once across both groups, static tabs lead the strip in
 * a fixed order, closing the last tab of a group folds the split — are tested
 * without mounting editors.
 */

export interface TabGroup {
  /**
   * Stays with the group for its life, so a view keyed on it keeps the
   * group's editors mounted when the other group appears or folds away.
   */
  key: GroupKey;
  tabs: TabSpec[];
  activeId: string | null;
}

export type GroupKey = "a" | "b";

/** A new, empty group whose key the existing one isn't using. */
function newGroup(existing: TabGroup[]): TabGroup {
  return { key: existing.some((g) => g.key === "a") ? "b" : "a", tabs: [], activeId: null };
}

export interface TabLayout {
  /** One group, or two when split. Never empty. */
  groups: TabGroup[];
  /** The group the keyboard and the left nav open into. */
  focusedGroup: number;
  /** The first group's share of the width while split. */
  ratio: number;
}

export const STATIC_ORDER: StaticTabKind[] = [
  "description",
  "reviewers",
  "checks",
  "comments",
  "since-review",
  "guide",
  "verification",
  "mutation",
];

const DYNAMIC_KINDS: ReadonlySet<string> = new Set<DynamicTabKind>([
  "diff",
  "file",
  "since-file",
  "commit",
]);

export const isStaticTab = (t: TabSpec): boolean => !DYNAMIC_KINDS.has(t.kind);

const staticRank = (t: TabSpec): number =>
  isStaticTab(t) ? STATIC_ORDER.indexOf(t.kind as StaticTabKind) : STATIC_ORDER.length;

/** Static tabs first, by kind; everything else keeps the order the user gave it. */
function normalize(tabs: TabSpec[]): TabSpec[] {
  // Array.prototype.sort is stable, so equal ranks keep their relative order.
  return [...tabs].sort((a, b) => staticRank(a) - staticRank(b));
}

export function emptyLayout(): TabLayout {
  return { groups: [newGroup([])], focusedGroup: 0, ratio: 0.5 };
}

export function findTab(layout: TabLayout, id: string): { group: number; index: number } | null {
  for (let group = 0; group < layout.groups.length; group++) {
    const index = layout.groups[group]!.tabs.findIndex((t) => tabId(t) === id);
    if (index >= 0) return { group, index };
  }
  return null;
}

/** The tab showing in the focused group, if any. */
export function activeTab(layout: TabLayout): TabSpec | null {
  const group = layout.groups[layout.focusedGroup];
  return group?.tabs.find((t) => tabId(t) === group.activeId) ?? null;
}

function withGroup(layout: TabLayout, index: number, group: TabGroup): TabLayout {
  return { ...layout, groups: layout.groups.map((g, i) => (i === index ? group : g)) };
}

/**
 * Opens `spec`, or focuses it where it is already open. A file or diff that is
 * open already takes a new `revealLine` with a bumped `revealNonce`, so asking
 * for the same line again scrolls there again. A new tab goes into `group`
 * (the focused one by default); a second group is created when asked for and
 * missing.
 */
export function openTab(layout: TabLayout, spec: TabSpec, group?: number): TabLayout {
  const id = tabId(spec);
  const found = findTab(layout, id);
  if (found) {
    const g = layout.groups[found.group]!;
    const old = g.tabs[found.index]!;
    const next =
      "revealLine" in spec && spec.revealLine !== undefined
        ? { ...spec, revealNonce: ("revealNonce" in old ? (old.revealNonce ?? 0) : 0) + 1 }
        : old;
    const tabs = g.tabs.map((t, i) => (i === found.index ? next : t));
    return {
      ...withGroup(layout, found.group, { ...g, tabs, activeId: id }),
      focusedGroup: found.group,
    };
  }
  let target = group ?? layout.focusedGroup;
  let next = layout;
  if (target >= layout.groups.length) {
    next = { ...layout, groups: [...layout.groups, newGroup(layout.groups)] };
    target = next.groups.length - 1;
  }
  const g = next.groups[target]!;
  return {
    ...withGroup(next, target, { ...g, tabs: normalize([...g.tabs, spec]), activeId: id }),
    focusedGroup: target,
  };
}

export function focusTab(layout: TabLayout, id: string): TabLayout {
  const found = findTab(layout, id);
  if (!found) return layout;
  const g = layout.groups[found.group]!;
  return { ...withGroup(layout, found.group, { ...g, activeId: id }), focusedGroup: found.group };
}

/** Drops empty groups (keeping at least one) and keeps the focus on a real group. */
function foldEmpty(layout: TabLayout): TabLayout {
  const groups = layout.groups.filter((g) => g.tabs.length > 0);
  if (groups.length === layout.groups.length) return layout;
  if (groups.length === 0) return { ...layout, groups: [newGroup([])], focusedGroup: 0 };
  return { ...layout, groups, focusedGroup: Math.min(layout.focusedGroup, groups.length - 1) };
}

/**
 * Closes a tab. Closing the one showing shows its right-hand neighbour, or
 * its left when it was last, as editors do.
 */
export function closeTab(layout: TabLayout, id: string): TabLayout {
  const found = findTab(layout, id);
  if (!found) return layout;
  const g = layout.groups[found.group]!;
  const tabs = g.tabs.filter((_, i) => i !== found.index);
  let activeId = g.activeId;
  if (activeId === id) {
    const neighbour = tabs[found.index] ?? tabs[found.index - 1];
    activeId = neighbour ? tabId(neighbour) : null;
  }
  return foldEmpty(withGroup(layout, found.group, { ...g, tabs, activeId }));
}

/** Shows the next (1) or previous (-1) tab of the focused group, wrapping round. */
export function cycleTab(layout: TabLayout, dir: 1 | -1): TabLayout {
  const g = layout.groups[layout.focusedGroup];
  if (!g || g.tabs.length === 0) return layout;
  const index = g.tabs.findIndex((t) => tabId(t) === g.activeId);
  const next = g.tabs[(Math.max(index, 0) + dir + g.tabs.length) % g.tabs.length]!;
  return withGroup(layout, layout.focusedGroup, { ...g, activeId: tabId(next) });
}

/**
 * Moves a tab into `group`, splitting when that group doesn't exist yet, and
 * shows it there. `beforeId` places it in front of another tab of that group;
 * a static tab still lands in its fixed place.
 */
export function moveTab(
  layout: TabLayout,
  id: string,
  group: number,
  beforeId?: string,
): TabLayout {
  const found = findTab(layout, id);
  if (!found) return layout;
  if (found.group === group) {
    if (!beforeId || beforeId === id) return focusTab(layout, id);
    return focusTab(reorderInGroup(layout, group, id, beforeId, "before"), id);
  }
  const source = layout.groups[found.group]!;
  // Splitting a group's only tab off would leave that group empty beside it.
  if (group >= layout.groups.length && source.tabs.length === 1) return focusTab(layout, id);
  const spec = source.tabs[found.index]!;
  // Removing first can fold the source group away and shift the target's index.
  const sourceRemoved = closeTab(layout, id);
  const folded = sourceRemoved.groups.length < layout.groups.length;
  let target = folded && found.group < group ? group - 1 : group;
  let next = sourceRemoved;
  if (target >= next.groups.length) {
    next = { ...next, groups: [...next.groups, newGroup(next.groups)] };
    target = next.groups.length - 1;
  }
  const g = next.groups[target]!;
  const at = beforeId ? g.tabs.findIndex((t) => tabId(t) === beforeId) : -1;
  const tabs = at >= 0 ? [...g.tabs.slice(0, at), spec, ...g.tabs.slice(at)] : [...g.tabs, spec];
  return {
    ...withGroup(next, target, { ...g, tabs: normalize(tabs), activeId: id }),
    focusedGroup: target,
  };
}

/** Moves the focused group's tab to the other group: the split-view toggle. */
export function moveActiveToOtherGroup(layout: TabLayout): TabLayout {
  const g = layout.groups[layout.focusedGroup];
  if (!g?.activeId) return layout;
  return moveTab(layout, g.activeId, layout.focusedGroup === 0 ? 1 : 0);
}

export function reorderInGroup(
  layout: TabLayout,
  group: number,
  dragId: string,
  targetId: string,
  position: "before" | "after",
): TabLayout {
  const g = layout.groups[group];
  if (!g) return layout;
  const byId = g.tabs.map((spec) => ({ id: tabId(spec), spec }));
  const moved = reorderTabs(byId, dragId, targetId, position);
  if (moved === byId) return layout;
  return withGroup(layout, group, { ...g, tabs: normalize(moved.map((t) => t.spec)) });
}

export function setFocusedGroup(layout: TabLayout, group: number): TabLayout {
  return group < layout.groups.length && group !== layout.focusedGroup
    ? { ...layout, focusedGroup: group }
    : layout;
}

export function setRatio(layout: TabLayout, ratio: number): TabLayout {
  return { ...layout, ratio };
}

/** Drops the tabs of PRs no longer in the workspace. */
export function pruneTabs(layout: TabLayout, prIds: ReadonlySet<string>): TabLayout {
  let next = layout;
  for (const g of layout.groups) {
    for (const t of g.tabs) if (!prIds.has(t.prId)) next = closeTab(next, tabId(t));
  }
  return next;
}

// --- Persistence --------------------------------------------------------------

export const layoutStorageKey = (workspaceId: string) => `yarvis.review.tabs.${workspaceId}`;

const KINDS = new Set<string>([...STATIC_ORDER, ...DYNAMIC_KINDS]);

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function parseSpec(raw: unknown): TabSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string" || !KINDS.has(r.kind) || typeof r.prId !== "string") return null;
  if (r.kind === "diff" || r.kind === "file") {
    if (typeof r.path !== "string" || !r.path) return null;
    return { kind: r.kind, prId: r.prId, path: r.path };
  }
  if (r.kind === "since-file") {
    if (typeof r.path !== "string" || !r.path || typeof r.from !== "string" || !SHA.test(r.from)) {
      return null;
    }
    return { kind: "since-file", prId: r.prId, path: r.path, from: r.from };
  }
  if (r.kind === "commit") {
    if (typeof r.sha !== "string" || !SHA.test(r.sha)) return null;
    return {
      kind: "commit",
      prId: r.prId,
      sha: r.sha,
      ...(typeof r.subject === "string" ? { subject: r.subject.slice(0, 200) } : {}),
    };
  }
  return { kind: r.kind as StaticTabKind, prId: r.prId };
}

/**
 * Reads a stored layout, keeping what is well-formed. Anything else — an older
 * shape, a hand-edited value — gives an empty layout rather than an error, since
 * losing the open tabs costs a click and a broken view costs the workspace.
 */
export function parseLayout(raw: string | null): TabLayout {
  if (!raw) return emptyLayout();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return emptyLayout();
  }
  if (!value || typeof value !== "object") return emptyLayout();
  const v = value as Record<string, unknown>;
  const groupsRaw = Array.isArray(v.groups) ? v.groups.slice(0, 2) : [];
  const seen = new Set<string>();
  const groups: TabGroup[] = [];
  for (const graw of groupsRaw) {
    const g = (graw ?? {}) as Record<string, unknown>;
    const tabs: TabSpec[] = [];
    for (const t of Array.isArray(g.tabs) ? g.tabs : []) {
      const spec = parseSpec(t);
      if (!spec || seen.has(tabId(spec))) continue;
      seen.add(tabId(spec));
      tabs.push(spec);
    }
    if (tabs.length === 0) continue;
    const ids = tabs.map(tabId);
    const activeId =
      typeof g.activeId === "string" && ids.includes(g.activeId) ? g.activeId : ids[0]!;
    groups.push({ key: groups.length === 0 ? "a" : "b", tabs: normalize(tabs), activeId });
  }
  if (groups.length === 0) return emptyLayout();
  const ratio =
    typeof v.ratio === "number" && v.ratio > 0 && v.ratio < 1 ? v.ratio : emptyLayout().ratio;
  const focused = typeof v.focusedGroup === "number" ? v.focusedGroup : 0;
  return { groups, ratio, focusedGroup: focused >= 0 && focused < groups.length ? focused : 0 };
}

/** What is stored: a jump to a line is a moment, not part of the layout. */
export function serializeLayout(layout: TabLayout): string {
  return JSON.stringify({
    ...layout,
    groups: layout.groups.map((g) => ({
      key: g.key,
      activeId: g.activeId,
      tabs: g.tabs.map((t) =>
        "revealLine" in t || "revealNonce" in t ? { kind: t.kind, prId: t.prId, path: t.path } : t,
      ),
    })),
  });
}

export function loadLayout(workspaceId: string): TabLayout {
  try {
    return parseLayout(localStorage.getItem(layoutStorageKey(workspaceId)));
  } catch {
    return emptyLayout();
  }
}

export function saveLayout(workspaceId: string, layout: TabLayout): void {
  try {
    localStorage.setItem(layoutStorageKey(workspaceId), serializeLayout(layout));
  } catch {
    // Private-mode / quota failures are non-fatal; the tabs just won't come back.
  }
}

/** Forgets a workspace's tabs, once it is archived and won't be opened again. */
export function forgetLayout(workspaceId: string): void {
  try {
    localStorage.removeItem(layoutStorageKey(workspaceId));
  } catch {
    // Nothing to do: storage that can't be written held nothing either.
  }
}

/**
 * The changed file after (1) or before (-1) `current`, wrapping round; the
 * first file when nothing is open. Null when there are none.
 */
export function adjacentPath(paths: string[], current: string | null, dir: 1 | -1): string | null {
  if (paths.length === 0) return null;
  const index = current === null ? -1 : paths.indexOf(current);
  if (index === -1) return dir === 1 ? paths[0]! : paths[paths.length - 1]!;
  return paths[(index + dir + paths.length) % paths.length]!;
}
