# Yarvis as a client-server app

Yarvis today is one desktop app. A Tauri core (Rust) owns settings, secrets,
PTYs and the window, and it spawns a Bun sidecar that owns everything else. The
webview talks to the core through `invoke` and to the sidecar over HTTP on
127.0.0.1.

This document describes the first pass at splitting that into one server and
several clients. The server can run on the same Mac or on another machine (an
always-on Intel Mac mini, for example). Clients are the web UI in a browser, a
thin Tauri app, and later a native macOS app and a phone app.

The spikes under `spikes/` on the `yarvis/explore-a-client-server-architecture`
branch tested the risky parts. Each has a `FINDINGS.md`.

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

- `server/crates/yarvis-server`: the binary and the axum app.
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

- First start prints a one-time setup code to stdout. Registering the first
  passkey with it creates the first device with the `admin` scope.
- A passkey sign-in creates a **device** with a random 32-byte token. Only its
  SHA-256 is stored. Clients send it as `Authorization: Bearer <token>`. Browser
  WebSockets can't set headers, so they send it as the first message instead,
  never in the URL.
- Scopes: `read`, `chat`, `approve`, `admin`. A passkey device gets all four.
  A token made for a bot or script gets only what it is given. Admin actions
  (devices, vault, settings that change secrets) also need a passkey check in
  the last 10 minutes.
- Revoking a device takes effect on its next request and closes its open
  WebSockets.
- Every event has a `device_id`. Proxied sidecar requests carry it in a header.

RP ID: passkeys are tied to one domain for good. The default for the first pass
is the host name the server is reached at, set in the config (`auth.rp_id` and
`auth.origins`). For a long-lived install, use a domain you own, with a
tailnet-only subdomain. The native iOS and macOS apps need that, because the
domain has to serve an `apple-app-site-association` file. `localhost` works for
a server and browser on the same Mac.

## Deployments

Two settings decide where secrets live and whether the server signs commits:

```toml
[secrets]
backend = "vault"        # "vault" | "keychain" | "onepassword"

[ssh_agent]
enabled = true           # the server's own ssh-agent for git signing
```

**Home server (the Intel Mac mini).** `backend = "vault"`, `ssh_agent.enabled =
true`. The server starts locked. A passkey unlock (PRF) or the recovery key
opens the vault, starts the sidecar with its secrets, and starts the ssh-agent.
Git in a workspace uses `SSH_AUTH_SOCK` pointing at that agent, and every
signature waits for an approval from any device with the `approve` scope.

**Work laptop.** `backend = "onepassword"` (or `"keychain"`),
`ssh_agent.enabled = false`. Secrets and the signing key stay in 1Password,
managed the way they are today. Workspace PTYs inherit the user's own
`SSH_AUTH_SOCK`, which is 1Password's agent. You can still reach this server
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
to a browser. Cookies are not used for auth.

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

Auth (no token needed):

- `GET  /api/auth/status` → `{ setupRequired, rpId, vault: "absent"|"locked"|"unlocked" }`
- `POST /api/auth/setup/start` `{ code, deviceName }` → WebAuthn creation options
- `POST /api/auth/setup/finish` `{ credential }` → `{ token, device }`
- `POST /api/auth/login/start` → WebAuthn request options
- `POST /api/auth/login/finish` `{ credential, deviceName }` → `{ token, device }`

Devices (token needed):

- `GET    /api/devices/me`
- `GET    /api/devices` (admin)
- `POST   /api/devices/tokens` `{ name, scopes }` (admin, fresh) → `{ token, device }`
- `DELETE /api/devices/{id}` (admin, fresh)
- `POST   /api/auth/reverify/start|finish` (passkey check, makes the device fresh)

Events and approvals:

- `GET /api/events` (WebSocket, `read`). The first client message is
  `{"type":"auth","token":"..."}`. Then the server sends
  `{"type":"event", seq, at, deviceId, kind, data}`. A client that reconnects
  sends `{"type":"auth","token":"...","since":seq}` to catch up.
- Event kinds clients act on:
  - `alarm.fire` and `alarm.release`: what the control channel's alarm methods
    did to the window. `data` is the alarm, as `alarms.rs` builds it.
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

PTY:

- `GET /api/pty/{id}` (WebSocket, `chat`). Auth as above, plus
  `"offset": n` to resume. Then the protocol from `spikes/pty-ws`: binary
  frames are output, `{"type":"input"|"resize"|"focus"}` from the client.

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
  and `chat` for everything else.

## Open questions

- The real RP ID for the home server. Until it's chosen, use the config value.
- FileVault on the home server. Off means it comes back after a power cut with
  no one there. On means someone has to unlock it at the machine after a
  reboot.
- MCP OAuth address rules. The plan is to keep the sidecar's current rule,
  which allows authorization servers reached over a VPN.
