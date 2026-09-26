// Bridges Yarvis's requests to the tabs of this Chrome profile.
//
// The native host (scripts/browser/host.ts) forwards commands from the Yarvis
// sidecar over a native-messaging port; this worker answers each one. Every
// command is read-only — there is deliberately nothing here that clicks, types
// or navigates.
//
// An open native port keeps an MV3 service worker alive (Chrome 116+), and a
// dropped one is retried on an alarm, so the worker comes back after Chrome
// idles it or the host exits.

const HOST = "com.yarvis.browser";
const RECONNECT_ALARM = "yarvis-reconnect";

/** Ceiling on a page's text whatever the caller asked for. */
const MAX_TEXT_CHARS = 200_000;

let port = null;

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    port = null;
    return;
  }
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    // Read lastError so Chrome doesn't log an unchecked-error warning.
    void chrome.runtime.lastError;
    port = null;
  });
}

async function onMessage(message) {
  if (message?.type !== "command") return;
  let reply;
  try {
    reply = { ok: true, data: await run(message.command) };
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  port?.postMessage({ id: message.id, ...reply });
}

async function run(command) {
  switch (command?.type) {
    case "list_tabs":
      return listTabs();
    case "read_page":
      return readPage(command.tabId, command.maxChars);
    default:
      throw new Error(`Unknown command: ${command?.type}`);
  }
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => tab.id !== undefined)
    .map((tab) => ({
      id: tab.id,
      windowId: tab.windowId,
      active: tab.active,
      title: tab.title ?? "",
      url: tab.url ?? "",
    }));
}

async function readPage(tabId, maxChars) {
  const target = tabId ?? (await activeTabId());
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: target },
    func: extractPage,
    args: [Math.min(maxChars ?? 20_000, MAX_TEXT_CHARS)],
  });
  if (!injection?.result) throw new Error("The page returned nothing to read.");
  return injection.result;
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) throw new Error("No active tab.");
  return tab.id;
}

// Runs inside the page, so it must be self-contained.
function extractPage(maxChars) {
  const text = document.body?.innerText ?? "";
  return {
    url: location.href,
    title: document.title,
    selection: String(getSelection() ?? ""),
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms?.create(RECONNECT_ALARM, { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});
connect();
