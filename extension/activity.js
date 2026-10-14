// A log of what Yarvis asked this browser to do, for the side panel.
//
// It lives in session storage: kept in memory while Chrome runs, never written
// to disk, and gone when the browser quits. Page text is in here, and it should
// not outlive the session any more than the tab does.
//
// Each entry has its own key, with a small index listing them. A change then
// carries one entry to every listener rather than the whole log, and the panel
// only loads an entry's result when someone opens it.

export const INDEX_KEY = "activityIndex";
export const entryKey = (id) => `activity:${id}`;

const MAX_ENTRIES = 50;

/** Per entry, so one huge page can't take the whole log's space. */
export const MAX_RESULT_CHARS = 100_000;

/**
 * Session storage holds 10 MB, shared with the connection status the popup
 * reads. The log keeps well under that, measured in the bytes it actually takes.
 */
export const MAX_LOG_BYTES = 6 * 1024 * 1024;

/** The tool the agent called, for each command the extension answers. */
export const TOOL_FOR_COMMAND = {
  list_tabs: "list_browser_tabs",
  read_page: "read_browser_page",
  list_elements: "list_browser_elements",
  inspect: "inspect_browser_page",
  click: "click_browser_element",
  scroll: "scroll_browser_page",
  navigate: "navigate_browser_tab",
};

/** The result as the panel shows it: pretty JSON, cut to a size storage can hold. */
export function describeResult(reply) {
  const body = reply.ok ? (JSON.stringify(reply.data, null, 2) ?? "") : (reply.error ?? "");
  if (body.length <= MAX_RESULT_CHARS) return { result: body, resultTruncated: false };
  return { result: body.slice(0, MAX_RESULT_CHARS), resultTruncated: true };
}

/** What an entry costs in storage, which counts the JSON's UTF-8 bytes. */
export function storedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * The index after adding `row`: newest first, and cut from the oldest end until
 * it fits both the entry count and the byte budget. Returns the ids to delete.
 */
export function nextIndex(index, row) {
  const kept = [row];
  let bytes = row.bytes;
  const dropped = [];
  for (const existing of index) {
    if (kept.length < MAX_ENTRIES && bytes + existing.bytes <= MAX_LOG_BYTES) {
      kept.push(existing);
      bytes += existing.bytes;
    } else {
      dropped.push(existing.id);
    }
  }
  return { index: kept, dropped };
}

// Writes are chained so two commands finishing together can't drop each other's entry.
let writing = Promise.resolve();

export function recordActivity({ id, at, durationMs, instance, command, ok, data, error }) {
  const { type, ...args } = command ?? {};
  const entry = { args, ...describeResult({ ok, data, error }) };
  const row = {
    id,
    at,
    durationMs,
    instance: instance ?? "",
    tool: TOOL_FOR_COMMAND[type] ?? String(type),
    ok,
    bytes: storedBytes(entry),
  };
  writing = writing
    .then(async () => {
      const current = (await chrome.storage.session.get(INDEX_KEY))[INDEX_KEY] ?? [];
      const { index, dropped } = nextIndex(current, row);
      await chrome.storage.session.remove(dropped.map(entryKey));
      await chrome.storage.session.set({ [entryKey(id)]: entry, [INDEX_KEY]: index });
    })
    .catch(() => {
      // Losing a log line must never fail the command it describes.
    });
  return writing;
}

export async function loadEntry(id) {
  return (await chrome.storage.session.get(entryKey(id)))[entryKey(id)] ?? null;
}

export async function clearActivity() {
  const index = (await chrome.storage.session.get(INDEX_KEY))[INDEX_KEY] ?? [];
  await chrome.storage.session.remove([INDEX_KEY, ...index.map((row) => entryKey(row.id))]);
}
