# Telegram

The Telegram bot lets you chat with Yarvis from your phone. The sidecar runs a
bot that drives the same chat agent as the app, with the same tools and
memory. You can ask where things stand, plan, or start work in a workspace
while you're away from the laptop.

The bot needs a configured database and at least one LLM provider. See
[Getting started](../getting-started.md).

## Set up

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its HTTP API
   token. It looks like `123456:ABC-DEF...`.
2. Paste it into **Settings → Telegram** and save. It is stored in the
   Keychain, and saving reloads the sidecar to pick it up.
3. Message your bot `/whoami`. It replies with your chat id. Until at least one
   id is on the allowlist, the bot does nothing else: any other message gets a
   reply saying it isn't paired yet, with your chat id.
4. Paste your chat id into **Allowed chat ids** and save. Separate several ids
   with commas.

Once the allowlist is set, the bot ignores any chat that isn't on it. The one
exception is `/whoami`, which it answers for anyone. That only reveals the
sender's own chat id, but it does show the bot is running.

## Use it

Send a normal message to chat with the assistant. These commands control the
bot:

| Command | What it does |
| --- | --- |
| `/new_chat` | Start a fresh chat session |
| `/chats` | List recent sessions |
| `/switch <n>` | Switch to session `n` from that list |
| `/model` | Show the current provider and model, and the options |
| `/setmodel <provider> <model>` | Reply using a specific provider and model |
| `/whoami` | Show your chat id |
| `/help` | List the commands |
| `/unlock <code>` | Open an access window, when the second factor is on |
| `/lock` | Close the access window early |

### Workspace sessions started from Telegram

A Claude Code session the assistant starts from a Telegram turn is launched
with `--remote-control <session name>`. You're away from the machine, so you
need to reach the session from claude.ai/code or the Claude mobile app. The
assistant tells you the session name.

Sessions started at the laptop don't get the flag, because they open in a tab
you're already looking at. See [Workspaces](workspaces.md).

## Who can reach the bot

Access is limited to **private** chats on the allowlist. The bot ignores
groups, channels and messages from other bots.

The allowlist is stored in the Keychain rather than the settings file. With the
second factor off, it is the bot's only access check.

### Optional second factor (OTP)

The allowlist can't protect you if someone takes over your Telegram account,
through a stolen session or a SIM swap, because then the attacker *is* your
allowlisted chat. A TOTP second factor covers that case.

1. Open **Settings → Telegram → Two-factor unlock** and turn it on.
2. Add the secret Yarvis shows to an authenticator app (Authy, Google
   Authenticator, 1Password, …).
3. From then on, the bot won't act until you send `/unlock <code>`.

How it behaves:

- `/unlock` opens a window, two hours by default. You can change the length on
  the same screen.
- `/lock` ends the window early.
- The window locks again whenever the app restarts.
- Codes are rate-limited, with a lockout after repeated failures.
- Your `/unlock` message is deleted so the code doesn't linger in the chat.
- The app raises a desktop notification on each unlock, failed attempt and
  lockout, so you see access you didn't start.
- The code is checked in the sidecar. The TOTP secret stays on your laptop and
  in your authenticator. Only the six-digit code passes through Telegram, and
  the bot deletes that message.

## Running more than one copy of the app

Telegram allows only one process to poll a bot token. A second instance of the
app leaves the bot to the main one. See
[Development](../development.md#work-only-one-instance-does).
