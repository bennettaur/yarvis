# AGENTS.md

Guidance for AI agents building features in this repo.

## What this is

Yarvis is a personal-assistant desktop app for macOS, built with Tauri v2: an
LLM chat interface with memory, a spoken (STT/TTS) front end to the same agent,
work tracking, PR review, calendar, and workspace/git-worktree management. See
`README.md` for the full user-facing setup and feature docs — this file is about
working in the codebase.

## Architecture

Three processes, each with a clean ownership boundary:

- **Rust core** (`src-tauri/`) — native OS integration (window, tray,
  notifications), Keychain-backed secret storage, sidecar supervision
  (port selection, bearer token, secrets injected as env vars), and every PTY
  session: both the Terminal tab's shells and each workspace's agent session
  live in `pty.rs`, independent of the webview that renders them. The sidecar
  reaches them only through `control.rs`, a Unix-domain-socket RPC with a fixed
  method list (`claude.spawn`, `claude.kill`, `claude.send`) driven from
  `sidecar/src/core/controlClient.ts`. New ways to act on a session belong
  there, as another narrow method — not as a sidecar route that writes to a PTY.
- **React frontend** (`src/`) — Vite + TypeScript + Tailwind. Talks to the
  Rust core via `invoke` (native + secrets) and to the sidecar over
  authenticated loopback HTTP (data + AI).
- **Bun sidecar** (`sidecar/`) — a Hono HTTP service owning Postgres access
  (Drizzle ORM), LLM calls, and memory. Also hosts an optional Telegram
  remote-control bot.

Data lives in local **PostgreSQL + pgvector**. See `README.md`'s "Project
layout" section for a directory-by-directory map of both `src/` and
`sidecar/src/`.

## Commands

Run from the repo root unless noted.

```bash
bun install                      # install deps (root + sidecar workspace)

bun run tauri dev                # full app: frontend + Rust core + sidecar
bun run dev:instance <name>       # a second app beside the primary one; add
                                  #   YARVIS_DATABASE_URL to give it its own DB
bun run sidecar:dev               # sidecar only (prints a dev bearer token)

bun run test                      # frontend tests (src/, happy-dom) + the
                                  #   dev-script tests (scripts/)
bun run sidecar:test               # sidecar tests — needs a Postgres+pgvector
                                    #   test DB; set TEST_DATABASE_URL (and
                                    #   DATABASE_URL for migrations)
bun run --cwd sidecar db:migrate   # apply sidecar DB migrations

bun run typecheck                  # frontend tsc --noEmit
bun run sidecar:typecheck          # sidecar tsc --noEmit
bun run build                      # typecheck + vite build (frontend)

bun run check                      # biome lint + format check, whole repo
bun run check:write                # same, auto-fixing what it can

cargo fmt --manifest-path src-tauri/Cargo.toml            # Rust format
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --no-deps -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets   # Rust tests
(cd src-tauri && cargo audit)   # Rust advisories — run from src-tauri/ so the
                                #   accepted-advisory list in
                                #   src-tauri/.cargo/audit.toml applies
```

CI (`.github/workflows/ci.yml`) runs all of the above (frontend tests, sidecar
tests against a `pgvector/pgvector:pg16` service container, both typechecks,
biome, `bun audit --prod`, `cargo fmt --check`, `cargo clippy`, `cargo test`,
`cargo audit`). Every job in it runs on a read-only `GITHUB_TOKEN` — ci.yml
sets that default itself, so a job that needs to write back to GitHub has to
say so in its own `permissions:` block, where review can see it — and its
actions are pinned to commit SHAs, with the ref they were resolved from in a
trailing comment. `nightly.yml`
and `codeql.yml` follow neither convention yet. A pre-commit
hook (lefthook, installed via the `prepare` script) mirrors the biome and Rust
checks on staged files — `cargo clippy` blocks the commit if it fails since it
has no safe autofix.

`.github/workflows/nightly.yml` builds and publishes the `nightly` prerelease.
On macOS it always hands Tauri a signing identity — the `APPLE_SIGNING_IDENTITY`
secret when set, ad-hoc (`-`) otherwise — because macOS rejects a quarantined
bundle with no signature as "damaged", and Tauri skips signing entirely when
given no identity. Notarization runs only when the Apple ID secrets are also
present. A `codesign --verify` step blocks the macOS artifact upload when the
bundle is unsigned or its seal is broken, and `spctl --assess` additionally
fails the build when a Developer ID was expected but the signature silently fell
back to ad-hoc.

## Conventions

- Package manager is **Bun** everywhere, including the sidecar workspace.
- Formatting/linting is **Biome** for TS/JS/JSON/CSS; **rustfmt/clippy** for
  Rust. Run `bun run check:write` before committing frontend/sidecar changes.
- Frontend tests use `bun test` with a happy-dom environment; the preload in
  `src/test/setup.ts` registers the DOM, pins the timezone, and stubs Tauri
  runtime APIs. Component tests stub the sidecar API client
  (`src/lib/api`) and render with `src/test/render.tsx`'s `renderToHtml`.
- Sidecar tests that touch storage hit a real Postgres — see `sidecar/src/workspaces/routes.test.ts`
  for the pattern (temp workspaces root via `mkdtempSync`, `TRUNCATE` between
  tests, injected fake git runners to avoid real network/filesystem git ops).
- Secrets (provider API keys, tokens, DB URL) are entered in the app's
  Settings screen and stored in a single macOS Keychain item — never in env
  files or committed anywhere. Non-secret config (e.g.
  `YARVIS_WORKSPACES_ROOT`) uses env vars instead. Preferences the user is
  expected to change from the UI go in `src-tauri/src/settings.rs` when the
  Rust core enforces them, and in Postgres via the sidecar otherwise.
- Several instances of the app can run at once (`bun run dev:instance`), sharing
  one Keychain item and, unless told otherwise, one database. Anything singular
  to the machine or to that shared database — a global hotkey, a poll loop, a
  resume-on-startup sweep — belongs behind `instance.rs`, which decides who owns
  it, rather than being started unconditionally. Per-instance state that Tauri
  already keys by bundle identifier (the app data dir, the single-instance
  socket) needs nothing.
- Work that must finish regardless of what the UI is doing belongs in the
  sidecar, not in a React effect. An issue's "Start work" is the worked example:
  the route answers as soon as the workspace exists and the rest — provisioning,
  seeding `.yarvis/issue-prompt.md`, launching the agent session on the ticket —
  runs in the background there. The frontend starts nothing and resumes nothing;
  it opens a workspace and attaches to whatever session is present.
- Agent tools that read a pull request's code go through the `PrCodeSource`
  interface in `sidecar/src/pr/source.ts`, never a provider client directly —
  the tools in `codeTools.ts` are written once and GitHub/Azure each supply an
  implementation. A capability one provider lacks resolves to `null` so the
  caller can say so, rather than throwing.
- Speech backends sit behind the `SpeechClient` interface in
  `sidecar/src/voice/speech.ts`, resolved by `voice/providers.ts` the same way
  `llm/providers.ts` resolves chat models — built-ins keep a bare id, user
  providers keep the `custom:<id>` namespace.
- Voice is a capability of the chat surfaces, not a surface of its own:
  `src/lib/useVoice.ts` wraps speech around a thread the caller already owns,
  taking that surface's `send` and watching the reply text it is already
  accumulating. A spoken turn therefore uses whatever provider/model that chat
  is set to. Which speech backends to use lives in Postgres
  (`sidecar/src/voice/config.ts`), not in the frontend, because the Telegram bot
  runs in the sidecar and needs the same settings (#226).
- Outbound speech calls go through `guardedFetch` in that same file, never a
  bare `fetch`: it re-runs the SSRF guard on every redirect hop rather than only
  the first (`redirect: "manual"`, mirroring `memory/ingest.ts`) and puts a
  deadline on the whole chain. `fetch` strips `Authorization` across origins but
  not a custom provider's own auth headers, so following a redirect unchecked
  would hand those to whatever host it named.
- What a surface can do without asking depends on whether the user proof-read
  the turn. `ChatMessageMetadata.source` records where it came from, and
  `runAgentTurn` uses it: a `voice` turn puts the tools in
  `chat/destructiveTools.ts` behind the same approval prompt MCP tools use,
  because a transcript can be misheard or picked up from the room. A surface
  that can't prompt gets those tools dropped rather than run unattended —
  silently doing the irreversible thing is the one unacceptable outcome.
- `sidecar/src/mcp/` is the MCP *client* (servers Yarvis connects out to);
  `sidecar/src/mcpServer/` is the MCP endpoint Yarvis *serves*. A tool exposed
  over that endpoint is reached by outside clients holding only the scoped
  `YARVIS_MCP_TOKEN`, so it must be one that token is meant to grant — the
  endpoint deliberately sits outside the main bearer wall, like attention-ingest.
- Anything an outside party can influence — file contents, diffs, PR titles,
  recalled memories — enters a prompt as data, not instruction: fenced in
  per-request nonce tags (see `sidecar/src/pr/ask.ts`) with the system prompt
  telling the model to treat it as reference material. A path or query a *model*
  chooses is untrusted input too: `sidecar/src/pr/codeTools.ts` refuses `..`
  segments and search qualifiers before they reach a provider client.
- Text a *model* composes that will be typed into another agent's prompt is the
  sharpest form of that, since the receiving agent acts on it with its own
  permissions. `claude.send` is the only such path and it is guarded on both
  sides: `pty.rs`'s `prepare_instruction` turns the control characters that would
  submit early into spaces and rejects an instruction opening with a character
  the agent reads as a command (`!` is bash mode, `/` a slash command, `#` a
  memory write), `foreground_is_agent` refuses to type at all unless the
  configured agent is what's reading the prompt, and the chat agent's system
  prompt forbids relaying third-party text as an instruction. What no layer can
  establish is *what the agent is showing*, so a send is reported as delivered,
  never as done. Anything new that forwards text into a session owes the same
  three.
- Follow the repo's existing comment style: comments explain *why*, not
  *what* — no restating what a well-named function already says.
