# Yarvis Roadmap

Status of the build against the original vision. The full V1 plan lives at
`~/.claude/plans/we-are-going-to-polymorphic-lightning.md`.

## Shipped

- **Foundation** — Tauri v2 (Rust core) + React/Vite/TS frontend + Bun sidecar,
  local PostgreSQL 17 + pgvector, macOS Keychain secret storage, sidecar
  supervision with live reload.
- **Chat** — multi-provider streaming (Anthropic / AWS Bedrock / Gemini) with
  session + message persistence.
- **Work tracking** — daily/weekly tasks driven by chat tool-calls
  ("I plan to…", "what's left?", roll yesterday forward) plus a Tasks UI.
- **Memory** — `MemoryService` over pgvector with remember/recall tools in chat
  (Gemini embeddings when keyed, offline hash-embedding fallback).
- **Claude Code session introspection** — browse `~/.claude` projects, session
  transcripts, and plans (Sessions tab).
- **GitHub PR dashboard** — my PRs, review-requested, CI/merge status, stars,
  saved filters (PRs tab).
- **Alarms** — full-screen takeover + escalating sound/notification, with
  acknowledge/snooze (Alarms tab).

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

### 2. Google Calendar integration
Pull meetings and feed them into the alarm system; fire an alarm before a
meeting and escalate if you're a minute past the start without acknowledging.
- **Approach:** Google OAuth; list upcoming events; auto-create alarms for
  meetings; "joined/acknowledged" flow to stop escalation.
- **Needs from you:** a Google Cloud OAuth app (client id/secret) + consent —
  can't build or test the flow without it.
- **Builds on:** the alarm system (already ready to receive scheduled alarms).

### 3. Embedded / quick PR review view
In-app review of PRs that need your attention.
- **Approach:** GitHub blocks iframing its pages (`X-Frame-Options`), so build a
  custom PR detail view from the GraphQL API (description, diff, checks,
  review threads). Today the dashboard opens PRs in the system browser.
- **Needs from you:** nothing new (uses the existing GitHub token) — just a
  decision on how rich the in-app view should be vs. opening in the browser.
- **Builds on:** GitHub dashboard.

### 4. Memory & knowledge
Extend memory from "remember/recall" into notes, recaps, and learning.
- **Notes & recaps:** capture freeform notes; "give me a recap of today / this
  week" summarizing tasks completed + notes + key chat points.
- **Document/URL ingestion:** feed docs or links so the app learns over time
  (chunk → embed → store in memory for recall).
- **Memory management UI:** view, search, and delete stored memories.
- **Optional — OpenMemory backend:** `openmemory-js` was deferred because it
  boots its own server on import and is mid-rewrite; if its graph/temporal
  features become worth it, run it as a standalone server and add an
  HTTP-backed `MemoryService` (the interface already supports swapping).
- **Needs from you:** an embeddings key (Gemini/Bedrock) for good-quality
  semantic recall on ingested docs; works offline at lower quality otherwise.

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
  defense-in-depth.
- **Rust tests:** unit-test alarm due-logic and sidecar arg construction.
- **Chat polish:** optional per-session model pinning; markdown rendering of
  assistant messages.
- **Alarm tuning:** choose fullscreen-takeover vs. maximize + always-on-top;
  recurring alarms.

## Suggested order

1. **Embedded PR review view** — no new credentials; rounds out the GitHub work.
2. **Claude Code delegation** — high value; needs your guardrail decisions first.
3. **Google Calendar** — once you set up the OAuth app; unlocks meeting alarms.
4. **Memory & knowledge** — notes/recaps/ingestion as a focused milestone.
5. **Packaging** — when you're ready to run it as a real installed app.
