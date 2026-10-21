---
name: yarvis-setup
description: >-
  Walk a new developer through setting up a dev build of the Yarvis desktop
  app on their Mac: check prerequisites, install PostgreSQL 17 with pgvector,
  create the database, install dependencies, launch the app, and guide the
  first configuration in its Settings screen. Can also set up Yarvis's
  optional local speech server. Use only when someone asks to set up, install,
  or get started with Yarvis itself, or runs /yarvis-setup.
---

# Set up Yarvis

You are helping someone get a Yarvis dev build running for the first time. The
steps are written for people in `docs/getting-started.md`, and that file is the
source of truth. Read it before you start, and read `docs/voice-server.md` if
they want voice. This skill adds how to run the steps *with* the person.

## Rules

- **Ask before you install, start, or change anything outside the repo.** That
  includes Homebrew installs, background services, and lines added to
  `~/.zshrc`. Show the exact command and say what it changes (for example,
  "installs Postgres 17 with Homebrew and starts it as a login service"). Batch
  related commands into one question.
- **Never ask for, read, or handle secrets.** API keys, tokens and the database
  password go into the app's **Settings → Credentials** screen, which stores
  them in the Keychain. Tell the person what to paste there. If they paste a key
  into the chat anyway, tell them not to, and don't repeat it back.
- **Never write to the Keychain or 1Password yourself**, for example with the
  `security` or `op` commands. The app keeps all secrets in one JSON item, and
  writing it by hand can wipe the others.
- **Never overwrite `~/.yarvis/settings.json`.** Copy
  `docs/settings.example.json` there only if no file exists, and only if they
  want a file to edit.
- **Don't read the app's logs yourself.** A startup error can include the
  database URL. Ask the person for the error text on screen instead, and never
  repeat a connection string back.
- **Run commands from the repo root**, the directory that contains `.claude/`.
  If there is no `package.json` there, you are in a Yarvis workspace rather
  than a clone of the repo. Stop and tell the person.
- **Go one step at a time.** After each step, run its check and show the result
  before moving on. If a check fails, fix that before going further.
- Keep your messages short and concrete: what you're about to do, the command,
  the result.

## 1. See what's already done

Run the read-only check script:

```bash
.claude/skills/yarvis-setup/check.sh
```

It prints one line per requirement: `OK`, `MISSING` (required) or `WARN`
(optional, or worth a look). Give the person a short summary: what's ready,
what's missing, and the order you'll fix things in. Skip every step that's
already `OK`.

If `postgres-server` shows `MISSING` but the person says Postgres is running,
your shell's sandbox is probably blocking the local socket. Ask them to run the
script themselves by typing `! .claude/skills/yarvis-setup/check.sh`, which
puts its output in the conversation.

## 2. Ask what they want

Before installing anything, ask (with AskUserQuestion, multi-select) which
optional features they want now, so you install the right tools once:

- Workspaces (needs Claude Code, already present if they're talking to you)
- GitHub PR review and issues
- The Stack tab for stacked PRs (`gh` and `gh-stack`)
- Local voice (Apple Silicon only; needs `uv`)
- JIRA
- Google Calendar and alarms
- Secrets in 1Password instead of the Keychain (`op`)

Everyone needs the core: build tools, Bun, Rust, Postgres with pgvector, and one
LLM provider.

## 3. Install the build tools

Follow "1. Install the build tools" in `docs/getting-started.md`.

- If `xcode-clt` is missing, `xcode-select --install` opens a macOS dialog. Ask
  the person to click through it and tell you when it finishes.
- Prefer mise, since the repo lists Bun and Rust in `mise.toml`. If mise is
  installed but `bun` or `cargo` is missing, run `mise install` in the repo.
- Ask before adding a line to `~/.zshrc`. Tell them to open a new terminal
  (or run `exec zsh`) for it to apply to their own shell. In your shell, use
  `mise exec -- <command>` or the full path until then.

## 4. Postgres and pgvector

Follow "2. Install PostgreSQL with pgvector" in `docs/getting-started.md`:

1. `brew install postgresql@17 pgvector`
2. `brew services start postgresql@17`
3. Put `$(brew --prefix postgresql@17)/bin` on `PATH` (it's keg-only). Ask
   before adding it to `~/.zshrc`.
4. `createdb yarvis`
5. `psql -d yarvis -c 'CREATE EXTENSION IF NOT EXISTS vector;'`

If they already run a different Postgres (Postgres.app, Docker, an older
Homebrew version), don't install a second one without asking. Check it has
pgvector first:

```bash
psql -d postgres -Atc "select count(*) from pg_available_extensions where name = 'vector'"
```

`1` means it's available. `0` means that server needs pgvector installed. For
Docker, the `pgvector/pgvector:pg17` image has it built in.

Work out their database URL and tell them it. With Homebrew defaults it is
`postgres://localhost:5432/yarvis`. Mention that Homebrew's Postgres trusts
every local connection, so anything running on the Mac can read the database.
It isn't reachable from the network. `docs/getting-started.md` says how to add
a password if they want one. With a password, it is
`postgres://USER:PASSWORD@localhost:5432/yarvis`, and they type the password
into the app, not into this chat.

Re-run the check script. `postgres-server`, `pgvector`, `database` and
`vector-extension` should all be `OK`.

## 5. Install dependencies

```bash
bun install
```

This also installs the repo's git hooks (lefthook).

## 6. Start the app

`bun run tauri dev` is a long-running process that opens a window. The first
run compiles the Rust core, which takes a few minutes.

Recommend that the person runs it in a terminal of their own, so it outlives
this session and they can see its log:

```bash
cd <repo path> && bun run tauri dev
```

If they'd rather you run it, start it in the background. Don't read its log
output. Ask them to tell you when the Yarvis window appears, or what error it
shows.

Tell them to expect a Keychain prompt, and to choose **Always Allow**.

## 7. First configuration

Walk them through "5. First configuration" in `docs/getting-started.md`, one
item at a time, and wait for them to say they've done each:

1. **Settings → Credentials → Database URL**: paste the URL from step 4, and
   press **Save**.
   - Then run the check script again. `migrations` should now show tables. That
     confirms the app reached the database.
   - If it shows "Couldn't start the local service", ask them for the error on
     screen and use the troubleshooting section of the getting-started doc.
2. **An LLM provider key**, on the same Credentials tab: Anthropic, Gemini or Cerebras. Or
   AWS credentials for Bedrock, or a custom provider under **Settings → LLM
   Providers**. Ask which they have. Don't ask for the key itself.
3. **Check it works**: the **Dashboard** shows Database reachable and the
   provider's dot lit. Then **Chat** (Cmd+1): pick the provider and model, and
   send a message.

## 8. Optional features

Do only the ones they picked in step 2. Use the matching doc for the exact
steps, and give them the Settings path for each:

| Feature | Doc | What they do in the app |
| --- | --- | --- |
| GitHub | `docs/configuration.md#token-scopes` | Save a GitHub token in Settings → Credentials |
| Workspaces | `docs/features/workspaces.md` | Add repos in Settings → Repositories |
| Stack tab | `docs/features/workspaces.md` | Nothing. You install `gh` and run `gh extension install github/gh-stack`. |
| JIRA | `docs/features/issues-and-tasks.md` | Token, base URL and email in Settings → Credentials |
| Google Calendar | `docs/features/calendar-and-alarms.md` | Create the OAuth client in Google Cloud, enter the id and secret, then connect from the Calendar tab |
| 1Password | `docs/configuration.md#1password-instead-of-the-keychain` | Settings → Credentials → Secret store |
| Memory search | `docs/configuration.md#embeddings` | A Gemini key, or Settings → Embeddings |
| Transcript digest | `docs/features/assistant.md#what-it-can-see` | Settings → Assistant: turn on the transcript digest and pick directories |

Before they turn on the transcript digest, tell them what it does with their
data. Claude Code transcripts often hold pasted secrets and other people's
data. The digest sends them to the LLM provider, and the summaries are stored
as memories that Claude Code sessions (over MCP) and the Telegram bot can read
back. Suggest allowing only specific project directories they're comfortable
with.

For Google Calendar, walk them through the Google Cloud Console steps one
screen at a time. It's the step people most often get stuck on.

### Voice

Follow `docs/voice-server.md`:

1. Check `uname -m` is `arm64`. mlx-audio doesn't run on Intel Macs. On Intel,
   offer Gemini for voice instead.
2. `uv sync` in the repo.
3. Start the server: `uv run mlx_audio.server --host 127.0.0.1 --port 8000`.
   Like the app, it's long-running. Suggest a terminal of their own, or the
   `launchd` agent in the doc if they want it always on.
4. Walk them through adding the `local speech` provider and **Settings →
   Voice**, then **Test voice**. The first test downloads the model and takes a
   minute or two.

## 9. Wrap up

Finish with a short summary:

- what's set up and working,
- what's optional and still left, with the doc for each,
- where things live (the "Where things live" table in the getting-started doc),
- a pointer to `docs/features/assistant.md`, which explains the weekly
  workflow: tell the assistant your priorities on Monday, then ask "where did
  we leave off?" and "what's next?" through the week.
