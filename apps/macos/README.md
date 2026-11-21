# Yarvis for macOS

A native SwiftUI client for your own `yarvis-server`. It signs in with the
server's passphrase and an authenticator code, and covers chat, the attention
bell and approvals, and terminals natively (chat and attention are so far
tested only against stubs; see Test). Everything else opens in a web
view of the full web UI. The API it uses is in
[docs/client-server.md](../../docs/client-server.md), and
[docs/native-macos.md](../../docs/native-macos.md) maps it to Swift.

It's a Swift package, so it builds with the Command Line Tools alone. Xcode
isn't needed. It needs macOS 14 and Swift 6.2 or later (SwiftTerm's manifest
asks for 6.2).

## Layout

- `Sources/YarvisClient`: networking, API models and the state rules a
  client keeps, with no UI. Sign-in, the `/api/events` socket, the PTY
  attach protocol, chat and attention over the sidecar proxy, a streaming
  chat turn (`LiveTurn`) and the bell (`AttentionInbox`). An iOS app or the
  Android client can mirror this module.
- `Sources/YarvisMac`: the app. Views, the Keychain store, notifications.
- `Tests/YarvisClientTests`: tests for the client module (swift-testing).

## Build and run

```sh
cd apps/macos
swift build
swift run YarvisMac        # opens the app window
```

Run from `swift run`, the app has no bundle identifier, so macOS
notifications are off. Use the wrapped app for those.

## Wrap it into Yarvis.app

```sh
scripts/make-app.sh        # writes build/Yarvis.app, signed ad hoc
open build/Yarvis.app
```

The script builds in release mode, writes an `Info.plist`
(`dev.yarvis.mac`), and signs the bundle with `codesign -s -`. An ad hoc
signature is enough to launch it from Finder on the Mac that built it. To
copy it to another Mac, sign it with a Developer ID instead.

## Test

```sh
scripts/test.sh            # same as `swift test`, plus the search paths the
                           # Command Line Tools need for swift-testing
```

With Xcode installed, plain `swift test` works too. HTTP is tested with
`URLProtocol` stubs. The events and PTY clients are tested against scripted
fake sockets, so no test waits on a timer.

The `LiveServer` suites run only against a real server. Start one with a
temp data dir and the sidecar off, then pass it in:

```sh
yarvis-server device add --name e2e --scopes read,chat,terminal,approve,admin
YARVIS_E2E_URL=http://localhost:7878 YARVIS_E2E_TOKEN=<token> scripts/test.sh
```

They also take `YARVIS_E2E_READ_TOKEN` (a `read`-only token, for the scope
check), and `YARVIS_E2E_PASSPHRASE` with `YARVIS_E2E_TOTP_SECRET` (the
base32 secret setup showed) to test signing in. They cover sign-in,
`/api/devices/me`, the events socket, a shell over `/api/pty/{id}`, and the
4401 and 4403 closes. Chat and attention need the sidecar and Postgres, so
they're tested only against stubs.

## Signing in

Enter the server's URL, the passphrase, and the code from your authenticator
app (or a backup code). The URL must be `https`, or `http` on loopback
(`localhost`, any `127.x.x.x`, `::1`). Requests don't follow a redirect off
the server's origin. The device token goes in the login
Keychain as a generic password, service `dev.yarvis.mac.device-token`,
account = the server URL. Sign Out (in the app menu) deletes it from this
Mac. The device stays valid on the server until you revoke it in the web
UI's Settings → Devices.

A server that isn't set up yet needs the web UI first: setup (the setup
code, the passphrase, the authenticator, the backup codes) isn't built here.

When a route needs a recent code check (`403 reauth_required`), the app asks
for a code, sends it to `/api/auth/reverify`, and retries once. A `401`, or a
socket closed with `4401`, signs the app out.

## What's native and what's web

Native:

- **Chat.** The thread list, opening a thread, sending, the streamed reply as
  markdown, tool calls as one line each, Stop (Cmd-.), a model picker, and
  the approval bar for tool calls inside a turn.
- **Attention.** Pending attention items and server approvals (such as git
  signatures) in one list, live from the attention stream. Answer an
  `ask_user` question, allow or deny a Claude Code permission prompt
  (AskUserQuestion prompts get a question form), dismiss an item, or open it.
  Opening goes to the chat thread or terminal it names, or to the web UI.
  New items post a macOS notification from the wrapped app.
- **Terminals.** Each active workspace's agent session (`ws-claude:<id>`),
  with Start when none is running, and terminals opened from this app, in
  SwiftTerm. They resume where they left off after a dropped connection; an
  agent session that ended meanwhile isn't reattached, since that would
  start a plain shell under its id. The server has no route that lists live
  PTYs, so the app lists only those. Programs in a terminal can't write the
  clipboard (OSC 52 is ignored), and only http(s) links open.

Web (Show Web UI, Shift-Cmd-U, or the globe button):

- Everything else: workspaces, PRs, memory, settings, devices, the vault
  unlock screen, heads-down questions, first-run setup.
- The web view signs in on its own, with the same passphrase and a code. The
  app doesn't hand its token to the page, since the page's localStorage would
  then hold a second copy of it. Links off the server's origin open in your
  browser.

Open in Browser (app menu) opens the server URL in your default browser.
