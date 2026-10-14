import { clearActivity, INDEX_KEY, loadEntry } from "./activity.js";

const list = document.getElementById("entries");
const empty = document.getElementById("empty");

/**
 * Rows already on screen, by id. A new command adds one row and drops any the
 * log let go of; the rest keep their open state, scroll position and selection.
 */
const rows = new Map();

function block(label, text) {
  const heading = document.createElement("h3");
  heading.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = text;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy";
  copy.textContent = "Copy";
  copy.addEventListener("click", () => navigator.clipboard.writeText(text));
  return [heading, pre, copy];
}

function buildRow(row) {
  const item = document.createElement("li");
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const dot = document.createElement("span");
  dot.className = row.ok ? "dot on" : "dot error";
  dot.title = row.ok ? "Answered" : "Failed";
  const tool = document.createElement("span");
  tool.className = "tool";
  tool.textContent = row.tool;
  const meta = document.createElement("span");
  meta.className = "meta";
  const time = new Date(row.at).toLocaleTimeString();
  meta.textContent = [row.instance, time, `${row.durationMs} ms`].filter(Boolean).join(" · ");
  summary.append(dot, tool, meta);
  details.append(summary);

  // A result can be 100,000 characters, so it is only fetched and laid out when
  // someone opens the row.
  let loaded = false;
  details.addEventListener("toggle", async () => {
    if (!details.open || loaded) return;
    loaded = true;
    const entry = await loadEntry(row.id);
    if (!entry) {
      details.append(
        Object.assign(document.createElement("p"), { textContent: "No longer kept." }),
      );
      return;
    }
    const result = entry.resultTruncated
      ? `${entry.result}\n… cut here: the panel keeps the first 100,000 characters.`
      : entry.result;
    details.append(
      ...block("Arguments", JSON.stringify(entry.args, null, 2)),
      ...block(row.ok ? "Result" : "Error", result),
    );
  });
  item.append(details);
  return item;
}

function render(index) {
  const wanted = new Set(index.map((row) => row.id));
  for (const [id, element] of rows) {
    if (wanted.has(id)) continue;
    element.remove();
    rows.delete(id);
  }
  // The index is newest first; walk it and put each row in place.
  let previous = null;
  for (const row of index) {
    let element = rows.get(row.id);
    if (!element) {
      element = buildRow(row);
      rows.set(row.id, element);
    }
    const expected = previous ? previous.nextSibling : list.firstChild;
    if (expected !== element) list.insertBefore(element, expected);
    previous = element;
  }
  empty.hidden = index.length > 0;
}

document.getElementById("clear").addEventListener("click", () => {
  clearActivity();
});

chrome.storage.session.get(INDEX_KEY).then((stored) => render(stored[INDEX_KEY] ?? []));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[INDEX_KEY]) render(changes[INDEX_KEY].newValue ?? []);
});
