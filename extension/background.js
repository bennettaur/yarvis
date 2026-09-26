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

import { BLOCKED_LABEL_SOURCE, BLOCKED_PATH_SOURCE, isBlockedPath, sameOrigin } from "./site.js";

const HOST = "com.yarvis.browser";
const RECONNECT_ALARM = "yarvis-reconnect";

/** Ceiling on a page's text whatever the caller asked for. */
const MAX_TEXT_CHARS = 200_000;
const MAX_ELEMENTS = 300;

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
    case "list_elements":
      return listElements(command.tabId, command.maxElements);
    case "click":
      return click(command.tabId, command.ref);
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

async function inPage(tabId, func, args) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  if (!injection?.result) throw new Error("The page returned nothing.");
  return injection.result;
}

async function readPage(tabId, maxChars) {
  const target = tabId ?? (await activeTabId());
  return inPage(target, extractPage, [Math.min(maxChars ?? 20_000, MAX_TEXT_CHARS)]);
}

async function listElements(tabId, maxElements) {
  const target = tabId ?? (await activeTabId());
  return inPage(target, extractElements, [
    Math.min(maxElements ?? 150, MAX_ELEMENTS),
    BLOCKED_LABEL_SOURCE,
    BLOCKED_PATH_SOURCE,
  ]);
}

async function scroll(tabId, ref, direction) {
  const target = tabId ?? (await activeTabId());
  const moved = await inPage(target, scrollElement, [ref ?? null, direction]);
  if (moved.error) throw new Error(moved.error);
  // Chat lists load older messages lazily as the top comes into view, which
  // changes how far there is left to scroll, so the position is read after.
  await sleep(SETTLE_MS);
  const position = await inPage(target, scrollElement, [ref ?? null, "stay"]);
  return { ...(await pageState(target)), atTop: position.atTop, atBottom: position.atBottom };
}

async function click(tabId, ref) {
  const target = tabId ?? (await activeTabId());
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
      result = await inPage(target, clickElement, [ref, BLOCKED_LABEL_SOURCE, BLOCKED_PATH_SOURCE]);
    } catch (error) {
      // A click that starts a navigation can tear the page down before the script
      // reports back. The checks below still have to run.
      injectionError = error;
    }
    await sleep(SETTLE_MS);
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
  return { ...(await pageState(target)), navigated: before.url !== after.url };
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

// The functions below run inside the page, so each must be self-contained.

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

// Numbers each thing worth clicking and remembers the element, so a later click
// names a number instead of a selector the page could have changed under us.
function extractElements(maxElements, blockedSource, blockedPathSource) {
  const blocked = new RegExp(blockedSource, "i");
  const blockedPath = new RegExp(blockedPathSource, "i");
  const refs = new Map();
  window.__yarvisRefs = refs;
  const selector =
    'a[href],button,summary,[role="button"],[role="link"],[role="tab"],[role="treeitem"],[role="menuitem"],[role="option"]';
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  // A link to a page on this site is screened by its address, not its label: a
  // channel called "post-mortems" should open, but a link to /logout should not.
  // Anything else (a button, a "#" or javascript: link) has its label screened.
  const isNavigation = (el) => {
    const raw = el.tagName === "A" ? el.getAttribute("href") : null;
    if (!raw || raw.startsWith("#")) return false;
    try {
      return new URL(el.href).origin === location.origin;
    } catch {
      return false;
    }
  };
  const labelOf = (el) =>
    (el.getAttribute("aria-label") || el.innerText || el.title || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);

  const elements = [];
  let next = 1;
  let truncated = false;
  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el) || el.disabled) continue;
    // A <button> with no type attribute reports "submit" even outside a form, so
    // only one that sits in a form is a submit control.
    if (el.tagName === "BUTTON" && el.form && el.type === "submit") continue;
    if (el.tagName === "INPUT" && el.type === "submit") continue;
    const label = labelOf(el);
    if (!label) continue;
    if (isNavigation(el)) {
      const url = new URL(el.href);
      if (blockedPath.test(url.pathname + url.search)) continue;
    } else if (blocked.test(label)) {
      continue;
    }
    if (elements.length >= maxElements) {
      truncated = true;
      break;
    }
    const ref = next++;
    refs.set(ref, el);
    elements.push({
      ref,
      kind: el.tagName === "A" ? "link" : el.getAttribute("role") || "button",
      label,
      ...(el.tagName === "A" ? { href: el.href } : {}),
    });
  }

  // Message lists and side panels scroll on their own, not with the window.
  let scrollers = 0;
  for (const el of document.querySelectorAll("div,main,section,ul,ol")) {
    if (scrollers >= 10) break;
    if (el.clientHeight < 200 || el.scrollHeight <= el.clientHeight + 50) continue;
    const overflow = getComputedStyle(el).overflowY;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    const ref = next++;
    refs.set(ref, el);
    scrollers++;
    elements.push({
      ref,
      kind: "scroll",
      label: (el.getAttribute("aria-label") || el.getAttribute("role") || el.tagName).slice(0, 120),
    });
  }

  return { url: location.href, title: document.title, elements, truncated };
}

function clickElement(ref, blockedSource, blockedPathSource) {
  const el = window.__yarvisRefs?.get(ref);
  if (!el || !el.isConnected) {
    return { error: "That element is gone. List the page's elements again." };
  }
  const label = (el.getAttribute("aria-label") || el.innerText || el.title || "")
    .replace(/\s+/g, " ")
    .trim();
  const anchor = el.closest("a[href]");
  const rawHref = anchor?.getAttribute("href");
  const navigates =
    Boolean(rawHref) &&
    !rawHref.startsWith("#") &&
    (() => {
      try {
        return new URL(anchor.href).origin === location.origin;
      } catch {
        return false;
      }
    })();
  if (!navigates && new RegExp(blockedSource, "i").test(label)) {
    return { error: "That control changes or sends something, so Yarvis won't click it." };
  }
  if (navigates) {
    const url = new URL(anchor.href);
    if (new RegExp(blockedPathSource, "i").test(url.pathname + url.search)) {
      return { error: "That link changes something on the site, so Yarvis won't open it." };
    }
  }
  if (anchor) {
    let target;
    try {
      target = new URL(anchor.href);
    } catch {
      return { error: "That link has no usable address." };
    }
    if (target.origin !== location.origin) {
      return { error: "That link leaves this site. Yarvis stays on the current site." };
    }
    if (anchor.target && anchor.target !== "_self") {
      return { error: "That link opens a new tab. Yarvis works in the current tab only." };
    }
  }
  el.scrollIntoView({ block: "center" });
  el.click();
  return { ok: true };
}

function scrollElement(ref, direction) {
  const el =
    ref === null
      ? document.scrollingElement || document.documentElement
      : window.__yarvisRefs?.get(ref);
  if (!el || !el.isConnected) {
    return { error: "That element is gone. List the page's elements again." };
  }
  const step = el.clientHeight * 0.8;
  if (direction === "stay") {
    // Only reports where the panel is.
  } else if (direction === "up") el.scrollBy({ top: -step });
  else if (direction === "down") el.scrollBy({ top: step });
  else if (direction === "top") el.scrollTop = 0;
  else el.scrollTop = el.scrollHeight;
  return {
    atTop: el.scrollTop <= 0,
    atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
  };
}

// A rule left behind by a worker that died mid-command would keep blocking a tab.
chrome.declarativeNetRequest.getSessionRules().then((rules) =>
  chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: rules.map((rule) => rule.id),
  }),
);

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});
connect();
