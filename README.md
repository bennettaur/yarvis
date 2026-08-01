# Yarvis

A personal-assistant desktop app for macOS, built with Tauri v2.

V1 focuses on the foundation plus an LLM chat interface with memory and
daily/weekly work tracking. See the roadmap in
`~/.claude/plans/we-are-going-to-polymorphic-lightning.md` for the full plan.

## Architecture

Three processes with a clean ownership split:

- **Rust core** (`src-tauri/`) — native OS integration (window, tray,
  notifications), secret storage in the macOS Keychain, and supervision of the
  sidecar process (it picks a free loopback port, generates a bearer token, and
  injects secrets as environment variables).
- **React frontend** (`src/`) — Vite + TypeScript + Tailwind. Talks to the Rust
  core via `invoke` (native + secrets) and to the sidecar over authenticated
  loopback HTTP (data + AI).
- **Bun sidecar** (`sidecar/`) — a Hono HTTP service that owns Postgres access
  (Drizzle ORM), LLM calls, and memory. It also hosts an optional **Telegram
  remote-control bot** (a long-poll loop that drives the same chat agent). Runs
  `src/server.ts` directly with Bun in development; compiled to a single binary
  for distribution.

Data lives in a local **PostgreSQL + pgvector**.

## Prerequisites

- [Bun](https://bun.com) (`bun --version`)
- [Rust](https://rustup.rs) toolchain — `cargo`, `rustc` (required to build the
  Tauri core)
- Xcode Command Line Tools (`xcode-select --install`)
- PostgreSQL with the `pgvector` extension available

## Setup

```bash
# 1. Install JS dependencies (root + sidecar workspace)
bun install

# 2. Create the database and enable pgvector
createdb yarvis
psql -d yarvis -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 3. (Optional) Apply migrations manually. The sidecar also applies any pending
#    migrations automatically on startup, so this is only needed to migrate
#    without launching the app.
DATABASE_URL="postgres://localhost:5432/yarvis" bun run --cwd sidecar db:migrate
```

Secrets are entered in the app's **Settings** screen and stored in the macOS
Keychain — not in env files: the database URL, provider keys (Anthropic,
Gemini), a GitHub token and/or an Azure DevOps token + organization URL (for the
PR dashboard + embedded review — either provider can back it, selected with a
toggle in the PRs tab), a JIRA base URL + account email + API token (for the JIRA
issues integration on the Issues tab), a Google Cloud OAuth client id/secret (for the Calendar
integration), an optional embeddings-provider secret (an API key and/or
custom header values for an OpenAI-compatible embeddings endpoint), and an
optional Telegram bot token + allowed chat-id list (and, when the optional second
factor is enabled, a TOTP secret + re-auth window) for the remote-control bot,
see below. AWS Bedrock uses the standard AWS credential chain.

The Azure DevOps token is a Personal Access Token with **Code (read)** and
**Pull Request Threads (read & write)** scopes; the organization URL is the
`https://dev.azure.com/your-org` base (project is chosen per search).

The JIRA credentials are for Atlassian Cloud: the base URL is your
`https://your-org.atlassian.net` site, and the API token (created at
id.atlassian.com → Security → API tokens) is paired with your account email for
Basic auth.

### Embeddings

The `memories.embedding` column is `vector(1536)`, and the active embedder's
output dimension must match it (the model's output is truncated to it). Configure
an embeddings provider under **Settings → Embeddings**: an OpenAI-compatible
endpoint — a LiteLLM gateway fronting Gemini, or a Qwen3 embedding server (base
URL e.g. `http://localhost:4000/v1`, model e.g. `gemini-embedding-001`). Without
one, Yarvis uses Gemini directly when keyed, otherwise an offline hash embedder.
Each memory records the embedder identity (kind/model/dim) so a provider or
dimension change is detected and surfaced as a "re-embed needed" warning.

Note: the embeddings migration sets the column to `vector(1536)` and **clears
existing embeddings** (memory *content* is preserved). After upgrading, configure
a provider and run **Re-embed all** in Settings (or `POST /api/memory/reembed`)
to regenerate vectors.

All secrets live in a **single** Keychain item (one JSON object), rather than
one item per secret. macOS authorizes Keychain access per item, so consolidating
means a session is authorized once instead of prompting for every secret in
turn.

> **Upgrading from an earlier build:** secrets previously lived in one item per
> key, so re-save each secret once in Settings to populate the consolidated
> item. The old per-key items are no longer read and can be deleted from
> Keychain Access if you want to tidy up.

> **Touch ID:** gating this item behind Touch ID requires the app to be
> code-signed with an application-identifier entitlement so it can use the macOS
> data-protection keychain — unsigned dev builds fall back to the login-password
> prompt. That signing work is tracked separately; once it lands, the single
> authorization becomes a single Touch ID tap with no further change here.

For Google Calendar, create a **Desktop app** OAuth client in Google Cloud
Console and register the loopback redirect
`http://127.0.0.1:<sidecar-port>/oauth/google/callback` (any port is accepted
for Desktop clients), then enter the client id/secret in Settings and connect
from the Calendar tab. See `ROADMAP.md` for the full verification steps.

Workspaces manage their own repo clones and git worktrees under a base
directory, `~/dev/yarvis-workspaces` by default and overridable with the
`YARVIS_WORKSPACES_ROOT` env var (non-secret config, unlike the Keychain
secrets above). Add repos and edit their per-repo setup/run scripts in the
Settings tab's Repositories section.

Every provisioned workspace opens with an agent tab and nothing else — opening
one starts a Claude Code session in it (or attaches to the one already running)
and focuses that tab. No extra shell tab is opened alongside it; use `+` or
Cmd+T when you want one. Closing the agent tab kills its session, and nothing
reopens it while you stay on that workspace — but the dismissal is per-visit, so
switching workspaces (or leaving the Workspaces tab) and coming back counts as
opening the workspace again and starts a fresh session. The header's start-session
button brings one back on the spot.

The agent's tab title and launch command are set under Settings → Repositories →
Agent, defaulting to `Claude` and `claude --permission-mode auto`, so you can
bake in default options such as a model or permission mode. The
`YARVIS_CLAUDE_COMMAND` env var still overrides the stored command (non-secret
config) for the cases where it has to be injected without the settings file.

Remote Control is opt-in per launch. A session started from Telegram gets
`--remote-control <session name>` appended, since you're away from the machine
and can only reach it from claude.ai/code or the Claude mobile app. Sessions
started at the laptop — opening a workspace, an issue's "Start work", or asking
the in-app agent — don't, because they open in a tab you're already looking at;
enable Remote Control from inside the session if you later need to pick the work
up remotely. Keeping it off by default also means a non-Claude agent command
isn't handed a flag it doesn't understand.

Provisioning also writes a few context files into the workspace root, since
Claude starts there rather than inside a single repo: `AGENTS.md` (plus a
`CLAUDE.md` that includes it) describing which repos are present and on what
branch, and a `.claude/settings.json` that registers each repo's
`.claude/skills` and `.claude/agents` so those skills and agents still load
even though Claude runs one directory above the repos. The settings file is
merged, not overwritten, so any other keys already present are left intact.

At most 60 terminal sessions can be live at once; opening more fails until one
is closed. Raise or lower that under Settings → Repositories → Terminals (up to
1000) — each session is a real shell, so the cap trades memory and process count
for how many workspaces you can keep open. Leaving the field blank restores the
default. The value applies to the next terminal opened, without a restart, and
is stored in `settings.json` in the app data directory.

### PR review

The PRs tab lists **My PRs**, **Needs review**, **Reviewing**, and saved
**Filters**, grouped under collapsible per-repo headers (a collapsed repo stays
collapsed across tabs and restarts). The box above the tabs jumps straight to a
PR you can already name — paste a `https://github.com/owner/repo/pull/123` link,
or type `owner/repo#123`; a bare `repo#123` resolves against your registered
repos, and if the name matches several owners you're asked which one.

Two things are configurable under **Settings → PR review**:

- **"Needs review" search** — the GitHub issue search behind that tab, run
  as-is, so you decide what counts as needing your attention (drop drafts,
  narrow to an org, exclude PRs you've already reviewed). Defaults to
  `is:open is:pr review-requested:@me`; a few presets are one click away.
- **"Reviewing" history** — how far back that tab looks, in days (30 by
  default).

**Reviewing** shows PRs you've actually engaged with, from two signals: PRs
opened in yarvis (recorded as `pr.viewed` in the local event log) and GitHub's
record of your comments and submitted reviews. It splits into **In progress**
and **Complete** — merged, closed, or approved by you — with the latter
collapsed. An approval superseded by a later change request counts as in
progress again. GitHub only: Azure DevOps exposes neither half of that signal.

### Telegram remote control

Chat with Yarvis — and issue control commands — from Telegram. The sidecar runs
a bot that drives the same chat agent as the in-app UI; it requires a configured
database and at least one LLM provider.

Setup:

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its HTTP API
   token (format `123456:ABC-DEF...`).
2. Enter it under **Settings → Telegram** (stored in the Keychain; saving
   reloads the sidecar to pick it up).
3. Message your bot `/whoami` — it replies with your chat id. Until at least one
   id is on the allowlist the bot answers **only** `/whoami`; once the allowlist
   is set it ignores any chat that isn't on it.
4. Paste your chat id (comma-separated for several) into **Allowed chat ids** and
   save.

Access is restricted to **private** chats on the allowlist — the bot ignores
groups, channels, and bot senders. Commands:

- `/new_chat` — start a fresh chat session
- `/chats` — list recent sessions; `/switch <n>` — switch the active one
- `/model` — show the current provider/model and the available options
- `/setmodel <provider> <model>` — reply using a specific provider/model
- `/whoami` — show your chat id; `/help` — list commands

#### Optional second factor (OTP)

For defense against Telegram-account takeover (a stolen session or SIM swap, where
the attacker *is* your allowlisted chat), enable a TOTP second factor under
**Settings → Telegram → Two-factor unlock**. Yarvis generates a secret you add to
an authenticator app (Authy, Google Authenticator, 1Password, …); after that the
bot won't act until you send `/unlock <code>` to open a window (default 2h,
configurable). `/lock` ends the window early. The window relocks on restart, codes
are rate-limited with a lockout after repeated failures, your `/unlock` message is
deleted so the code doesn't linger, and the app raises a desktop notification on
each unlock/failed/lockout so you see access you didn't initiate. The code is
verified in the sidecar; it never leaves your authenticator and laptop.

## Development

```bash
# Run the full app (frontend + Rust core, which spawns the sidecar)
bun run tauri dev

# Run the sidecar standalone (prints a dev bearer token)
bun run sidecar:dev
```

## Testing

```bash
bun run test                   # frontend tests (src/) — runs under happy-dom
bun test sidecar/              # sidecar unit/integration tests
bun run --cwd sidecar typecheck
bun run build                  # typecheck + build the frontend
```

Frontend tests use `bun test` with a happy-dom environment. The preload in
`src/test/setup.ts` registers the DOM, pins the timezone, and stubs the Tauri
runtime APIs; component tests stub the sidecar data layer (`src/lib/api`) and
render real components with the `renderToHtml` helper in `src/test/render.tsx`.

## Project layout

```
src/            React frontend (Vite + TS + Tailwind)
  lib/          sidecar API client, Keychain wrappers, Omni Chat context registry, notifications, cross-tab nav (nav.ts)
    pr/         provider-agnostic PR data layer (GitHub + Azure DevOps transports, cache, refs, per-file viewed state, link/shorthand locator)
    issues/     provider-neutral issue data layer (GitHub + JIRA) — types + api client
    jira/       JIRA-specific data layer (issue detail, transitions, comments, create) — types + api client
  components/   one panel per tab (Chat, Tasks, PRs, Memory, Calendar, Terminal, Workspaces, …)
    issue/      Issues tab views: GitHub + JIRA issue lists, detail, create/repo-picker modals
    workspaces/  workspace detail subviews + Omni widgets
    shell/      desktop shell: nav rail, top bar, boot loading screen, tab shortcuts
    omni/       Omni view — chat-driven dynamic-UI canvas
    omnichat/   Omni Chat — global summon-from-anywhere chat overlay
  omni/         json-render component catalog, registry, layout primitives
src-tauri/      Rust core (Tauri v2)
  src/keychain.rs   Keychain-backed secret commands (single consolidated item)
  src/sidecar.rs    sidecar supervisor
  src/alarms.rs     full-screen alarm scheduler
sidecar/        Bun + TS service (Hono)
  src/db/       Drizzle schema, client, migrations (applied on startup)
  src/chat/     multi-provider streaming chat + tool-calls (agent.ts: shared agent turn)
  src/telegram/ Telegram remote-control bot (long-poll loop, slash commands, chat→session map)
  src/tasks/    daily/weekly work tracking
  src/events/   local on-device event log (action trail; reconciled to memory later)
  src/memory/   pgvector memory, notes, ingestion, recaps
  src/github/   GitHub PR dashboard + embedded review (REST + GraphQL), dashboard config, in-progress review roll-up
  src/azure/    Azure DevOps PR dashboard + embedded review (REST; diffs built with jsdiff)
  src/pr/       provider-neutral PR types shared by the github/ and azure/ clients
  src/issues/   provider-neutral issue routes/service (stars, filters, workspace links, start-work, issue writes)
  src/jira/     JIRA Cloud REST client + routes + agent tools + ADF↔Markdown conversion
  src/google/   Google Calendar OAuth + events
  src/omni/     Omni UI generation (streaming) + saved layouts
  src/workspaces/ repo registry + git-worktree provisioning (/api/repos, /api/workspaces)
  src/attention/  attention stream: hook ingest, SSE stream, scoped clearing
  src/chat/attentionTools.ts  request_attention tool (badge + OS notification)
  drizzle/      generated SQL migrations
```

## Attention stream

The bell in the top bar collects everything waiting on you — chiefly a Claude
Code session blocked on a permission prompt or idle waiting for input, raised by
the hooks Yarvis writes into each workspace's `.claude/settings.json`.

Items are keyed by the PTY session that raised them. A terminal the app can
navigate back to — a workspace's tabs and the standalone Terminal tab — carries
`YARVIS_SESSION_KEY` (plus `YARVIS_WORKSPACE_ID` when it belongs to a workspace)
and a create-only ingest token, so a Claude run started by hand in one of a
workspace's terminal tabs flags *that* tab rather than the workspace as a whole.

How the stream behaves:

- **Grouped by origin.** Repeat asks from one workspace collapse into a single
  row with a count, naming the tabs involved; dismissing it clears them all.
- **Cleared by looking.** Opening the workspace — or the terminal tab — that
  raised an item marks it read, and an item raised by something already on screen
  never fires an OS notification. Nothing auto-clears while the window is in the
  background.
- **Highlighted where it happened.** A workspace with something pending is marked
  in the workspace list, and the tab behind it is marked in the terminal tab strip,
  so a flag is findable while you're looking elsewhere.

## Keyboard shortcuts

- **Cmd/Ctrl + 1–9** — jump to the Nth tab in the nav rail.
- **Cmd/Ctrl + Shift + ] / [** — cycle to the next / previous tab (wraps around).
- **Control + Shift + Space** — summon **Omni Chat** from anywhere: a centered chat
  overlay that receives a snapshot of the screen you're on (e.g. the PR you're
  reviewing) as context. Esc hides it while the conversation keeps streaming in the
  background; re-summoning resumes the same session. The agent can call
  `request_attention` to raise a nav-rail badge and an OS notification when it needs
  you. Any view contributes context by calling the `useOmniChatContext` hook.
