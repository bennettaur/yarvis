# Development

This page is for working on Yarvis itself. To get a dev build running for the
first time, start with [Getting started](getting-started.md). For conventions
an agent (or a person) should follow when changing the code, read
[`AGENTS.md`](../AGENTS.md).

## Architecture

Three processes, each with a clear owner:

- **Rust core** (`src-tauri/`). Native OS integration (window, tray,
  notifications, global hotkeys, alarms), the secret store (Keychain or
  1Password), and every terminal session. It supervises the sidecar: it picks a
  free loopback port, generates a bearer token, and passes secrets in as
  environment variables.
- **React frontend** (`src/`). Vite, TypeScript and Tailwind. It calls the Rust
  core through Tauri `invoke` for native features and secrets, and the sidecar
  over authenticated loopback HTTP for data and AI.
- **Bun sidecar** (`sidecar/`). A Hono HTTP service that owns Postgres (through
  Drizzle), every LLM call, memory, the background jobs and the Telegram bot.
  In development it runs `sidecar/src/server.ts` directly with Bun.

Data lives in PostgreSQL with pgvector. Non-secret settings live in
`~/.yarvis/settings.json`. See [Configuration](configuration.md).

## Commands

Run these from the repo root.

```bash
bun run tauri dev                 # the full app: frontend + Rust core + sidecar
bun run dev:instance <name>       # a second copy beside your main one
bun run sidecar:dev               # the sidecar on its own (YARVIS_LOG_DEV_TOKEN=1 prints its API token)
bun run demo                      # record screenshots and video of the UI (see demo/README.md)

bun run test                      # frontend tests (src/) and dev-script tests (scripts/)
bun run sidecar:test              # sidecar tests; needs a test database
bun run typecheck                 # frontend tsc --noEmit
bun run sidecar:typecheck         # sidecar tsc --noEmit
bun run build                     # typecheck + vite build

bun run check                     # biome lint + format check
bun run check:write               # the same, fixing what it can

bun run --cwd sidecar db:generate # generate a migration from schema changes
bun run --cwd sidecar db:migrate  # apply migrations (needs DATABASE_URL)

cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --no-deps -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
(cd src-tauri && cargo audit)     # run from src-tauri/ so its accepted-advisory list applies
```

The sidecar applies pending migrations every time it starts, so you rarely need
`db:migrate` by hand.

## Test database

Sidecar tests run against a real Postgres. Create a separate test database once:

```bash
createdb yarvis_test
psql -d yarvis_test -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

Tests use `TEST_DATABASE_URL`, which defaults to
`postgres://localhost:5432/yarvis_test`. Migrations read `DATABASE_URL`, so set
both when you run the suite:

```bash
DATABASE_URL=postgres://localhost:5432/yarvis_test \
TEST_DATABASE_URL=postgres://localhost:5432/yarvis_test \
  bun run sidecar:test
```

Tests truncate tables between cases. Never point them at your real `yarvis`
database.

Settings kept in `settings.json` (custom providers, voice config and so on)
aren't in Postgres, so truncating doesn't reset them. The sidecar preload in
`sidecar/src/test/setup.ts` points `YARVIS_SETTINGS_PATH` at a temp file and
`YARVIS_AGENTS_DIR` at an empty temp folder for the whole suite when it runs
from `sidecar/`, so your own `~/.yarvis/agents` definitions never change what
the tests load. A test that writes settings should still set its own path per
test.

Frontend tests use `bun test` with happy-dom. The preload in
`src/test/setup.ts` registers the DOM, pins the timezone and stubs the Tauri
APIs. Component tests stub the sidecar client (`src/lib/api`) and render with
`renderToHtml` from `src/test/render.tsx`.

## Git hooks and CI

`bun install` installs a lefthook pre-commit hook. On staged files it runs:

- `biome check --write`, re-staging what it fixes,
- a check that `bun.lock` names no private registry (see `AGENTS.md`),
- `cargo fmt`, re-staging what it fixes,
- `cargo clippy -D warnings`, which blocks the commit if it fails.

CI (`.github/workflows/ci.yml`) runs the frontend and sidecar tests (against a
`pgvector/pgvector:pg16` container), both typechecks, Biome, `bun audit --prod`,
`cargo fmt --check`, `cargo clippy`, `cargo test` and `cargo audit`.

## Running more than one instance

A branch under development can run beside the copy you use every day. Give the
second one a name:

```bash
bun run dev:instance migration-test
```

The name picks a bundle identifier (`com.mikebennett.yarvis.migration-test`)
and a pair of Vite ports in the 1430–1489 range. The pair comes from the name,
so it's the same every launch. If something else holds it, the launcher moves
to the next free pair. The second port is Vite's HMR socket, used when
`TAURI_DEV_HOST` is set. `YARVIS_DEV_PORT` pins a port instead, and fails if it
is taken. Because macOS
derives the app data directory from the identifier, each instance gets its own
`alarms.json` and control socket. The window title shows the name.

Use `dev:instance` rather than setting `YARVIS_INSTANCE` on a plain
`bun run tauri dev`. The variable alone makes the process skip the hotkeys and
background workers, but it keeps the main bundle identifier, so it shares the
main instance's alarms and control socket.

### What the instances share

Both instances read the **same secrets item** and the **same
`~/.yarvis/settings.json`**. By default they also share the database, so the
second instance sees your real data. That is usually what you want.
`YARVIS_CLAUDE_COMMAND` changes the agent command for one instance without
touching the shared file.

To give an instance its own database (for testing a migration, say):

```bash
createdb yarvis_dev
psql -d yarvis_dev -c 'CREATE EXTENSION IF NOT EXISTS vector;'

YARVIS_DATABASE_URL="postgres://localhost:5432/yarvis_dev" \
  bun run dev:instance migration-test
```

`YARVIS_DATABASE_URL` replaces only the database URL. Every other secret still
comes from the shared item. Two cautions:

- The Settings screen reads and writes the **shared** database URL, not the
  override. Changing it from the isolated instance repoints your main one.
- A connection string on the command line ends up in your shell history and in
  `ps` output. Export it or use `.pgpass` if it has a password.

### Work only one instance does

Some work must happen in exactly one process. A named instance leaves it to the
main one:

| What | Why only once | Override |
| --- | --- | --- |
| Telegram bot | Telegram rejects a second long-poll on the same token | `YARVIS_BACKGROUND_WORKERS=1` |
| Workspace and PR poller | Doubles API traffic and writes the same rows twice | `YARVIS_BACKGROUND_WORKERS=1` |
| Resuming interrupted kick-offs | Would start two agent sessions in one workspace | `YARVIS_BACKGROUND_WORKERS=1` |
| Stale PR-guide sweep | Deletes rows on a schedule | `YARVIS_BACKGROUND_WORKERS=1` |
| Background jobs | Write memories and call an LLM on a schedule | `YARVIS_BACKGROUND_WORKERS=1` |
| Global hotkeys (`Control+Shift+Space`, `Control+Shift+V`) | Only one process can hold a hotkey | `YARVIS_GLOBAL_SHORTCUTS=1` |

Set an override to `1` on the instance that should do the work, or `0` on the
main instance to make it stop. Only `1`/`true` and `0`/`false` are read.

A separate database covers only the rows. The Telegram token still comes from
the shared Keychain, so turning workers on in a second instance splits your real
bot traffic between two processes. Give it its own bot token first. The
workspace poller also doubles GitHub API traffic against your rate limit.

Workspaces are shared too: both instances create worktrees under
`YARVIS_WORKSPACES_ROOT`. Point one elsewhere to keep them apart.

## Nightly builds

`.github/workflows/nightly.yml` publishes a `.dmg` to the
[`nightly` release](https://github.com/bennettaur/yarvis/releases/tag/nightly).

Release builds don't bundle the sidecar yet. `command_base` in
`src-tauri/src/sidecar.rs` runs a `yarvis-sidecar` binary that packaging doesn't
produce (`bun build --compile` plus `externalBin`). Until that lands, run the
dev build.

The nightly is ad-hoc code-signed but not notarized, so macOS blocks the first
launch:

1. Drag **Yarvis** into `/Applications` and open it. macOS refuses.
2. Open **System Settings → Privacy & Security**, find the message about Yarvis
   near the bottom, and click **Open Anyway**.

That approves this one app and keeps the quarantine and malware checks in place
for everything else. `xattr -dr com.apple.quarantine /Applications/Yarvis.app`
also works, but it turns those checks off for the bundle for good.

An app with no signature at all is reported as "damaged" with no override
([#189](https://github.com/bennettaur/yarvis/issues/189)). The ad-hoc signature
prevents that.

Notarizing removes the extra step. It needs an Apple Developer account. Once
there is one, set `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` as
repository secrets, and the nightly workflow signs and notarizes with no other
changes.

## Project layout

```
src/            React frontend (Vite + TS + Tailwind)
  lib/          sidecar API client, Keychain wrappers, Omni Chat context registry,
                notifications, cross-tab nav (nav.ts), unsaved editor buffers
                (fileDrafts.ts) and cursor/scroll positions (editorPlaces.ts),
                and the voice loop (useVoice.ts and friends)
    pr/         provider-agnostic PR data layer: GitHub and Azure transports, cache,
                refs, per-file viewed state, link parsing, diff parsing and context
                expansion, guide, insight and stack clients
    issues/     provider-neutral issue data layer (GitHub, JIRA, Azure Boards) and
                start-work flow
    jira/       JIRA data layer: detail, transitions, comments, create
    azureBoards/ Azure Boards data layer: detail, state and field edits, comments,
                start-work
    find/       find-on-page engine
  components/   one panel per tab (Chat, Tasks, PRs, Memory, Calendar, Terminal,
                Workspaces, …)
    voice/      the mic button and voice controls shared by the chat surfaces
    pr/         PR dashboard and embedded review: lists, diffs, context expansion,
                change minimap, guide panel, insight cards, stack list
    issue/      Issues tab views
    files/      shared file-tree rows
    editor/     CodeMirror 6 wrapper behind the workspace file editor
    workspaces/ workspace detail views, Omni widgets, self-review comments, editor
    shell/      nav rail, top bar, boot screen, tab shortcuts, cheat sheet
    omni/       Omni view, the chat-built widget canvas
    omnichat/   Omni Chat, the summon-from-anywhere chat overlay
    memory/     memory library, activity log, agent todos, projects
    clipboard/  clipboard palette
    onboarding/ first-run setup guide and the app tour
    find/       find-on-page bar (Cmd+F)
  omni/         json-render component catalog, registry, layout primitives
src-tauri/      Rust core (Tauri v2)
  src/keychain.rs       secret commands over the single consolidated item
  src/secret_store.rs   which store holds that item: Keychain or 1Password
  src/onepassword.rs    the 1Password store, through the `op` CLI
  src/settings.rs       non-secret settings in ~/.yarvis/settings.json
  src/instance.rs       which instance this process is, and what it owns
  src/sidecar.rs        sidecar supervisor
  src/pty.rs            terminal and workspace agent sessions
  src/control.rs        fixed-method socket the sidecar drives sessions through
  src/alarms.rs         full-screen alarm scheduler
  src/clipboard.rs      clipboard read/write and in-memory clip history
sidecar/        Bun + TS service (Hono)
  src/core/        client for the Rust core's control socket
  src/db/          Drizzle schema, client, migrations (applied on startup)
  src/chat/        streaming multi-provider chat and tools (agent.ts: the shared turn)
  src/llm/         provider resolution and the model catalog (catalog.ts)
  src/voice/       speech to text and text to speech
  src/clipboard/   saved clipboard entries and the credential screen (screening.ts)
  src/telegram/    Telegram bot
  src/tasks/       daily and weekly tasks, dedupe, "did I already finish this?"
  src/events/      the local activity log
  src/memory/      pgvector memory, notes, ingestion, recaps
  src/projects/    projects: status, focus, tracked tickets with priorities
  src/todos/       the assistant's own todo list
  src/agents/      specialists and bounded delegated runs
  src/help/        the user docs, embedded, and the tools the Yarvis guide reads them with
  src/jobs/        scheduler and jobs: consolidation, nightly rollup, transcript
                   digest, and your own scheduled jobs
  src/digest/      dangling work, next-work ranking, weekly summary, dismissals
  src/github/      GitHub PR dashboard and review
  src/azure/       Azure DevOps PR dashboard and review
  src/pr/          provider-neutral PR review: guides, insights, code tools,
                   workspace-on-a-PR, stacks
  src/issues/      provider-neutral issue routes and start-work
  src/jira/        JIRA client, routes, tools, ADF↔Markdown
  src/azureBoards/ Azure Boards work item client, routes, HTML to Markdown
  src/google/      Google Calendar OAuth, reads, and create
  src/omni/        Omni UI generation and saved layouts
  src/workspaces/  repo registry, worktree provisioning, base-branch sync,
                   teardown, self-review comments, gh-stack bridge, file editor
  src/mcp/         MCP client: connected servers, OAuth, tool registry, approvals
  src/mcpServer/   the MCP endpoint Yarvis serves
  src/attention/   attention stream: hook ingest, SSE, clearing
  drizzle/         generated SQL migrations
scripts/        dev tooling (dev-instance.ts)
demo/           Playwright demo recordings: mocked Rust core, seeded demo DB (see demo/README.md)
```
