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

- **First run.** A new server isn't set up yet. When it starts, it prints a
  one-time **setup code** in its terminal. Enter that code and choose a
  passphrase of at least 12 characters (twice). Scan the QR code with an
  authenticator app (1Password, Google Authenticator, Authy…) or type in the
  key under it, and enter the code the app shows. Last come ten **backup
  codes**: save them somewhere safe, since they're shown once. This first
  device gets every scope.
- **After that.** Enter the passphrase and the code your authenticator app
  shows, or click **Use a backup code**. Each sign-in makes a new device,
  named from the field on the sign-in screen. A wrong passphrase or code says
  only that one of them was wrong. Ten wrong tries in 15 minutes lock signing
  in for 15 minutes, from everywhere.
- **Lost your authenticator?** Sign in with a backup code, then set up a new
  authenticator under **Settings → Devices → Account**. With no backup codes
  left either, run `yarvis-server auth reset` on the server: it prints a new
  setup code, and you set the account up again. Devices already signed in
  stay signed in.

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
| `chat` | Chatting, and starting and driving workspaces and their agent sessions, directly or through the assistant |
| `terminal` | Opening terminals, and saving files into a workspace, since both run code as the server's user |
| `approve` | Answering approvals |
| `admin` | Managing devices and changing settings and secrets |

A sign-in gets all five. A token created in Settings can't have
`terminal` or `admin`. Creating a token, revoking a device, and every account
change ask for a code from your authenticator app if you haven't entered one
(or signed in) in the last 10 minutes.

## Account

**Settings → Devices → Account** changes the passphrase (it asks for the
current one), sets up a new authenticator app (confirmed with a code from
it), makes new backup codes (the old ones stop working), and signs out every
other device. Changing the passphrase or the authenticator keeps your other
devices signed in unless you tick the box to sign them out.

## Devices

**Settings → Devices** lists every device signed in to the server, with its
scopes and when it was last seen. Managing them needs the `admin` scope.

- **Revoke** signs a device out at once. Its next request fails and its open
  connections close. Revoking the device you're using signs you out.
- **Pair a device with a token** is for a client that can't sign in itself: a
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

- Clipboard history. The [clipboard palette](clipboard.md) in a browser, or in
  a desktop app connected to a server on another machine, has only your saved
  entries.
- Global shortcuts, such as the ones that open
  [Quick Chat](quick-chat.md) and the clipboard palette from another app.
- An alarm bringing the window to the front over your other apps. In a
  browser the alarm still takes over the page, but only while its tab is open.
- **Show in Finder** for a saved voice clip.
