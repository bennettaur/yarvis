# PR review

The **PRs** tab is where you find the pull requests waiting on you and review
them without leaving the app. It works with GitHub and Azure DevOps. On top of
a normal diff view it adds two things: a **guided review** where an agent lays
out the order to read the change in, and **line questions** where you ask about
a piece of code and keep the answer as a private note. The assistant can search
those notes later.

## Set up

1. Save a **GitHub token** or an **Azure DevOps token** in **Settings →
   Credentials**. For Azure DevOps, also set the organization URL
   (`https://dev.azure.com/your-org`) on the same screen. See
   [Token scopes](../configuration.md#token-scopes) for what each token needs.
2. Guided reviews and line questions are agent runs, so they also need an LLM
   provider key. See [Getting started](../getting-started.md#5-first-configuration).
3. To start a workspace from a PR, register its repo under **Settings →
   Repositories**. See [Workspaces](workspaces.md).

When both providers are set up, a toggle in the PRs tab picks which one backs
the list. If an Azure DevOps token is saved but Azure rejects it, or the
organization URL is missing or wrong, the PRs tab says which one to fix instead
of showing Azure DevOps on the toggle.

## Use it

### Find a PR

The PRs tab has four lists:

- **My PRs**: pull requests you opened.
- **Needs review**: pull requests where your review is requested.
- **Reviewing**: pull requests you have actually engaged with (see below).
- **Filters**: your saved searches.

Each list is grouped under a header per repo. A repo you collapse stays
collapsed across tabs and restarts.

The box above the lists jumps straight to a PR you can already name. It
accepts:

- a link, such as `https://github.com/owner/repo/pull/123` or
  `https://dev.azure.com/org/project/_git/repo/pullrequest/123`. An Azure DevOps
  link has to be in the organization set up in Settings,
- `owner/repo#123` (GitHub only),
- `repo#123` (GitHub only), which is matched against your registered repos. If
  the name matches several owners, you are asked which one.

Leaving the PRs tab and coming back puts you where you were: the same
provider, the same list, and the same PR if you had one open. That also
survives a restart.

On GitHub, **My PRs**, **Needs review** and **Filters** nest a stack under its
bottom PR, marked **stack of N**, with the layers indented under it. A PR
counts as stacked on another when it targets that PR's head branch. Only PRs in
the same list are linked, so a stack whose middle layer isn't in the list shows
as two. If the branch lookup fails or is slow, the list loads without nesting.

### Read a diff

- Files open as you scroll toward them. **Collapse all** and **Expand all**
  fold the whole set.
- **Unified** and **Split** switch between one column and old-beside-new. The
  choice sticks across PRs.
- Each `⋯ N lines` marker between hunks reveals the code the patch left out:
  twenty lines from either end, or the whole stretch if you click the count.
- **Whole file** shows the complete file with its changes still highlighted,
  plus a strip down the edge marking where the changes fall. The full text is
  fetched only when you ask for it.
- Two copy buttons sit beside each filename: the repo-relative path, and the
  provider's link to the file at the commit the PR points at. They are always
  in the diff header, and appear in the file list when you hover a row. See
  [Clipboard](clipboard.md).
- Clicking a row in the file list opens that diff, even one marked viewed or
  folded away. It jumps to the file and flashes its header. The view stays on
  that file while the files above it load, until you scroll.
- A file with review comments shows a speech bubble with the count. That count
  includes replies and resolved threads.

### Take a guided review

A guided review has an agent read the change and give you an order to review
it in. It works from the outside in: the request that arrives, then what
handles it, down to what it finally writes.

1. Open a PR and press **Guided review**, beside the Files heading.
2. Wait for the agent to finish. A box docks at the bottom of the review with
   the first step. Each step names a file and lines, with a sentence on why it
   comes at that point.
3. Click a location in the step to jump to that code. Its file header flashes.
   A long path keeps the file name and line numbers and drops directories from
   the front. Hover it to see the whole path.
4. Read the step's notes. Steps also carry what the agent thinks is **wrong**,
   such as an unhandled failure path, a comment that no longer matches its
   code, or a misleading name. Each is a click away from its line.
5. Press **Next**. That marks every file the step covered as viewed. This is
   the same per-file state the **Viewed** pill sets, and it syncs to
   github.com.
6. On the last step, press **Finish**. It marks that step's files viewed and
   ends the tour.

**Back** is for re-reading and unmarks nothing. Jumping straight to a step
marks nothing either.

Not every file gets its own step:

- Data files, schemas, models and fixtures fold into one **data sanity check**
  step. The agent reports that it checked the models are sensible, the names
  mean what they say, and the human-facing descriptions are accurate.
- Test files fold into a **test sanity check**. The agent reads them against
  the code they cover, looking for untested paths, tests that only exercise
  their own mocks, and tests written differently from the rest of the repo.
- A file that mixes data with logic still gets a walkthrough step for the
  logic.

A step only covers files this PR changed, and never a file another step walks
you through.

A guide is made once per PR. It is kept until you approve, request changes, or
merge. Pushing new commits marks it out of date rather than deleting it. A
guide nobody has touched for 30 days is deleted.

### Ask about a line

1. Hover a line in the diff and press the **?** beside it.
2. To ask about a range, shift-click a second line. The range runs from the
   line you picked in step 1 to the one you shift-click.
3. Type your question. The answer appears inline, under those lines.
4. To share an answer with the author, press **Post**. That turns it into a
   real line comment on the PR.

Until you press **Post**, answers are your own notes. Nothing reaches the
author. They are stored against those lines and kept indefinitely.

The assistant can search them, so you can ask it things like "what did I work
out about that file?" or "where did I leave off?" in chat. See
[The assistant](assistant.md).

### What they cost

Both are agent runs against your configured LLM provider, and neither is
cheap. A guided review gives the agent up to 60 tool-calling steps to explore
the change. A line question gets up to 16. Each step carries diffs and file
contents.

On Azure DevOps, the agent's code search needs the **Code Search** extension
installed in your organization. Without it, guided reviews and line questions
still work, but the agent can't search the repo and says so.

### Work on the PR

The PR's floating header carries one workspace control:

- If the PR already has a workspace, it jumps back to it.
- If it doesn't (someone else's PR, your own raised outside the app, or one
  whose workspace you archived), **Start workspace** creates one checked out on
  the PR's own branch and opens it.

That workspace starts nothing: no ticket and no prompt. You get an agent
session at a blank prompt, ready to ask about the change or push a fix. This
works on GitHub and Azure DevOps.

**Treat Start workspace like checking the branch out and running its setup
script yourself.** The branch may be someone else's. The repo's setup script
runs against their code, and the agent session runs in that worktree.

Some rules that follow from how it works:

- The clone comes from the repo *you* registered under Settings →
  Repositories, so the branch has to live in that repo. PRs from forks are
  refused, so this works only for PRs whose branch is in that repo.
- Provisioning runs in the sidecar, so it finishes whether or not you stay on
  the screen. The workspace shows its log while it runs.
- Pressing **Start workspace** twice reuses the first workspace instead of
  creating a second worktree on the branch.
- Once the workspace is created, the button changes to a link back to it. For
  a workspace created some other way, the link appears after the next PR poll
  (within a minute).

### See where a PR sits in its stack

A PR that is part of a stack gets a **Stack** section above **Checks**. It
lists every layer with its state and marks where you are. Click a layer to open
it.

- It is worked out from base and head branch names through the API, not from
  `gh stack`. That means it works for anyone's PR, and finds stacks built by
  hand as well as by the CLI.
- A layer whose branch no longer contains the tip of the one below it is
  flagged **needs restack**.
- The walk stops after ten layers in each direction. A `+` on the count says
  it stopped.
- A PR that isn't stacked gets no section. Azure DevOps has no stacks.

Merging a stack needs the `gh stack` CLI, so it lives in the workspace's Stack
tab. See [Workspaces](workspaces.md).

## Reference

### Settings → PR review

- **"Needs review" search.** The GitHub issue search behind the Needs review
  list, run exactly as written. You decide what counts, for example dropping
  drafts, narrowing to one org, or leaving out PRs you already reviewed. The
  default is `is:open is:pr review-requested:@me`. A few presets are one click
  away.
- **"Reviewing" history.** How many days back the Reviewing list looks. The
  default is 30.

Both are stored in the `githubPrConfig` section of `~/.yarvis/settings.json`.
See [Configuration](../configuration.md).

### How Reviewing decides what to show

Reviewing lists PRs you have engaged with, using two signals:

- PRs you opened in Yarvis, recorded as `pr.viewed` in the local activity log.
- GitHub's record of your comments and submitted reviews.

The list splits into **In progress** and **Complete**. Complete means merged,
closed, or approved by you, and it starts collapsed. An approval that a later
change request supersedes counts as in progress again.

Reviewing is GitHub only. Azure DevOps exposes neither signal.
