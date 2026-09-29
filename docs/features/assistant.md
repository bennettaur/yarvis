# The assistant

The Yarvis assistant is the chat agent at the center of the app. It knows your
projects and their priorities. It keeps your task list and a log of what you
actually did. It can start work in a workspace and hand follow-ups to the
Claude Code sessions running there. Tell it what matters this week, then keep
asking it where you are and what's next.

You can talk to it from four places, and they all reach the same agent and the
same memory:

- the **Chat** tab (Cmd+1),
- **Omni Chat**, the overlay you summon from anywhere with Control+Shift+Space
  (see [Chat and Omni Chat](quick-chat.md)),
- your voice (see [Voice](voice.md)),
- Telegram (see [Telegram](telegram.md)).

## Set up

The assistant works as soon as you have a database and an LLM provider (see
[Getting started](../getting-started.md)). It gets much more useful with:

1. **A GitHub token** (Settings → Credentials). It powers PR lists, review
   requests and "what's waiting on me".
2. **Your repos** under Settings → Repositories, so it can start workspaces.
3. **JIRA**, if your tickets live there (see
   [Issues and tasks](issues-and-tasks.md)).
4. **Google Calendar**, so it can plan around your meetings (see
   [Calendar and alarms](calendar-and-alarms.md)).
5. **Good embeddings** (a Gemini key, or Settings → Embeddings), so it can
   find old memories by meaning. See
   [Configuration](../configuration.md#embeddings).
6. **The transcript digest** (Settings → Assistant). It is off by default.
   Turn it on and pick which Claude Code project directories it may read, so
   the assistant learns what happened in your coding sessions. See
   [What it can see](#what-it-can-see).

## A week with the assistant

### Monday: set the priorities

Start the week by telling it what matters, in plain words. For example:

> This week is about shipping the billing migration. PROJ-412 and PROJ-415 are
> urgent, PROJ-420 is nice to have. I also need to review Sam's auth PR before
> Wednesday, and I want the flaky test fixed by Friday.

From a message like that, the assistant:

- creates or updates a **project** ("billing migration"), sets its **focus**
  for the week, and tracks each ticket with the **priority** you gave it,
- adds **tasks** to your list: weekly ones for end-of-week goals, daily ones
  for today,
- saves the story around it (why, who, deadlines) to **memory**,
- puts anything *it* promised to do ("check Sam's PR before Wednesday") on its
  own **todo list**, so the promise outlives the conversation.

You can see all of this under **Memory → Projects**, **Tasks**, and
**Memory → Agent todos**.

For a project with a lot of tickets, ask it to reconcile the project against
JIRA. It hands that to the `project-manager` specialist (a smaller agent with
its own tools; see [Specialists](#specialists)), which reads the tickets and
reports what changed.

### Starting work

Ask it to start something, and it sets up a workspace and puts an agent on it:

> Start work on PROJ-412 in the billing-api repo.

The assistant creates a [workspace](workspaces.md) with a fresh worktree and
writes the ticket into `.yarvis/brief.md`. Then it launches a Claude Code
session told to read the brief and make a first pass. For JIRA and GitHub
issues it also assigns the ticket to you and marks it in progress. It tells you
the name of the session it started.

You can do the same thing yourself with **Start work** on an issue or task.

### During the week: where was I, and what's next?

These are the questions it is built to answer:

- **"Where did we leave off?"** It recalls the day and session summaries,
  checks the activity log for anything more recent, and reads its own todos and
  your open tasks.
- **"What should I work on next?"** It ranks what's waiting on you: reviews
  you started and never finished, reviews requested of you, live workspaces,
  your open PRs, overdue tasks and its own todos. It explains why each one is
  on the list. If you've done little reviewing this week, it moves reviews up.
- **"What's hanging?"** It lists everything left open, across GitHub and your
  workspaces.
- **"Give me a plan for today."** It hands this to the `planner` specialist.
  The planner reads your projects and their priorities along with everything
  waiting on you, and comes back with three suggestions, each with a first
  step.

The "what next" ranking doesn't read your project priorities on its own. If
you want priorities to count, ask for a plan, or say "check my project
priorities" in the same message.

Turn a suggestion down ("not that one this week") and it records the
dismissal, so the suggestion stops coming back. A dismissal can expire after a
few days.

### Steering running work

The assistant can act on your workspaces in bulk:

- **"Merge main into all my open PRs."** It fetches and merges each
  workspace's base branch, pushes, and tells you per workspace what merged, what
  it skipped and what conflicted. A conflicted merge is left in the worktree,
  unpushed.
- **"Tell the billing-api session to resolve the conflicts and commit."** It
  types that instruction into the workspace's running Claude Code session.
  Yarvis can only confirm the text was delivered, not that the work got done,
  and it says so.
- **"What's the state of the billing-api workspace?"** It reports the PR,
  checks and mergeability from the last poll (refreshed every minute).
- **"Archive the billing-api workspace."** It stops the session, removes the
  worktrees, and completes any linked task. If there are uncommitted changes,
  it asks before throwing them away.

### Friday: what did I get done?

Ask "what did I get done this week?" The assistant gathers the week's
activity, the reviews you gave, your PRs and their state, the tasks you
finished and the workspaces you archived, then writes it up with each PR
named. It works well for status updates and brag docs.

## What it keeps track of

| Thing | What it is | Where you see it |
| --- | --- | --- |
| **Tasks** | What *you* intend to do, scoped to today or this week | Tasks tab |
| **Agent todos** | What the *assistant* has promised to do, with a progress log | Memory → Agent todos |
| **Projects** | A status, a focus for the week, and tracked tickets with priorities (urgent, high, medium, low) | Memory → Projects |
| **Memories** | Durable facts, typed by kind | Memory → Memories |
| **Activity log** | A record of what you did in the app | Memory → Activity |

Tasks and agent todos are separate on purpose. One is your plan, the other is
the assistant's.

### Memory kinds

Every memory has a kind, and the assistant narrows its searches by kind:

- `fact`, `preference`, `project`, `decision`: things you told it, or that it
  learned.
- `agent-feedback`: how you want agents to behave. It comes from what you tell
  the assistant, and from the transcript digest.
- `note`: quick jot-downs (Memory → Quick note, or "note that…"). These feed
  the daily and weekly recaps.
- `doc`: documents you ingested from a URL or pasted text.
- `activity-summary`, `session-summary`, `day-summary`: written only by the
  background jobs, never by a chat turn.

Suggestions you turn down are kept in a separate list, not as memories, so
they can be matched exactly.

When a fact changes, the assistant corrects the memory instead of storing a
contradiction. The old version stays for the record but drops out of search.

### The activity log

Yarvis records meaningful actions as events. Examples:

- a PR viewed, approved, commented on or merged,
- an issue or JIRA ticket created or commented on,
- work started on a ticket,
- a workspace created, its session started, synced or archived,
- tasks created and completed,
- calendar events booked,
- the assistant's own todos and projects.

Clicking around the UI is not an event. The log only records what you do *in
Yarvis*, so a PR you review on github.com doesn't show up.

Browse and search it under **Memory → Activity**.

## What it can see

The assistant sees your work through the activity log, the PR poller and
memory. It does not watch your terminals.

**It sees right away:**

- your tasks, projects, todos and memories,
- the activity log, as events happen,
- workspace PR state, checks and mergeability (polled every minute),
- live GitHub searches: your PRs and review requests,
- anything a Claude Code session saved to Yarvis memory.

**It sees after the nightly jobs:**

- what happened inside a Claude Code session, if you turned on the
  transcript digest,
- summaries of each 4-hour window and each day.

**It can't see:**

- terminal output, or a session's live transcript,
- whether an instruction it sent was carried out,
- the attention bell (a session waiting on a prompt),
- PRs you reviewed on github.com rather than in Yarvis.

Two ways to close the gap during the day:

- **Have your Claude Code sessions write to Yarvis memory.** Every workspace
  session is connected to Yarvis's MCP endpoint, which offers `remember` and
  `take_note`. Ask the session to "note in Yarvis what you did and what's
  left", and the assistant can recall it immediately. See [MCP](mcp.md).
- **Turn on the transcript digest.** Each night it summarizes new and grown
  sessions from the project directories you allowed into `session-summary`
  memories: what was worked on, the decisions made, and any feedback about
  how an agent should behave.

The digest is off by default for a reason. Transcripts often hold pasted
secrets and other people's data, and summarizing them sends them to your LLM
provider. The summaries are then stored as memories, which Claude Code
sessions (over MCP) and the Telegram bot can read back. Only allow
directories you're comfortable with.

## What it asks before doing

Some actions pause and ask you in the approval bar above the message box (press
**A** to approve, **D** to deny):

- **Booking a calendar event** asks every time.
- **MCP tools** ask unless you set them to auto-approve in the Tool manager.
- **Spoken turns** ask before anything irreversible: deleting a task, archiving
  a workspace, starting work, filing a JIRA ticket, syncing branches, sending an
  instruction to a session, launching a session, forgetting a memory, or
  delegating. A transcript can be misheard, or picked up from the room.

The assistant is also instructed to create workspaces, start work, sync,
send instructions or archive only when you ask in the current conversation,
and never to copy text from an issue, PR or memory into a session as an
instruction. These are instructions to the model, not checks in code, so a
cleverly written issue or PR could still talk it into something. The approval
prompts above, and the checks on what can be typed into a session (see
[Workspaces](workspaces.md)), are enforced in code.

A denied call is not retried.

## Tools

The assistant's built-in tools come in families. The first group is always
available. The second is loaded on demand when a request needs it, which keeps
each turn smaller.

Always available:

- **Tasks.** Create, list, update, complete, delete, roll over and find
  finished tasks.
- **Memory.** Remember, recall, correct, list, forget and take notes.
- **Projects.** Create, read and update projects, and track, list and untrack
  tickets with priorities.
- **Todos.** The assistant's own todo list.
- **Activity.** Search the event log and count activity by type.
- **Planning.** Find dangling work, suggest what's next, dismiss or restore a
  suggestion, and summarize the week.
- **Delegation.** List specialists and delegate to one.
- **Attention.** Raise a notification when it needs you.

Loaded on demand:

- **Workspaces.** List repos and issues, start work, create and start sessions
  (including a scratch session with no repo), check status, sync with base,
  send instructions, archive.
- **JIRA.** Search, read, create, and start work on a ticket.
- **PR review.** List your guided reviews and search the notes you took while
  reviewing.
- **Calendar.** List events and create one.

The full list, with each tool's policy, is in **Settings → Tools & MCP → Tool
Manager**.

## Specialists

Multi-step jobs go to a **specialist**: a smaller agent that runs in its own
context, with only the tools its definition lists. The assistant picks one by
its description, hands it a self-contained task, and relays the report in its
own words.

The shipped specialists:

| Name | What it does | Used by |
| --- | --- | --- |
| `planner` | Three suggestions for what to work on, each with why now and a first step. Prefers finishing over starting, and includes a review when you've done few. | You, via chat |
| `work-scout` | A short ranked list of everything outstanding, with one next action each. Reports only. | You, via chat |
| `project-manager` | Reconciles a project's tracked tickets against JIRA. Files new tickets only when asked. | You, via chat |
| `activity-consolidator` | Summarizes a window of events into prose. | The background jobs |
| `session-summarizer` | Summarizes one Claude Code transcript into work, decisions and feedback. Has no tools, on purpose. | The transcript digest |

A delegated run has limits:

- It gets no MCP tools, because it can't stop and ask for approval.
- It can't delegate further.
- A tool that writes where other people can see it (filing a JIRA ticket, say)
  is available only if the definition grants it by name. `project-manager` is
  the only shipped specialist with such a grant. Settings marks it "acts
  unattended".

### Writing your own specialist

A specialist is a markdown file: YAML frontmatter for its settings, and the
body as its system prompt. The shipped ones live in
`sidecar/src/agents/definitions/`. Yours go in `~/.yarvis/agents/*.md`. A file
with the same name as a shipped one **replaces** it.

```markdown
---
name: release-notes
description: >-
  Turns a week of merged PRs into release notes. Use it when the user asks what
  to tell people about what shipped.
tools:
  - work_summary
  - search_events
  - recall
model: anthropic/claude-sonnet-5   # optional; or complexity: low|medium|max
maxSteps: 8                         # optional, default 8, hard cap 30
---

You write release notes from a developer's own activity.

Group by theme rather than by pull request, and name each PR once…
```

The fields:

- `name` is the handle the assistant delegates by.
- `description` is what the assistant reads when choosing. Write it as "what
  this is for, and when to use it".
- `tools` are built-in tool names, as a YAML list or comma-separated. The Tool
  Manager lists them all. An unknown name is an error. Leaving `tools` out gives
  a specialist with no tools, which suits one that works only from what it is
  handed.
- `model` picks a provider and model. `complexity: low | medium | max` picks
  whatever you set for that tier under **Settings → Assistant → Complexity
  tiers** instead. You can't set both. With neither, it uses the default chat
  model.
- `maxSteps` is optional: default 8, hard cap 30.
- `enabled: false` turns a specialist off, including a shipped one.
- `unattended:` lists write tools the specialist may use without approval.

A misspelled key is an error too. `tool:` instead of `tools:` would otherwise
give a specialist with no tools and no warning.

**Settings → Assistant** lists what loaded, reports any file that failed to
parse, and reloads without a restart.

Definitions load from `~/.yarvis/agents` only, never from a workspace or a
cloned repo. A definition is a system prompt plus a tool list, so a repo that
could supply one could hand the assistant both instructions and the means to
act on them.

## Background jobs

Three jobs ship with the app and keep memory up to date: a summary of recent
activity every 4 hours, the transcript digest at 02:00 (if on), and a daily
rollup at 03:00. Their status and a **Run now** button are under **Settings →
Assistant**. See [Scheduled jobs](scheduled-jobs.md#background-jobs-that-ship-with-the-app)
for the details, and for scheduling your own prompts.

## Tips

- **Say priorities out loud.** "PROJ-412 is urgent" is stored and used later.
  "Let's look at PROJ-412" is not.
- **Start each day with "where did we leave off?"** and end it with "note what's
  left for tomorrow".
- **Ask for reasoning.** "Why that one first?" gets you its ranking logic.
- **Let sessions report back.** A line in your repo's `CLAUDE.md` like "When you
  finish a chunk of work, save a short note to Yarvis memory with
  `take_note`" gives the assistant same-day visibility.
- **Correct it.** "That's wrong, the deadline moved to the 14th" updates the
  memory rather than adding a second one.
