# Yarvis as a client-server app

Yarvis today is one desktop app. A Tauri core (Rust) owns settings, secrets,
PTYs and the window, and it spawns a Bun sidecar that owns everything else. The
webview talks to the core through `invoke` and to the sidecar over HTTP on
127.0.0.1.

This document describes splitting that into one server and several clients.
The server can run on the same Mac or on another machine (an
always-on Intel Mac mini, for example). Clients are the web UI in a browser, a
thin Tauri app, and later a native macOS app and a phone app.

Spikes tested the risky parts first. They live on the
`yarvis/explore-a-client-server-architecture` branch, under `spikes/`, as
reference code that isn't meant to merge. Each has a `FINDINGS.md`, and
references below to `spikes/...` point there.

## What's built and what isn't

Built:

- `yarvis-server`: config, its tables in Postgres, sign-in with a passphrase and a
  TOTP code (or a backup code), set up with a one-time setup code, devices and
  scoped tokens (`read`, `chat`, `terminal`, `approve`, `admin`), `Fresh<S>`
  checks (a TOTP code in the last 10 minutes), the event log and `/api/events`,
  approvals, and Host and CSP checks.
- Settings and the secrets blob, in the Keychain, 1Password or the server's
  own vault. The vault opens with its own passphrase or the recovery key.
- The sidecar's supervisor and the `/api/sidecar` proxy. The sidecar runs only
  while the secrets can be read, so with the vault it starts on unlock and
  stops on lock.
- PTY sessions over `/api/pty/{id}` with resume, the sidecar's control socket,
  and alarms as events.
- The optional ssh-agent, which signs git commits after an approval. Workspace
  shells point `SSH_AUTH_SOCK` at it.
- The web UI as a server client: sign-in, a vault unlock screen, Settings →
  Devices, and an approvals list.
- The thin Tauri app, which starts a local server or connects to a remote one.
- A first native macOS app (`apps/macos/`): chat, attention and approvals,
  and terminals natively, the rest in a web view. See
  [native-macos.md](native-macos.md).
- An end-to-end test (`bun run e2e`, `e2e/`) that drives the real server and
  the built UI in Chromium, signing in with TOTP codes it computes.

Not yet:

- A phone app.
- Porting sidecar modules to Rust.
- Passkeys, as an optional second way to sign in beside the passphrase.
- An OpenAPI description.

## Goals

- One Rust binary, `yarvis-server`, that a browser can use with no Tauri app
  installed.
- Every client signs in with the passphrase and a TOTP code, or uses a scoped
  device token. Every event records which device caused it, and a device can
  be revoked at once.
- PTY sessions (Claude Code in a workspace) stream over WebSocket to any number
  of clients and survive a client disconnecting.
- Secrets can live in the server's own encrypted vault, unlocked with its own
  passphrase.
  The server can also run its own ssh-agent to sign git commits after an
  approval. Both are optional: a server can keep using the macOS Keychain or
  1Password, with no ssh-agent at all (see "Deployments").
- The existing UI keeps working, in a browser and in the Tauri app, with no
  feature lost.

Out of scope: porting the sidecar's TypeScript to Rust, the
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
  ├─ /api/auth/*, /api/account/*      sign-in, the account
  ├─ /api/devices/*                    devices, scoped tokens
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

The sidecar calls back into the server over a Unix-socket control channel
(`server/crates/yarvis-server/src/control.rs`), with the same methods as the
desktop app's core. Anything the sidecar would trigger in the window, such as ringing an alarm, becomes an event on
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
  - `store`: server state (the account, devices, events, approvals) in the
    `yarvis_server` schema of the Postgres database the sidecar also uses, through
    `sqlx` with runtime queries. The server runs its own migrations
    (`migrations/`, tracked in `yarvis_server._sqlx_migrations`), and Drizzle's
    config filters to `public`, so neither sees the other's tables. With Postgres
    down nobody can sign in or unlock the vault; see "Postgres" below.
  - `database_url`: where the database URL comes from (see "Postgres").
  - `auth`: the account (passphrase, TOTP, backup codes), devices, tokens,
    scopes, the setup code.
  - `events`: the append-only event log and the `/api/events` WebSocket.
  - `approvals`: pending approvals, answered by the first device to respond.
  - `secret_store`: the `SecretBackend` trait with Keychain, 1Password and vault
    backends. The JSON blob format is the one `src-tauri` uses today.
  - `vault`: the encrypted vault and its passphrase and recovery wrappers.
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

The server has one account. Signing in takes its passphrase and a code from an
authenticator app (TOTP), or one of its backup codes.

- **Setup.** First start prints a one-time setup code to stdout, and writes it
  to a `0600` file in the data dir for a server whose stdout goes to a log. It
  allows 5 wrong guesses. Setup takes the code, a passphrase and a device name,
  and returns a new TOTP secret (as text, an `otpauth://` URI and a QR code).
  Setup finishes only when a code from that secret verifies. That creates the
  account and the first device with all five scopes, and returns 10 one-time
  backup codes, shown once. The setup routes answer `409` once the account
  exists.
- **The passphrase** is at least 12 characters, stored as an Argon2id hash
  (19 MiB, 2 passes, the OWASP minimum), hashed off the async workers and
  compared in constant time.
- **TOTP** is RFC 6238 with the parameters every app defaults to: SHA-1,
  6 digits, 30-second steps, and one step either side of now. A code at or
  before the last accepted step is refused, so a code works once. The check and
  the write of the accepted step hold the account row (`SELECT ... FOR UPDATE`),
  so two servers on one database can't both accept one code. The secret is
  stored in Postgres as it is, since the server computes codes from it: whoever
  can read the database can make codes. The passphrase hash still stands
  between them and a sign-in.
- **Backup codes** are 10 codes of 10 characters, stored as SHA-256 (they
  carry about 49 bits each, so a slow hash adds nothing). Each signs in once in
  place of a TOTP code.
- **Sign-in** checks the passphrase first and the second factor only after it
  matches, and every refusal says only "wrong passphrase or code". Each sign-in
  creates a new **device** with a random 32-byte token, sent as base64url
  without padding. Clients treat it as opaque. Only its SHA-256 is stored.
  Clients send it as `Authorization: Bearer <token>`. Browser WebSockets can't
  set headers, so they send it as the first message instead, never in the URL.
  Signing in again from the same browser makes a second device. The devices
  page shows when each was last used, so old ones are easy to revoke.
- **Lockout.** Ten failures in 15 minutes (sign-ins, reverify codes, or a
  wrong current passphrase on a passphrase change), from anywhere, lock sign-in for 15 minutes. That caps guessing, and it also lets
  anyone who can reach the server keep the owner locked out by failing on
  purpose; that trade is accepted. On top of it, the sign-in and setup routes
  are rate-limited per address.
- A token unused for 90 days stops working.
- Scopes: `read`, `chat`, `terminal`, `approve`, `admin`. A signed-in device
  gets all five. A token made for a bot or script gets only what it is given,
  and `POST /api/devices/tokens` can't give `terminal` or `admin`.
- **Fresh**: device management, the account changes, and changing the vault's
  passphrase or recovery key or the secrets backend also need a recent check
  on this device: a sign-in or a TOTP code (`POST /api/auth/reverify`) in the
  last 10 minutes (`verified_at`). Without one they get
  `403 { "error": "reauth_required" }`, and the client asks for a code and
  retries. Only devices made by a sign-in can be fresh; a token never can.
  Setting and deleting secrets need only `admin`, so the Tauri app's CLI-made
  token can manage its own keys. Unlocking and locking the vault need only
  `admin` too: an unlock is a check of its own, and the recovery key has to
  work for an admin token made with the CLI.
- **Account changes** (admin and fresh): change the passphrase (with the
  current one), set up a new authenticator (confirmed with a code from it),
  make new backup codes, and sign out every other device. A passphrase or
  authenticator change keeps the other devices signed in unless asked to sign
  them out.
- **Recovery.** A lost authenticator is what the backup codes are for. With
  those gone too, `yarvis-server auth reset` on the server removes the account
  and prints a new setup code, which the running server accepts at once. It
  needs the same trust as `device add`: a shell on the server. Signed-in
  devices stay signed in, unless it runs with `--sign-out-all`, which revokes
  every device, tokens included: after a compromise, the attacker's device is
  one of them. A running server refuses those tokens at once, and closes
  their open sockets within about 2 seconds, when it next checks the devices
  table for revocations another process made.
- Tokens minted over the API (`POST /api/devices/tokens`) can't have `admin`
  or `terminal`. Tokens made with the CLI on the server machine can, since
  whoever runs that can already read the database and open a shell.
- `401` means no token, or a token that's unknown, revoked or expired, and
  clients sign out on it. `403` means the device lacks the route's scope,
  isn't fresh, or sent a wrong code, passphrase or vault secret.
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
`*.ts.net` name. Add that URL to `auth.origins`; sign-in isn't tied to a
domain, so nothing else is needed.

## Deployments

Two settings decide where secrets live and whether the server signs commits.
A full `server.toml`, with the defaults:

```toml
[server]
bind = "127.0.0.1:7878"
data_dir = "~/.yarvis/server"   # written out in full; ~ isn't expanded
# web_dir = "/path/to/dist"     # the built web UI; unset serves only /api
allow_plain_http = false        # needed for any bind that isn't loopback
# path = "/opt/homebrew/bin:/usr/bin:/bin"  # PATH for the sidecar and sessions;
                                # unset, they get the server's own

[auth]
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

[database]
# url = "postgres://localhost:5432/yarvis"   # YARVIS_DATABASE_URL wins over it
schema = "yarvis_server"        # where the server's own tables live
```

With `secrets.backend` unset, the server follows `secretBackend` in
`~/.yarvis/settings.json`, as the desktop app does: 1Password when it says
`"onepassword"`, the Keychain otherwise. An existing install, such as a work
laptop already on 1Password, keeps its store when the Tauri app starts a local
server, and Settings can still switch between the two. Once `server.toml`
names a backend, it wins, and Settings can only change which 1Password item a
1Password server reads. Every settings response carries that choice as
`configuredSecretBackend` (`null` when `secretBackend` decides), so Settings
shows the store really in use and offers no switch the server would refuse.

The server refuses `ssh_agent.enabled = true` with any backend but `vault`,
since the vault is where the signing key lives.

**Home server (the Intel Mac mini).** `backend = "vault"`, `ssh_agent.enabled =
true`. The server starts locked. The vault passphrase or the recovery key
opens the vault, starts the sidecar with its secrets, and starts the ssh-agent.
Git in a workspace uses `SSH_AUTH_SOCK` pointing at that agent, and every
signature waits for an approval from any device with the `approve` scope.
Setting it up:

1. Set `backend = "vault"` and `ssh_agent.enabled = true` in `server.toml`.
2. Run `yarvis-server vault init`. It asks for the vault passphrase twice
   (or reads it with `--passphrase-stdin`), writes `vault.json` (`0600`) to
   the data dir and prints the recovery key to stdout, once. Write the key
   down.
   With the agent on it also makes the signing key and prints its public key
   to stderr, for GitHub's signing keys and for `user.signingkey`.
3. Start the server and sign in. The web UI shows an unlock screen while the
   vault is locked; unlock with the vault passphrase.
4. Point git at the agent: `gpg.format = ssh`, `user.signingkey =
   "key::<public key>"`. Workspace shells get `SSH_AUTH_SOCK` from the server.

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
server never makes a signing key, never opens an agent socket, and
`/api/vault/ssh-agent` returns 404, so the UI hides the signing section.

Outbound HTTPS from the server uses the bundled Mozilla roots
(`webpki-root-certs` with reqwest's `tls_certs_only`), never the macOS
platform verifier, which fails in a process with no keychain. See
`spikes/headless/FINDINGS.md`.

`keychain` and `onepassword` only work when the server runs inside a logged-in
macOS session (a LaunchAgent, or the Tauri app starting it). A server started
at boot, before anyone logs in, has no keychain. That setup needs `vault`. See
`spikes/headless/FINDINGS.md`.

## Postgres

The server and the sidecar share one Postgres database (with pgvector, for the
sidecar), as the desktop app does (`docs/getting-started.md`). The server keeps
its tables in the `yarvis_server` schema; the sidecar's are in `public`.

**The URL** comes from, in order:

1. `YARVIS_DATABASE_URL` in the server's environment.
2. `url` under `[database]` in `server.toml`. The URL can carry a password, so
   the server warns when others can read the file.
3. `database_url` in the Keychain or 1Password item, where older versions
   saved it from Settings. Read only with those backends, never the vault,
   which is locked at boot. The server logs a warning asking for the URL to be
   moved.
4. `postgres://localhost:5432/yarvis`, the database the getting-started guide
   creates.

The server hands the URL to the sidecar as `DATABASE_URL`. Settings shows it,
with any password masked, and where it came from; it can't be changed there,
since the server needs it before anyone signs in. A server on the Keychain or
1Password backend, the bundled one the Tauri app starts included, still finds
an older install's URL there (3), and uses the default (4) otherwise.

**Two servers on one database** (a `dev:instance` beside the main app, or the
tests) need different `[database] schema` values, or they share one account
and devices, and each start denies the other's pending approvals. The Tauri app
writes `yarvis_server_<instance>` for a named instance.

**When Postgres isn't up**, as for a moment when launchd starts the server at
boot, the server listens anyway and retries the connection with backoff (1s,
doubling, at most 30s apart) until it gets one. Until then `/api/health` and
every route that reads the database answer `503` with
`database_unavailable`, and the sign-in screen says it is waiting and retries.
The sidecar starts once the database is ready. A Postgres that goes away later
gives `503`s per request, not `401`s, so no client is signed out. CLI commands
wait 10 seconds and then fail.

**Older installs** kept the server's state in `<data_dir>/server.db`. Nothing
is copied from it: set the account up again with the new setup code. The
server logs a line while the file is there, and it can be deleted.

**Ordering guarantees** that SQLite's single writer gave come from Postgres
locks: a TOTP code, the setup code and an approval answer are each checked and
written under a row lock or one conditional `UPDATE`, so the first of two racing
requests wins. Events take a transaction-scoped advisory lock per schema while
they insert, so `seq` values commit in order across processes, and a client
catching up with `since` never skips one that committed late.

**Revocations by another process** (`auth reset --sign-out-all`) still reach
open sockets through a two-second poll of the devices table. `LISTEN`/`NOTIFY`
would make that immediate; it is a possible follow-up.

## Running it

Every setup needs Postgres with pgvector (see "Postgres").

**A single Mac (the Tauri app).** Nothing to configure.

1. Install and open the app. It writes `server.toml` into its app data folder,
   starts the bundled `yarvis-server` on a loopback port, and pairs itself with
   `yarvis-server device add`, keeping the token in the Keychain.
2. Secrets stay wherever Settings says (the Keychain unless you chose
   1Password), and workspace shells get 1Password's SSH agent when it exists.
3. For the actions that need a fresh device (minting or revoking devices,
   account changes, switching the secrets backend), open
   `http://localhost:<port>` in a browser on the same Mac, with the port from
   `bind` in `<app data>/server.toml`, and set up the account with the code in
   `<app data>/server/setup-code`. The app's own token can't do them. The app
   keeps its port across restarts when it is free.

**A home server with the vault and ssh-agent, behind `tailscale serve`.** The
server runs on an always-on Mac and you reach it from anywhere on the tailnet.

1. Build the UI (`bun run build`) and the server
   (`cargo build --release --manifest-path server/Cargo.toml`).
2. Write `~/.yarvis/server.toml`, with your machine's tailnet name:

   ```toml
   [server]
   bind = "127.0.0.1:7878"              # tailscale serve connects here
   data_dir = "/Users/me/.yarvis/server"
   web_dir = "/Users/me/yarvis/dist"
   # launchd's PATH misses Homebrew and mise, where claude, git, gh and bun are
   path = "/Users/me/.local/share/mise/shims:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

   [auth]
   origins = ["https://mac-mini.example-tailnet.ts.net"]

   [secrets]
   backend = "vault"

   [ssh_agent]
   enabled = true
   ```

   The bind stays on loopback, so `allow_plain_http` isn't needed: TLS ends
   at `tailscale serve`, on the same machine.
3. Run `yarvis-server vault init`, choose the vault passphrase, and write
   down the recovery key it prints. Add the signing key it prints to GitHub
   as a signing key.
4. Set the database, with `[database] url` in `server.toml` or
   `YARVIS_DATABASE_URL` in the LaunchAgent's environment, unless the default
   `postgres://localhost:5432/yarvis` is right. Start the server (a LaunchAgent
   keeps it running), then
   `tailscale serve --bg 7878` to publish it as
   `https://mac-mini.example-tailnet.ts.net`.
5. Open that URL, enter the setup code from `<data_dir>/setup-code`, choose
   the sign-in passphrase, scan the QR code into an authenticator app, confirm
   a code, and save the backup codes. The vault unlock screen comes next; enter
   the vault passphrase. The sidecar starts once the vault is open.
6. Every commit a workspace shell signs waits for an approval, which any
   device with `approve` can give from the approvals box. Locking the vault
   stops the sidecar and the agent until the next unlock.
7. To pair a Tauri app with this server, make its token on the server with
   `yarvis-server device add --name Laptop --scopes read,chat,terminal,approve`,
   so its terminals work.

**The work laptop, with 1Password and no server agent, reached remotely.**
Secrets and the signing key stay in 1Password, and the server never holds a
key.

1. Use the Tauri app as on a single Mac, or run the server yourself with
   `[secrets] backend = "onepassword"` and `[ssh_agent] enabled = false`. A
   server under launchd also needs `upstream_socket` set to 1Password's agent
   socket (see "Deployments").
2. To reach it from another device, publish its port (the `bind` in its
   `server.toml`) with `tailscale serve` as for the home server, and add the
   laptop's `https://` tailnet URL to `auth.origins`.
3. Commits are signed by 1Password's agent, which asks on the laptop. So while
   you're away from the laptop, workspace sessions can run but can't sign
   commits; nothing in the server works around that.

## Clients

All clients use the same HTTP and WebSocket API. Nothing in the API is specific
to a browser. Cookies are not used for auth (see "Browser tokens and XSS").

**Web UI.** The React app in `src/`, built by Vite and served by the server.

1. `src/lib/server.ts` talks to the page's own origin. `sidecarFetch` sends
   the device token to `/api/sidecar/...`.
2. Every core command goes through one function, `core(cmd, args)`, which
   calls `/api/core/...` on the server. A few commands only make sense on the
   machine you sit at (clipboard history, focusing a window). For those, `core`
   uses the Tauri bridge when the page runs inside the Tauri app, and the UI
   hides the feature otherwise.

The UI is always served by the server it talks to, in a browser and in the
Tauri window alike, so every request is same-origin and needs no CORS.

In front of the app are three screens, in this order: sign-in (passphrase
and code, or first-run setup), the vault unlock screen while the vault is locked, and the boot
screen while the sidecar starts. There's also a devices page in Settings and
an approvals list.

**Thin Tauri app.** A window, a tray icon, global shortcuts, the clipboard
history, alarm takeovers and notifications. It either starts a local
`yarvis-server` (the default, so a single Mac still works with one app) or
connects to a server URL. It keeps its device token in the Keychain. It doesn't
spawn the sidecar or own any PTYs.

**Native macOS app.** A SwiftUI app over the same API, in `apps/macos/`.
See [native-macos.md](native-macos.md) for what it builds natively, each API
surface's Swift counterpart, and what in the API gets in its way.

To keep that possible, the API has to stay plain: JSON bodies, typed error
bodies (`{ "error": "...", "detail": "..." }`), and WebSocket messages as
tagged JSON (`{"type": "...", ...}`).

**Android app.** A Kotlin and Jetpack Compose app in `apps/android/`, scoped to
chat and the attention stream: answering tool approvals, permission prompts,
questions and server approvals from a phone. It signs in with the passphrase
and a code, keeps its token encrypted with a Keystore key, and needs an HTTPS
origin, normally a `tailscale serve` name. It follows the sidecar's attention
SSE stream for the bell's items and `/api/events` for server approvals. It has
no push, so it notifies only while open or shortly after. See
[apps/android/README.md](../apps/android/README.md).

## API contract

All routes are under `/api`. Errors are `{ "error": string, "detail"?: string }`.
Times are milliseconds since the Unix epoch. A **device** in a response is:

```json
{ "deviceId": "…", "name": "My iPhone", "scopes": ["read", "chat"], "verifiedAt": 1763600000000 }
```

The devices list adds more fields (see `GET /api/devices`). Tokens and their
hashes never appear in a response, except the one time a token is created.

- `GET /api/health` → `{ "status": "ok", "service": "yarvis-server" }`, no token.

Auth (no token needed):

- `GET  /api/auth/status` → `{ setupRequired, vault: "absent"|"uninitialized"|"locked"|"unlocked" }`.
  `absent` means the backend isn't `vault`; `uninitialized` means it is, but
  `yarvis-server vault init` hasn't run.
- `POST /api/auth/setup/start` `{ code, passphrase, deviceName }` →
  `{ enrollmentId, secret, otpauthUri, qrSvg }`. `code` is the setup code,
  `secret` is base32, and `qrSvg` is an SVG document. A short passphrase is
  `400`; a wrong setup code is `401` with the tries left in `detail`.
- `POST /api/auth/setup/finish` `{ enrollmentId, code }` →
  `{ token, device, backupCodes }`. `code` is the first TOTP code; a wrong one
  is `403`, and the enrollment stays open until 10 minutes after
  `setup/start`. An unknown or expired `enrollmentId` is `400`, and a setup
  code used meanwhile is `401`.
- `POST /api/auth/login` `{ passphrase, code | backupCode, deviceName }` →
  `{ token, device }`. Any wrong factor is `401 { "error": "wrong passphrase
  or code" }`; while sign-in is locked, `429`. Sending both or neither of
  `code` and `backupCode` is `400`; before setup, `409`.

The setup and sign-in routes (not `status`) are rate-limited per client
address. Once the account exists the setup routes answer `409`.

Devices and the account (token needed):

- `GET    /api/devices/me` (`read`) → the calling device
- `DELETE /api/devices/me` (any valid token; needs no scope and no recent code) →
  `{ revokedAt }`: signs this device out. It closes the device's sockets and
  appends `device.revoked` as revoking it from another device would. It can
  only reach the calling device.
- `GET    /api/devices` (admin) → every device, revoked ones included:
  `[{ deviceId, name, kind: "login"|"token", scopes, createdBy,
  userAgent, createdAt, lastSeenAt, verifiedAt, revokedAt, current }]`.
  `current` marks the calling device.
- `POST   /api/devices/tokens` `{ name, scopes }` (admin, fresh) → `{ token, device }`.
  `scopes` can't include `admin` or `terminal` (`400`).
- `DELETE /api/devices/{id}` (admin, fresh) → `{ revokedAt }`
- `POST   /api/auth/reverify` `{ code }` (admin) → `{ verifiedAt }`: a TOTP
  code that makes the device fresh. Only a signed-in device can; a token gets
  `403`. A wrong code is `403` and counts towards the lockout.
- `GET    /api/account` (admin) → `{ backupCodesLeft }`
- `POST   /api/account/passphrase` `{ currentPassphrase, newPassphrase,
  signOutOtherDevices? }` (admin, fresh) → `{ revokedDevices }`. A new
  passphrase under 12 characters is `400`; a wrong current one is `403` and
  counts towards the lockout; while locked, `429`.
- `POST   /api/account/totp/start` (admin, fresh) → an enrollment, as setup
  returns, that only this device can finish; `/finish` `{ enrollmentId, code,
  signOutOtherDevices? }` → `{ revokedDevices }` replaces the secret.
- `POST   /api/account/backup-codes` (admin, fresh) → `{ backupCodes }`,
  replacing every old one.
- `POST   /api/account/sign-out-others` (admin, fresh) → `{ revokedDevices }`:
  every live device but this one, tokens included.

"Fresh" means a sign-in or a TOTP code in the last 10 minutes. Without one
these routes answer `403 { "error": "reauth_required" }`.

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
  - `account.created`, `account.changed` (`{ what: "passphrase"|"totp"|"backupCodes" }`),
    `account.backup_code_used` (`{ left }`) and `account.reset`
    (`{ signOutAll, revokedDevices }`, preceded by a `device.revoked` for each
    device it signed out).
  - `sidecar.started` and `sidecar.stopped`: the sidecar restarted, so cached
    data may be stale.
  - `vault.locked` and `vault.unlocked`. `vault.unlocked` has `via`
    (`"passphrase"` or `"recovery"`). `vault.passphrase_changed` and
    `vault.recovery_key_rotated` follow those changes.
  - `pty.started`: `{ id, kind, workspaceId }`, as in `GET /api/pty`.
  - `pty.exited`: `{ id, code }`.
  - `ssh_agent.grant_started` (`{ expiresAt, keyFingerprint }`, from the
    device that allowed it), `ssh_agent.grant_ended` (`{ reason: "stopped" }`)
    and `ssh_agent.signed` (`{ keyFingerprint, hashAlgorithm, grantedBy,
    grantExpiresAt }`, one per signature made without asking). See the
    ssh-agent below.
- `GET  /api/approvals` (`read`) → the pending ones, oldest first:
  `[{ id, kind, summary, data, createdAt, expiresAt, maxAllowForSecs? }]`.
  `kind` names the requester (`git.sign`), `summary` is the line to show,
  `data` is the requester's own details (for `git.sign`, `keyFingerprint` and
  `hashAlgorithm`), and times are milliseconds since the epoch.
  `maxAllowForSecs` is set when approving may also cover later requests, and
  is the longest it may.
- `POST /api/approvals/{id}` `{ approve: bool, allowForSecs? }` (`approve`).
  The first answer wins. Later answers get `409`, and so does an answer after
  the approval timed out. No answer in time, a restart, or a requester that
  stops waiting all count as a denial; `approval.answered` then has
  `deviceId: null` and a `reason`. `allowForSecs` lets an approval cover later
  requests for that long; it is `400` on a denial, on an approval without
  `maxAllowForSecs`, or past it, and nothing is recorded then.
  `approval.answered` carries it as `allowForSecs`.

Core (what `invoke` did; one route per command, JSON body = the command's
arguments with the same camelCase keys the frontend passes to `invoke` today,
response = its return value, `204` for none):

- `POST /api/core/{command}`, for example `/api/core/get_settings` or
  `/api/core/set_secret`. Scope: `admin` for anything that writes secrets or
  settings, `terminal` for PTY control, `read` for reads. A command that only makes
  sense on the client machine is not served here.

PTY (`terminal` to drive a session, `read` to look at one):

`terminal` lets a device run a shell as the user the server runs as. From
there it can reach everything that user can, the control socket and the
secrets store included, so treat `terminal` as full trust. Only signed-in
devices and `yarvis-server device add` get it; a token minted over the API
can't.

`chat` opens no shell, but it is broad on purpose: it starts workspaces,
runs their setup, and drives their agent sessions, directly and through the
assistant. Those agents act with their own permissions, so a `chat` device
is trusted with the workspaces. What `terminal` adds is raw shell access:
the PTY socket and commands below, and saving a file into a worktree
(`PUT /api/workspaces/:id/repos/:wrId/file`), since a planted hook runs as the
server's user. `admin` reaches a shell indirectly too: `set_agent` and
`set_agent_harnesses` choose the command `pty_start_claude` runs.

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
  `terminal`, since the commands are user-written and can carry a `VAR=secret`.

- `GET /api/pty` (`terminal`, as attaching needs) → `{ sessions: [{ id, kind,
  workspaceId, cwd, harness, startedAt, running, exitCode, attached }] }`,
  oldest first. `kind` is `"agent"` for a workspace's agent session
  (`ws-claude:<workspaceId>`), `"review"` for a review workspace's Ask Claude
  session (`review-claude:<workspaceId>`), and `"shell"` for every other
  terminal. `workspaceId` is the workspace the id names (`ws-claude:`,
  `review-claude:`, or a pane `ws:<workspaceId>/<tab>/<pane>`), else `null`.
  `cwd` is the folder the shell started in, or `null` for the default (the
  home folder). `harness` is `{ id, name }` for an agent session and `null`
  otherwise. `startedAt` is Unix milliseconds. A session whose shell exited
  stays listed with `running: false` and its `exitCode` until it is killed
  or replaced. Attaching to an exited shell's id starts a new shell there; a
  review session is replaced only by starting a new review. `attached` counts
  the clients attached now. `pty.started` and `pty.exited` events say when to
  list again. They are appended separately, so for a shell that exits at
  once `pty.exited` can come first; list again rather than track state from
  the events.
- `GET /api/pty/{id}` (WebSocket, `terminal`). `{id}` is the session id,
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
`YARVIS_CORE_SOCK`. A Unix socket path must fit in about 104 bytes on macOS
(108 on Linux), so when the data dir is too deep for that, the server's
sockets go in `~/.yarvis/run/<hash of the data dir>/` instead, and
`[server] socket_dir` puts them anywhere else (`socket_dir.rs`). Either
folder must be a real folder owned by the server's user with mode 0700. The
server refuses to start if the control socket can't be bound.

The control socket keeps `control.rs`'s method list and checks. Two things
differ from the desktop app: the alarm methods append `alarm.fire` and
`alarm.release` events instead of taking over a window, and `mcp.saveOAuth`
and `github.saveToken` write the secrets blob in whichever backend the server
uses.

Each PTY gets `SSH_AUTH_SOCK` from the `[ssh_agent]` config: with
`enabled = false`, `upstream_socket` when set, else the server's own value;
with `enabled = true`, always the server's own `ssh-agent.sock` (in the data
dir, or the folder above), never another
agent. That socket exists only while the vault is unlocked, so a shell signs
while it's open and fails to sign while it's locked, including a shell started
while it was locked.

Vault (only when `secrets.backend = "vault"`; every route is 404 otherwise):

The vault has its own passphrase, separate from the sign-in passphrase, and
the two should differ. Sign-in proves who is asking a running server; the
vault passphrase is what decrypts `vault.json`, which anyone with a copy of the
file can attack offline with nothing else in the way. So it is stretched
harder (Argon2id, 64 MiB, 3 passes, under a salt of its own), never stored,
and a leak of the sign-in passphrase or the database doesn't open the vault.

- `GET  /api/vault/status` (`read`) → `{ state: "uninitialized"|"locked"|"unlocked",
  wrappers: [{ id, label, kind: "passphrase"|"recovery" }] }`
- `POST /api/vault/unlock` `{ passphrase }` (admin) → `{ state }`. A wrong
  passphrase is `403`, and makes the next try wait: 1 second, then doubling to
  at most 5 minutes, cleared by a right one. Trying sooner is `429`, and so
  is a try sent while another is still being checked. A wait
  only slows guessing; unlike a lockout, it can't keep the owner out for long,
  and only an admin device can make it grow.
- `POST /api/vault/unlock/recovery` `{ recoveryKey }` (admin) → `{ state }`.
  Not slowed, since the key can't be guessed, and not fresh, so an admin token
  made with the CLI can recover the vault.
- `POST /api/vault/lock` (admin) → `{ state }`. Stops the ssh-agent first.
- `POST /api/vault/passphrase` `{ currentPassphrase | recoveryKey,
  newPassphrase }` (admin, fresh, unlocked) → `{ state }`: re-wraps the vault
  key under the new passphrase. The old one stops working. Sending both or
  neither proof is `400`, and so is the sign-in passphrase as the new one. A
  wrong proof is `403`; a wrong passphrase slows the next try as an unlock's
  does (`429` while waiting).
- `POST /api/vault/recovery-key` `{ currentPassphrase | recoveryKey }` (admin,
  fresh, unlocked) → `{ recoveryKey }`, shown once. The old key stops
  working. It needs the same proof as a passphrase change: otherwise a stolen
  fresh device could rotate the key, then use the new key to replace the
  passphrase.
- `GET  /api/vault/ssh-agent` (`read`) → `{ enabled: true, publicKey?, socketPath?,
  grantExpiresAt? }`, with the key and socket only while the agent runs and
  `grantExpiresAt` only while signing is allowed without asking; 404 when
  `ssh_agent.enabled = false`.
- `DELETE /api/vault/ssh-agent/grant` (`approve`) → `204`. Goes back to
  asking before every signature. Also `204` when no grant was active.

The ssh-agent listens on `ssh-agent.sock` (`0600`) in the data dir (or the
folder above, for a long data dir or a `socket_dir`) while the
vault is unlocked, and locking removes it. It serves one Ed25519 key and signs
only SSHSIG blobs in the `git` namespace with a `sha256` or `sha512` hash,
refusing anything else before asking anyone. Each signature is an approval of kind `git.sign`, with the key's
fingerprint in the summary; SSHSIG carries only a hash of the commit, so there
is no repo or message to show. No answer in 60 seconds, a denial, or a lock
while it waits refuses the signature and fails `git commit`.

An approver can also allow signing for a while, up to an hour
(`allowForSecs` on the answer), as 1Password's agent does. Until it ends,
signatures are made without asking, for any process that can reach the
socket, and each one appends `ssh_agent.signed`; one that can't be recorded is
refused. The grant is kept only in memory, so locking the vault, the agent
stopping or a restart ends it, as does `DELETE /api/vault/ssh-agent/grant`.
It never widens what is signed: the namespace and hash checks still come
first.

Pairing a device that can't sign in itself:

- `yarvis-server device add --name NAME --scopes read,chat,terminal,approve,admin`
  prints a token. Only someone who can run commands on the server machine can
  do this, which is the same trust as reading the setup code. The thin Tauri
  app uses it when it starts a local server.
- A signed-in admin device can mint one with `POST /api/devices/tokens`. The
  user pastes it into the client being paired (a Tauri app pointed at a remote
  server, a script).

OAuth redirects (no token: a browser arriving from an authorization server):

- `GET /api/oauth/mcp/callback?code&state` and
  `GET /api/oauth/google/callback?code&state`, each forwarded to the
  sidecar's own callback with the query only, none of the browser's headers. The sidecar
  accepts only a `state` its own flow issued, once. Nothing else on the
  sidecar is reachable this way. The sidecar registers this URL as the
  redirect when `auth.origins` has an `https` origin off loopback (passed to it
  as `YARVIS_PUBLIC_ORIGIN`), and its loopback callback otherwise.

Voice:

- `GET /api/voice/turn-detector/socket` (WebSocket, `chat`): continuous voice
  mode's audio. After the auth message, frames are relayed both ways to the
  sidecar's turn detector, which listens only on loopback. The server gets the
  detector's address and token from the sidecar's
  `/api/voice/turn-detector/upstream`, which the proxy never serves to a
  client; `/api/sidecar/api/voice/turn-detector` reports only its state.

Sidecar:

- `ANY /api/sidecar/{*path}` → the sidecar's `/{path}`, with `read` for `GET`
  and `chat` for everything else. Routes that change what the sidecar may do
  (MCP servers, custom providers, model choices, the sidecar's settings
  sections, the GitHub sign-in, standing tool consent, job and specialist
  definitions, registered repos) need `admin`, and so does reading the MCP
  endpoint's connection info, which carries its token. Answers to tool
  approvals, permission prompts and agent questions need `approve`.
  Saving a file into a worktree needs `terminal`; every other workspace
  route, starting a workspace or an agent run included, is `chat`. Rules are
  matched on the percent-decoded path, as the sidecar's router decodes it
  before routing. The proxy keeps that list (`SCOPE_RULES` in
  `sidecar_proxy.rs`). A path with `..`, an encoded slash or backslash, or an
  empty segment is refused. The client's own
  `Authorization` and `X-Yarvis-Device-Id` headers are dropped before the
  server adds its own. `sidecarFetch("/api/status")` becomes
  `/api/sidecar/api/status`: only `/health` and paths under `/api/` are
  served.
- While no sidecar process is up (the supervisor is waiting for the secrets,
  restarting it, or has stopped it because the vault locked), the proxy
  answers `503` and sends nothing to the sidecar's port, which another local
  process could have taken.
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

## Known gaps

[client-server-parity.md](client-server-parity.md) maps what the old Tauri
core did to where it lives now, with the test that covers each piece.

- **Google OAuth on a `*.ts.net` name is untried.** Google requires a Web
  application client's redirect host to end in a domain on the Public Suffix
  List, and `ts.net` is on it, but nobody has registered a `ts.net` redirect
  with Google yet.
- **Port squatting in local mode.** The Tauri app starts its server on a
  loopback port and sends it a token. Another local user who binds that port
  first receives the token. The app doesn't check the server's identity yet.
- **Revoking a device doesn't revoke what it minted.** Tokens minted by a
  revoked device stay valid until revoked one by one.
- **The local Tauri app can't do fresh actions.** Its token comes from
  `yarvis-server device add`, and a token device is never fresh, so minting
  and revoking devices, account changes and switching the secrets backend
  need a browser signed in with the passphrase. A remote Tauri app given a token minted over the
  API can't open terminals, since such tokens can't carry `terminal`; make
  its token with `device add` on the server instead.
- **Anyone who can reach the server can lock sign-in.** Ten wrong sign-ins
  in 15 minutes lock it for 15 minutes, whoever sends them.
- **The database holds the TOTP secret.** Whoever reads the `yarvis_server`
  schema can make codes; the passphrase's Argon2id hash is what still protects
  sign-in.
- **The sidecar's database role can read the server's tables.** The sidecar
  connects with the same URL, so a SQL injection in the sidecar, or anyone with
  that URL, can read the TOTP secret, the passphrase hash and the devices'
  token hashes (not the tokens), and write them. On one Mac that adds little,
  since the sidecar runs as the same user as the server and can read its
  files. A separate Postgres role for the server isn't practical on a default local
  Postgres, where the sidecar also needs to create tables and the `vector`
  extension. This holds until the sidecar's queries move into the server.
  With the default URL and Homebrew's Postgres, which trusts every local
  connection, "anyone with that URL" is any process on the Mac that opens a
  socket to it, terminal and agent sessions included: one could add itself a
  device. The server keeps `YARVIS_DATABASE_URL` out of the shells it starts,
  but that only hides the URL, and the default one is no secret. A password
  on the database (`docs/getting-started.md`) is what narrows it to
  whoever holds the URL.
- **Per-IP rate limits behind `tailscale serve`.** Every request arrives from
  127.0.0.1, so all clients share one budget on the setup and sign-in routes.
- **Some `read` routes run git.** Listing a repo's branches and a
  workspace's sync, stack and since-review views fetch or clone. They act
  only on repos an admin registered, with nothing the caller chooses.
- **A lock doesn't reach running PTY sessions.** Stopping the sidecar (on
  lock, restart or shutdown) kills it and every process it started, but PTY
  sessions keep the environment they started with. A sidecar that crashes on
  its own leaves its detached children (agent runs, the voice servers)
  reparented; its startup sweep ends the agent runs.
- **Monaco under the CSP is untested.** Monaco's TypeScript worker contains
  a `new Function(`. The end-to-end test doesn't open an editor, since that
  needs the sidecar, so whether it trips `script-src 'self'` is unchecked.

## Open questions

- FileVault on the home server. Off means it comes back after a power cut with
  no one there. On means someone has to unlock it at the machine after a
  reboot.
- MCP OAuth address rules. The plan is to keep the sidecar's current rule,
  which allows authorization servers reached over a VPN.
