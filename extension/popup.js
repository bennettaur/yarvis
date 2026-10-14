import { loadProfile, saveProfileName } from "./profile.js";

const nameInput = document.getElementById("name");
const example = document.getElementById("example");
const saved = document.getElementById("saved");
const host = document.getElementById("host");
const list = document.getElementById("instances");

function render(status) {
  list.replaceChildren();
  if (!status?.hostConnected) {
    host.textContent =
      "The Yarvis helper isn't running. Run bun run browser:install with this extension's id, then reload the extension.";
    return;
  }
  const instances = status.instances ?? [];
  host.textContent =
    instances.length === 0 ? "No Yarvis app is running." : "Yarvis apps this browser can talk to:";
  for (const instance of instances) {
    const item = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = instance.connected ? "dot on" : "dot";
    dot.title = instance.connected ? "Connected" : "Not answering";
    const name = document.createElement("span");
    name.textContent = instance.name;
    const port = document.createElement("span");
    port.className = "port";
    port.textContent = `:${instance.port}`;
    item.append(dot, name, port);
    list.append(item);
  }
}

async function init() {
  const profile = await loadProfile();
  nameInput.value = profile.name;
  example.textContent = profile.name;

  const { status } = await chrome.storage.session.get("status");
  render(status);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.status) render(changes.status.newValue);
  });
  chrome.runtime.sendMessage({ type: "reconnect" }).catch(() => {});
}

document.getElementById("rename").addEventListener("submit", async (event) => {
  event.preventDefault();
  const next = await saveProfileName(nameInput.value);
  if (!next) return;
  nameInput.value = next.name;
  example.textContent = next.name;
  saved.hidden = false;
  setTimeout(() => {
    saved.hidden = true;
  }, 1500);
});

// Chrome only opens the side panel from inside the click, and waiting on another
// call first can lose that, so the window is looked up before anyone clicks.
let windowId;
chrome.windows.getCurrent().then((current) => {
  windowId = current.id;
});
document.getElementById("activity").addEventListener("click", (event) => {
  const button = event.currentTarget;
  if (windowId === undefined) return;
  chrome.sidePanel
    .open({ windowId })
    .then(() => close())
    .catch((error) => {
      button.textContent = `Couldn't open the side panel: ${error.message}`;
    });
});

init();
