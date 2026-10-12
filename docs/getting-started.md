# Getting started

This guide takes a new Mac from nothing to a running dev build of Yarvis with
a working chat. It takes about 30 minutes, most of it waiting on installs and
the first Rust compile.

Prefer to be walked through it? Install
[Claude Code](https://claude.com/claude-code), clone the repo
(`git clone https://github.com/bennettaur/yarvis.git && cd yarvis`), run
`claude`, and type `/yarvis-setup`. The skill checks each step below, runs the
commands once you approve them, and tells you what to enter in the app. See
[Set up with Claude Code](#set-up-with-claude-code).

## What you are setting up

Yarvis is a Tauri desktop app made of three processes:

- a **Rust core** (`src-tauri/`) that owns the window, the terminals, and your
  secrets,
- a **React frontend** (`src/`) that draws the UI,
- a **Bun sidecar** (`sidecar/`) that talks to Postgres and the LLM providers.

`bun run tauri dev` starts all three. Data lives in a local PostgreSQL database
with the `pgvector` extension. Secrets live in the macOS Keychain. Everything
else lives in `~/.yarvis/settings.json`. See [Configuration](configuration.md)
for the details.

## Requirements

Required:

| Tool | Why | Check |
| --- | --- | --- |
| macOS | Yarvis is a macOS app. Apple Silicon is needed only for local voice. | — |
| Xcode Command Line Tools | Compilers for the Rust build | `xcode-select -p` |
| [Homebrew](https://brew.sh) | Installs Postgres and the other tools | `brew --version` |
| [Bun](https://bun.com) | Runs the frontend build and the sidecar | `bun --version` |
| [Rust](https://rustup.rs) | Builds the Tauri core | `cargo --version` |
| PostgreSQL 16 or later (17 recommended) + pgvector | Stores chat, memory, workspaces and more | `psql --version` |
| An LLM provider | An Anthropic, Gemini or Cerebras API key, AWS credentials for Bedrock, or an OpenAI-compatible endpoint | — |

Needed for some features:

| Tool | Needed for | Install |
| --- | --- | --- |
| [Claude Code](https://claude.com/claude-code) | Workspaces. Each workspace opens a `claude` session. | `curl -fsSL https://claude.ai/install.sh \| bash` |
| [GitHub CLI](https://cli.github.com) + `gh-stack` | The workspace Stack tab's grouping and merge button | `brew install gh && gh extension install github/gh-stack` |
| [uv](https://docs.astral.sh/uv/) | The local speech server for voice | `brew install uv` |
| [1Password CLI](https://developer.1password.com/docs/cli/) | Keeping secrets in 1Password instead of the Keychain | `brew install 1password-cli` |

## 1. Install the build tools

Install the Xcode Command Line Tools if `xcode-select -p` prints an error:

```bash
xcode-select --install
```

The repo lists Bun and Rust in `mise.toml`, so the simplest way to get both is
[mise](https://mise.jdx.dev):

```bash
brew install mise
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc
exec zsh
```

You run `mise install` inside the repo in step 3.

If you'd rather not use mise, install Bun and Rust directly. Either way works,
as long as `bun` and `cargo` are on your `PATH`:

```bash
curl -fsSL https://bun.sh/install | bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## 2. Install PostgreSQL with pgvector

Install Postgres 17 and the pgvector extension from Homebrew, then start
Postgres as a background service:

```bash
brew install postgresql@17 pgvector
brew services start postgresql@17
```

`postgresql@17` is "keg-only", which means Homebrew doesn't put its commands
on your `PATH`. Add them:

```bash
echo "export PATH=\"$(brew --prefix postgresql@17)/bin:\$PATH\"" >> ~/.zshrc
exec zsh
```

Check that the server is up:

```bash
psql -d postgres -c 'select version();'
```

Create the Yarvis database and turn on pgvector in it:

```bash
createdb yarvis
psql -d yarvis -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

Homebrew's Postgres lets your macOS user connect locally with no password. Your
database URL is therefore:

```text
postgres://localhost:5432/yarvis
```

You enter that URL in the app in step 5. The app creates the tables itself the
first time it connects.

Homebrew's Postgres only listens on your own machine, so the network can't
reach it. It does trust every local connection, though. Any program running as
any user on your Mac can read the database, which holds your chat history and
memories. If that matters to you, give your role a password and switch
`trust` to `scram-sha-256` in `$(brew --prefix)/var/postgresql@17/pg_hba.conf`,
then restart Postgres. The URL becomes
`postgres://USER:PASSWORD@localhost:5432/yarvis`. Enter it only in the app's
Settings screen, never on the command line.

## 3. Clone the repo and install dependencies

```bash
git clone https://github.com/bennettaur/yarvis.git
cd yarvis
mise install   # skip if you installed Bun and Rust directly
bun install
```

`bun install` installs the frontend and sidecar packages. It also installs the
repo's git hooks through lefthook. The pre-commit hook runs Biome, `cargo fmt`
and `cargo clippy` on staged files.

## 4. Start the app

```bash
bun run tauri dev
```

The first run compiles the whole Rust core, which takes a few minutes. Later
runs take seconds. When the build finishes, a Yarvis window opens.

If macOS asks whether Yarvis may use the Keychain, choose **Always Allow**. Dev
builds aren't code-signed, so you may be asked for your login password
instead of Touch ID.

Keep the terminal open. It shows the log for all three processes, and closing
it quits the app.

## 5. First configuration

The app starts with nothing configured, so on first launch it opens a **setup
guide**. It covers the same ground as the steps below, plus choosing where
secrets are kept (the macOS Keychain or 1Password), and finishes by offering a
tour of each page. You can skip it and reopen it, or the tour, at any time from the
**Help** button (the **?** at the bottom of the nav rail).

To do the same by hand, open **Settings** (the gear at the bottom of the nav
rail on the left) and do these three things.

1. **Connect the database.** Go to **Settings → Credentials**. In **Database
   URL**, enter `postgres://localhost:5432/yarvis` and press **Save**. The
   sidecar restarts and creates its tables. You see "Preparing your
   database…" for a moment.
2. **Add an LLM provider.** On the same Credentials tab, save one of:
   - **Anthropic API key** (`sk-ant-…`) from the
     [Anthropic Console](https://console.anthropic.com). This is the best-tested
     option.
   - **Gemini API key** (`AIza…`). This also gives you embeddings for memory
     search and cloud voice.
   - **Cerebras API key** (`csk-…`).

   There are two other options. AWS Bedrock needs no key in Yarvis: it uses
   your normal AWS credentials (`~/.aws`, `AWS_PROFILE`, and `AWS_REGION`,
   which defaults to `us-east-1`). For an OpenAI- or Anthropic-compatible
   endpoint (LiteLLM, Ollama, a company gateway), use **Settings → LLM
   Providers → Add provider** instead.

   The setup guide can't check AWS credentials, so with only Bedrock
   configured it keeps opening at launch until you finish or skip it.
3. **Check it works.** Open **Dashboard** (bottom of the nav rail). **Database**
   should say reachable, and your provider's dot should be lit. Then open
   **Chat** (Cmd+1), pick the provider and a model at the top, and say hello.

Secrets are saved to one Keychain item and never read back into the UI. To
change one, save a new value over it.

That's a working Yarvis. Everything below is optional. From here you can also
ask the assistant where a setting is or how to set something up ("where do I
add a GitHub token?"). It answers from these docs, with links that open the
right page.

## 6. Turn on the features you want

Each integration is independent. Set up the ones you need, in any order.

| Feature | What to do | Guide |
| --- | --- | --- |
| GitHub PRs and issues | Save a **GitHub token** in Settings → Credentials. See [token scopes](configuration.md#token-scopes). | [PR review](features/pr-review.md) |
| Workspaces | Install Claude Code, then add repos under **Settings → Repositories**. | [Workspaces](features/workspaces.md) |
| Azure DevOps PRs and Azure Boards | Save an **Azure DevOps token** and set the organization URL under Settings → Credentials. Azure Boards also needs the **Work Items (read & write)** scope. | [PR review](features/pr-review.md), [Issues and tasks](features/issues-and-tasks.md) |
| JIRA | Save a **JIRA API token** and set the base URL and account email. | [Issues and tasks](features/issues-and-tasks.md) |
| Google Calendar and alarms | Create a Google OAuth client, then connect from the Calendar tab. | [Calendar and alarms](features/calendar-and-alarms.md) |
| Better memory search | Add a Gemini key, or configure **Settings → Embeddings**. Without either, memory search uses a weaker offline embedder. | [Configuration](configuration.md#embeddings) |
| Voice | Run the local speech server and point Settings → Voice at it. | [Voice server](voice-server.md) |
| MCP servers | Add servers under **Settings → Tools & MCP**. | [MCP](features/mcp.md) |
| Reading your browser | Load the `extension/` folder in Chrome, then run `bun run browser:install <extension-id>`. | [Browser](features/browser.md) |
| Telegram | Create a bot with @BotFather and save its token. | [Telegram](features/telegram.md) |
| Transcript digest | Turn on the transcript digest under **Settings → Assistant** so the assistant learns what happened in your Claude Code sessions. | [The assistant](features/assistant.md) |

Once you have a provider and GitHub set up, read
[The assistant](features/assistant.md). It explains the weekly workflow the
rest of the app is built around.

## Where things live

| What | Where |
| --- | --- |
| Secrets (DB URL, API keys, tokens) | One macOS Keychain item: service `com.mikebennett.yarvis`, account `secrets`. You can move it to 1Password. |
| Other settings | `~/.yarvis/settings.json` |
| Your own specialist agents | `~/.yarvis/agents/*.md` |
| Chat, memory, tasks, workspaces, PR notes | The Postgres database |
| Workspace clones and worktrees | `~/dev/yarvis-workspaces` (set `YARVIS_WORKSPACES_ROOT` to change it) |
| Sidecar log | `~/Library/Logs/com.mikebennett.yarvis/sidecar.log`, and **Settings → Diagnostics** |

## Troubleshooting

**"Couldn't start the local service."** The sidecar failed to start, usually on
the database. The screen shows the error. Common causes:

- `connection refused`. Postgres isn't running. Run
  `brew services start postgresql@17`.
- `database "yarvis" does not exist`. Run `createdb yarvis`.
- `extension "vector" is not available`. pgvector isn't installed for the
  Postgres you're running. Run `brew install pgvector` and check that
  `psql --version` reports 17.

Fix the cause, then press **Retry**. **Continue anyway** opens the app without
the database, so you can change the URL in Settings.

**The provider picker says "(no key)".** That provider has no key saved. Save
one in Settings → Credentials.

**The build fails on the Rust step.** Check that `cargo --version` works in the
same terminal. If you use mise, run `mise install` in the repo and open a new
terminal.

**`bun: command not found` in the log.** The Rust core starts the sidecar with
the `bun` on your `PATH`. Start the app from a terminal where `bun --version`
works.

**Port 1420 is in use.** Another Yarvis dev build (or Vite) is already running.
Quit it, or run a second copy with `bun run dev:instance <name>`. See
[Development](development.md#running-more-than-one-instance).

**Keychain prompts keep coming back.** Choose **Always Allow** rather than
**Allow**. Unsigned dev builds can't use Touch ID for the Keychain. The
1Password store is the way to get a Touch ID prompt today (see
[Configuration](configuration.md#1password-instead-of-the-keychain)).

**Something else.** Open **Settings → Diagnostics**. It shows the sidecar log
with filters by level and scope, and a button to copy it.

## Nightly builds

A `.dmg` is published to the
[`nightly` release](https://github.com/bennettaur/yarvis/releases/tag/nightly),
but it doesn't run yet, because release builds don't bundle the sidecar. Use
the dev build above. [Development](development.md#nightly-builds) has the
details.

## Set up with Claude Code

You need [Claude Code](https://claude.com/claude-code) installed and the repo
cloned (step 3), because the skill lives inside the repo at
`.claude/skills/yarvis-setup/`. From the repo root:

```bash
claude
```

Then type `/yarvis-setup`. It:

1. checks each requirement and offers to install what's missing,
2. installs Postgres and pgvector, starts it, and creates the database,
3. runs `bun install` and starts the app,
4. walks you through the Settings screen, one step at a time,
5. can also set up the local speech server.

The skill is written to never ask for your API keys. You paste those into the
app's Settings screen yourself, so they go straight to the Keychain. If you
paste one into Claude Code anyway, it is sent to Anthropic with the rest of
the conversation.
