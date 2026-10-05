# Yarvis

A personal-assistant desktop app for macOS, built for developers who run
several coding agents at once.

You tell the Yarvis assistant what matters this week. It keeps track of your
projects, tasks and what you actually did. It starts work in isolated
workspaces with a Claude Code session on each, and it answers "where did I
leave off?" and "what should I do next?". Around it sit the tools a working
day needs: terminals, PR review with guided tours, your calendar with
full-screen meeting alarms, voice, a clipboard palette, and MCP (connect
servers to Yarvis, and let Claude Code use Yarvis's memory).

## Get started

- Follow [Getting started](docs/getting-started.md). It covers requirements,
  PostgreSQL with pgvector on a Mac, the first launch, and the first
  configuration.
- Or let Claude Code walk you through it (needs Claude Code installed): clone
  the repo, run `claude` in it, and type `/yarvis-setup`.

The short version, for those who have Bun, Rust and Postgres already:

```bash
git clone https://github.com/bennettaur/yarvis.git && cd yarvis
createdb yarvis && psql -d yarvis -c 'CREATE EXTENSION IF NOT EXISTS vector;'
bun install
bun run tauri dev
```

Then, in the app, open **Settings → Credentials**. Save the database URL
`postgres://localhost:5432/yarvis` and one LLM provider key.

## Features

| Feature | What it does |
| --- | --- |
| [The assistant](docs/features/assistant.md) | Plans your week with you, remembers what matters, tracks projects and priorities, starts and steers work |
| [Chat and Omni Chat](docs/features/quick-chat.md) | The Chat tab, and Omni Chat: summon the assistant over any screen with Control+Shift+Space |
| [Workspaces](docs/features/workspaces.md) | Multi-repo git worktrees, each with its own Claude Code session, diffs, self-review and stacked PRs |
| [Terminals](docs/features/terminals.md) | Tabbed, split terminals that keep running while you switch views |
| [PR review](docs/features/pr-review.md) | GitHub and Azure DevOps reviews with guided tours and per-line questions |
| [Issues and tasks](docs/features/issues-and-tasks.md) | GitHub issues, JIRA tickets and Azure Boards work items, your task list, and one-click "Start work" |
| [Omni view](docs/features/omni-view.md) | Describe a dashboard and get one, built from live widgets |
| [Voice](docs/features/voice.md) | Talk to the assistant and hear it answer, fully local if you like |
| [Calendar and alarms](docs/features/calendar-and-alarms.md) | Google Calendar, and full-screen meeting alarms |
| [Clipboard](docs/features/clipboard.md) | Copy buttons everywhere, and a palette of saved snippets and history |
| [MCP](docs/features/mcp.md) | Connect MCP servers to Yarvis, and give Claude Code sessions Yarvis's memory |
| [Telegram](docs/features/telegram.md) | Drive the assistant from your phone |
| [Scheduled jobs](docs/features/scheduled-jobs.md) | Run a prompt on a cron schedule |
| [Keyboard shortcuts](docs/features/keyboard-shortcuts.md) | Every shortcut in one place |

## More docs

- [Configuration](docs/configuration.md): where secrets and settings live,
  the `settings.json` reference, embeddings, 1Password, and environment
  variables. There is a starter [`settings.example.json`](docs/settings.example.json).
- [Running the local speech server](docs/voice-server.md): the local
  speech-to-text and text-to-speech server for voice.
- [Development](docs/development.md): architecture, commands, tests, running a
  second instance, nightly builds, and the project layout.
- [Showcase deck](docs/showcase/yarvis-showcase.html): a slide deck on the
  weekly workflow. Open it in a browser.
- [Showcase video](https://bennettaur.github.io/yarvis/video/): a 90-second reel and a
  full walkthrough, rendered with Remotion from the app's own components. The
  source is in [`video/`](video/README.md).
- [`AGENTS.md`](AGENTS.md): conventions for changing the code.
- [`ROADMAP.md`](ROADMAP.md): what's shipped and what's next.

## How it's built

A Tauri v2 app in three processes. A Rust core owns the window, terminals and
secrets. A React frontend draws the UI. A Bun sidecar owns Postgres
(with pgvector), the LLM calls and the background jobs. See
[Development](docs/development.md#architecture).
