// The side panel's chat with the Yarvis agent.
//
// Requests go to the worker over a port, which hands them to the native host,
// which calls the sidecar (see scripts/browser/chat.ts). Every message can carry
// the tab beside the panel, so "what is this page about?" means this page.

import { sessionLabel, tabContext, titleFor } from "./conversation.js";
import { loadProfile } from "./profile.js";

const instanceSelect = document.getElementById("instance");
const sessionSelect = document.getElementById("session");
const statusLine = document.getElementById("chat-status");
const thread = document.getElementById("thread");
const composer = document.getElementById("composer");
const input = document.getElementById("message");
const sendButton = document.getElementById("send");
const shareTab = document.getElementById("share-tab");
const tabTitle = document.getElementById("tab-title");
const approvalBar = document.getElementById("approval");
const approvalText = document.getElementById("approval-text");
const approvalArgs = document.getElementById("approval-args");

const NEW_CHAT = "";
const STOPPED = Symbol("stopped");
const sessionKey = (instance) => `chatSession:${instance}`;

let port = null;
const pending = new Map();

/** The turn being streamed, so Stop can cancel it. */
let turnId = null;

/** From Send until the turn settles, including the setup before it streams. */
let busy = false;
let stopRequested = false;

/** A switch of Yarvis app during a turn waits for it, or it would clear the reply being written. */
let refreshAfterTurn = false;

/** Tool calls waiting on the user, answered front first. */
const approvals = [];

/** The app the running turn went to; an answer to its approvals must go there too. */
let turnInstance = "";

function worker() {
  if (port) return port;
  port = chrome.runtime.connect({ name: "chat" });
  port.onMessage.addListener((message) => {
    const request = pending.get(message.id);
    if (!request) return;
    if (message.type === "chat_event") {
      request.onEvent?.(message.event);
      return;
    }
    pending.delete(message.id);
    if (message.ok) request.resolve(message.data);
    else request.reject(new Error(message.error ?? "Yarvis didn't answer."));
  });
  // The worker can be restarted under the panel; the next request reconnects.
  port.onDisconnect.addListener(() => {
    port = null;
    for (const [id, request] of pending) {
      pending.delete(id);
      request.reject(new Error("Lost the connection to the extension. Try again."));
    }
  });
  return port;
}

function ask(op, fields = {}, onEvent) {
  const id = crypto.randomUUID();
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onEvent });
  });
  worker().postMessage({ id, op, instance: instanceSelect.value, ...fields });
  return { id, promise };
}

function showStatus(text) {
  statusLine.textContent = text ?? "";
  statusLine.hidden = !text;
}

function addBubble(role, text) {
  const item = document.createElement("li");
  item.className = `bubble ${role}`;
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = text;
  item.append(body);
  thread.append(item);
  item.scrollIntoView({ block: "end" });
  return item;
}

function addToolLine(bubble, name) {
  const line = document.createElement("div");
  line.className = "tool-line";
  line.dataset.tool = name;
  line.textContent = `Using ${name}…`;
  bubble.insertBefore(line, bubble.querySelector(".body"));
  return line;
}

async function loadSessions(selected) {
  const sessions = await ask("sessions").promise;
  sessionSelect.replaceChildren(new Option("New chat", NEW_CHAT));
  for (const session of sessions)
    sessionSelect.append(new Option(sessionLabel(session), session.id));
  const keep = sessions.some((s) => s.id === selected) ? selected : NEW_CHAT;
  sessionSelect.value = keep;
  return keep;
}

async function openSession(id) {
  thread.replaceChildren();
  await chrome.storage.local.set({ [sessionKey(instanceSelect.value)]: id });
  if (id === NEW_CHAT) return;
  const messages = await ask("messages", { sessionId: id }).promise;
  for (const message of messages) addBubble(message.role, message.content);
}

async function refresh() {
  showStatus("");
  try {
    const key = sessionKey(instanceSelect.value);
    const remembered = (await chrome.storage.local.get(key))[key];
    await openSession(await loadSessions(remembered));
  } catch (error) {
    showStatus(error.message);
  }
}

/** Whether the status line is showing a connection problem, which a reconnect clears. */
let connectionNote = false;

function renderInstances(state) {
  const connected = (state?.instances ?? []).filter((instance) => instance.connected);
  const current = instanceSelect.value;
  instanceSelect.replaceChildren(...connected.map((i) => new Option(i.name, i.name)));
  instanceSelect.hidden = connected.length < 2;
  if (connected.some((i) => i.name === current)) instanceSelect.value = current;
  const note = !state?.hostConnected
    ? "The Yarvis helper isn't running. Open the extension's popup for how to set it up."
    : connected.length === 0
      ? "No Yarvis app is running."
      : null;
  if (note || connectionNote) showStatus(note);
  connectionNote = Boolean(note);
  return instanceSelect.value !== current;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function selectionIn(tab) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => String(globalThis.getSelection?.() ?? ""),
    });
    return result?.result ?? "";
  } catch {
    // Chrome's own pages and the Web Store can't be scripted; the title and URL still go.
    return "";
  }
}

async function showActiveTab() {
  const tab = await activeTab();
  tabTitle.textContent = tab?.title || tab?.url || "none";
}

async function currentTabContext() {
  if (!shareTab.checked) return undefined;
  const tab = await activeTab();
  if (!tab) return undefined;
  const profile = await loadProfile();
  return tabContext(tab, await selectionIn(tab), profile.name) ?? undefined;
}

function renderApproval() {
  const next = approvals[0];
  approvalBar.hidden = !next;
  if (!next) return;
  const more = approvals.length > 1 ? ` (+${approvals.length - 1} more)` : "";
  const where = next.server ? ` from ${next.server}` : "";
  approvalText.textContent = `Yarvis wants to run ${next.name}${where}${more}.`;
  approvalArgs.textContent = next.args ?? "";
}

function answerApproval(approved) {
  const next = approvals.shift();
  renderApproval();
  if (!next) return;
  ask("approve", { toolCallId: next.id, approved, instance: turnInstance }).promise.catch((error) =>
    showStatus(error.message),
  );
}

function setBusy(next) {
  busy = next;
  sendButton.textContent = next ? "Stop" : "Send";
  input.disabled = next;
  sessionSelect.disabled = next;
  instanceSelect.disabled = next;
}

async function send(text) {
  showStatus("");
  addBubble("user", text);
  const reply = addBubble("assistant", "");
  reply.classList.add("streaming");
  const body = reply.querySelector(".body");
  const tools = new Map();
  stopRequested = false;
  turnInstance = instanceSelect.value;
  setBusy(true);
  try {
    let sessionId = sessionSelect.value;
    if (sessionId === NEW_CHAT) {
      const session = await ask("create_session", {
        title: titleFor(text),
        instance: turnInstance,
      }).promise;
      sessionSelect.add(new Option(sessionLabel(session), session.id), 1);
      sessionSelect.value = session.id;
      sessionId = session.id;
      await chrome.storage.local.set({ [sessionKey(turnInstance)]: sessionId });
    }
    const tab = await currentTabContext();
    if (stopRequested) {
      reply.remove();
      return;
    }
    const turn = ask("send", { sessionId, message: text, tab, instance: turnInstance }, (event) => {
      if (event?.type === "delta") {
        body.textContent += event.text;
        reply.scrollIntoView({ block: "end" });
      } else if (event?.type === "tool_call") {
        tools.set(event.id, addToolLine(reply, event.name));
      } else if (event?.type === "tool_result") {
        const line = tools.get(event.id);
        if (line) {
          const name = line.dataset.tool;
          line.textContent = event.status === "ok" ? `Used ${name}` : `${name} (${event.status})`;
        }
      } else if (event?.type === "tool_approval_request") {
        approvals.push(event);
        renderApproval();
      } else if (event?.type === "attention") {
        showStatus(`Yarvis wants your attention${event.reason ? `: ${event.reason}` : "."}`);
      } else if (event?.type === "error") {
        showStatus(event.message);
      }
    });
    turnId = turn.id;
    // A stopped turn usually saves nothing in Yarvis, so its partial reply goes too.
    if ((await turn.promise) === STOPPED) reply.remove();
    else if (!body.textContent && statusLine.hidden) body.textContent = "(no response)";
  } catch (error) {
    showStatus(error.message);
  } finally {
    turnId = null;
    // A turn that ended stopped waiting on its approvals.
    approvals.length = 0;
    renderApproval();
    reply.classList.remove("streaming");
    if (!body.textContent) reply.remove();
    setBusy(false);
    input.focus();
    if (refreshAfterTurn) {
      refreshAfterTurn = false;
      refresh();
    }
  }
}

function stop() {
  showStatus("Stopped.");
  if (!turnId) {
    // Still creating the chat or reading the tab; send() checks this before streaming.
    stopRequested = true;
    return;
  }
  const id = turnId;
  worker().postMessage({ id, cancel: true });
  const request = pending.get(id);
  pending.delete(id);
  request?.resolve(STOPPED);
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) {
    stop();
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  send(text);
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

sessionSelect.addEventListener("change", () => {
  showStatus("");
  openSession(sessionSelect.value).catch((error) => showStatus(error.message));
});
instanceSelect.addEventListener("change", refresh);

chrome.tabs.onActivated.addListener(showActiveTab);
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (tab.active && (info.title || info.url)) showActiveTab();
});

document.getElementById("approve").addEventListener("click", () => answerApproval(true));
document.getElementById("deny").addEventListener("click", () => answerApproval(false));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !changes.status) return;
  const instanceChanged = renderInstances(changes.status.newValue);
  // With no app left there is nothing to load, and the note above says why.
  if (!instanceChanged || !instanceSelect.value) return;
  if (busy) refreshAfterTurn = true;
  else refresh();
});

async function init() {
  showActiveTab();
  const { status: state } = await chrome.storage.session.get("status");
  renderInstances(state);
  if (instanceSelect.value) await refresh();
}

init();
