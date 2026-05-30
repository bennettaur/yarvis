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
Gemini), a GitHub token (for the PR dashboard + embedded review), a Google
Cloud OAuth client id/secret (for the Calendar integration), and an optional
embeddings-provider secret (an API key and/or custom header values for an
OpenAI-compatible embeddings endpoint; a local Ollama server needs neither).
AWS Bedrock uses the standard AWS credential chain.

### Embeddings

The `memories.embedding` column is `vector(1024)`, and the active embedder's
output dimension must match it. Configure an embeddings provider under
**Settings → Embeddings**: an OpenAI-compatible endpoint such as your proxy or a
local Ollama server (base URL `http://localhost:11434/v1`, model e.g.
`mxbai-embed-large`). Without one, Yarvis uses Gemini when keyed *and* the column
dimension is 768, otherwise an offline hash embedder. Each memory records the
embedder identity (kind/model/dim) so a provider or dimension change is detected
and surfaced as a "re-embed needed" warning.

Note: migration `0006` widens the column to `vector(1024)` and **clears existing
embeddings** (memory *content* is preserved). After upgrading, configure a
provider and run **Re-embed all** in Settings (or `POST /api/memory/reembed`) to
regenerate vectors.

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
bun test sidecar/              # sidecar unit/integration tests
bun run --cwd sidecar typecheck
bun run build                  # typecheck + build the frontend
```

## Project layout

```
src/            React frontend (Vite + TS + Tailwind)
  lib/          sidecar API client, Keychain command wrappers
  components/   one panel per tab (Chat, Tasks, PRs, Memory, Calendar, Terminal, …)
    shell/      desktop shell: nav rail, top bar, boot loading screen
    omni/       Omni view — chat-driven dynamic-UI canvas
  omni/         json-render component catalog, registry, layout primitives
src-tauri/      Rust core (Tauri v2)
  src/keychain.rs   Keychain-backed secret commands
  src/sidecar.rs    sidecar supervisor
  src/alarms.rs     full-screen alarm scheduler
sidecar/        Bun + TS service (Hono)
  src/db/       Drizzle schema, client, migrations (applied on startup)
  src/chat/     multi-provider streaming chat + tool-calls
  src/tasks/    daily/weekly work tracking
  src/memory/   pgvector memory, notes, ingestion, recaps
  src/github/   PR dashboard + embedded review (REST + GraphQL)
  src/google/   Google Calendar OAuth + events
  src/omni/     Omni UI generation (streaming) + saved layouts
  drizzle/      generated SQL migrations
```
