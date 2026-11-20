# Signing in and devices

Yarvis runs as a server (`yarvis-server`) that you can open from a browser
as well as from the desktop app. Every client that connects to it signs in
and becomes a **device**: a browser, the desktop app, or a script you gave a
token to. Each device has its own token and its own scopes, and you can
revoke any one of them without touching the rest.

See [Yarvis as a client-server app](../client-server.md) for how the pieces
fit together.

## Sign in

Open the server's address in a browser. With no device token yet, Yarvis
shows the sign-in screen.

- **First run.** A new server has no passkey yet. When it starts, it prints a
  one-time **setup code** in its terminal. Enter that code, name the device,
  and click **Create passkey**. Your browser or password manager stores the
  passkey. This first device gets every scope.
- **After that.** Click **Sign in** and pick your passkey. Each sign-in makes
  a new device, named from the field on the sign-in screen.

A browser keeps its device token in local storage, so it stays signed in
across reloads. A script running in the page could read it, so revoke a
browser's device if you think the page was tampered with. The desktop app
keeps its token in the macOS Keychain instead.

If the server rejects the token (it was revoked, say), Yarvis goes back to
the sign-in screen.

## Scopes

| Scope | Allows |
|---|---|
| `read` | Reading data and following events |
| `chat` | Chatting, and using terminals and agent sessions |
| `approve` | Answering approvals |
| `admin` | Managing devices and changing settings and secrets |

A passkey sign-in gets all four. Creating a token, and revoking a device,
also ask you to check your passkey again if you haven't in the last few
minutes.

## Devices

**Settings → Devices** lists every device signed in to the server, with its
scopes and when it was last seen. Managing them needs the `admin` scope.

- **Revoke** signs a device out at once. Its next request fails and its open
  connections close. Revoking the device you're using signs you out.
- **Pair a device with a token** is for a client that can't use a passkey: a
  desktop app pointed at a server on another machine, or a script. Give it a
  name and only the scopes it needs, then click **Create token**. The token is
  shown once. Copy it into the client, then click **Done**.

Someone with a terminal on the server machine can also create a token with
`yarvis-server device add --name NAME --scopes read,chat`.

## Approvals

Some actions wait for you to allow them, such as the server signing a git
commit. They show in a box at the bottom right of every page, and under
**Settings → Devices**. Any device with the `approve` scope can answer, and
the first answer counts. If another device answered first, the request just
disappears from the list.

## In a browser versus the desktop app

Everything works in a browser except what belongs to the machine in front of
you:

- Clipboard history. The [clipboard palette](clipboard.md) in a browser has
  only your saved entries.
- Global shortcuts, such as the ones that open
  [Quick Chat](quick-chat.md) and the clipboard palette from another app.
- An alarm taking over the screen. In a browser a ringing alarm shows under
  **Ringing** in the attention panel, where you can acknowledge or snooze it.
- **Show in Finder** for a saved voice clip.
- Continuous voice mode's turn detector, which listens on a port only the
  server's own machine can reach. It works in a browser on that machine, not
  from another one.
