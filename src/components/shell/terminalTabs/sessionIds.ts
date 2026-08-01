/**
 * The PTY-id ↔ terminal-tab mapping, shared by the surface that owns the tabs
 * and by everything that only holds a session id — chiefly the attention stream,
 * whose items are keyed by the id of the PTY that raised them and which needs to
 * name (and focus, and highlight) the exact tab behind one.
 */

/** Surface key of the standalone Terminal tab. */
export const TERMINAL_SURFACE_KEY = "tab:terminal";

/**
 * Default tab title of a workspace's pinned agent session, and the label used
 * for one whose real title isn't reachable from here. The title is configurable
 * (Settings → Repositories → Agent) but lives in the Rust core, which this
 * module can't read synchronously — so a renamed agent is labelled by its
 * default in attention items. Kept in step with `DEFAULT_AGENT_NAME` in
 * `workspaces/agentTab.ts`, which is the value actually rendered on the tab.
 */
export const DEFAULT_AGENT_TAB_TITLE = "Claude";

/** Where a surface's tab state is persisted. */
export function storageKeyFor(surfaceKey: string): string {
  return `yarvis.terminalTabs.${surfaceKey}`;
}

/** A pane's PTY id: unique across surfaces because the surface key leads it. */
export function sessionId(surfaceKey: string, tabId: string, paneId: string): string {
  return `${surfaceKey}/${tabId}/${paneId}`;
}

export interface TerminalSessionRef {
  surfaceKey: string;
  tabId: string;
  paneId: string;
}

/**
 * Reverses `sessionId`. Returns null for anything that isn't a pane id — a
 * pinned session (`ws-claude:<workspaceId>`), a run script (`ws-run:<repoId>`),
 * or a key from another producer entirely.
 */
export function parseSessionId(id: string): TerminalSessionRef | null {
  const parts = id.split("/");
  if (parts.length !== 3) return null;
  const [surfaceKey, tabId, paneId] = parts;
  if (!surfaceKey || !tabId || !paneId) return null;
  return { surfaceKey, tabId, paneId };
}

/** The two surfaces a user can be sent to in order to see a given session. */
export type AttentionSurface = "terminal" | "workspace";

/**
 * Which surface owns a session id, or null when nothing can display it (an
 * Omni-hosted terminal, a repo run script). Navigation routes on this rather
 * than on an item's workspace: a Claude run started by hand in the standalone
 * Terminal tab picks up a workspace's hook config, so it reports a workspace it
 * doesn't live in. Kept in step with `attention_env` in `src-tauri/src/pty.rs`,
 * which only hands the ingest token to these same surfaces.
 */
export function attentionSurfaceOf(id: string): AttentionSurface | null {
  if (id.startsWith("ws-claude:")) return "workspace";
  const ref = parseSessionId(id);
  if (!ref) return null;
  if (ref.surfaceKey === TERMINAL_SURFACE_KEY) return "terminal";
  return ref.surfaceKey.startsWith("ws:") ? "workspace" : null;
}

/**
 * A human label for a session — the title of the tab it lives in, read from the
 * surface's persisted state. `TerminalTabs` owns that blob but imports this
 * module, so the shape is restated here rather than imported back. Best-effort:
 * an unparseable or unknown id yields null and callers fall back to the item's
 * own title.
 */
export function sessionTabTitle(id: string): string | null {
  if (id.startsWith("ws-claude:")) return DEFAULT_AGENT_TAB_TITLE;
  const ref = parseSessionId(id);
  if (!ref) return null;
  try {
    const raw = localStorage.getItem(storageKeyFor(ref.surfaceKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { tabs?: { id: string; title?: string }[] };
    return parsed.tabs?.find((t) => t.id === ref.tabId)?.title ?? null;
  } catch {
    return null;
  }
}
