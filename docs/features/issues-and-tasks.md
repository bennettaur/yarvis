# Issues and tasks

Two tabs hold the work you plan to do. **Tasks** (Cmd+5) is your own to-do
list for today and this week. **Issues** (Cmd+7) shows GitHub issues and JIRA
tickets. Both have a **Start work** button that creates a
[workspace](workspaces.md) and starts a Claude Code session on the item. The
assistant reads and writes the same tasks, so you can plan by talking to it and
see the result here.

## Set up

Tasks need only the database.

For **GitHub issues**:

1. Save a **GitHub token** under **Settings → Credentials**. See
   [Configuration](../configuration.md#token-scopes) for the scopes.
2. Add the repo under **Settings → Repositories** and tick **Pull issues**.
   Only repos with that box ticked show up on the Issues tab.

For **JIRA** (Atlassian Cloud only):

1. Create an API token at id.atlassian.com → Security → API tokens.
2. Under **Settings → Credentials**, save it as **JIRA API token**.
3. On the same tab, set the **JIRA base URL** (`https://your-org.atlassian.net`)
   and the **account email** the token belongs to.

## Tasks

### Use it

1. Type into **Add a task…**.
2. Pick **Today** or **This week**.
3. Press **Add**.

Tasks are grouped into three lists:

- **Overdue**: open tasks whose date has passed. Complete them, or ask the
  assistant to carry them over.
- **Today**.
- **This week**: tasks with no fixed day.

Each task shows a date chip: Today, Tomorrow, a weekday, or "3d ago" for an
overdue one.

Hover a task to see its actions:

| Action | What it does |
| --- | --- |
| Complete | Marks it done |
| Create workspace | Opens the New workspace form with the task's name and link filled in. You pick the repos. |
| Start work | The same, but the agent session starts on the task as soon as the workspace is ready |
| Delete | Deletes the task at once. **There is no confirmation.** |

A task linked to a workspace is marked complete when you archive that
workspace.

### With the assistant

The assistant manages the same list. You can say things like:

- "I need to finish the migration by Friday." It creates a weekly task with
  Friday's date.
- "What's left for today?" It lists your open tasks.
- "Move yesterday's leftovers to today." It rolls the open tasks forward.
- "Did I already finish any of these?" It looks for evidence, such as an
  archived workspace or a merged PR that matches, then asks before marking
  anything done.

Adding a task that looks like one you already have is reported as a duplicate
rather than added twice. The assistant only deletes a task when you ask it to.
Otherwise it completes tasks. See [The assistant](assistant.md).

## Issues

A toggle at the top switches between **GitHub** and **JIRA**.

### GitHub

| Tab | Shows |
| --- | --- |
| **Assigned to me** | Open issues assigned to you, in repos with Pull issues ticked |
| **All open** | Every open issue in those repos |
| **Filters** | Your saved searches, written in GitHub search syntax, for example `is:open is:issue label:bug` |

Star an issue to keep it close at hand. Starred issues also feed the
**In progress** list in the attention panel (the bell in the top bar). Choose
what feeds that list under **Settings → Work in progress**.

### JIRA

| Tab | Shows |
| --- | --- |
| **Assigned to me** | Tickets assigned to you |
| **Created by me** | Tickets you reported |
| **Search** | A JQL search, or a bare key like `PROJ-45` |
| **Starred** | Tickets you starred |

**+ New issue** files a new JIRA ticket.

### Start work

Press ▶ on an issue row, or **Start work** in the issue's detail view.

**On a GitHub issue:**

1. Yarvis creates a workspace for the issue's repo and links the issue to it.
2. It assigns the issue to you and adds an `in progress` label (creating the
   label if the repo doesn't have it).
3. It switches to the Workspaces tab. Once provisioning finishes, Claude starts
   on a prompt made from the issue's title, body and link.

The assign and label steps are best effort. If one fails, the workspace is
still created, and you see a warning.

**On a JIRA ticket:**

1. A picker opens. Choose the repos the work needs, or none for a scratch
   workspace.
2. Choose the status to move the ticket to. It defaults to your workflow's "In
   Progress" status. Pick none to leave the status alone.
3. Confirm. Yarvis creates the workspace, assigns the ticket to you, moves it
   to the status you chose, and starts Claude on it.

You can also ask the assistant: "start work on PROJ-123 in the api repo". It
takes the same path. See [The assistant](assistant.md).
