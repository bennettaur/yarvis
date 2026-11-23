# Running the server

Everything in Yarvis goes through `yarvis-server`. It holds your account,
devices, secrets and terminals, runs the sidecar, and serves the web UI. The
desktop app, a browser and the Android app are all clients of it.

There are two ways to run it:

- **Let the desktop app run it.** This is the default. The app starts a
  server on a loopback port and pairs itself with it. You don't configure
  anything, and the server stops when the app quits.
- **Run it on its own.** You build it, write its config, and keep it running
  with launchd. Use this for an always-on machine (a home Mac mini), or when
  you want the server to keep running with the app closed.

Either way, you can reach it from your phone or another computer through
[Tailscale](#reach-it-over-tailscale) or a
[Caddy reverse proxy on your home network](#reach-it-on-your-home-network-with-caddy).

Both need Postgres with pgvector, set up as in
[Getting started](getting-started.md#2-install-postgresql-with-pgvector).
The design behind all this is in [client-server.md](client-server.md).

## The server the desktop app runs

The app keeps this server's files in
`~/Library/Application Support/com.mikebennett.yarvis/`:

| What | Where |
| --- | --- |
| Config | `server.toml` |
| Data, including the setup code | `server/` |
| Log | `~/Library/Logs/com.mikebennett.yarvis/server.log` |

The app rewrites `bind`, `data_dir`, `web_dir` and its own loopback origins
in `server.toml` on every start. Anything else you add there, such as another
entry in `auth.origins`, is kept. Restart the app after editing it.

**Its port.** A dev build (`bun run tauri dev`) always uses port 7420. A
release build picks a free port the first time and keeps it while it stays
free. The port in use is the one in `bind` in `server.toml`.

**Its account.** The app pairs itself with a device token, so it never needs
to sign in, and the server's account isn't set up yet. You need the account
before any other device can sign in, the Android app included. Set it up once:

1. Find the setup code in
   `~/Library/Application Support/com.mikebennett.yarvis/server/setup-code`.
2. Open the server in a browser on the same Mac. In a dev build that is
   `http://localhost:1420`, the Vite dev server, since the dev server doesn't
   serve the UI itself. In a release build it is `http://localhost:<port>`.
3. Enter the setup code, choose a passphrase, scan the QR code into an
   authenticator app, confirm a code, and save the backup codes.
   [Signing in and devices](features/devices.md) explains each screen.

## Run the server on its own

These steps run the server from a clone of the repo, with its config at
`~/.yarvis/server.toml`. Replace `/Users/me` with your home folder and
`/Users/me/yarvis` with where your clone is. Paths in `server.toml` must be
written out in full, since `~` isn't expanded.

Don't run this server and the desktop app's own server side by side on the
same database. They would share one account and fight over approvals. Point
the desktop app at this server instead (step 7).

1. **Build the UI and the server.** From the repo root:

   ```bash
   bun install
   bun run build
   cargo build --release --manifest-path server/Cargo.toml
   ```

   The server is now at `server/target/release/yarvis-server`. It starts the
   sidecar with `bun run` on `sidecar/src/main.ts` in this same clone, so
   keep the clone where it is.

2. **Write `~/.yarvis/server.toml`.**

   ```toml
   [server]
   bind = "127.0.0.1:7878"
   data_dir = "/Users/me/.yarvis/server"
   web_dir = "/Users/me/yarvis/dist"
   # launchd's PATH misses Homebrew and mise, where bun, git, gh and claude
   # live. `echo $PATH` in a terminal prints yours.
   path = "/Users/me/.local/share/mise/shims:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

   [auth]
   origins = ["http://localhost:7878"]

   [secrets]
   backend = "keychain"   # or "onepassword" or "vault"; see below
   ```

   Keep `bind` on `127.0.0.1`. Tailscale and Caddy both run on the same Mac
   and connect to it there, so the server never needs to listen on the
   network. If your database isn't `postgres://localhost:5432/yarvis`, add a
   `[database]` section with its `url`, or set `YARVIS_DATABASE_URL` in the
   LaunchAgent's `EnvironmentVariables` (step 6). A URL with a password makes
   either file a secret, so keep it readable only by you.
   [Configuration](configuration.md#secrets-on-yarvis-server) explains the
   secrets backends, and [Commit signing](#commit-signing-and-the-ssh-agent)
   below explains the `[ssh_agent]` section.

3. **With the vault backend only, create the vault:**

   ```bash
   server/target/release/yarvis-server vault init
   ```

   It asks for a vault passphrase and prints a recovery key once. Write the
   key down.

4. **Start it in a terminal** to check it works:

   ```bash
   server/target/release/yarvis-server
   ```

   On its first run it prints a setup code, and also writes it to
   `<data_dir>/setup-code`. Leave it running.

5. **Set up the account.** Open `http://localhost:7878`, enter the setup
   code, choose a passphrase, scan the QR code into an authenticator app,
   confirm a code, and save the backup codes. With the vault backend, the
   unlock screen comes next. Then press Ctrl+C in the terminal to stop the
   server.

6. **Keep it running with launchd.** Save this as
   `~/Library/LaunchAgents/dev.yarvis.server.plist`:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key>
     <string>dev.yarvis.server</string>
     <key>ProgramArguments</key>
     <array>
       <string>/Users/me/yarvis/server/target/release/yarvis-server</string>
       <string>--config</string>
       <string>/Users/me/.yarvis/server.toml</string>
     </array>
     <key>RunAtLoad</key>
     <true/>
     <key>KeepAlive</key>
     <true/>
     <key>StandardOutPath</key>
     <string>/Users/me/Library/Logs/yarvis-server.log</string>
     <key>StandardErrorPath</key>
     <string>/Users/me/Library/Logs/yarvis-server.log</string>
   </dict>
   </plist>
   ```

   Then load it:

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.yarvis.server.plist
   ```

   To restart it after a config change or a rebuild, run
   `launchctl kickstart -k gui/$(id -u)/dev.yarvis.server`. To stop it, run
   `launchctl bootout gui/$(id -u)/dev.yarvis.server`.

   A LaunchAgent runs inside your login session, so the `keychain` and
   `onepassword` backends work. It doesn't start until you log in. A server
   that has to start at boot, before anyone logs in, has no Keychain and needs
   the `vault` backend.

7. **Point the desktop app at it** (optional). Make a token for the app:

   ```bash
   server/target/release/yarvis-server device add --name Laptop --scopes read,chat,terminal,approve
   ```

   In the app's tray menu, choose **Server connection…**, pick the remote
   server, and enter `http://127.0.0.1:7878` and the token. On another Mac,
   use the server's `https://` address from Tailscale or Caddy instead; the
   app refuses plain `http` to anything but loopback.

To update, pull, rerun step 1, and restart the LaunchAgent.

## Commit signing and the SSH agent

Workspace terminals and agent sessions run `git`, and `git` signs commits and
pushes over SSH through whatever agent `SSH_AUTH_SOCK` points at. The server
sets `SSH_AUTH_SOCK` in every terminal it starts. It picks the socket like
this:

1. With `[ssh_agent] enabled = true`, the server's own agent. It keeps the
   signing key in the vault and asks for an approval on every signature. It
   needs `[secrets] backend = "vault"`.
2. Otherwise, `[ssh_agent] upstream_socket`, when it is set.
3. Otherwise, the `SSH_AUTH_SOCK` the server itself started with.

When you start the server from a terminal, or the desktop app starts it, (3)
passes on your login shell's agent. launchd doesn't give a LaunchAgent your
shell's `SSH_AUTH_SOCK`, so a server under launchd needs (1) or (2).

### Work laptop: sign with 1Password

Keep the key in 1Password and let 1Password's agent sign. 1Password asks you
to approve each use on the laptop itself.

1. In 1Password, open **Settings → Developer** and turn on **Use the SSH
   agent**. Check the socket exists:

   ```bash
   ls -l ~/Library/Group\ Containers/2BUA8C4S2C.com.1password/t/agent.sock
   ```

2. Set up git to sign with your 1Password key, if it doesn't already. In
   1Password, the key's **Configure Commit Signing** button gives you the
   lines for `~/.gitconfig`.

3. Tell the server to use that socket:

   - **The desktop app's server:** nothing to do. When the socket exists, the
     app writes it into `server.toml` as `upstream_socket`.
   - **A server you run yourself:** add it to `~/.yarvis/server.toml`,
     written out in full, then restart the server:

     ```toml
     [secrets]
     backend = "onepassword"   # or "keychain"

     [ssh_agent]
     enabled = false
     upstream_socket = "/Users/me/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
     ```

4. Check it from a new workspace terminal: `ssh-add -l` should list your
   1Password keys.

The server never holds the key, so it can't sign while you are away from the
laptop. A workspace session started from your phone can still run, but its
commits wait until you approve them in 1Password on the laptop.

### Home server: sign with the server's own agent

On an always-on machine you aren't sitting at, let the server hold the key and
approve each signature from any device, your phone included.

1. In `server.toml`:

   ```toml
   [secrets]
   backend = "vault"

   [ssh_agent]
   enabled = true
   ```

2. Run `yarvis-server vault init` (step 3 above). With the agent on, it also
   makes a signing key and prints its public key. Add that key to GitHub as a
   **signing key**.
3. Point git at it in `~/.gitconfig`:

   ```ini
   [gpg]
     format = ssh
   [user]
     signingkey = "key::<the public key it printed>"
   [commit]
     gpgsign = true
   ```

4. After each server start, unlock the vault from the web UI. Until then the
   sidecar and the agent don't run.

Every signature then waits for an approval, which any device with the
`approve` scope can give. The Android app shows these under **Attention**.

## Reach it from other devices

The server only listens on loopback and speaks plain HTTP. To reach it from
another device, put something on the same Mac that serves HTTPS and forwards
to it. Clients send their device token with every request, so the server
expects HTTPS from anything that isn't on the same machine. The Android app
and the desktop app both refuse plain `http` to another host.

Whichever you use, the server's `Host` check only lets in names it knows. Add
the new `https://` address to `auth.origins` in `server.toml` and restart the
server. Otherwise every request gets `403 unknown host`.

Tailscale is the easier of the two. It works away from home, needs no domain,
and its certificates work with the Android app as they are.

### Reach it over Tailscale

1. Install Tailscale on the server's Mac and sign in.
2. In the [Tailscale admin console](https://login.tailscale.com/admin/dns),
   turn on **MagicDNS** and **HTTPS Certificates**.
3. Publish the server's port with HTTPS:

   ```bash
   tailscale serve --bg 7878
   ```

   Use the port from `bind` in `server.toml`: 7878 in the example above, 7420
   for a dev build of the desktop app. It prints the address, which looks like
   `https://my-mac.tail1234.ts.net`. `--bg` keeps it published across
   restarts. `tailscale serve status` shows it, and
   `tailscale serve --https=443 off` removes it.
4. Add that address to `server.toml` and restart the server:

   ```toml
   [auth]
   origins = ["http://localhost:7878", "https://my-mac.tail1234.ts.net"]
   ```

5. Install Tailscale on the phone or other computer and sign in to the same
   tailnet.

`tailscale serve` only publishes inside your tailnet. Nobody outside it can
reach the server. A release build of the desktop app can move to another port
if its old one is taken, which breaks this. If that happens, publish the new
port the same way.

### Reach it on your home network with Caddy

[Caddy](https://caddyserver.com) on the server's Mac can serve HTTPS on your
LAN and forward to the server. The server stays on loopback, as with
Tailscale. This only works at home, unless you also run a VPN into your
network.

The catch is the certificate. The Android app trusts only the public
certificate authorities that ship with Android. Caddy's own local CA
(`tls internal`) won't work with it, even if you install Caddy's root
certificate on the phone. So you need a domain you own and a real
certificate. Since nothing on the internet can reach your Mac, Caddy gets the
certificate from Let's Encrypt with a DNS challenge, through your DNS
provider's API. The steps below use Cloudflare. Other DNS providers have
Caddy modules of their own.

1. **Give the Mac a fixed LAN address.** Set a DHCP reservation in your
   router, say `192.168.1.20`.
2. **Point a name at it.** In your DNS provider, add an `A` record such as
   `yarvis.home.example.com` → `192.168.1.20`. A public record for a private
   address is harmless, since nothing outside your network can reach it. Use
   a public record rather than one only your router knows: an Android phone
   with **Private DNS** turned on skips the router's DNS.
3. **Get Caddy with the DNS module.** The standard Homebrew build doesn't
   include DNS modules. Download a build from
   [caddyserver.com/download](https://caddyserver.com/download) with the
   `caddy-dns/cloudflare` module ticked, or build one with xcaddy:
   `xcaddy build --with github.com/caddy-dns/cloudflare`. Put the binary at,
   say, `/Users/me/bin/caddy`.
4. **Make a Cloudflare API token** with **Zone → DNS → Edit** on that one
   zone. Caddy uses it to answer the DNS challenge, so it is a secret.
5. **Write the Caddyfile** at `/Users/me/.config/caddy/Caddyfile`:

   ```caddyfile
   yarvis.home.example.com {
       tls {
           dns cloudflare {env.CLOUDFLARE_DNS_SECRET}
       }
       reverse_proxy 127.0.0.1:7878
   }
   ```

   Use the port from `bind` in `server.toml`. Caddy passes the `Host` header
   through unchanged and forwards WebSockets and server-sent events without
   extra config.
6. **Run Caddy with launchd.** Save this as
   `~/Library/LaunchAgents/dev.yarvis.caddy.plist`, with the Cloudflare
   secret from step 4 filled in:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key>
     <string>dev.yarvis.caddy</string>
     <key>ProgramArguments</key>
     <array>
       <string>/Users/me/bin/caddy</string>
       <string>run</string>
       <string>--config</string>
       <string>/Users/me/.config/caddy/Caddyfile</string>
     </array>
     <key>EnvironmentVariables</key>
     <dict>
       <key>CLOUDFLARE_DNS_SECRET</key>
       <string>paste-it-here</string>
     </dict>
     <key>RunAtLoad</key>
     <true/>
     <key>KeepAlive</key>
     <true/>
     <key>StandardOutPath</key>
     <string>/Users/me/Library/Logs/caddy.log</string>
     <key>StandardErrorPath</key>
     <string>/Users/me/Library/Logs/caddy.log</string>
   </dict>
   </plist>
   ```

   The file holds a secret, so make it readable only by you, then load it:

   ```bash
   chmod 600 ~/Library/LaunchAgents/dev.yarvis.caddy.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.yarvis.caddy.plist
   ```

   If macOS asks whether `caddy` may accept incoming connections, allow it.
   `caddy.log` shows the certificate being issued within a minute or so.
7. **Add the address to `server.toml`** and restart the server:

   ```toml
   [auth]
   origins = ["http://localhost:7878", "https://yarvis.home.example.com"]
   ```

8. **Check it** from another device on your Wi-Fi: open
   `https://yarvis.home.example.com` in a browser. A server that serves the
   UI shows the sign-in screen. A dev build's server serves only `/api`, so
   `https://yarvis.home.example.com/api/health` is the check there.

Anyone on your Wi-Fi can now reach the sign-in screen. Signing in still takes
your passphrase and an authenticator code, and repeated failures lock sign-in
for 15 minutes. Don't forward the port on your router to the internet.

If Caddy runs on another machine, such as a NAS, the server has to listen on
the LAN (`bind = "192.168.1.20:7878"` with `allow_plain_http = true`). The
hop from Caddy to the server is then plain HTTP across your network, device
tokens included. Keep Caddy on the server's Mac when you can.

## Connect the Android app

The app needs an HTTPS address from [Tailscale](#reach-it-over-tailscale) or
[Caddy](#reach-it-on-your-home-network-with-caddy), and a server whose
account is set up. For the desktop app's server, set up the account as in
[Its account](#the-server-the-desktop-app-runs).

1. Build and install the app. [apps/android/README.md](../apps/android/README.md)
   has the steps.
2. On Tailscale, open the Tailscale app on the phone and check it's
   connected. On Caddy, check the phone is on your home Wi-Fi.
3. In the Yarvis app, enter the server's address. A bare name such as
   `my-mac.tail1234.ts.net` or `yarvis.home.example.com` is enough; the app
   adds `https://`.
4. Enter your passphrase and a code from your authenticator app, or a backup
   code.

Each sign-in adds a device to **Settings → Devices** on the server, named
after the phone. Revoke it there if you lose the phone. **Sign out** in the
app revokes it too.

## Troubleshooting

**`403 unknown host`.** The address you used isn't in `auth.origins`. Add it,
with `https://` and no path, and restart the server.

**The server won't start: "server.bind isn't loopback".** Keep `bind` on
`127.0.0.1` and put Tailscale or Caddy in front, as above. Set
`allow_plain_http = true` only when the HTTPS proxy is on another machine.

**The sign-in screen says it is waiting for the database.** The server can't
reach Postgres. It keeps retrying. See
[Getting started](getting-started.md#troubleshooting) for the usual causes.

**The sidecar doesn't start under launchd, or terminals can't find `git` or
`claude`.** `[server] path` is missing or doesn't include where they live.
See [Configuration](configuration.md#path-for-a-server-launchd-starts).

**Commits fail to sign under launchd.** `SSH_AUTH_SOCK` points nowhere. Set
`upstream_socket` or turn on the server's agent, as in
[Commit signing](#commit-signing-and-the-ssh-agent). With the server's agent,
check the vault is unlocked.

**The Android app says the connection failed on Caddy.** Open the address in
the phone's browser. A certificate warning means Caddy is serving its own
certificate rather than one from Let's Encrypt: check `caddy.log`. A name that
doesn't resolve usually means the phone uses Private DNS and the record isn't
public, or your router blocks public names that point at private addresses
(DNS rebinding protection). Most routers let you add an exception for your
domain.
