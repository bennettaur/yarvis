# Yarvis for macOS

A native SwiftUI client for your own `yarvis-server`. It signs in with the
server's passphrase and an authenticator code, and is laid out like the web
UI: Chat, Terminal and Workspaces pages, Settings for devices and the
account, and the attention bell. Those are native (chat, workspaces and
attention are so far tested only against stubs; see Test). Everything else
opens in a web view of the full web UI. The API it uses is in
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
`/api/devices/me`, signing out with `DELETE /api/devices/me`, the events
socket, a shell over `/api/pty/{id}` and its row in `GET /api/pty`, and the
4401 and 4403 closes. Chat, workspaces and attention need the sidecar and
Postgres, so they're tested only against stubs.

## Signing in

Enter the server's URL, the passphrase, and the code from your authenticator
app (or a backup code). The URL must be `https`, or `http` on loopback
(`localhost`, any `127.x.x.x`, `::1`). Requests don't follow a redirect off
the server's origin. The device token goes in the login
Keychain as a generic password, service `dev.yarvis.mac.device-token`,
account = the server URL. Sign Out (in the app menu) revokes the device on
the server (`DELETE /api/devices/me`) and deletes the token from this Mac.
The token is deleted even when the server can't be reached; the app then
says the device may still be listed under Settings → Devices in the web UI,
where you can revoke it.

A server that isn't set up yet needs the web UI first: setup (the setup
code, the passphrase, the authenticator, the backup codes) isn't built here.

When a route needs a recent code check (`403 reauth_required`), the app asks
for a code, sends it to `/api/auth/reverify`, and retries once. A `401`, or a
socket closed with `4401`, signs the app out.

## What's native and what's web

The sidebar lists the pages in the web UI's order, with Settings at the
bottom. Cmd-1 to Cmd-3 open Chat, Terminal and Workspaces, Cmd-, opens
Settings, and Cmd-Shift-] / Cmd-Shift-[ step through all four pages. Open chat tabs,
the model pick, terminal layouts and the selected workspace are saved on
this Mac per server, since they hold that server's ids; signing in to
another server shows that server's own. The last page and display
choices (the Chats sidebar, Thinking, Show archived) are shared.

Native:

- **Chat.** Threads open in tabs, and each tab runs its own turn, so a reply
  keeps streaming while you work in another. The Chats sidebar collapses.
  Return sends and Shift-Return adds a line; a message sent during a reply
  is queued, and the queue waits after a turn fails or is stopped. Stop
  (Cmd-.) ends the turn, and a model picker sits by the composer. Thinking
  sends `reasoning` and shows the model's reasoning for the live turn. Tool
  calls are cards folded under a summary line. A sent message can be edited
  and resent, and a failed turn retried. The approval bar answers with A
  and D, and offers Always allow for MCP tools. Replies render as markdown
  with lists, tables and quotes; http(s) links open in the browser, and
  `yarvis://` links and workspace ids open the place they name. Artifacts
  open in a side pane (Excalidraw ones in the web UI). In an untrusted
  artifact, `yarvis://` links stay inert; web links still open in the
  browser. An MCP bar offers sign-in or reconnect for
  servers that aren't usable.
- **Terminal.** Tabs with split panes, as in the web UI: Cmd-T opens a tab,
  Cmd-W closes one (asking first if something is running), Cmd-D splits
  right and Cmd-Shift-D splits below. Tabs reorder by drag. Font size
  (Cmd-=, Cmd--, Cmd-0) and the colours (the web's Default or Palenight
  theme) are the server's settings, shared with the web UI.
  Shift-Return sends a newline for Claude Code. The layout stays on this
  Mac, and each pane gets a fresh shell after a relaunch. Sessions resume
  after a dropped connection; a session the server started (`ws-claude:`,
  `review-claude:`) isn't reattached after it ends, since that would start
  a plain shell under its id. Programs in a terminal can't write the
  clipboard (OSC 52 is ignored), and only http(s) links open.
- **Workspaces.** The list grouped by repo, with status, PR glyphs and the
  attention dot. A workspace's page has rename, repos, linked PRs (link,
  unlink, detect), Start session with a harness picker, and Archive. Its
  agent runs as a pinned tab on the workspace's own terminal surface, and
  starts on its own the first time you open a workspace with none running.
  It shows the provisioning log, with retry and ignore. The side panel has
  changed files, all files, review comments with Copy for Claude, and PR
  checks; files open as a diff (click a line number, then shift-click
  another, to comment on a range) or in an editor (Cmd-S saves) that won't
  overwrite a change made since it loaded. New workspaces are created with repos and
  branches. Lists are polled only while the page is on screen.
- **Settings.** Connection (this device, Sign Out), approvals, devices
  (revoke, pair a device with a token) and the account (passphrase, a new
  authenticator, backup codes, sign out other devices). While the server's
  vault is locked or not set up, an unlock screen replaces the app.
- **Attention.** The toolbar bell (Shift-Cmd-A) opens a panel of pending
  attention items and server approvals (such as git signatures), live from
  the attention stream. Answer an `ask_user` question, allow or deny a
  Claude Code permission prompt (AskUserQuestion prompts get a question
  form), dismiss an item, or open it. Opening goes to the chat thread,
  workspace or terminal pane it names, or to the web UI. New items post a
  macOS notification from the wrapped app.

Not built natively yet: on Workspaces, PR checks' Fix with Claude, the
Stack tab, Link work, the Run pane and the inline repo creator; voice in
chat.

Web (Show Web UI, Shift-Cmd-U, or the globe button):

- Everything else: PRs, tasks, memory, the rest of Settings, heads-down
  questions, first-run setup.
- The web view signs in on its own, with the same passphrase and a code. The
  app doesn't hand its token to the page, since the page's localStorage would
  then hold a second copy of it. Links off the server's origin open in your
  browser.

Open in Browser (app menu) opens the server URL in your default browser.
