// Bridges Yarvis's requests to the tabs of this Chrome profile.
//
// The native host (scripts/browser/host.ts) forwards commands from the Yarvis
// sidecar over a native-messaging port; this worker answers each one. Yarvis can
// read, scroll, click links and buttons, and navigate — but only within the
// origin the tab is already on (see site.js), and it can never type, so it
// cannot compose or send anything.
//
// An open native port keeps an MV3 service worker alive (Chrome 116+), and a
// dropped one is retried on an alarm, so the worker comes back after Chrome
// idles it or the host exits.
//
// Each Chrome profile has its own copy of this extension, and each one tells the
// host who it is: a random id kept for good, and a name the user sets in the
// popup. That name is what an agent passes to reach "the work profile".

import { recordActivity } from "./activity.js";
import { loadProfile, PROFILE_KEY } from "./profile.js";
import { BLOCKED_LABEL_SOURCE, BLOCKED_PATH_SOURCE, isBlockedPath, sameOrigin } from "./site.js";

const HOST = "com.yarvis.browser";
const RECONNECT_ALARM = "yarvis-reconnect";

/** Ceiling on a page's text whatever the caller asked for. */
const MAX_TEXT_CHARS = 200_000;
const MAX_ELEMENTS = 300;
const MAX_INSPECT = 30;
const MAX_WAIT_MS = 5_000;

/** How long a click or scroll gets to change the page before it is read back. */
const SETTLE_MS = 900;
const LOAD_TIMEOUT_MS = 10_000;

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
    setStatus({ hostConnected: false, instances: [] });
  });
  setStatus({ hostConnected: true, instances: [] });
  sayHello();
}

/** Tells the host who this profile is; it polls nothing until it knows. */
async function sayHello() {
  const profile = await loadProfile();
  port?.postMessage({ type: "hello", profileId: profile.id, name: profile.name });
}

/**
 * The popup reads this from session storage rather than asking the worker, so
 * it shows the last known state even while the worker is starting back up.
 */
function setStatus(status) {
  chrome.storage.session.set({ status }).catch(() => {
    // The badge below still tells the truth if the popup's copy can't be written.
  });
  const connected = status.instances.filter((instance) => instance.connected).length;
  chrome.action.setBadgeText({ text: connected > 0 ? String(connected) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
}

async function onMessage(message) {
  if (message?.type === "status") {
    setStatus({ hostConnected: true, instances: message.instances ?? [] });
    return;
  }
  if (message?.type !== "command") return;
  const startedAt = Date.now();
  let reply;
  try {
    reply = { ok: true, data: await run(message.command) };
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  port?.postMessage({ id: message.id, ...reply });
  recordActivity({
    id: message.id,
    at: startedAt,
    durationMs: Date.now() - startedAt,
    instance: message.instance,
    command: message.command,
    ...reply,
  });
}

async function run(command) {
  switch (command?.type) {
    case "list_tabs":
      return listTabs();
    case "read_page":
      return readPage(command.tabId, command.maxChars);
    case "list_elements":
      return listElements(command);
    case "inspect":
      return inspect(command);
    case "click":
      return click(command);
    case "scroll":
      return scroll(command.tabId, command.ref, command.direction);
    case "navigate":
      return navigate(command.tabId, command.url);
    default:
      throw new Error(`Unknown command: ${command?.type}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// While a click or navigation runs, top-level loads in that tab to any other host
// are blocked before the request is made. The origin checks afterwards can only
// undo a visit; this stops the visit, including an open redirect on the site
// itself. Blocking by excluded domain also lets the host's own subdomains
// through, which the after-the-fact check still catches.
async function withNavigationLock(tabId, url, run) {
  const { hostname } = new URL(url);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [
      {
        id: tabId,
        priority: 1,
        action: { type: "block" },
        condition: {
          tabIds: [tabId],
          resourceTypes: ["main_frame"],
          excludedRequestDomains: [hostname],
        },
      },
    ],
  });
  try {
    return await run();
  } finally {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] });
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

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) throw new Error("No active tab.");
  return tab.id;
}

/** The adapter kit, then the site adapters, then page.js, which finds them when it loads. */
const PAGE_FILES = [
  "adapters/kit.js",
  "adapters/slack.js",
  "adapters/gmail.js",
  "adapters/calendar.js",
  "page.js",
];

const SCREENS = { blockedSource: BLOCKED_LABEL_SOURCE, blockedPathSource: BLOCKED_PATH_SOURCE };

/**
 * Runs one of page.js's functions in the tab. The files are injected every time
 * because a navigation replaces the page's world, and injecting into a page
 * that already has them only redefines the same functions.
 */
async function inPage(tabId, name, options) {
  await chrome.scripting.executeScript({ target: { tabId }, files: PAGE_FILES });
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (fn, args) => globalThis.__yarvis[fn](args),
    args: [name, options],
  });
  if (!injection?.result) throw new Error("The page returned nothing.");
  return injection.result;
}

/** A page-side refusal or bad selector becomes the tool's error. */
function orThrow(result) {
  if (result?.error) throw new Error(result.error);
  return result;
}

async function readPage(tabId, maxChars) {
  const target = tabId ?? (await activeTabId());
  return inPage(target, "readPage", { maxChars: Math.min(maxChars ?? 20_000, MAX_TEXT_CHARS) });
}

async function listElements({ tabId, maxElements, selector, text }) {
  const target = tabId ?? (await activeTabId());
  return orThrow(
    await inPage(target, "listElements", {
      maxElements: Math.min(maxElements ?? 150, MAX_ELEMENTS),
      selector,
      text,
      ...SCREENS,
    }),
  );
}

async function inspect({ tabId, selector, limit }) {
  const target = tabId ?? (await activeTabId());
  return orThrow(
    await inPage(target, "inspect", {
      selector,
      limit: Math.min(limit ?? 10, MAX_INSPECT),
      ...SCREENS,
    }),
  );
}

async function scroll(tabId, ref, direction) {
  const target = tabId ?? (await activeTabId());
  orThrow(await inPage(target, "scroll", { ref, direction }));
  // Chat lists load older messages lazily as the top comes into view, which
  // changes how far there is left to scroll, so the position is read after.
  await sleep(SETTLE_MS);
  const position = await inPage(target, "scroll", { ref, direction: "stay" });
  return { ...(await pageState(target)), atTop: position.atTop, atBottom: position.atBottom };
}

async function click({ tabId, ref, selector, index, mode, waitMs }) {
  const target = tabId ?? (await activeTabId());
  // waitMs only ever adds time: the navigation lock is held for the settle, and
  // a shorter one would let a delayed navigation start after the lock is gone.
  const settle = Math.min(Math.max(waitMs ?? SETTLE_MS, SETTLE_MS), MAX_WAIT_MS);
  const before = await chrome.tabs.get(target);

  // A click can open a new tab (target=_blank, window.open). Close any that
  // appear from this tab, whatever they point at: only the current tab is ours.
  const opened = [];
  const onCreated = (tab) => {
    if (tab.openerTabId === target) opened.push(tab.id);
  };
  chrome.tabs.onCreated.addListener(onCreated);
  let result;
  let injectionError;
  await withNavigationLock(target, before.url ?? "", async () => {
    try {
      result = await inPage(target, "click", { ref, selector, index, mode, ...SCREENS });
    } catch (error) {
      // A click that starts a navigation can tear the page down before the script
      // reports back. The checks below still have to run.
      injectionError = error;
    }
    // A click refused in the page did nothing, so there is nothing to wait for.
    if (!result?.error) await sleep(settle);
  });
  chrome.tabs.onCreated.removeListener(onCreated);
  for (const id of opened) await chrome.tabs.remove(id).catch(() => {});

  const after = await chrome.tabs.get(target);
  if (!sameOrigin(before.url ?? "", after.url ?? "")) {
    await chrome.tabs.goBack(target).catch(() => {});
    throw new Error(
      "That click left the site. Yarvis went back, but the other page may already have loaded.",
    );
  }
  if (opened.length > 0) throw new Error("That click tried to open another tab, which was closed.");
  if (result?.error) throw new Error(result.error);
  if (injectionError && before.url === after.url) throw injectionError;
  const changed = before.url !== after.url || before.title !== after.title;
  if (mode === "hover") return { ...(await pageState(target)), hovered: result?.clicked };
  return {
    ...(await pageState(target)),
    clicked: result?.clicked,
    navigated: before.url !== after.url,
    changed,
    // A click that moves nothing is easy to mistake for one that worked.
    ...(changed
      ? {}
      : {
          note: "The click was delivered, but the page's address and title did not change. It may have opened something in place (a menu, a thread), or done nothing. Read the page before saying what happened; if nothing happened, inspect_browser_page the element and try something inside it, mode 'direct', or its openUrl.",
        }),
  };
}

async function navigate(tabId, url) {
  const target = tabId ?? (await activeTabId());
  const before = await chrome.tabs.get(target);
  if (!sameOrigin(before.url ?? "", url)) {
    throw new Error("That address is on a different site. Yarvis stays on the current site.");
  }
  const { pathname, search } = new URL(url);
  if (isBlockedPath(pathname + search)) {
    throw new Error("That address changes something on the site, so Yarvis won't open it.");
  }
  await withNavigationLock(target, before.url ?? "", async () => {
    const loaded = waitForLoad(target);
    await chrome.tabs.update(target, { url });
    await loaded;
  });

  const after = await chrome.tabs.get(target);
  // A redirect can carry the tab off the site even when the address didn't.
  if (!sameOrigin(before.url ?? "", after.url ?? "")) {
    await chrome.tabs.goBack(target).catch(() => {});
    throw new Error("That address redirected to a different site, so it was undone.");
  }
  return pageState(target);
}

// Resolves once the tab has gone through loading to complete. Checking the status
// alone would return at once, since the old page is still "complete" when the
// update is issued. A same-page change (a hash) never loads, hence the short cap
// on waiting for it to start.
function waitForLoad(tabId) {
  return new Promise((resolve) => {
    let started = false;
    const finish = () => {
      clearTimeout(startTimer);
      clearTimeout(giveUp);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") started = true;
      if (info.status === "complete" && started) finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const startTimer = setTimeout(() => {
      if (!started) finish();
    }, 1500);
    const giveUp = setTimeout(finish, LOAD_TIMEOUT_MS);
  });
}

async function pageState(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return { url: tab.url ?? "", title: tab.title ?? "" };
}

// A rule left behind by a worker that died mid-command would keep blocking a tab.
chrome.declarativeNetRequest.getSessionRules().then((rules) =>
  chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: rules.map((rule) => rule.id),
  }),
);

// A rename in the popup reaches the host, which re-polls every instance under
// the new name.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[PROFILE_KEY]) sayHello();
});

// Opening the popup is the moment someone wants a fresh answer.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "reconnect") connect();
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});
connect();
