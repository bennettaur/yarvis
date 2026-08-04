# Yarvis Roadmap

Status of the build against the original vision. The full V1 plan lives at
`~/.claude/plans/we-are-going-to-polymorphic-lightning.md`.

## Shipped

- **Foundation** — Tauri v2 (Rust core) + React/Vite/TS frontend + Bun sidecar,
  local PostgreSQL 17 + pgvector, macOS Keychain secret storage, sidecar
  supervision with live reload. Migrations apply automatically on sidecar
  startup; a boot screen gates the UI on sidecar `/health` readiness.
- **Desktop shell** — full-bleed layout with a left icon nav rail and a top bar
  with live sidecar status (sharp, flat aesthetic, indigo accent), replacing the
  earlier centered card layout. Static pages remain.
- **Chat** — multi-provider streaming (Anthropic / AWS Bedrock / Gemini) with
  session + message persistence.
- **Work tracking** — daily/weekly tasks driven by chat tool-calls
  ("I plan to…", "what's left?", roll yesterday forward) plus a Tasks UI.
- **Memory** — `MemoryService` over pgvector with remember/recall tools in chat.
  Embeddings come from a configurable OpenAI-compatible provider (an internal
  proxy or a local Ollama server), with Gemini as a fallback when keyed and the
  column dimension is 768, and an offline hash embedder otherwise. The column is
  `vector(1024)`; each memory records the embedder identity (kind/model/dim), so
  a provider or dimension change is detected and surfaced as a "re-embed needed"
  health warning in Settings (with a re-embed action).
- **Claude Code session introspection** — browse `~/.claude` projects, session
  transcripts, and plans (Sessions tab).
- **PR dashboard (GitHub + Azure DevOps)** — my PRs and review-requested, split
  into tabs and grouped by repo, newest-first; each row is clickable into the
  in-app review and shows a draft label, CI/merge status, and relative dates.
  Stars and saved filters too. A provider toggle switches between GitHub and
  Azure DevOps, which share one provider-agnostic UI (PRs tab).
- **Alarms** — full-screen takeover + escalating sound/notification, with
  acknowledge/snooze, plus a Join-meeting action on meeting-derived alarms that
  opens the meet link and ends the alarm (Alarms tab).
- **Embedded PR review** — in-app PR detail view (description, normalized checks,
  review threads, file diffs) rendered with markdown and per-line diff coloring
  (PRs tab → row click). Decomposed into reusable, prop-driven components that
  share one cached fetch per PR; the detail view places the changed-file list
  beside the diffs and has a collapsible checks section. Works for both GitHub
  (GraphQL + REST diffs) and Azure DevOps (REST; per-file diffs computed with
  jsdiff since Azure has no unified-diff endpoint). Clicking a diff line opens a
  composer that posts a single-line comment to the PR, and existing review
  threads render inline at their line — for both providers. A static header at
  the top of the detail view shows a derived lifecycle status
  (Draft / CI failing / Awaiting review / Ready to merge) plus a review toolbar
  that publishes a draft (GitHub `markPullRequestReadyForReview`; Azure
  `isDraft=false` PATCH), approves, or requests changes (GitHub native review
  submission; Azure votes 10 / -10 with the comment posted as a PR-level thread
  when provided). Per-file "Viewed" pill checkboxes mark files done — synced
  to github.com natively via GraphQL on GitHub, and persisted to localStorage
  on Azure (no provider equivalent). Toggling a file viewed collapses its diff
  (and re-expands when unmarked). A "Reviewers" panel lists requested reviewers
  alongside anyone who has already reviewed, with a per-verdict badge (approved
  / changes requested / pending / commented / dismissed) and a compact summary
  in the collapsed header — GitHub via `reviewRequests` + `latestReviews`,
  Azure via reviewer vote codes on the PR payload. The provider toggle only
  shows providers whose viewer probe lands, so an unconfigured option never
  flashes.
- **Diff reading** — files open on their own as the reader scrolls toward them
  (an IntersectionObserver rooted on the review pane, which is what lets the
  margin reach past its bottom edge), with "Collapse all" / "Expand all" for
  the whole set. A Unified/Split toggle, persisted across PRs, puts the old
  file beside the new one with the nth deletion of a run across from the nth
  addition. Each gap between hunks carries a marker that reveals the code the
  patch left out — twenty lines at either end or the whole stretch — and a
  per-file "Whole file" toggle opens every gap at once, with a strip down the
  edge marking where in the file the changes fall. Gap markers size themselves
  from the hunk headers, so a file's full text is only fetched once context is
  actually asked for; those fetches share a concurrency gate with the per-file
  diffs so expanding a large Azure review can't fan out into hundreds of
  simultaneous requests.
- **PR guided tour** — an agent explores a pull request with provider-backed
  read/search tools, records what connects to what in a scratch graph, and lays
  out a reading order from the outside in: the request that arrives, then what
  handles it, down to what it finally writes. Each step names a file and line
  range with a sentence or two on why it comes there, plus optional background.
  The guide is stored per PR against the commit it was generated at, so a push
  marks it stale rather than silently shifting its line numbers, and an
  in-progress guide holds one coalescing item in the attention stream showing
  which step the review is on. Cleanup is event-driven — approving, requesting
  changes, or merging retires the guide, a detail load that reports a closed PR
  retires it lazily, and a startup sweep drops anything untouched for 30 days —
  so no poller watches pull requests that have a guide. In the review the tour
  renders as a box docked to the bottom of the scroll pane (the diff moves under
  it as steps advance, so it can't scroll away from the reader) with the step
  count, the explanation, an expandable context section, and back/next. Landing
  on a step opens its file — overriding a deliberate collapse — scrolls to its
  lines, and marks them down the left edge, in both the unified and side-by-side
  views.
- **Line insights** — a "?" beside any line asks the same tool-equipped agent
  about that code (shift-click extends from the last line asked about, so a
  block can be picked out without a drag that would fight the browser's own text
  selection). The answer is stored against those lines and renders inline,
  styled apart from review threads because it is the reviewer's own note rather
  than something the author sees — with a Post action that turns one into a real
  line comment when it is worth sharing. Insights carry the commit they were
  written against and are marked out of date once the PR moves past it. Unlike
  guides they are not swept: an answer about why code is the way it is outlives
  the pull request that prompted it. The chat agent can read both —
  `list_pr_reviews` answers "where did I leave off" from the guides and their
  progress, `search_pr_insights` looks through the recorded notes — read-only,
  since reporting on a review is useful and inventing one is not.
- **Issues dashboard (GitHub)** — a global Issues tab mirroring the PR
  dashboard: "Assigned to me" / "All open" / saved-filter views, grouped by
  repo, with stars, search, "in progress" badges, and a manual refresh. Issues
  are pulled from repos flagged with a per-repo "Pull issues" toggle, and new
  issues can be opened in any of those repos. The issue detail view (title,
  labels, assignees, markdown body, comments) grooms a ticket in place — editing
  its title and description, closing and reopening it — and has a "Start work"
  action that creates a workspace for the issue, links it, best-effort assigns
  the issue to the viewer and labels it in-progress on GitHub, then provisions
  the worktree and launches a Claude session seeded with the issue title +
  description (written to `.yarvis/issue-prompt.md`). The chat agent can drive
  the same start-work flow conversationally via its `list_repo_issues` /
  `start_work_on_issue` tools. The data model, provider layer, and
  `/api/issues/:provider` routes are source-agnostic (keyed by provider /
  sourceKey / externalId) so JIRA can be added without a rewrite.
- **Memory & knowledge** — notes, daily/weekly recaps (tasks completed + notes,
  LLM-summarized or offline raw), document/URL ingestion (chunk → embed →
  store), and a management UI to search/delete (Memory tab). Reuses the
  `memories` table with a `type` tag (note/doc/fact).
- **Google Calendar** — desktop OAuth + a date-range events fetch backing a
  Calendar tab with a view switcher: agenda, a Sunday-start week grid, a month
  grid, and a scrolling day timeline (vertical/horizontal) with a current-time
  line. Every view arms meeting alarms just before start and shows whether one
  is already set. The week/month/day views are also Omni widgets.
- **Omni (dynamic UI)** — describe a workspace in natural language and an agent
  composes a live layout from a fixed component catalog: layout primitives
  (Row/Column/Grid/Panel/…) plus self-contained feature widgets (Tasks,
  Calendar, CalendarWeek, CalendarMonth, CalendarDay, Memory, PRs, Sessions,
  Alarms, Settings, Chat, Terminal, WorkspaceList, and a Workspace widget named
  by id) and the decomposed
  PR-review widgets (PrDescription/PrChecks/PrFileList/PrFileDiffs) that name a
  single PR by owner/repo/number and share one cached fetch. Widgets accept an
  optional fixed `height` so duplicates scroll independently. Streamed from the
  sidecar `/api/omni/generate` and rendered with `@json-render`; the canvas
  scrolls and the builder panel collapses; layouts can be named, saved
  (`omni_layouts`), and reloaded (Omni tab).
- **Terminal** — a live shell backed by a real PTY in the Rust core
  (`portable-pty`), rendered with xterm.js. Sessions are keyed by a stable id
  and live in the core independent of the webview, so the shell survives tab
  switches and Omni re-renders (scrollback is captured and replayed on
  reattach). Available as a standalone Terminal tab and as an Omni widget. In
  every terminal-tab strip (standalone Terminal tab and each workspace's
  terminal), tabs can be dragged to reorder them; the new order persists.
- **Workspaces** — one or many repo worktrees pulled into a folder for a
  contextual task. A repo registry + git-worktree engine in the sidecar (clone,
  refresh default branch, cut worktrees off `origin/<default>`, run per-repo
  setup scripts; metadata in Postgres); a Workspaces sidebar tab with a
  per-workspace terminal at the parent folder + per-repo run-script terminals; a
  right-hand All files / Changed / PR-checks column backed by a background PR
  poller; task linkage that auto-completes a linked task on archive (recording a
  summary + merged-PR URL); and `WorkspaceList` / `Workspace` Omni widgets. The
  worktree engine also answers the working-directory question in "Claude Code
  delegation" below. Files / Changes views auto-refresh every 5 seconds while
  visible (paused when the tab is hidden); the open workspace's detail view
  re-polls every 20 seconds so PR / checks cache updates from the background
  poller appear without re-selecting. Archived workspaces are hidden by
  default with a "Show archived (N)" toggle; the active selection and the
  show-archived state are persisted to localStorage so navigating away and
  back returns to the same workspace. The New Workspace form has inline
  "+ Add new" repo creation so a fresh repo can be registered without leaving
  the page. The PR-checks panel's "Review in yarvis" button hands off to the
  PRs tab (via an in-app event bus) and opens the detail view directly,
  alongside an "Open externally ↗" button for the provider's web UI.
- **Omni Chat + keyboard navigation** — a global `Control+Shift+Space` hotkey
  (registered in the Rust core) raises a centered chat overlay over any tab; Esc
  hides it while the session keeps streaming in the background, and re-summoning
  resumes the same persisted conversation. Each mounted view contributes a context
  snapshot via the `useOmniChatContext` hook → a frontend page-context registry;
  the active snapshot is sent to the agent as a nonce-delimited, non-instruction
  screen-context message (kept out of the system prompt). A `request_attention`
  tool lets the agent raise a nav-rail badge + an OS notification when it finishes
  background work or needs a decision. The agent also holds workspace tools: it
  can list repos and their open issues, spin up workspaces (from repos, from an
  issue like the "Start work" button, or scratch) and start agent sessions
  (remote-controllable only when the request came in over Telegram, where there
  is no local tab to drive), report a workspace's PR / CI-check / mergeable status, and
  archive workspaces — all from natural language, and reachable from Chat, Omni,
  and the Telegram bot alike. Tab shortcuts too: Cmd/Ctrl+1–9 jump to a
  tab, Cmd/Ctrl+Shift+[ / ] cycle through them.
- **Telegram remote control** — chat with Yarvis and issue control commands from
  Telegram. A long-poll bot in the sidecar drives the same chat agent (extracted
  into a shared `runAgentTurn`), persists a chat→session mapping plus the chosen
  provider/model (`telegram_chats`), and supports `/new_chat`, `/chats`,
  `/switch`, `/model`, `/setmodel`, and `/whoami`. Access is gated by a chat-id
  allowlist and restricted to private chats; the bot token + allowlist are stored
  in the Keychain like other secrets. An optional TOTP second factor (`/unlock`)
  gates the bot behind a time-boxed window with rate-limited lockout and desktop
  alerts, to defend against Telegram-account takeover.
- **Event log (Phase 2)** — a local, on-device trail of meaningful actions
  (chat started, task created/completed via backend hooks; PR viewed, review
  guide generated and stepped through, line insight recorded and revisited, and
  alarm created from the UI), persisted to an `events` table and served over
  `POST`/`GET /api/events`. Event types are a fixed allowlist; recording is
  best-effort so a logging failure never breaks the triggering action. UI
  navigation and Omni layouts are deliberately not events. Reconciling events
  into memories is Phase 3 (not yet built).

## Remaining to build

### 1. Claude Code delegation
Dispatch coding tasks to Claude Code from the app (e.g. "fix all my failing
PRs" → check out the PR branch and run an agent to fix it).
- **Approach:** `@anthropic-ai/claude-agent-sdk` `query()` in the Bun sidecar,
  pointed at a working directory; stream progress to the UI; tie into the PR
  dashboard to target failing PRs.
- **Needs from you:** guardrail decisions — which repos/paths are allowed,
  permission mode (auto-accept edits vs. prompt), whether to sandbox, how to get
  the branch locally (find existing clone vs. fresh checkout to a scratch dir),
  and Agent SDK auth/billing (Anthropic key vs. Bedrock).
- **Builds on:** GitHub dashboard. Bun is already the runtime (Agent SDK is
  Bun-first).

### 2. Google Calendar verification
The integration is built but unexercised.
- **Needs from you:** create a Google Cloud OAuth app (Desktop client), register
  the loopback redirect `http://127.0.0.1:<sidecar-port>/oauth/google/callback`,
  and enter the client id/secret in Settings. Then connect from the Calendar tab
  and confirm the auth → token-exchange → events → alarm flow end to end.
- **Possible follow-ups:** background auto-sync of alarms (today arming is
  manual per event or "set alarms for all"); a "joined" signal beyond
  acknowledging the alarm; per-event lead-time configuration.

### 3. Memory & knowledge follow-ups
The core is shipped; optional extensions remain.
- **OpenMemory backend:** `openmemory-js` was deferred because it boots its own
  server on import and is mid-rewrite; if its graph/temporal features become
  worth it, run it as a standalone server and add an HTTP-backed `MemoryService`
  (the interface already supports swapping).
- **Needs from you:** an embeddings provider for good-quality semantic recall —
  either a local Ollama server (no key) or a proxy/Gemini key, configured in
  Settings → Embeddings. Works offline via the hash embedder at lower quality
  otherwise. (The current embedder path is OpenAI-compatible or Gemini; Bedrock
  embeddings are not wired up.)

### 4. Event reconciliation (Phase 3)
The event log (Phase 2) records actions but nothing yet folds them into memory.
- **Approach:** a periodic reconciliation pass scans unprocessed events
  (`processed_at IS NULL`, oldest-first via `events_processed_occurred_idx`),
  derives layered memories (e.g. a short summary referencing a PR or chat, plus
  a daily rollup), and stamps `processed_at`. Plus a PR created/reviewed poller
  that emits events, and a default summarization model setting.
- **Builds on:** the shipped event log and the existing `MemoryService`.

## Cross-cutting / polish / tech debt

- **Packaging & distribution:** compile the Bun sidecar to a single binary
  (`bun build --compile`) and wire the production spawn path in `sidecar.rs`
  (`externalBin` + `extractFromBunfs` for the Agent SDK's bundled CLI); app
  bundle + code signing.
- **Live verification:** exercise the credential-gated paths once keys are
  entered — chat streaming + task tool-calls, GitHub queries, Gemini embeddings.
- **Tray + autostart:** the plugins are installed but not yet wired to behaviors
  (run in tray, launch at login, focus on alarm).
- **Secret storage review:** confirm Keychain coverage; consider Stronghold for
  defense-in-depth. Note: Google OAuth access/refresh tokens are persisted in
  Postgres (`google_tokens`) rather than the Keychain — fine for a local
  single-user app, but a candidate to move to the Keychain or encrypt at rest.
- **Rust tests:** unit-test alarm due-logic and sidecar arg construction.
- **Chat polish:** optional per-session model pinning; markdown rendering of
  assistant messages (a reusable `Markdown` component now exists — used by the
  PR review and Memory tabs — and could be wired into the chat transcript).
- **Alarm tuning:** choose fullscreen-takeover vs. maximize + always-on-top;
  recurring alarms.

## Suggested order

1. **Google Calendar verification** — set up the OAuth app and exercise the
   already-built flow end to end.
2. **Claude Code delegation** — high value; needs your guardrail decisions first.
3. **Packaging** — when you're ready to run it as a real installed app.
