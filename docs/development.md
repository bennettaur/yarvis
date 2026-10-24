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
bun run tauri:preview             # the same on the production frontend build: faster, no hot reload
bun run tauri:build               # a release bundle with the compiled sidecar (see Nightly builds)
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

## Verifying a PR for merge

The `/verify-pr` Claude Code skill checks a PR is ready to merge and posts a
short verification report on it. The report covers the goal, diff coverage,
whether the new tests fail without the change, how many small breaking edits to
the changed lines the tests catch (mutation testing with Stryker, for
TypeScript), reliability, security, complexity, maintainability and UI. It runs
locally, since it needs the test database and the demo harness.
`scripts/verify/` holds the parts that measure and post.

Only run it on another contributor's PR the way the skill says to. Their
tests and scripts would run with your `gh` login, so the skill measures their
PR without running any of its code.

The `Verify` workflow (`.github/workflows/verify.yml`) reacts to two kinds of
PR comment from users with write access, and acts as the yarvis GitHub App:

- **A report** from a user in `VERIFY_TRUSTED_USER_IDS`, signed by a key in
  `VERIFY_ALLOWED_SIGNERS`, for this PR and its current head. The workflow sets a `Verification report` commit status on that commit. The
  status is always a success: it records that a current report exists, and its
  description carries the verdict. If the PR is a maintainer's, not a draft,
  low risk, and the report has no concerns, the bot also approves it and turns
  on squash auto-merge. A push makes the report stale, so run `/verify-pr`
  again.
- **`/approve`** from a trusted user. The bot approves the current head and
  turns on auto-merge, marking a draft ready first. This is how a maintainer
  merges their own PR, since GitHub won't let them approve it. On an outside
  contributor's PR, write `/approve <sha>` with the commit you reviewed, so a
  push made after you read the diff isn't approved with it. Anything else after
  `/approve` is ignored.

Only low-risk PRs can merge on a report alone. `scripts/verify/tier.ts` decides
the tier, from both sides of any rename:

- **High:** CI and repo config, the verifier itself, agent instructions and
  hooks (`CLAUDE.md`, `AGENTS.md`, `.claude/`), git hooks, build and test
  config, secrets and shell access, app permissions, sidecar request handling,
  agent tool approvals, the MCP server, settings, migrations, dependencies,
  what the Chrome extension may do, the frontend's privileged calls
  (`src/lib/privilegedCommands.ts`, `src/lib/api.ts` and the files that
  import `privilegedCommands.ts`, listed in `tier.ts`), or more than 800
  changed lines of code.
- **Standard:** any other change to the Rust core, the sidecar, the extension
  or dev scripts, or more than 300 changed lines of code.

Tests, docs and lockfiles don't count toward the line limits. The rest of the
frontend is low risk because `scripts/verify/nativeBridge.ts` fails CI when
any other file makes one of those calls, or imports `privilegedCommands.ts`
without being listed.

The workflow and the gate always run as they are on the default branch, so a
change to either takes effect once it merges. They need these repository
settings:

- `YARVIS_BOT_CLIENT_ID` (variable) and `YARVIS_BOT_PRIVATE_KEY` (secret): the
  yarvis GitHub App's client ID and private key. The app needs read and write
  access to actions, contents, pull requests, issues and commit statuses.
- `VERIFY_TRUSTED_USER_IDS` (variable): comma-separated numeric GitHub user
  IDs whose reports and `/approve` count (`gh api users/<login> --jq .id`).
  IDs, not logins, because a login freed by a rename can be taken by someone
  else. Defaults to `2670128` (bennettaur).
- `VERIFY_MODE` (variable): `shadow` (the default) sets the status but never
  auto-approves. `enforce` lets a passing report approve. `/approve` works in
  both. Before switching to `enforce`, make `Verification report` a required
  status check in the `Protect Main` ruleset. Once it is required, nothing
  merges, `/approve` included, without a signed report for the current head.
- `VERIFY_ALLOWED_SIGNERS` (variable): the public keys allowed to sign, one
  OpenSSH allowed_signers line each. With none, the gate accepts no report.

#### Signing reports

`verify:report` signs each report's data block, which names the repo, the PR
and the commit, with your git SSH signing key (`user.signingkey`, through
`gpg.ssh.program`, so a key in 1Password works). Set `yarvis.verifySigningKey`
to use a different key. The gate checks the signature with `ssh-keygen -Y
verify`, so a report posted with a stolen GitHub token, or by a test running
under your `gh` login, isn't accepted unless it was also signed on your
machine. Each key is limited to one namespace, so a key allowed to approve
merges can't sign a report.

What a signature proves is narrower than it sounds. It shows the report was
signed on a machine holding your key, after 1Password let that session use
it. It doesn't show the report came from an honest `/verify-pr` run: a
prompt-injected agent in a session 1Password has approved could sign other
text. The gate's own tier and checks are the backstop, so approve 1Password
for the shortest time it offers. A signed report also counts for only six
hours after it was signed, so an old one can't be re-posted later to merge.

To allow your key, print its line and add it to the variable:

```bash
bun run --silent verify:signers
gh variable set VERIFY_ALLOWED_SIGNERS --body "$(bun run --silent verify:signers)"
```

The second command replaces the variable's whole value, so use it only for
the first key; otherwise add the line in the repo's settings.

### The merge reviewer

A report's `agent` verdict means it looks right but someone should read the
diff before it merges. That someone can be Yarvis's `merge-reviewer`
specialist (see `docs/features/pr-review.md`). It posts a signed agent-review
comment, and the gate approves on it in enforce mode only when:

- the comment is from a trusted user and signed by a key allowed for agent
  reviews (namespace `yarvis-agent-review`);
- it names the PR, its current commit and the exact latest signed report, so
  a new report needs a new review;
- that report's verdict is `agent` with no blocking finding, the change isn't
  high risk by the gate's own tier, the author is trusted and it isn't a draft.

Each review also counts for only six hours after it was signed, and a signed
reject of a report stands even if an approve of the same report is posted
after it. Reviews must be signed by the principal `yarvis-merge-reviewer` and
reports by any other, so even an allowed_signers line missing its
`namespaces=` limit can't let one key do the other's job.

Its key lives in Yarvis's Settings → Credentials. `bun run verify:agent-key`
writes one to `merge-reviewer.key`, readable only by you, and prints its
`VERIFY_ALLOWED_SIGNERS` line. Add that line beside your report key's line in
the repo's settings rather than with `gh variable set`, which would replace
it. Paste the key file's line into Settings, then delete the file. The bot's approval on
these starts `Agent-approved:`, which calibration reports as its own path and
auto-revert treats like an auto-merge.

### When an auto-merge breaks main

The `Verify revert` workflow (`.github/workflows/verify-revert.yml`) runs when
CI fails on a push to `main`. If the gate auto-approved the PR behind that
commit, CI was passing on the commit before it, and no revert exists yet, it
re-runs the failed jobs once. If they fail again, it opens a revert PR through
GitHub's own revert and comments on the original. A maintainer merges the
revert, or closes it and fixes forward. PRs a person approved, `/approve`
included, are left alone.

### Checking the thresholds

`bun run verify:calibrate --days 60` lists each verdict, and each way PRs were
approved, against how many of those merges were later reverted or caused a
regression. Reverts are found from GitHub's `Reverts owner/repo#N` line. For a
fix that doesn't revert, add a line `Regression-from: #N` to the fix PR's
description, so it counts too.

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
| Background jobs | Write memories and the activity log, calling an LLM or GitHub on a schedule | `YARVIS_BACKGROUND_WORKERS=1` |
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

Build a release locally with `bun run tauri:build`, not `bun run tauri build`.
It layers `src-tauri/tauri.release.conf.json` over the main config, which
compiles the sidecar into a single binary (`bun run sidecar:compile`), bundles it
with `externalBin`, and ships `sidecar/drizzle` as a resource for the migrations.
Those entries stay out of `tauri.conf.json` because `tauri-build` checks that an
`externalBin` exists on every cargo build, including `cargo clippy` in the
pre-commit hook. A release build also runs the sidecar with the `PATH` of your
login shell (`src-tauri/src/login_path.rs`), since an app opened from Finder
gets one without Homebrew or mise on it.

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
  src/core/        client for the Rust core's control socket (sessions, saving
                   OAuth credentials and a signed-in GitHub token)
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
  src/workStreams/ threads of work heads-down mode pushes forward, and their links
  src/headsDown/   the heads-down loop: passes, its tool policy, questions and messages
  src/agents/      specialists and bounded delegated runs
  src/help/        the user docs, embedded, and the tools the Yarvis guide reads them with
  src/jobs/        scheduler and jobs: consolidation, nightly rollup, transcript
                   digest, GitHub review sync, and your own scheduled jobs
  src/digest/      dangling work, next-work ranking, weekly summary, dismissals
  src/github/      GitHub PR dashboard and review, sign-in (device flow), error
                   explanations and rate-limit backoff
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
  src/attention/   attention stream: hook ingest, SSE, clearing, held
                   permission prompts
  src/questions/   questions agents ask over MCP, and their answers
  drizzle/         generated SQL migrations
scripts/        dev tooling (dev-instance.ts)
demo/           Playwright demo recordings: mocked Rust core, seeded demo DB (see demo/README.md)
video/          the showcase video: a standalone Remotion package (see video/README.md)
```
