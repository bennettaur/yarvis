// What the side panel's chat sends, kept apart from the panel's DOM code so it
// can be tested.

/** The sidecar refuses longer values, so they are cut here rather than failing the turn. */
export const MAX_TAB_URL_CHARS = 2_000;
export const MAX_TAB_TITLE_CHARS = 500;
export const MAX_SELECTION_CHARS = 2_000;

/**
 * The tab beside the panel, as the turn's context. Null when there is no tab
 * to describe, so the turn goes without rather than failing.
 */
export function tabContext(tab, selection, profileName) {
  if (tab?.id === undefined || tab.id < 0) return null;
  const context = {
    tabId: tab.id,
    url: (tab.url ?? "").slice(0, MAX_TAB_URL_CHARS),
    title: (tab.title ?? "").slice(0, MAX_TAB_TITLE_CHARS),
    profile: profileName,
  };
  const picked = (selection ?? "").trim();
  if (picked) context.selection = picked.slice(0, MAX_SELECTION_CHARS);
  return context;
}

/** A new chat is titled after its first message, so the chat picker has something to show. */
export function titleFor(message) {
  const line = message.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

export function sessionLabel(session) {
  const when = new Date(session.updatedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${session.title || "Untitled chat"} · ${when}`;
}
