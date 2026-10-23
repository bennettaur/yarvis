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

Each pass ends by choosing how long to sleep. It sleeps at least the idle time
outside your working hours, when there is nothing to push or every stream is
waiting on you or someone else, when you haven't replied for a while, and after
a pass that failed. A message from you, an answer, or a workspace
that needs attention wakes it early.

## What it does without asking

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

The Yarvis logo at the top of the page shows what it is doing: a spinning ring
while a pass runs, dimmed while it sleeps until the next one, and grey when
heads-down mode is off.

**What it has been doing** shows the pass that is running, live, and the ones
before it. The live pass shows each tool call as it happens, and its latest
thought folded to one line. Each finished pass shows its notes, how many tool
calls it made, and which ones failed with the start of their error. Open a pass
to see each tool call it made and what came back. A pass you stopped shows as
stopped, not failed.

## When a pass fails

A rate limit or a server error from the model's provider is retried a few
times, a few seconds apart. If the provider fails part-way through a pass, for
example by reporting that it is overloaded, the pass waits and carries on from
where it got to, up to two more times. It is told which calls already went
through, so it doesn't repeat them.

A pass that still fails, runs out of time, or is stopped keeps what it did:
its tool calls show when you open it, with the error. The next pass is told
the error and the calls the failed one made, so it checks where things stand
instead of starting over.

## Pace and working hours

Under **Pace and working hours** on the page:

- The model passes run on. **Default chat model** follows whatever your chats
  use. A change applies from the next pass. If the model you picked leaves the
  catalogue or its provider loses its key, passes fail until you pick another.
- The shortest and longest sleep between passes, and how long it sleeps when
  there is little to do.
- How long without a reply before you count as away.
- Your working hours. Outside them it sleeps longer and doesn't tag anyone in
  a message. Pick **Any time is fine to tag people** to drop the limit. These
  are kept per machine, so a work laptop can keep office hours and another can
  tag people at any time.
- The MCP tools it may use without asking. You add one from its approval
  card and can remove it here. A tool whose description or schema changes has
  to be allowed again, like auto-approval in the Tool manager.

The pace and working hours are stored in `~/.yarvis/settings.json` under
`headsDown` (see [Configuration](../configuration.md)). Which MCP tools it may
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
