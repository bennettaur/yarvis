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
  (Drizzle ORM), LLM calls, and memory. Runs `src/server.ts` directly with Bun
  in development; compiled to a single binary for distribution.

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
toggle in the PRs tab), a Google Cloud OAuth client id/secret (for the Calendar
integration), and an optional embeddings-provider secret (an API key and/or
custom header values for an OpenAI-compatible embeddings endpoint). AWS Bedrock
uses the standard AWS credential chain.

The Azure DevOps token is a Personal Access Token with **Code (read)** and
**Pull Request Threads (read & write)** scopes; the organization URL is the
`https://dev.azure.com/your-org` base (project is chosen per search).

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
  lib/          sidecar API client, Keychain wrappers, Omni Chat context registry, notifications
    pr/         provider-agnostic PR data layer (GitHub + Azure DevOps transports, cache, refs)
  components/   one panel per tab (Chat, Tasks, PRs, Memory, Calendar, Terminal, …)
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
  src/chat/     multi-provider streaming chat + tool-calls
  src/tasks/    daily/weekly work tracking
  src/events/   local on-device event log (action trail; reconciled to memory later)
  src/memory/   pgvector memory, notes, ingestion, recaps
  src/github/   GitHub PR dashboard + embedded review (REST + GraphQL)
  src/azure/    Azure DevOps PR dashboard + embedded review (REST; diffs built with jsdiff)
  src/pr/       provider-neutral PR types shared by the github/ and azure/ clients
  src/google/   Google Calendar OAuth + events
  src/omni/     Omni UI generation (streaming) + saved layouts
  src/chat/attentionTools.ts  request_attention tool (badge + OS notification)
  drizzle/      generated SQL migrations
```

## Keyboard shortcuts

- **Cmd/Ctrl + 1–9** — jump to the Nth tab in the nav rail.
- **Cmd/Ctrl + Shift + ] / [** — cycle to the next / previous tab (wraps around).
- **Control + Shift + Space** — summon **Omni Chat** from anywhere: a centered chat
  overlay that receives a snapshot of the screen you're on (e.g. the PR you're
  reviewing) as context. Esc hides it while the conversation keeps streaming in the
  background; re-summoning resumes the same session. The agent can call
  `request_attention` to raise a nav-rail badge and an OS notification when it needs
  you. Any view contributes context by calling the `useOmniChatContext` hook.
