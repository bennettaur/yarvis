# Scheduled jobs

The **Jobs** tab runs prompts on a schedule. Each job is a cron schedule, a
prompt, and the agent that answers it. Every run is kept with what the agent
said, so the tab is both the schedule and the log. Use it for things like a
weekday-morning summary of what's waiting on you, or a nightly check in a repo.

Yarvis also ships its own background jobs that keep the assistant's memory up
to date. Those are covered [at the end](#background-jobs-that-ship-with-the-app).

## Set up

A job needs an LLM provider and the database. See
[Getting started](../getting-started.md). A Claude Code job also needs Claude
Code installed.

## Use it

1. Open the **Jobs** tab. It has no number shortcut, so click it in the nav
   rail or cycle to it with **Cmd+Shift+]**.
2. Create a job and fill in:
   - **Schedule.** A cron expression in this machine's local time. For
     example, `0 9 * * 1-5` is 9:00 on weekdays. The editor offers a few
     presets.
   - **Prompt.** What the agent should do.
   - **Agent.** Who runs it (see below).
3. Save. A job whose schedule doesn't parse is refused rather than stored.

Other controls:

- **Run now** runs a job off-schedule. Its output appears in the history a
  moment later.
- A job you switch off keeps its history and can still be run by hand.

A new job does **not** run as soon as you save it. It waits for its next
scheduled time. For example, a job set for 08:45 that you save at 17:00 first
runs at 08:45 the next day.

### Choosing the agent

There are two kinds:

- **Yarvis.** The default assistant, or one of your specialists. The default
  assistant gets the tools that are always available (tasks, memory, projects,
  todos, activity, planning) but can't delegate. A job has nobody watching it, so it gets no
  MCP tools either.
- **Claude Code.** A headless Claude Code session (`claude -p`) in a directory
  you name. You can also set a model and a permission mode.

### Claude Code jobs are a trust decision

A Claude Code job runs with no terminal attached, so nobody is there to answer
a permission prompt. What it can do is whatever its permission mode allows
without asking.

- `bypassPermissions` and `dontAsk` mean an unsupervised agent editing files
  and running commands in that directory on every run. The editor warns you
  when you pick one.
- It runs as you, in the directory you named.
- It reads that directory's own Claude Code configuration.

So the directory is a trust decision, not just a location. Point it somewhere
you trust.

Other limits on a Claude Code job:

- Like a delegated Yarvis run, it gets no MCP servers and can't start
  subagents.
- It runs the program named in the agent command (**Settings → Repositories →
  Agent**, for example `claude`), but not that command's flags, which are meant
  for interactive sessions.
- It doesn't inherit the app's environment. The provider keys and the
  sidecar's own token stay out of its reach.

### Limits and retention

- A run is abandoned after 15 minutes.
- Output is scrubbed of anything shaped like a credential, then cut to 20,000
  characters before it is stored.
- 100 runs are kept per job, and runs older than 90 days are deleted.

## Background jobs that ship with the app

These are code, not rows in the Jobs tab. They write memory and the activity
log rather than output you read, and they are what lets the assistant answer
"what did I do yesterday?". Their status and a manual trigger are under
**Settings → Assistant**.

| Job | When | What it does |
| --- | --- | --- |
| GitHub review sync (`github-review-sync`) | Every 30 minutes. Needs a GitHub token. | Copies the approvals and change requests you gave on github.com into the activity log. Reviews you submitted in Yarvis are already there and are not logged twice. The first run reads the last 14 days. Covers every repo the token can see, private ones included. |
| Transcript digest (`cc-session-digest`) | Daily at 02:00. **Off until you turn it on.** | Reads new or grown Claude Code transcripts under `~/.claude/projects` in the directories you allow, and writes a `session-summary` memory for each. Also writes an `agent-feedback` memory when a session held instructions about how an agent should behave. |
| Event consolidation (`consolidate-events`) | Every 4 hours | Folds activity-log events nobody has summarized yet into one `activity-summary` memory |
| Daily rollup (`daily-rollup`) | Daily at 03:00 | Folds yesterday's activity and session summaries into a single `day-summary` |

About the transcript digest: transcripts are local files that often hold
pasted secrets and other people's data. Summarizing them sends them to your
LLM provider. That's why it is off by default. Turn it on under **Settings →
Assistant** and choose which project directories it may read. An empty list
digests nothing.

A few things about how the shipped jobs run:

- A machine asleep at 02:00 still gets its run once, late. Daily jobs compare
  calendar days, not elapsed time.
- Events are marked processed only once their summary is stored. A failed or
  oversized run loses nothing and is picked up next time.
- If you run more than one copy of the app on the same database, only one runs
  the jobs. See [Development](../development.md#work-only-one-instance-does).

See [The assistant](assistant.md) for how these memories feed planning and
"where did we leave off?".

## Writing your own specialist

A Yarvis job can run one of your own specialists instead of the default
assistant. A specialist is a markdown file in `~/.yarvis/agents/` that names its
tools and holds its system prompt. See
[Writing your own specialist](assistant.md#writing-your-own-specialist).
