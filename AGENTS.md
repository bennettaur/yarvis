# AGENTS.md

Guidance for AI agents building features in this repo.

## What this is

Yarvis is a personal-assistant desktop app for macOS, built with Tauri v2: an
LLM chat interface with memory, work tracking, PR review, calendar, and
workspace/git-worktree management. See `README.md` for the full user-facing
setup and feature docs — this file is about working in the codebase.

## Architecture

Three processes, each with a clean ownership boundary:

- **Rust core** (`src-tauri/`) — native OS integration (window, tray,
  notifications), Keychain-backed secret storage, and sidecar supervision
  (port selection, bearer token, secrets injected as env vars).
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
bun run sidecar:dev               # sidecar only (prints a dev bearer token)

bun run test                      # frontend tests (src/), happy-dom
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
```

CI (`.github/workflows/ci.yml`) runs all of the above (frontend tests, sidecar
tests against a `pgvector/pgvector:pg16` service container, both typechecks,
biome, `bun audit --prod`, `cargo fmt --check`, `cargo clippy`). A pre-commit
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
- Agent tools that read a pull request's code go through the `PrCodeSource`
  interface in `sidecar/src/pr/source.ts`, never a provider client directly —
  the tools in `codeTools.ts` are written once and GitHub/Azure each supply an
  implementation. A capability one provider lacks resolves to `null` so the
  caller can say so, rather than throwing.
- Anything an outside party can influence — file contents, diffs, PR titles,
  recalled memories — enters a prompt as data, not instruction: fenced in
  per-request nonce tags (see `sidecar/src/pr/ask.ts`) with the system prompt
  telling the model to treat it as reference material. A path or query a *model*
  chooses is untrusted input too: `sidecar/src/pr/codeTools.ts` refuses `..`
  segments and search qualifiers before they reach a provider client.
- Follow the repo's existing comment style: comments explain *why*, not
  *what* — no restating what a well-named function already says.
