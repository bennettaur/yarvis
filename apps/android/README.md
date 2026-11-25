# Yarvis for Android

A small native client for a Yarvis server. It does two things:

- **Chat** with the assistant: the thread list, a thread's history, sending a
  message with the reply streamed in as markdown, the tools the turn ran,
  stopping a turn, and answering the turn's tool approvals.
- **Attention**: what the web UI's attention bell shows. That is Claude Code
  permission prompts, `ask_user` questions from the assistant and from coding
  agents, heads-down questions and approvals, items the assistant or the app
  surfaced, and server approvals such as git signatures. You can approve or
  deny, answer a question (choices, several choices, or free text), or
  dismiss an item. New items raise a local notification, except while the
  Attention tab is on screen.

Terminals, settings, devices and first-time setup stay in the web UI.

## Build

The toolchain is pinned in this folder: `mise.toml` pins JDK 21, the Gradle
wrapper pins Gradle (with its checksum), and `gradle/libs.versions.toml`
holds the library versions. You also need the Android SDK command-line
tools, with `ANDROID_HOME` pointing at them.

```bash
cd apps/android
mise install
# Once: the SDK platform and build tools the app compiles against.
sdkmanager "platforms;android-37.2" "build-tools;37.0.0" "platform-tools"
mise exec -- ./gradlew testDebugUnitTest assembleDebug lint
```

The debug APK lands in `app/build/outputs/apk/debug/app-debug.apk`. CI runs the
same command (the `android` job in `.github/workflows/ci.yml`) on pull requests
that change this folder and on pushes to main. The nightly workflow runs it too
and attaches the APK to the `nightly` release as `yarvis-android-debug.apk`.

## Install on a phone

1. On the phone, turn on Developer options, then USB debugging (or Wireless
   debugging).
2. Connect it and check that `adb devices` lists it.
3. Run `adb install -r app/build/outputs/apk/debug/app-debug.apk`.

The app needs Android 8.0 (API 26) or later.

## Connect to a server

The app only talks HTTPS, since the device token goes with every request, and
it trusts only the certificate authorities that ship with Android. Two setups
give a server that:

- [`tailscale serve`](https://tailscale.com/kb/1312/serve) on the server's
  Mac, which gives it a name like `https://my-mac.tail1234.ts.net`.
- A Caddy reverse proxy on your home network, with a Let's Encrypt
  certificate for a domain you own.

[Running the server](../../docs/server.md) has the steps for both, including
the `auth.origins` entry the server needs and setting up the account the app
signs in to. In the app, enter the server's name (such as
`my-mac.tail1234.ts.net`), your passphrase, and a code from your
authenticator app (or a backup code).

Each sign-in creates a device on the server, named after the phone unless you
change it. Sign out revokes that device on the server, with no code needed.
If the revoke fails (for example, the server can't be reached), the app
forgets the token anyway and says that the device is still on the server's
devices list, so you can revoke it there.

## How it works

- `api/` is the HTTP layer: OkHttp, kotlinx.serialization and coroutines,
  with no Android dependencies, so its tests run on the JVM against
  MockWebServer. `Models.kt` mirrors the server's Rust structs and the
  sidecar's rows.
- Chat goes through the server's sidecar proxy (`/api/sidecar/api/chat/...`).
  A turn is a `POST /api/chat` whose response is a server-sent event stream.
  Stopping a turn closes that stream, which the sidecar takes as the user's
  stop. Tool approvals are separate `POST`s while the stream stays open.
- Attention is live from two places. The bell's items come from the
  sidecar's SSE stream at `/api/sidecar/api/attention/stream`, not from server
  events, and the app reloads the pending list on every reconnect. Server
  approvals come from `/api/approvals`, reloaded on the `/api/events`
  WebSocket's `approval.requested` and `approval.answered`. That socket sends
  the token as its first message, resumes with `since`, reloads on `lagged`,
  and reloads the sidecar's items on `sidecar.started`. It signs out on close
  code 4401 and stops on 4403 or 4400.
- The device token is encrypted with an AES-GCM key kept in the Android
  Keystore and stored in DataStore. A 401 from any request signs the app out.
  When an answer gets `403 reauth_required`, the app asks for a code, calls
  `/api/auth/reverify`, and retries once.
- Markdown is rendered with
  [multiplatform-markdown-renderer](https://github.com/mikepenz/multiplatform-markdown-renderer).
  No image loader is installed, so a reply can't make the phone fetch a
  remote image.

## Notifications and background delivery

The app keeps its streams open while it's on screen and for 10 minutes after
you leave it. In that window, a new item posts a local notification. After
that, the streams close, and Android may freeze the app anyway.

Real background delivery needs push. That would take:

- A Firebase project, with `google-services.json` in the app and the FCM SDK.
- A route on the server for a device to register its FCM token, stored per
  device and dropped when the device is revoked.
- The server sending a push (through the FCM HTTP v1 API, with a service
  account key in its secret store) when an attention item or approval
  arrives. The sidecar's items would have to reach the server first, for
  example as server events.
- Keeping the push payload to a title and an id, with the app fetching the
  details itself, so prompt contents don't pass through Google.
