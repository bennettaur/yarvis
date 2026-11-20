// The app's own page, shown while the server starts and from the tray's
// "Server connection…". It can call only the commands in
// capabilities/default.json.
const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);

const $ = (id) => document.getElementById(id);
const form = $("form");
let filledIn = false;

function describe(status) {
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

function showRemoteFields() {
  $("remote").hidden = form.elements.mode.value !== "remote";
}

async function refresh() {
  try {
    const settings = await invoke("get_connection_settings");
    $("status").textContent = describe(settings.status);
    $("open").hidden = settings.status.state !== "connected";
    if (!filledIn) {
      form.elements.mode.value = settings.mode;
      $("url").value = settings.remoteUrl ?? "";
      showRemoteFields();
      filledIn = true;
    }
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
    $("error").textContent = String(e);
    $("error").hidden = false;
  }
});

$("open").addEventListener("click", () => {
  invoke("open_server").catch((e) => {
    $("error").textContent = String(e);
    $("error").hidden = false;
  });
});

refresh();
