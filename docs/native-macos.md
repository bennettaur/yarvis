# A native macOS client

Not built yet. This maps each part of the server's API
([client-server.md](client-server.md)) to what a SwiftUI app would use, and
lists what in the API would get in its way.

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

**Sign-in.** The same routes a browser uses, with nothing browser-specific
in them: `POST /api/auth/login` with the passphrase and a TOTP code (or a
backup code) returns the device token. Setup shows the `otpauth://` URI as a
QR code (`qrSvg` renders with any SVG view, or the app can draw its own from
`otpauthUri`). No ASAuthorization, no Associated Domains entitlement, and no
`apple-app-site-association` file: sign-in isn't tied to a domain, so a
`*.ts.net` name from `tailscale serve` works as it does in a browser. The
token goes in the Keychain. Passkeys could come back later as an optional
second way to sign in, and would bring the association file back with them.

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
`terminal` scope.

**WKWebView fallback.** The fallback screens use the app's token: inject it
into `localStorage` (`yarvis.deviceToken`) with a `WKUserScript` before the
page loads, as the Tauri app hands its token to the page. The web UI's own
code prompt then works inside the view for anything that needs a fresh
device.

## What in the API would get in the way

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
