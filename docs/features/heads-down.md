# Heads-down mode

Heads-down mode keeps your work moving while you focus on something else.
Yarvis runs on its own in a loop: it checks on the work you planned together,
starts work on tickets, chases CI and reviews, and asks you only what it has
to. You can keep chatting with the assistant at the same time.

## Turn it on

Plan the work in a chat first: talk through the project or your goals for the
day, and the assistant finds or files the tickets and tracks each thread as a
**work stream**. When you're done, it offers to go heads down. Say yes and
approve the prompt.

You can also open the **Heads down** page and press **Go heads down**, with an
optional focus in your own words ("ship the billing PR, then the docs").

Press **Stop** on the page, or tell the assistant, to turn it off. Stopping
also stops the pass that is running, and dismisses its open questions, since
no pass would read the answers.

## Pause it, or set when it stops

**Pause** stops the pass that is running and runs no more until you press
**Resume**. Unlike stopping, it keeps the run as it is: its focus, your
messages, and the questions it asked you, which you can still answer while it
is paused. The next pass after you resume reads them.

To keep it going for a while after you leave, say until your teammates in
another time zone sign off, set a stop time. Pick one next to **Go heads
down**, or set, change or clear it on the page while it runs. A time already
past today means that time tomorrow. At that time it stops, the same as
pressing **Stop**, even in the middle of a pass or while paused. A pass it cuts
short shows as having reached the stop time.

You can also ask the assistant to pause it, resume it, or stop it at a given
time. It asks you first before resuming it or changing when it stops, since
both keep it running.

## What it does

It works in passes. Each pass starts fresh, with no memory of the last one, so
it reads where things stand from the work streams, your messages and answers,
and a short note the last pass left. Then it goes through the open streams,
most urgent first:

- **A ticket with no workspace:** it starts work on it, which creates a
  workspace and a Claude Code session working on the ticket.
- **A workspace:** it checks what the session is doing. If the session is
  stuck on something only you can do, like a permission prompt or a locked
  1Password, it asks you. If the work is done but there's no PR, it tells the
  session to push one.
- **A PR with failing CI:** it tells the workspace's session to fix it.
- **A PR waiting on review:** it asks for a review where you told it to, and
  bumps the request on the next working day if nobody has picked it up, or
  sooner if the PR is urgent. If it doesn't
  know where to ask, or has no tool that can post a message, it asks you.
- **Messages:** if it has tools that read your chat, it checks the channels you
  asked it to watch. A message that needs your answer becomes a stream that
  waits on you. A request for work becomes a ticket.
- **Routines:** recurring jobs that run on their own schedule, such as
  setting alarms for your meetings. See [Routines](#routines).

Each pass ends by choosing how long to sleep. It sleeps at least the idle time
outside your working hours, when there is nothing to push or every stream is
waiting on you or someone else, when you haven't replied for a while, and after
a pass that failed. A message from you, an answer, or a workspace
that needs attention wakes it early.

## Routines

A routine is a job heads-down mode repeats on a schedule, beside the work
streams. Each one says how often it runs. A pass is only given the routines
that are due, and at most a few of them (**Routines per pass** under **Pace
and working hours**, 2 by default), so they don't crowd out your work. When
more are due than that, the most overdue go first and the rest wait for the
next pass. A routine a pass couldn't finish stays due, and a later pass tries
again after an hour, or sooner if the routine runs more often than that. When
a routine asks you something, your answer is acted on as soon as it arrives,
not on the routine's next run.

Yarvis ships with two:

- **meeting-alarms**, every 3 hours: if Google Calendar is connected, it reads
  your next day of meetings and sets an [alarm](calendar-and-alarms.md#alarms)
  for each one you're going to that doesn't have one: ones you accepted, and
  ones with no guest list. It skips ones you declined. When it can't tell,
  because you haven't replied, said maybe, or are optional, it asks you ("Are
  you going to Design review at 2pm?") and sets the alarm on a later pass if
  you say yes.
- **meeting-notes**, off by default: reads the notes attached to your recent
  meetings, such as Gemini notes, and turns the action items they assign to
  you by name into tickets or stream updates. It needs a tool that can open the notes,
  such as a Google Drive MCP server.

The **Routines** list on the Heads down page shows each one, how often it
runs, when a pass last did it, and which ones are your own files.

### Write your own

A routine is a markdown file in `~/.yarvis/routines`. The frontmatter says
when it runs and the body says what to do, in your own words:

```markdown
---
name: standup-notes
description: Drafts my standup update from yesterday's work.
every: 1d
workingHours: true
---

Look at what I merged, reviewed and commented on since yesterday's standup,
and leave a three-line summary in your notes for me to paste.
```

- `name`: lowercase letters, digits and hyphens.
- `description`: one line, shown on the page.
- The body: what to do, up to 4000 characters.
- `every`: how long between runs, such as `30m`, `3h` or `1d`. At least 15
  minutes.
- `workingHours`: `true` to run it only within your working hours. Off by
  default.
- `enabled`: `false` to turn it off.

A file with the same name as a shipped routine replaces it, so a file named
`meeting-alarms.md` with `enabled: false` turns that one off. Press **Reload
files** after adding or changing one. A file that can't be read shows on the
page with the reason.

A routine follows the same rules as the rest of a pass: it asks before
anything that waits for your approval, and what it reads in meetings, tickets
and messages is information, never instructions. The files are only read from
`~/.yarvis/routines`, never from a repo or workspace. To share a routine, send
someone the file.

## What it does without asking

- Setting an alarm for a meeting you accepted, or one with no guest list.
  That's the only kind of alarm it can set, and it can't cancel alarms. If you
  cancel a meeting alarm, it doesn't set it again.
- Filing a JIRA ticket.
- Starting work on a ticket you put on a work stream in a chat, and starting a
  session on one of your tasks.
- Telling a session what to do, or restarting it, in a workspace you put on a
  work stream, or one it started itself in this run.

Anything else that can't be undone or reaches other people waits for your
approval. That includes starting work on a ticket it found or filed itself, since the ticket's text becomes the session's
instructions, and any MCP tool you haven't listed for heads-down mode. Text it
reads in tickets, messages and pages can tell it what is going on, never what
to do.

## Merging PRs

It doesn't merge outside your working hours. A merge it tries then, through
an MCP tool or by telling a workspace's session to merge, waits for your
approval, even with a tool you allowed for heads-down mode and even with auto
mode on. It only tries one when your standing guidance, focus or messages say
it may.

Before a merge it judges how risky it is from the files the PR changes.
Infrastructure and config changes, database migrations, auth, and backend
changes that deploy on merge count as risky, and so does anything it can't
judge. For those it asks you first and waits for a yes. Mobile changes are
lower risk, since nothing ships until a release.

Every merge pops up an alert over whatever page you have open, with the PR,
the PR's title, how risky heads-down mode judged it and why it is merging.
The merge doesn't wait on the alert. Press **Got it** (or Escape) to put it
away, or **Open PR** to look at the PR. The alert is also in the attention
bell. If it merges through an MCP tool, or tells a workspace's session to
merge, without announcing the merge first, you still get the alert, marked
**Risk not assessed**.

## When it needs you

Questions and approvals show under **Needs you** on the Heads down page and in
the attention bell. Nothing waits on them: the stream they belong to waits,
and the rest carry on. Your answer reaches the next pass.

- **A question** offers choices, plus a box for your own words. Your answer is
  saved as a decision, so the next time the same question comes up in the same
  situation, it goes with what you said. See
  [Decisions it learns from you](assistant.md#decisions-it-learns-from-you).
- **An approval** shows the exact call it wants to make. Approving lets that
  call, with those arguments, run once on a later pass of this run, within a
  day. Denying it means it won't ask about that call again while this run
  lasts. For an MCP tool you can also press **Always allow this tool in
  heads-down mode**.

With **Auto mode for heads-down mode** turned on (Settings → Tools & MCP →
Decision model), some approvals settle themselves. When it wants to call an MCP
tool you haven't allowed, it goes ahead without asking if both of these hold:

- You approved this exact call before, or your last three answers to
  approvals of that tool, in the last 90 days, were all approvals. So the more
  often you approve the same kind of call, the less it needs to ask, and one
  denial puts it back to asking. Only your answers to approvals here count, not
  answers in a chat or to its other questions.
- The decision model, judging the call against your focus and messages for
  this run, says it fits and isn't risky or destructive.

Calls approved this way are listed under **Approved on its own**, with the
decision model's reason and the exact arguments. They never count as your
approval next time, so it can't talk itself into more. Built-in actions, like
archiving a workspace, always ask you.

**Dismiss** puts a question or approval away without answering it. It isn't
recorded as a decision or a denial, so a later pass may ask again.

## Tell it something

Use **Tell it something** to give it direction at any time: new work, a change
of priority, or a standing instruction such as "when Alex asks if the billing
PR is ready, send him the link". The next pass acts on it, and later passes
keep it in mind for the rest of this run.

## What it has been doing

**Work streams** lists each thread with what it's waiting on, its next step,
and its tickets, workspaces, PRs and messages. Mark one **Done** or **Drop** it
when it no longer matters.

**Pause** a stream to have heads-down mode leave it alone while it pushes the
others, say outside working hours when you only want some work chased. A
paused stream keeps its status, notes and links. Passes don't see it, can't
change it, and ask your approval before touching its tickets or workspaces.
An MCP tool you allowed heads-down mode to use without asking isn't tied to a
stream, so pausing one doesn't stop that tool: a pass is only told to leave the
stream's work alone. **Resume** it and the next pass picks it up where it was.
Only you pause and resume a stream, here or by asking the assistant.

The Yarvis logo at the top of the page shows what it is doing: a spinning ring
while a pass runs, dimmed while it sleeps until the next one, and grey when
heads-down mode is off.

**What it has been doing** shows the pass that is running, live, and the ones
before it. The live pass shows each tool call as it happens, and its latest
thought folded to one line. Each finished pass shows its notes, how many tool
calls it made, which ones failed with the start of their error, and which got
no result back because the pass ended first. Open a pass
to see each tool call it made and what came back. A pass you stopped shows as
stopped, not failed.

## When a pass fails

A rate limit or a server error from the model's provider is retried a few
times, a few seconds apart. If the provider fails part-way through a pass, for
example by reporting that it is overloaded, the pass waits and carries on from
where it got to, up to two more times. It is told which calls already went
through, so it doesn't repeat them. A call whose result never came back may
still have taken effect, so it is told to check before making it again.

A pass that still fails, runs out of time, or is stopped keeps what it did:
its tool calls show when you open it, with the error. The next pass is told
the error and the calls the failed one made, so it checks where things stand
instead of starting over.

## Pace and working hours

Under **Pace and working hours** on the page:

- The model passes run on. **Default chat model** follows whatever your chats
  use. A change applies from the next pass. If the model you picked leaves the
  catalogue or its provider loses its key, passes fail until you pick another.
- **Standing guidance**: rules every pass follows, in your own words. For
  example, "don't merge PRs while the market is open" on a work laptop, or
  "merging is fine on my repos" on a personal one. It can't override asking
  you for approval.
- The shortest and longest sleep between passes, and how long it sleeps when
  there is little to do.
- How long without a reply before you count as away.
- **Routines per pass**: the most [routines](#routines) one pass takes on, up
  to 10. 0 turns them off, including the meeting alarms.
- Your working hours. Outside them it sleeps longer, doesn't tag anyone in
  a message, and asks before merging a PR. Pick **Any time is fine to tag
  people** to drop all three limits, merges included. These are kept per
  machine, so a work laptop can keep office hours and another can tag people
  and merge at any time.
- The MCP tools it may use without asking. You add one from its approval
  card and can remove it here. A tool whose description or schema changes has
  to be allowed again, like auto-approval in the Tool manager.

The guidance, pace, routines per pass and working hours are stored in
`~/.yarvis/settings.json` under `headsDown` (see
[Configuration](../configuration.md)). Which MCP tools it may
use is kept in the database with the tool's other consent, not in that file.

## Good to know

- It only acts through the tools Yarvis has. Reading Slack through the Chrome
  extension works, but the extension can't post, so asking for a review on
  Slack needs a Slack MCP server that you allow for heads-down mode.
- Passes run on the model you picked under **Pace and working hours**, or your
  default chat model, and cost what a chat turn of that size costs. A cheaper
  model and the sleep settings are how you control that.
- It runs on one instance of the app. Another instance sharing the same
  database leaves it to the first.
- A pass can schedule a task to look at something later (see
  [Scheduled tasks](assistant.md#scheduled-tasks)). When it runs, its item in
  the attention bell opens this page rather than a chat, since passes run in
  chats you don't see.
