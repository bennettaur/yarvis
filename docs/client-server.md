# Yarvis as a client-server app

Yarvis today is one desktop app. A Tauri core (Rust) owns settings, secrets,
PTYs and the window, and it spawns a Bun sidecar that owns everything else. The
webview talks to the core through `invoke` and to the sidecar over HTTP on
127.0.0.1.

This document describes the first pass at splitting that into one server and
several clients. The server can run on the same Mac or on another machine (an
always-on Intel Mac mini, for example). Clients are the web UI in a browser, a
thin Tauri app, and later a native macOS app and a phone app.

Spikes tested the risky parts first. They live on the
`yarvis/explore-a-client-server-architecture` branch, under `spikes/`, as
reference code that isn't meant to merge. Each has a `FINDINGS.md`, and
references below to `spikes/...` point there.

What is built so far: the `server/` skeleton (config, SQLite store, device
tokens and scopes, the event log and its WebSocket, the error shape, the
`SecretBackend` trait, `GET /api/health` and `GET /api/devices/me`). The rest
of this document is the plan the next pull requests implement.

## Goals for the first pass

- One Rust binary, `yarvis-server`, that a browser can use with no Tauri app
  installed.
- Every client signs in with a passkey or a scoped device token. Every event
  records which device caused it, and a device can be revoked at once.
- PTY sessions (Claude Code in a workspace) stream over WebSocket to any number
  of clients and survive a client disconnecting.
- Secrets can live in the server's own encrypted vault, unlocked with a passkey.
  The server can also run its own ssh-agent to sign git commits after an
  approval. Both are optional: a server can keep using the macOS Keychain or
  1Password, with no ssh-agent at all (see "Deployments").
- The existing UI keeps working, in a browser and in the Tauri app, with no
  feature lost.

Out of scope for the first pass: porting the sidecar's TypeScript to Rust, the
native macOS app itself, and the phone app.

## The sidecar stays, behind the server

The sidecar is about 83,000 lines of TypeScript. Porting it is the long tail of
this project, not the first step. So the server supervises the sidecar the way
the Tauri core does today, and puts it behind a reverse proxy:

```
browser / Tauri / native app
        │  HTTPS + WebSocket, device token
        ▼
yarvis-server (Rust, axum)
  ├─ /api/auth/*, /api/devices/*      passkeys, devices, scoped tokens
  ├─ /api/events (WS)                  event stream, approvals, alarms
  ├─ /api/approvals/*                  first answer wins, any device
  ├─ /api/core/*                       what `invoke` did: settings, secrets, PTY control
  ├─ /api/pty/{id} (WS)                PTY attach with resume
  ├─ /api/vault/*                      lock, unlock, wrappers (optional)
  ├─ /api/sidecar/*  ──proxy──►  Bun sidecar on 127.0.0.1 (its own bearer token)
  └─ /*                                the built web UI (static files)
```

The sidecar only listens on loopback and never sees a device token. The server
checks the device, strips the client's `Authorization` header, adds the
sidecar's own token, and adds `X-Yarvis-Device-Id` so the sidecar can record
who asked. SSE and WebSocket routes on the sidecar are proxied as streams.

The sidecar's calls back into the core (the Unix-socket control channel in
`src-tauri/src/control.rs`) move to the server unchanged. Anything the sidecar
used to trigger in the window, such as ringing an alarm, becomes an event on
`/api/events`. Each client decides how to show it.

Porting a sidecar module later means adding a native route and deleting its
proxy path. Clients don't change, because they only see `/api/...` on one
origin.

## Crates

`server/` is a Cargo workspace, separate from `src-tauri/`:

- `server/crates/yarvis-server`: the binary and the axum app. It reads
  `~/.yarvis/server.toml`, or the file given with `--config`.
- Modules inside it, each owned by one area:
  - `config`: the server config file and command-line flags.
  - `store`: SQLite (`rusqlite`, bundled) for server state: passkeys, devices,
    events, approvals. Postgres stays the sidecar's database. Auth and the vault
    must work even when Postgres is down, so server state does not live there.
  - `auth`: passkeys (webauthn-rs), devices, tokens, scopes, the setup code.
  - `events`: the append-only event log and the `/api/events` WebSocket.
  - `approvals`: pending approvals, answered by the first device to respond.
  - `secret_store`: the `SecretBackend` trait with Keychain, 1Password and vault
    backends. The JSON blob format is the one `src-tauri` uses today.
  - `vault`: the encrypted vault and its passkey-PRF and recovery wrappers.
  - `ssh_agent`: the optional ssh-agent, which signs only `git` namespace
    signatures, after an approval.
  - `sidecar`: spawning, supervising and proxying the Bun sidecar.
  - `control`: the sidecar's Unix-socket control channel.
  - `pty`: PTY sessions and the attach WebSocket.
  - `core_api`: HTTP versions of the Tauri commands.
  - `web`: serving the built UI.

The thin Tauri app no longer needs most of `src-tauri/src`. What stays there
is what has to run on the machine in front of you (see "Clients").

## Auth

This follows `spikes/auth/FINDINGS.md`.

- First start prints a one-time setup code to stdout, and writes it to a
  `0600` file in the data dir for a server whose stdout goes to a log.
  Registering the first passkey with it creates the first device with all
  four scopes. The setup routes stop working once a passkey exists.
- Every passkey sign-in creates a new **device** with a random 32-byte token,
  sent as base64url without padding. Clients treat it as opaque. Only its
  SHA-256 is stored. Clients send it as `Authorization: Bearer <token>`.
  Browser WebSockets can't set headers, so they send it as the first message
  instead, never in the URL. Signing in again from the same browser makes a
  second device. The devices page shows when each was last used, so old ones
  are easy to revoke.
- A token unused for 90 days stops working.
- Scopes: `read`, `chat`, `approve`, `admin`. A passkey device gets all four.
  A token made for a bot or script gets only what it is given.
- **Fresh**: device management, adding a passkey, and vault actions also need
  a passkey check on this device in the last 10 minutes (`verified_at`).
  Without one they get `403 { "error": "fresh passkey check needed" }`, and
  the client runs `/api/auth/reverify`. A token device can never be fresh,
  so it can never do these things.
- Tokens minted over the API (`POST /api/devices/tokens`) can't have `admin`.
  Tokens made with the CLI on the server machine can, since whoever runs that
  can already read the database.
- `401` means no token, or a token that's unknown, revoked or expired.
  `403` means the device lacks the route's scope, or isn't fresh.
- Revoking a device takes effect on its next request and closes its open
  WebSockets, including proxied sidecar streams.
- Every event has a `deviceId`, `null` for the server's own work. Proxied
  sidecar requests carry it in `X-Yarvis-Device-Id`.

**Browser tokens and XSS.** The web UI keeps its token in localStorage, which
script on the page can read. An HttpOnly cookie would hide the token from an
injected script, but the script could still act through the page while it is
open, and cookies bring CSRF and WebSocket-hijacking checks of their own. So
the defense is keeping script out: every response carries a strict CSP
(`script-src 'self'`, no inline script) and `frame-ancestors 'none'`. Model
output and markdown are rendered as data, which the UI already does.

**Host checks.** Every request's `Host` must be a loopback name, the bind
address, or a host in `auth.origins`. That stops a page on another site from
reaching a loopback server through DNS rebinding.

**TLS.** The server speaks plain HTTP. It refuses to bind anything but
loopback unless `server.allow_plain_http = true`, which is for a server with
TLS in front of it. On a tailnet, `tailscale serve` gives the server an HTTPS
name, and passkeys need HTTPS on any name other than `localhost`.

RP ID: passkeys are tied to one domain for good. Set it with `auth.rp_id`
(default `localhost`) and the matching `auth.origins`. For a long-lived
install, use a domain you own, with a tailnet-only subdomain. The native iOS and macOS apps need that, because the
domain has to serve an `apple-app-site-association` file. `localhost` works for
a server and browser on the same Mac.

## Deployments

Two settings decide where secrets live and whether the server signs commits.
A full `server.toml`, with the defaults:

```toml
[server]
bind = "127.0.0.1:7878"
data_dir = "~/.yarvis/server"   # written out in full; ~ isn't expanded
# web_dir = "/path/to/dist"     # the built web UI; unset serves only /api
allow_plain_http = false        # needed for any bind that isn't loopback

[auth]
rp_id = "localhost"
origins = ["http://localhost:7878"]

[secrets]
# backend = "keychain"          # "vault" | "keychain" | "onepassword"

[ssh_agent]
enabled = false                 # the server's own ssh-agent; needs "vault"
# upstream_socket = "..."       # the agent workspace shells use when it's off

[sidecar]
enabled = true
# command = ["bun", "run", "..."]
# migrations_dir = "..."       # for a compiled sidecar: YARVIS_MIGRATIONS_DIR
```

With `secrets.backend` unset, the server follows `secretBackend` in
`~/.yarvis/settings.json`, as the desktop app does: 1Password when it says
`"onepassword"`, the Keychain otherwise. An existing install, such as a work
laptop already on 1Password, keeps its store when the Tauri app starts a local
server, and Settings can still switch between the two. Once `server.toml`
names a backend, it wins, and Settings can only change which 1Password item a
1Password server reads.

The server refuses `ssh_agent.enabled = true` with any backend but `vault`,
since the vault is where the signing key lives.

**Home server (the Intel Mac mini).** `backend = "vault"`, `ssh_agent.enabled =
true`. The server starts locked. A passkey unlock (PRF) or the recovery key
opens the vault, starts the sidecar with its secrets, and starts the ssh-agent.
Git in a workspace uses `SSH_AUTH_SOCK` pointing at that agent, and every
signature waits for an approval from any device with the `approve` scope.

**Work laptop.** `backend = "onepassword"` (or `"keychain"`),
`ssh_agent.enabled = false`. Secrets and the signing key stay in 1Password,
managed the way they are today. Workspace PTYs get `SSH_AUTH_SOCK` set to
`ssh_agent.upstream_socket` when it is set, and to the server's own
`SSH_AUTH_SOCK` otherwise. A server started by the Tauri app inherits the
login session's value. One run by launchd doesn't, so set `upstream_socket` to
1Password's agent socket,
`~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock` (written
out in full). You can still reach this server
from another device. But 1Password only approves a signature on the laptop
itself, so commits can only be signed while you are at the laptop. Nothing in
the server tries to work around that. With `ssh_agent.enabled = false` the
`/api/vault/ssh-agent/*` routes return 404, and the UI hides the signing
section.

Outbound HTTPS from the server uses the bundled Mozilla roots
(`webpki-root-certs` with reqwest's `tls_certs_only`), never the macOS
platform verifier, which fails in a process with no keychain. See
`spikes/headless/FINDINGS.md`.

`keychain` and `onepassword` only work when the server runs inside a logged-in
macOS session (a LaunchAgent, or the Tauri app starting it). A server started
at boot, before anyone logs in, has no keychain. That setup needs `vault`. See
`spikes/headless/FINDINGS.md`.

## Clients

All clients use the same HTTP and WebSocket API. Nothing in the API is specific
to a browser. Cookies are not used for auth (see "Browser tokens and XSS").

**Web UI.** The existing React app in `src/`, built by Vite and served by the
server. Two changes:

1. `src/lib/api.ts` finds the server instead of asking Tauri for the sidecar's
   port. It uses the page's own origin, or a server URL the Tauri app gives it.
   `sidecarFetch` sends the device token to `/api/sidecar/...`.
2. Every `invoke("...")` goes through one function, `core(cmd, args)`. It calls
   `/api/core/...` on the server. A few commands only make sense on the machine
   you sit at (clipboard history, focusing a window). For those, `core` uses
   the Tauri bridge when the page runs inside the Tauri app, and the UI hides
   the feature otherwise.

The UI is always served by the server it talks to, in a browser and in the
Tauri window alike, so every request is same-origin and needs no CORS.

There's also a sign-in page (passkey or setup code), a devices page in
Settings, and an approvals list.

**Thin Tauri app.** A window, a tray icon, global shortcuts, the clipboard
history, alarm takeovers and notifications. It either starts a local
`yarvis-server` (the default, so a single Mac still works with one app) or
connects to a server URL. It keeps its device token in the Keychain. It doesn't
spawn the sidecar or own any PTYs.

**Native macOS app (later).** A SwiftUI app that talks to the same API:

- Sign in with `ASAuthorizationPlatformPublicKeyCredentialProvider` against the
  same RP ID. This needs the domain's `apple-app-site-association` file, which
  is why a real domain matters.
- The token is kept in the Keychain, as in the Tauri app.
- Terminals use SwiftTerm, fed by the same `/api/pty/{id}` WebSocket.
- Chat and the rest are native views over the same JSON routes. Screens not
  rebuilt yet can be shown in a `WKWebView` pointed at the server.

To keep that possible, the API has to stay plain: JSON bodies, typed error
bodies (`{ "error": "...", "detail": "..." }`), and WebSocket messages as
tagged JSON (`{"type": "...", ...}`). Request and response types live in the
server code as `serde` structs, so an OpenAPI description can be generated
from them later for a Swift client.

## API contract for the first pass

All routes are under `/api`. Errors are `{ "error": string, "detail"?: string }`.
Times are milliseconds since the Unix epoch. A **device** in a response is:

```json
{ "deviceId": "…", "name": "My iPhone", "scopes": ["read", "chat"], "verifiedAt": 1763600000000 }
```

The devices list adds `kind` (`"passkey"` or `"token"`), `createdAt`,
`lastSeenAt` and `revokedAt`. Tokens and their hashes never appear in a
response, except the one time a token is created.

- `GET /api/health` → `{ "status": "ok", "service": "yarvis-server" }`, no token.

Auth (no token needed):

- `GET  /api/auth/status` → `{ setupRequired, rpId, vault: "absent"|"locked"|"unlocked" }`
- `POST /api/auth/setup/start` `{ code, deviceName }` → WebAuthn creation options
- `POST /api/auth/setup/finish` `{ credential }` → `{ token, device }`
- `POST /api/auth/login/start` → WebAuthn request options
- `POST /api/auth/login/finish` `{ credential, deviceName }` → `{ token, device }`

Devices (token needed):

- `GET    /api/devices/me` (`read`) → the calling device
- `GET    /api/devices` (admin)
- `POST   /api/devices/tokens` `{ name, scopes }` (admin, fresh) → `{ token, device }`
- `DELETE /api/devices/{id}` (admin, fresh)
- `POST   /api/auth/reverify/start|finish` (passkey check, makes the device fresh)

Events and approvals:

- Every WebSocket starts the same way. The client sends
  `{"type":"auth","token":"…"}` within 10 seconds, plus any fields the route
  reads. If it fails, the server closes the socket with one of these codes:
  - `4401`: no auth message, or the token is unknown, revoked or expired. Also
    sent when the device is revoked while connected. Sign in again.
  - `4403`: the device lacks the scope.
  - `4400`: a field the route reads is malformed.
  - `1011`: the server failed. Reconnect.
- `GET /api/events` (WebSocket, `read`). With no `since`, the client gets
  only events from now on. With `"since": seq` it first gets every event
  after `seq`, then live ones, with nothing missed or repeated. Each message is
  one event:

  ```json
  {"type": "event", "seq": 42, "at": 1763600000000, "deviceId": "…", "kind": "approval.requested", "data": {}}
  ```

  If the client is more than 1000 events behind, or falls behind while
  connected, it gets `{"type": "lagged"}` and the socket closes. It should
  reload what it shows, then reconnect without `since`. Event `data` never
  holds a token or secret, since every `read` device can see the history.
- Event kinds clients act on:
  - `alarm.fire` and `alarm.release`: what the control channel's alarm methods
    did to the window. For `alarm.fire`, `data` is the alarm, as `alarms.rs`
    builds it: `{ id, label, fireAtMs, sound, meetLink, status }`. For
    `alarm.release` it is `{ id }`. The server doesn't remember which alarms
    are ringing, so a client that sees the same id fire twice rings it once.
  - `approval.requested` and `approval.answered`: see below.
  - `device.created` and `device.revoked`.
  - `sidecar.started` and `sidecar.stopped`: the sidecar restarted, so cached
    data may be stale.
  - `vault.locked` and `vault.unlocked`.
  - `pty.exited`: `{ id, code }`.
- `GET  /api/approvals` (`read`)
- `POST /api/approvals/{id}` `{ approve: bool }` (`approve`). The first answer
  wins. Later answers get `409`.

Core (what `invoke` did; one route per command, JSON body = the command's
arguments with the same camelCase keys the frontend passes to `invoke` today,
response = its return value, `204` for none):

- `POST /api/core/{command}`, for example `/api/core/get_settings` or
  `/api/core/set_secret`. Scope: `admin` for anything that writes secrets or
  settings, `chat` for PTY control, `read` for reads. A command that only makes
  sense on the client machine is not served here.

PTY (`chat` to drive a session, `read` to look at one):

`chat` lets a device run a shell as the user the server runs as. From there
it can reach everything that user can, the control socket and the secrets
store included, so treat `chat` as full trust. Don't give it to a token for
a bot or a script.

- `POST /api/core/pty_write` `{ id, data }` → `204`. `data` is at most 64 KiB.
- `POST /api/core/pty_resize` `{ id, cols, rows }` → `204`. Attached clients
  get a `size` message; who owns the size doesn't change.
- `POST /api/core/pty_kill` `{ id }` → `204`, also when there was no session.
- `POST /api/core/pty_start_claude` `{ workspaceId, cwd, name, remoteControl, harness? }`
  → `204`. Starts the agent session `ws-claude:<workspaceId>`. A command's
  own refusal (an unknown harness, the session cap) is a `400` with the reason
  in `error`.
- `POST /api/core/pty_exists` `{ id }` → `true` while a shell runs there.
- `POST /api/core/pty_is_busy` `{ id }` → `true` while something other than
  the shell holds the terminal.
- `POST /api/core/pty_session_harness` `{ id }` → `{ id, name }` or `null`.
- `POST /api/core/get_agent_config` → `{ name, command, harnesses, defaultHarness }`.
  `chat`, since the commands are user-written and can carry a `VAR=secret`.

- `GET /api/pty/{id}` (WebSocket, `chat`). `{id}` is the session id,
  URL-encoded (ids such as `ws:<workspaceId>/<tab>/<pane>` hold slashes). The
  hello is:

  ```json
  {"type": "auth", "token": "…", "cols": 120, "rows": 32, "offset": 1234, "cwd": "/path"}
  ```

  `cols` and `rows` are the client's viewport (default 80×24). `offset` is
  where to resume, from an earlier connection. `cwd` is where a shell spawned
  by this attach opens. Attaching to an id with no running shell spawns a
  plain one there, except under `review-claude:`, which only the sidecar can
  start. A malformed field closes with `4400`. A refusal the client can't fix
  by retrying (the session cap, an ended review session) sends
  `{"type": "error", "error": "…"}`, then closes with `4400`.

  Then the server sends, as JSON text:

  ```json
  {"type": "attached", "clientId": 7, "mode": "resume", "requestedOffset": 1234,
   "startOffset": 1234, "endOffset": 1500, "lostBytes": 0,
   "cols": 120, "rows": 32, "owner": 7, "exit": null}
  ```

  and right after it one binary catch-up frame, then live binary output
  frames. Every binary frame is an 8-byte big-endian stream offset followed
  by the bytes. The catch-up starts at `startOffset`, and each frame starts
  where the previous one ended. Offsets count every byte the session ever
  produced, so they stay valid when old output is dropped and across a
  respawn under the same id.

  - `mode: "resume"`: `offset` was still in scrollback, and the catch-up is
    exactly what came after it. Append it.
  - `mode: "snapshot"`: no `offset`, or one the server no longer has. The
    catch-up is everything kept (up to 1 MiB). Clear the screen and replay
    it. `lostBytes` is how many bytes between `offset` and `startOffset` are
    gone.

  Other server messages:
  - `{"type": "size", "cols", "rows", "owner"}`: the PTY size changed, or
    its owner did. `owner` is a `clientId`, or `null` when nobody owns it.
  - `{"type": "resync", …}`: the same fields as `attached`, sent when the
    client fell behind, followed by a catch-up frame. It resumes from the
    last byte the client was sent, or is a snapshot if that is gone.
  - `{"type": "exit", "code": 3}`: the shell exited, after its last output
    byte. The socket then closes with `1000`.

  From the client:
  - A binary frame, or `{"type": "input", "data": "…"}`: input, at most
    64 KiB a message. More closes the socket with `4400`.
  - `{"type": "resize", "cols", "rows"}`: the client's viewport.
  - `{"type": "focus"}`: take over the PTY size.

  The first client to report a viewport owns the PTY size. A client takes it
  over by typing or sending `focus`, and the PTY is then resized to that
  client's last viewport. A non-owner's viewport is recorded but not applied.
  When the owner disconnects, the size stays until the next client types or
  focuses. A client whose socket stops draining is resynced rather than
  slowing the others down, and one whose send blocks for 10 seconds is
  dropped. Revoking the device closes its terminals with `4401`.

  While the sidecar types an instruction into an agent session
  (`claude.send`, `claude.slash`), other input to that session waits, from
  the text to its Enter.

  When a session's shell exits, the event log gets `pty.exited` with
  `{ id, code }`.

The sidecar's control socket is `core-control.sock` in the server's data dir
(mode 0600, in a 0700 folder). The sidecar gets its path as
`YARVIS_CORE_SOCK`. It keeps `control.rs`'s method list and checks. Two things
differ from the desktop app: the alarm methods append `alarm.fire` and
`alarm.release` events instead of taking over a window, and `mcp.saveOAuth`
and `github.saveToken` write the secrets blob in whichever backend the server
uses.

Each PTY gets `SSH_AUTH_SOCK` from the `[ssh_agent]` config: with
`enabled = false`, `upstream_socket` when set, else the server's own value;
with `enabled = true`, the socket the server's ssh-agent reports through
`PtyManager::set_server_ssh_agent`, and none at all until it does (or while
the vault is locked), so git can't sign through another agent.

Vault (only when `secrets.backend = "vault"`):

- `GET  /api/vault/status`
- `POST /api/vault/unlock/start|finish` (passkey PRF) and `/api/vault/unlock/recovery`
- `POST /api/vault/lock` (admin)
- `GET  /api/vault/ssh-agent` → `{ enabled, publicKey?, socketPath? }`; 404 when
  `ssh_agent.enabled = false`

Pairing a device without a passkey:

- `yarvis-server device add --name NAME --scopes read,chat,approve,admin`
  prints a token. Only someone who can run commands on the server machine can
  do this, which is the same trust as reading the setup code. The thin Tauri
  app uses it when it starts a local server.
- A signed-in admin device can mint one with `POST /api/devices/tokens`. The
  user pastes it into the client being paired (a Tauri app pointed at a remote
  server, a script).

Sidecar:

- `ANY /api/sidecar/{*path}` → the sidecar's `/{path}`, with `read` for `GET`
  and `chat` for everything else. Routes that change what the sidecar may do
  (MCP servers, custom providers, model choices, the sidecar's settings
  sections, the GitHub sign-in, standing tool consent, job and specialist
  definitions, registered repos) need `admin`, and so does reading the MCP
  endpoint's connection info, which carries its token. Answers to tool
  approvals, permission prompts and agent questions need `approve`. The proxy
  keeps that list (`SCOPE_RULES` in `sidecar_proxy.rs`). A path with `..`, an
  encoded slash or backslash, or an empty segment is refused. The client's own
  `Authorization` and `X-Yarvis-Device-Id` headers are dropped before the
  server adds its own. `sidecarFetch("/api/status")` becomes
  `/api/sidecar/api/status`: only `/health` and paths under `/api/` are
  served.
- While no sidecar process is up (the supervisor is waiting for the secrets,
  or restarting it), the proxy answers `503` and sends nothing to the
  sidecar's port, which another local process could have taken.
- A response still streaming when its device is revoked ends there.
- Routes that local processes call on the sidecar with their own scoped
  tokens (Claude Code hooks posting to `/ingest/*`, the browser extension's
  host, the MCP endpoint) are not proxied. They stay on loopback.
- A WebSocket on the proxy authenticates with its first message like every
  other socket, and needs what a write to its path needs (at least `chat`),
  since a socket can send as well as read.

Core commands that changed on the way from `invoke`:

- `set_secret_backend` behaves as it did when `server.toml` names no backend.
  When it names one, a request for another kind gets `409`, and on a
  1Password server it switches the item, copying the secrets into it as
  before. The first item such a server is given is filled from the Keychain.
- `get_sidecar_info` and `get_sidecar_log_path` are gone. Clients reach the
  sidecar through the proxy, and the log is on the server's disk (the sidecar's
  `/api/logs` serves its recent lines).

## Open questions

- The real RP ID for the home server. Until it's chosen, use the config value.
- FileVault on the home server. Off means it comes back after a power cut with
  no one there. On means someone has to unlock it at the machine after a
  reboot.
- MCP OAuth address rules. The plan is to keep the sidecar's current rule,
  which allows authorization servers reached over a VPN.
