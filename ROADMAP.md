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
- **Embedded PR review** — in-app PR detail view built from the GitHub GraphQL
  API (description, normalized checks, review threads) plus REST file diffs,
  rendered with markdown and per-line diff coloring (PRs tab → "Review").
- **Memory & knowledge** — notes, daily/weekly recaps (tasks completed + notes,
  LLM-summarized or offline raw), document/URL ingestion (chunk → embed →
  store), and a management UI to search/delete (Memory tab). Reuses the
  `memories` table with a `type` tag (note/doc/fact).
- **Google Calendar (scaffolded, untested)** — desktop OAuth + upcoming-events
  fetch and a Calendar tab that arms meeting alarms just before start. Built
  blind against the documented Google APIs; needs real OAuth credentials to
  exercise (see Remaining → Calendar verification).

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
  assistant messages (a reusable `Markdown` component now exists — used by the
  PR review and Memory tabs — and could be wired into the chat transcript).
- **Alarm tuning:** choose fullscreen-takeover vs. maximize + always-on-top;
  recurring alarms.

## Suggested order

1. **Google Calendar verification** — set up the OAuth app and exercise the
   already-built flow end to end.
2. **Claude Code delegation** — high value; needs your guardrail decisions first.
3. **Packaging** — when you're ready to run it as a real installed app.
