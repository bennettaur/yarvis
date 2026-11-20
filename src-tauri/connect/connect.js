// The app's own page, shown while the server starts and from the tray's
// "Server connection…". It can call only the commands in
// capabilities/default.json.
const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);

const $ = (id) => document.getElementById(id);
const form = $("form");
let formPrefilled = false;

function statusText(status) {
  switch (status.state) {
    case "starting":
      return "Starting…";
    case "connected":
      return `Connected to ${status.origin}.`;
    case "needsSetup":
      return "Choose a server to connect to.";
    case "failed":
      return `Couldn't connect: ${status.message}`;
    default:
      return "";
  }
}

function showError(e) {
  $("error").textContent = String(e);
  $("error").hidden = false;
}

function showRemoteFields() {
  $("remote").hidden = form.elements.mode.value !== "remote";
}

async function refresh() {
  try {
    const settings = await invoke("get_connection_settings");
    $("status").textContent = statusText(settings.status);
    $("open").hidden = settings.status.state !== "connected";
    if (!formPrefilled) {
      form.elements.mode.value = settings.mode;
      $("url").value = settings.remoteUrl ?? "";
      showRemoteFields();
      formPrefilled = true;
    }
    // Nothing pushes status to this page, so poll while the server starts.
    if (settings.status.state === "starting") setTimeout(refresh, 500);
  } catch (e) {
    $("status").textContent = `Couldn't read the connection settings: ${e}`;
  }
}

form.addEventListener("change", showRemoteFields);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  $("error").hidden = true;
  const mode = form.elements.mode.value;
  try {
    await invoke("save_connection_settings", {
      settings: {
        mode,
        remoteUrl: mode === "remote" ? $("url").value : null,
        token: mode === "remote" ? $("token").value : null,
      },
    });
  } catch (e) {
    showError(e);
  }
});

$("open").addEventListener("click", () => {
  invoke("open_server").catch(showError);
});

refresh();
