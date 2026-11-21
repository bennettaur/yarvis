# A native macOS client

Not built yet. This maps each part of the server's API
([client-server.md](client-server.md)) to what a SwiftUI app would use, and
lists what in the API would get in its way.

## Each API surface and its Swift counterpart

| API surface | Swift |
|---|---|
| Passkey setup, sign-in and `reverify` (`/api/auth/*`) | `ASAuthorizationPlatformPublicKeyCredentialProvider` |
| Vault unlock with a passkey (`/api/vault/unlock/*`, PRF) | The PRF inputs on `ASAuthorizationPlatformPublicKeyCredentialAssertionRequest` (macOS 15 and later) |
| The device token | Keychain (`kSecClassGenericPassword`), sent as `Authorization: Bearer` |
| `/api/events` | `URLSessionWebSocketTask` |
| `/api/pty/{id}` | `URLSessionWebSocketTask` feeding SwiftTerm's `TerminalView` |
| JSON routes (`/api/core/*`, `/api/devices`, `/api/approvals`, `/api/sidecar/*`) | `URLSession` with `Codable` types; SSE streams through `URLSession.bytes` |
| Screens not rebuilt natively | `WKWebView` pointed at the server |
| Alarms, notifications, global shortcuts | Native, driven by `alarm.fire` and `alarm.release` events |

**Passkeys.** The server sends WebAuthn options as webauthn-rs JSON with
base64url fields, the same shape a browser gets. The app decodes `challenge`,
`user.id` and `allowCredentials[].id`, builds the request with
`createCredentialRegistrationRequest` or `createCredentialAssertionRequest`,
and sends back the browser-shaped JSON the `finish` routes read: `id`,
`rawId`, and `response.clientDataJSON` plus `attestationObject` or
`authenticatorData`, `signature` and `userHandle`, all base64url.
`src/lib/auth.ts` is the reference for both directions.

The app needs the Associated Domains entitlement
(`webcredentials:<rp_id>`), and the RP ID's domain has to serve
`/.well-known/apple-app-site-association` naming the app. Apple fetches that
file through its CDN from the public internet, so a tailnet-only name doesn't
work for a released app. A personal build can use
`webcredentials:<rp_id>?mode=developer`, which fetches it directly.

webauthn-rs checks `clientDataJSON`'s origin against `auth.origins`. If the
origin ASAuthorization puts there isn't the server's `https://` URL, add it
to `auth.origins`.

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

**WKWebView fallback.** WKWebView can't run WebAuthn without the browser
entitlement, so the fallback screens use the app's token: inject it into
`localStorage` (`yarvis.deviceToken`) with a `WKUserScript` before the page
loads, as the Tauri app hands its token to the page. Anything that needs a
fresh passkey (device management, switching the secrets backend) goes through
a native passkey check first.

## What in the API would get in the way

- **No `apple-app-site-association` route.** The server serves `web_dir` with
  an SPA fallback, so `/.well-known/apple-app-site-association` returns
  `index.html`. The server needs a route (or a config value) for it, and it
  has to be reachable from the public internet, as above.
- **The sidecar has no typed schema.** `/api/sidecar/*` is a proxy to a few
  hundred Hono routes. A Swift client hand-writes types for each screen it
  rebuilds, which is why screens move to native one at a time and the rest
  stay in `WKWebView`.
- **`/api/core/{command}` is one route with untyped bodies.** Commands keep
  the Tauri names (`set_secret`, `pty_write`) and the frontend's camelCase
  arguments. That works from Swift but has no schema.
- **Local-only flows.** MCP and Google OAuth redirect to the sidecar's
  loopback port, which works only from the server's machine, native or not.
- Nothing else is browser-specific. Auth is a bearer header, never a cookie;
  WebSockets authenticate with their first message; CSP and frame headers only
  matter to the web UI.

## An OpenAPI description

Not added. With `utoipa` and `utoipa-axum` it would take:

- `#[derive(ToSchema)]` on the request and response structs (`SignedIn`,
  `DeviceRow`, `Pending`, the vault and passkey bodies), and `#[utoipa::path]`
  on each handler.
- Building the routers with `OpenApiRouter` so the paths are collected as
  they're mounted, and serving the document at `/api/openapi.json`.
- A path per core command, or a `oneOf` per command, since
  `/api/core/{command}` dispatches on the name. The command bodies are parsed
  from `serde_json::Value` today, so each needs a named type first.

That covers the server's own routes. It doesn't cover
the WebSocket protocols, which OpenAPI can't describe (AsyncAPI could), or
the sidecar, which would need its own description from its Hono routes.
