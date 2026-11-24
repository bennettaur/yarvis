# A native macOS client

A first version lives in `apps/macos/` (build and run steps are in its
[README](../apps/macos/README.md)). This page maps each part of the server's
API ([client-server.md](client-server.md)) to Swift, says what the app builds
natively, and lists what in the API gets in its way.

## What's built

`apps/macos` is a Swift package with two targets:

- `YarvisClient`: the networking, with `Codable` models named after the
  server's and the web client's types, and no UI. It's the module an iOS app,
  or the Android client's authors, would mirror.
- `YarvisMac`: the SwiftUI app.

The app is laid out like the web UI: a sidebar with the Chat, Terminal,
Workspaces, Calendar, Alarms and Heads down pages in the web's order
and Settings at the bottom, and the attention bell as a panel. `AppModel` routes between pages as the web's
`App.tsx` does: an attention item, a `yarvis://` link or a workspace mention
opens the chat thread, workspace or terminal pane it names, and a PTY id is
routed by the surface that owns it (`tab:terminal/…` to Terminal,
`ws-claude:<id>` and `ws:<id>/…` to Workspaces).

Native:

- Sign-in and sign-out, the code prompt for `reauth_required`, the
  events socket and the vault unlock screen.
- Chat: tabs with concurrent turns, queued messages, reasoning, tool
  cards, edit and resend, the approval bar, artifacts and the MCP
  connection bar.
- Terminals: tabs and split panes in SwiftTerm, with a layout kept per
  surface in the web's shape.
- Workspaces: the list, the detail page with its agent and terminals,
  provisioning, new workspaces, archiving, changed and all files, diffs
  with review comments, and the editor.
- Calendar: agenda, week, month and day views, and meeting alarms.
- Alarms: the list, and a takeover driven by `alarm.fire` and
  `alarm.release` events and the `/api/alarms/stream` SSE.
- Heads-down mode: the run, questions and approvals, work streams,
  messages, routines, settings and the merge pop-ups. The live pass
  comes from `/api/heads-down/stream`, which only sends what happens
  after it connects, so the lists are read again on each connect.
- Settings: devices, pairing tokens and the account.
- Attention: items, server approvals, answering `ask_user` questions
  and permission prompts, dismissing and opening. New attention items
  post a macOS notification when the app runs as `Yarvis.app`.

In a `WKWebView`: everything else, including first-run setup, PRs, tasks,
memory, and the rest of Settings.

Checked against a real `yarvis-server` with the sidecar off: sign-in with a
passphrase and TOTP, `/api/devices/me`, signing out with
`DELETE /api/devices/me` (its 4401 close, then a second revoke answered
`401`), a wrong reverify code (`403`, the device stays signed in),
`/api/events` with `since`, a shell over `/api/pty/{id}` with its
`pty.exited` event and its exited row in `GET /api/pty`, and the `4401` and
`4403` closes. Chat and attention need the sidecar and Postgres, so they're tested
against stubs of the sidecar's JSON only.

## Each API surface and its Swift counterpart

| API surface | Swift |
|---|---|
| Setup, sign-in and `reverify` (`/api/auth/*`) | A SwiftUI form: passphrase, then a code; `URLSession` POSTs |
| Vault unlock (`/api/vault/unlock`) | A SwiftUI form for the vault passphrase |
| The device token | Keychain (`kSecClassGenericPassword`), sent as `Authorization: Bearer` |
| `/api/events` | `URLSessionWebSocketTask` |
| `/api/pty/{id}` | `URLSessionWebSocketTask` feeding SwiftTerm's `TerminalView` |
| JSON routes (`/api/core/*`, `/api/devices`, `/api/approvals`, `/api/sidecar/*`) | `URLSession` with `Codable` types; SSE streams through `URLSession.bytes` |
| Screens not rebuilt natively | `WKWebView` pointed at the server |
| Alarms, notifications, global shortcuts | Native, driven by `alarm.fire` and `alarm.release` events |

**Sign-in.** The same routes a browser uses: `POST /api/auth/login` with the
passphrase and a TOTP code (or a backup code) returns the device token, which
goes in the Keychain. Setup shows the `otpauth://` URI as a QR code (`qrSvg`
renders in any SVG view, or draw one from `otpauthUri`). Sign-in isn't tied
to a domain, so a `*.ts.net` name from `tailscale serve` works as it does in
a browser. Adding passkeys later, as a second way to sign in, would need the
Associated Domains entitlement and an `apple-app-site-association` route.

When a route answers `403 reauth_required`, ask for a code and send it to
`POST /api/auth/reverify`, then retry. A `401` means the token is gone: sign
in again.

**Events.** Open the socket, send `{"type":"auth","token":"…","since":seq}`
as the first message, and keep the last `seq` seen for the next connect. A
`{"type":"lagged"}` message means reload and reconnect without `since`. Close
codes `4401` (sign in again), `4403` (missing scope) and `4400` (bad request)
arrive as `closeCode`; don't retry after them.

**Terminals.** Send the hello with `cols`, `rows` and the last `offset`. Each
binary frame is an 8-byte big-endian offset then the bytes: feed the bytes to
`TerminalView.feed(byteArray:)` and keep the offset. On `mode: "snapshot"`,
reset the terminal before feeding. Send keystrokes as binary frames, and
`{"type":"resize"}` from `sizeChanged`. Opening terminals needs the
`terminal` scope. The list comes from `GET /api/pty`. Read it again on
each `pty.started` and `pty.exited` event rather than patch it from them,
since they can arrive in either order.

**WKWebView fallback.** The web view signs in on its own, with the
passphrase and a code, and becomes a device of its own. The app doesn't
inject its token into the page's `localStorage`: script on the page can read
`localStorage`, so the token would sit in a second, weaker place. The cost is
a second sign-in and a second row on the devices page.

**Chat and attention.** These are sidecar routes behind `/api/sidecar`.
A chat turn is `POST /api/chat` answered as SSE (`delta`, `tool_call`,
`tool_result`, `tool_approval_request`, `error`, `done`), read through
`URLSession.bytes`; cancelling the request stops the turn. The attention
stream (`/api/attention/stream`) replays nothing, so the list is reloaded
each time it reconnects.

## What in the API gets in the way

- **The sidecar has no typed schema.** `/api/sidecar/*` is a proxy to a few
  hundred Hono routes. A Swift client hand-writes types for each screen it
  rebuilds, which is why screens move to native one at a time and the rest
  stay in `WKWebView`.
- **`/api/core/{command}` is one route with untyped bodies.** Commands keep
  the Tauri names (`set_secret`, `pty_write`) and the frontend's camelCase
  arguments. That works from Swift but has no schema.
- **OAuth on a server reached on loopback only.** There, MCP and Google
  sign-ins redirect to the sidecar's loopback port, which works only from the
  server's machine. A server with an `https` origin takes them on its own
  origin instead (`/api/oauth/*/callback`), which a native client's browser
  sheet can reach.
- Nothing else is browser-specific. Auth is a bearer header, never a cookie;
  WebSockets authenticate with their first message; CSP and frame headers only
  matter to the web UI.

## An OpenAPI description

Not added. With `utoipa` and `utoipa-axum` it would take:

- `#[derive(ToSchema)]` on the request and response structs (`SignedIn`,
  `DeviceRow`, `Pending`, the account and vault bodies), and `#[utoipa::path]`
  on each handler.
- Building the routers with `OpenApiRouter` so the paths are collected as
  they're mounted, and serving the document at `/api/openapi.json`.
- A path per core command, or a `oneOf` per command, since
  `/api/core/{command}` dispatches on the name. The command bodies are parsed
  from `serde_json::Value` today, so each needs a named type first.

That covers the server's own routes. It doesn't cover
the WebSocket protocols, which OpenAPI can't describe (AsyncAPI could), or
the sidecar, which would need its own description from its Hono routes.
