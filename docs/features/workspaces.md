# Workspaces

A workspace is a folder where one piece of work happens. It holds a git
worktree for each repo the work touches, all on one branch, and a Claude Code
session started at the folder's root. You can run several workspaces at once,
one per ticket or PR, without them stepping on each other's checkouts. Yarvis
tracks each workspace's pull requests and CI, and tells you when a session is
waiting on you.

On this page:

- [Set up](#set-up)
- [Create a workspace](#create-a-workspace) and [what provisioning does](#what-provisioning-does)
- [The agent tab](#the-agent-tab)
- [The workspace list](#the-workspace-list) and its PR badges
- [The right column](#the-right-column): files, diffs, self-review, PR checks, stacks
- [Working across workspaces with the assistant](#working-across-workspaces-with-the-assistant)
- [Archiving](#archiving)
- [The attention bell](#the-attention-bell)

## Set up

1. Install [Claude Code](https://claude.com/claude-code). Each workspace runs
   `claude` in its agent tab.
2. Add your repos under **Settings → Repositories**. For each one, give:
   - **Clone URL**, for example `git@github.com:owner/repo.git`.
   - **Display name** (optional). It defaults to the repo name.
   - **Setup script** (optional). It runs in each new worktree, for example
     `bun install`.
   - **Run script** (optional). It adds a **Run** button that starts the app,
     for example `bun run dev`.
   - **Pull issues**. Tick it to show the repo's issues on the Issues tab.
3. Optional: install the GitHub CLI and the stack extension for the
   [Stack tab](#stacked-pull-requests)'s grouping and merge button:
   ```bash
   brew install gh
   gh extension install github/gh-stack
   ```
4. Optional: save a GitHub or Azure DevOps token in **Settings → Credentials**
   so workspaces show PR state and checks. See
   [Configuration](../configuration.md).

Workspaces keep their clones and worktrees under `~/dev/yarvis-workspaces`.
Set the `YARVIS_WORKSPACES_ROOT` environment variable to use another folder.

### The agent command

**Settings → Repositories → Agent** sets the agent tab's title and the command
it runs. The defaults are `Claude` and `claude --permission-mode auto`. Add
flags there, such as a model or a different permission mode. The
`YARVIS_CLAUDE_COMMAND` environment variable overrides the stored command.

## Use it

### Create a workspace

There are four ways to start one.

**From the Workspaces tab**

1. Open **Workspaces** (Cmd+4) and press **New**.
2. Enter a name.
3. Tick the repos the work needs, and pick a branch for each. Leave all repos
   unticked for a scratch workspace: a plain folder to run an agent in.
4. Optionally link a task.
5. Press **Create**.

**From an issue or task.** Press **Start work** on a GitHub issue, a JIRA
ticket, an Azure Boards work item, or a task. Yarvis creates the workspace, writes the work into
`.yarvis/brief.md`, and starts the agent on it. See
[Issues and tasks](issues-and-tasks.md).

**From a pull request.** On a PR's page, press **Start workspace**. You get a
workspace checked out on the PR's branch, with an agent at a blank prompt. See
[PR review](pr-review.md#work-on-the-pr).

**By asking the assistant.** Tell the assistant what you want, for example
"start a workspace in the api repo to add rate limiting". It creates the
workspace and starts the session on a brief it writes from your conversation.
See [The assistant](assistant.md).

### Rename a workspace

Press **Rename** next to the workspace's name in its header, type the new name,
and press Enter or click away to save. Escape keeps the old name.

Only the name shown in Yarvis changes. The folder and the branch keep the name
the workspace was created with, because a running agent session works in that
folder and the branch may already be pushed. The `AGENTS.md` in the workspace
folder also keeps the old name. It is only rewritten if provisioning runs
again, such as a retry after a failure.

### What provisioning does

Creating a workspace starts provisioning in the sidecar. For each repo it
clones the repo (once, then reuses the clone), creates a git worktree, and runs
the setup script. The workspace shows the log while this runs.

Provisioning runs in the background. You can leave the screen and come back:
reopening the workspace rejoins the run and its log. If the workspace was
started from **Start work**, a task, or the assistant, the sidecar still
launches the agent on that work once provisioning finishes, even if you've left
the screen.

Claude starts at the workspace root, not inside one repo. So provisioning also
writes these files into the root:

| File | What it's for |
| --- | --- |
| `AGENTS.md` and `CLAUDE.md` | Tells the agent which repos are present and on what branch. `CLAUDE.md` just includes `AGENTS.md`. |
| `.claude/settings.json` | The attention hooks that tell Yarvis when the session needs you |
| `.claude/skills/`, `.claude/agents/` | Copies of each repo's own skills and agents |
| `.claude/.yarvis-copied.json` | A list of the copies above, so they can be cleaned up |
| `.mcp.json` | Points the session at Yarvis's MCP endpoint, so it can read and write Yarvis memory. See [MCP](mcp.md). |
| `.yarvis/brief.md` | The work the session was started on, when there is one |

Some details:

- **Skills and agents are copied** because Claude Code only loads them from the
  folder it starts in, and has no setting to load them from elsewhere.
- **Name clashes.** When two repos ship the same skill or agent name, both
  copies get the repo's folder name as a prefix. The same happens when a repo's
  entry clashes with one you added to the workspace root yourself. A renamed
  agent's frontmatter `name` is rewritten to match, because that is the name an
  agent answers to.
- **Copies are refreshed on every provision.** Because
  `.claude/.yarvis-copied.json` lists every copy, a repo that leaves the
  workspace takes its copies with it. Anything you added by hand is
  left alone.
- **`.claude/settings.json` and `.mcp.json` are merged, not overwritten.**
  Other keys and other MCP servers you have there stay.
- **`.yarvis/brief.md` is written last,** as the final step of provisioning.

### When provisioning fails

A failed provision opens on the failed repo's setup log, with two buttons:

- **Retry provisioning** picks up where the run stopped. Worktrees that were
  already created are reused, so the retry doesn't fail on the step that worked.
- **Ignore and use anyway** puts the workspace back in service. The agent
  session starts, the failed repos keep their error badges and logs, and retry
  stays on offer. A workspace started from a ticket still starts its session
  on that ticket.

Work a workspace was started on doesn't begin until provisioning succeeds or
you press **Ignore and use anyway**.

### The agent tab

Every workspace opens with one tab: the agent. Opening the workspace starts a
Claude Code session in it, or attaches to the one already running, and focuses
that tab. No shell tab opens with it. Press `+` or Cmd+T when you want one.

- **Closing the agent tab ends its session.** It stays closed until you leave
  the workspace.
- **Coming back starts a new session.** Returning from another workspace or
  another nav rail tab counts as opening the workspace again.
- **To bring it back sooner,** press the start-session button in the header.

Workspace tabs are terminals, so everything in [Terminals](terminals.md)
applies, including splits. A workspace's tabs can also hold diffs, the file
editor, setup logs, and the **Run** pane for a repo's run script.

### Remote Control

Remote Control lets you pick up a Claude Code session from claude.ai/code or
the Claude mobile app. Yarvis turns it on only for sessions started from
[Telegram](telegram.md), by adding `--remote-control <session name>` to the
command, since you're away from the machine then.

Sessions you start at the laptop (by opening a workspace, pressing **Start
work**, or asking the in-app assistant) don't get it. They open in a tab you
are already looking at. Turn on Remote Control from inside the session if you need it
later. Leaving it off by default also means a non-Claude agent command isn't
handed a flag it doesn't know.

## The workspace list

Each row shows the workspace's status and a badge for each repo that has a
pull request. The badge shows whatever needs acting on first, so a red build on
an approved PR still reads as failing. Hover a badge to see the repo, PR number
and state.

| Badge | Meaning |
| --- | --- |
| `◇` | Open, awaiting review |
| `◌` | Draft |
| `●` | Checks running |
| `✗` | Checks failing |
| `⚠` | Merge conflicts |
| `✎` | Changes requested |
| `★` | Ready to merge |
| `✓` | Approved |
| `◆` | Merged |
| `⊘` | Closed |

`★` means nothing more is needed from anyone: approved, and the provider calls
the merge clean. `✓` is an approval that isn't a green light yet. Something
still blocks the merge: a branch-protection rule (required reviewers,
CODEOWNERS, required checks), a base the branch must be updated against, or a
merge state the provider hasn't worked out.

Azure DevOps doesn't report check state or a merge verdict here. Its badges
reflect the review only and never reach `★`.

Badges come from a background PR poll that runs every minute, so they can lag
a change by up to a minute.

A workspace with something waiting on you is also marked in the list. See
[The attention bell](#the-attention-bell).

## The right column

The column beside the terminals shows the workspace's files and PR state.

### All files and editing

**All files** lists the worktree. Clicking a file opens it in an editor tab.
The editor is CodeMirror with the file's own syntax highlighting. A file type
it doesn't know opens without colors.

Binary files, files that aren't valid UTF-8, and files over 2 MB are described
instead of opened. Saving one back would rewrite bytes the editor never showed
you.

- **Cmd+S** (or **Save**) writes the file back to the worktree.
- Edits live outside the tab. Switching tabs keeps what you typed, and the tab
  is marked while it has unsaved changes. Closing it asks first.
- Switching away and back also keeps your place: the cursor and scroll position
  come back where you left them, even after closing the tab and reopening the
  file.
- **Revert** throws your edits away and re-reads the file.
- Unsaved text and your place in each file are in memory only. The tab comes
  back when the app reopens, but unsaved text in it does not, and it opens at
  the top. Save before quitting.

**A save is refused if the file changed since you opened it.** The agent works
in the same worktree, and saving over its work would drop that work silently.
The refusal keeps your edits and offers two ways out: reload from disk, or
overwrite with your version.

### Changed, and reviewing your own work

**Changed** lists the files the branch changed. Clicking a row opens its diff.
Hovering a row shows a ✎ that opens the file in the editor instead.

A diff from **Changed** takes review comments, the way a PR review does:

1. Drag down the line-number gutter to pick a range, or hover a line and press
   **+** for one line.
2. Write the comment. It hangs under the last line it covers.

Comments attach to the new version of the file, the same side a PR review uses.
A line the change only deletes can't take a comment. Each comment records the
file, the lines, and the commit the worktree was on. The card shows that
commit, so you can tell a note on older code from one on the current code.

**Nothing is published.** Comments stay in the local database and never reach
a PR. That is the point: comments on github.com are read by other people, and
they go stale as soon as the agent acts on them.

The **Comments** tab lists the whole review across every repo in the
workspace, with a count of open comments. A comment's heading opens its diff.

- **Copy for Claude** puts the open comments on the clipboard as a numbered
  list, ready to paste into the agent session.
- **Resolve** marks a comment dealt with. It stays in the list but leaves the
  copied text. **Reopen** puts it back. **×** deletes it.

Archiving a workspace deletes its comments once the worktrees are gone. If the
archive stops partway (a worktree won't remove), the workspace can still be
reopened, so its comments are kept.

### PR checks

**PR checks** shows the branch's pull request and its CI checks. It has copy
buttons for the PR link, each check, and a summary of all checks. See
[Clipboard](clipboard.md#copy-buttons).

### Other worktrees in the workspace

An agent building a stack of PRs often gives each branch its own worktree. The
branch the workspace started on isn't always one of the layers.

The right column finds every worktree of a repo's clone inside the workspace
folder, wherever the agent put it: `<workspace>/widget-api`,
`<workspace>/widget/.claude/worktrees/x`, and so on. A picker at the top of the
column switches between them. With more than one repo, the picker groups them
by repo. The line under it always names the branch you are looking at.

- **Switching runs no `git checkout`.** Each worktree already has its branch
  checked out, and the agent may be working in any of them.
- **All files**, **Changed**, **PR checks** and **Stack** read the picked
  worktree. A file opened from it gets its own tab, titled with the branch.
- **Changed** measures a stacked branch from the branch below it, not from
  main. Each layer shows only its own changes, the way its PR does. The layer
  below is found from local git history among the workspace's worktree
  branches. If the parent has no worktree here, the next one down that does is
  used, or main.
- The workspace's own branch keeps its polled checks and header badges. For
  other worktrees, **PR checks** looks up the PR when you open it and offers
  **Refresh**.
- **A diff from another worktree takes no comments.** Comments are filed by
  repo and path, so one left there would show up on the workspace branch's copy
  of the file.
- In the **Stack** tab, a layer checked out in another worktree has a **View**
  button that switches the column to it.

### Stacked pull requests

The **Stack** tab shows the chain of PRs the picked branch belongs to. Each
layer targets the one below it, with main at the bottom. Every layer shows a
one-glyph state, using the same glyphs as the workspace list: merged, queued,
draft, checks failing, changes requested, approved. Two extra states exist
only here: a branch `gh stack` tracks that has no PR yet, and a layer whose
status couldn't be read. That way you can see which layer is holding up the
rest without opening each PR.

Clicking a layer opens it in the PRs tab. A branch with no PR has nothing to
open.

**Where the data comes from.** GitHub ships stacks through the
[`gh stack`](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands)
CLI, with no API for them, so the tab reads two sources:

- Each layer's status comes from the normal pull request API.
- Which branches are in the stack, and their order, come from
  `gh stack view --json` run in the worktree. It also reports branches that
  drifted off the layer below. Those are flagged **needs restack**, meaning run
  `gh stack rebase`.

Without `gh` or the extension, the tab still works once the branch has a PR.
It walks base and head branch names through the API instead, which also finds
hand-built stacks, and it says why the CLI half is missing.

`gh` uses the GitHub token from Settings if there is one, and its own
`gh auth login` otherwise. Merging needs a token that can write to the repo.

**The tab isn't polled.** A `gh stack view` call plus the API round trips cost
much more than the other tabs, and a stack changes when you act on it. It
loads when you open it, and has a **Refresh** button. Press it after running
`gh stack rebase` in a terminal.

**Merge stack up to #N** merges every layer from main up to and including the
picked branch's PR. Layers above it are left alone.

1. Press **Merge stack up to #N**. The button asks again and says how many PRs
   that is, since they aren't all on screen.
2. Pick a strategy. The default is whatever the repo last used. Squash, merge
   commit and rebase are the choices.
3. Confirm.

The merge is all or nothing on GitHub's side. If any PR in range can't merge,
none do, and you see the reason `gh` gave. If the stack changes between your
confirmation and the merge (an agent restacking in the same worktree, say), the
merge is refused rather than landing a different set than the one you agreed
to.

It runs `gh stack merge`. Without the CLI, the button is replaced by a line
saying so. `gh pr merge` doesn't work on a stack.

## Working across workspaces with the assistant

### Merging main into many workspaces

When several workspaces need the same fix from main, ask the assistant (or
[Telegram](telegram.md)): "merge main into all my open PRs". For each workspace
it fetches, merges the branch's base into it, and pushes if the remote is
missing commits.

A repo is skipped, with the reason reported, when its worktree:

- has uncommitted changes,
- is part-way through a merge, rebase, cherry-pick or revert,
- isn't on the workspace's own branch, or
- hasn't finished provisioning.

**A branch you never pushed gets published by this.** It counts as ahead of a
remote branch that doesn't exist yet.

A merge that conflicts is left in the worktree with its conflict markers and
isn't pushed. You can fix it yourself, or hand it back to the agent.

### Sending an instruction to a running session

The assistant can type an instruction into a workspace's running session, for
example "resolve the merge conflicts and commit". The session works on it in
the background.

Safety rules:

- **The send is refused unless the configured agent is what's reading the
  prompt.** If the agent exited, or something else is running in that
  terminal, nothing is typed.
- **An instruction can't start with `!`, `/`, `#` or `@`.** The agent reads
  those as commands, not requests.
- **A send confirms delivery only, never that the work was done.** Yarvis
  can't see what the agent is showing. If a permission prompt is up, the text
  answers that prompt.

## Archiving

Press **Archive** in the workspace header when the work is done. The dialog
asks for a short summary and the PR link, prefilled from the PR the poller
saw. Archiving stops the session, removes the worktrees, and marks linked
tasks complete. It runs in the background. While it runs, the right column is
replaced by a "Removing worktrees…" note, since the worktrees it reads are being
deleted. If the archive stops on a worktree, the right column comes back so you
can see what's dirty.

A worktree with uncommitted work won't remove. The workspace stays in
"archiving" with that repo's error. Reopen the dialog to see it, and use
**Force remove** only if the uncommitted work can go.

Archived workspaces are hidden from the list. **Show archived** brings them
back.

## Terminal limit

At most 60 terminal sessions can be live at once, across the Terminal tab and
every workspace. Opening more fails until you close one. See
[Terminals](terminals.md#session-limit) to change the limit.

## The attention bell

The bell in the top bar collects everything waiting on you. Mostly that is a
Claude Code session blocked on a permission prompt or sitting idle waiting for
input. The hooks Yarvis writes into each workspace's `.claude/settings.json`
raise these.

Items are tied to the exact terminal that raised them, so a Claude run you
started by hand in one of a workspace's shell tabs flags *that tab*, not the
whole workspace. [Terminals](terminals.md#attention-and-yarvis-memory) lists
the environment variables that make this work.

How the bell behaves:

- **Grouped by origin.** Repeat items from one workspace collapse into one row
  with a count, naming the tabs involved. Dismissing the row clears them all.
- **Cleared by looking.** Opening the workspace or terminal tab that raised an
  item marks it read. An item raised by something already on screen never
  sends an OS notification. Nothing clears itself while the window is in the
  background.
- **Marked where it happened.** A workspace with something pending is marked in
  the workspace list, and its tab is marked in the tab strip.

The assistant doesn't read the bell. It is for you.
