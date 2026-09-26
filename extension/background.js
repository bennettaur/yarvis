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

import { BLOCKED_LABEL_SOURCE, sameOrigin } from "./site.js";

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
  ]);
}

async function scroll(tabId, ref, direction) {
  const target = tabId ?? (await activeTabId());
  const result = await inPage(target, scrollElement, [ref ?? null, direction]);
  if (result.error) throw new Error(result.error);
  // Chat lists load older messages lazily as the top comes into view.
  await sleep(SETTLE_MS);
  return { ...(await pageState(target)), atTop: result.atTop, atBottom: result.atBottom };
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
  try {
    result = await inPage(target, clickElement, [ref, BLOCKED_LABEL_SOURCE]);
    await sleep(SETTLE_MS);
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }
  for (const id of opened) await chrome.tabs.remove(id).catch(() => {});
  if (result.error) throw new Error(result.error);
  if (opened.length > 0) throw new Error("That click tried to open another tab, which was closed.");

  const after = await chrome.tabs.get(target);
  if (!sameOrigin(before.url ?? "", after.url ?? "")) {
    await chrome.tabs.goBack(target).catch(() => {});
    throw new Error(
      "That click left the site, so it was undone. Yarvis stays on the current site.",
    );
  }
  return { ...(await pageState(target)), navigated: before.url !== after.url };
}

async function navigate(tabId, url) {
  const target = tabId ?? (await activeTabId());
  const before = await chrome.tabs.get(target);
  if (!sameOrigin(before.url ?? "", url)) {
    throw new Error("That address is on a different site. Yarvis stays on the current site.");
  }
  await chrome.tabs.update(target, { url });
  await waitForLoad(target);

  const after = await chrome.tabs.get(target);
  // A redirect can carry the tab off the site even when the address didn't.
  if (!sameOrigin(before.url ?? "", after.url ?? "")) {
    await chrome.tabs.goBack(target).catch(() => {});
    throw new Error("That address redirected to a different site, so it was undone.");
  }
  return pageState(target);
}

async function waitForLoad(tabId) {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await sleep(200);
  }
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
function extractElements(maxElements, blockedSource) {
  const blocked = new RegExp(blockedSource, "i");
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
  // A link to a page on this site only moves around; the same-origin check in
  // clickElement covers it. Anything else (a button, a "#" or javascript: link)
  // may act, so its label is screened.
  const isNavigation = (el) => {
    if (el.tagName !== "A" || !el.getAttribute("href")) return false;
    try {
      const url = new URL(el.href);
      return (
        url.origin === location.origin &&
        !(url.hash && url.pathname === location.pathname && !url.search)
      );
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
    if (el.type === "submit" || (el.tagName === "BUTTON" && el.form && el.type !== "button")) {
      continue;
    }
    const label = labelOf(el);
    if (!label || (!isNavigation(el) && blocked.test(label))) continue;
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

function clickElement(ref, blockedSource) {
  const el = window.__yarvisRefs?.get(ref);
  if (!el || !el.isConnected) {
    return { error: "That element is gone. List the page's elements again." };
  }
  const label = (el.getAttribute("aria-label") || el.innerText || el.title || "")
    .replace(/\s+/g, " ")
    .trim();
  const anchor = el.closest("a[href]");
  const navigates =
    anchor &&
    (() => {
      try {
        const url = new URL(anchor.href);
        return (
          url.origin === location.origin &&
          !(url.hash && url.pathname === location.pathname && !url.search)
        );
      } catch {
        return false;
      }
    })();
  if (!navigates && new RegExp(blockedSource, "i").test(label)) {
    return { error: "That control changes or sends something, so Yarvis won't click it." };
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
  if (direction === "up") el.scrollBy({ top: -step });
  else if (direction === "down") el.scrollBy({ top: step });
  else if (direction === "top") el.scrollTop = 0;
  else el.scrollTop = el.scrollHeight;
  return {
    atTop: el.scrollTop <= 0,
    atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
  };
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});
connect();
