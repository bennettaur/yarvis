# Review workspaces

The **Review** tab is a second way to review pull requests, built for speed. A
review workspace checks one or more PRs out on your machine and lays them out
like an editor: each PR's sections in a nav on the left, and whatever you open
from it as tabs on the right. You can put two tabs side by side, and review
several PRs at once, each in its own colour. It works with GitHub and Azure
DevOps. The [PRs tab](pr-review.md) stays as it is; use whichever suits the PR.

## Set up

Review workspaces use the same credentials as the PRs tab: a GitHub sign-in or
token, or an Azure DevOps token and organization URL, under **Settings →
Credentials**. See [PR review](pr-review.md#set-up).

A PR's repo doesn't have to be registered. If it is (under **Settings →
Repositories**), its setup script is offered for the PR's checkout; see
[Running the setup script](#running-the-setup-script).

## Use it

### Open a PR

On the **Review** tab, paste a PR into the box: a link, `owner/repo#123`, or
`repo#123` for a registered repo, the same forms the PRs tab takes. A PR that
is already in a review workspace opens there. Anything else gets a new
workspace named after the PR.

From the PRs tab, the PR's header has **Open in review workspace**, which does
the same and switches to the Review tab. Its **▾** lists your review
workspaces, to add the PR to one of them instead.

The nav and the description show straight away. The PR's commits are fetched
in the background, and the PR's header in the nav says how far that has got.
The description, reviewers, checks and comments come from the provider, so
they work before the clone finishes. Changed files and the file tree fill in
when it does.

The Review tab remembers the workspace you had open. **←** goes back to the
list, ordered by when each workspace was last opened.

### Find your way around

Each PR has a group in the left nav, headed by its colour, `repo#number` and
title:

- **Description**, **Reviewers**, **Checks** and **Comments** each open as a
  tab. Comments starts with the PR's conversation (on GitHub; Azure DevOps
  general comments show as threads), then every open review thread, with
  resolved ones behind **Show resolved**. Each inline thread links to its line
  in the diff. The number beside Comments counts the open threads. Images in
  comments load straight from wherever they are hosted, as they do in the PRs
  tab, so opening the tab lets those hosts see the request.
- **Since last review** opens what changed since you last reviewed the PR (see
  [Since last review](#since-last-review)). When there are commits you haven't
  seen, it says how many.
- **Changed files** is a tree of what the PR changes, with how many you've
  viewed. Each file has a viewed checkbox, its comment count (amber while a
  thread is open), and a **must read** marker when the
  [verification report](#verification-report) names it. Clicking a file opens
  its diff.
- **Commits** lists the PR's commits, newest first. A green dot marks a commit
  that is new since your last review, and the section opens by itself when
  there are any. Clicking a commit opens it as a tab: the files it touched on
  the left, and the diff of the one you pick against the commit's parent.
- **All files** is the whole tree at the PR's head, collapsed by default, with
  a filter box: every word you type must appear in the path. Files the PR
  changes are marked and open as diffs; anything else opens whole.

Clicking the PR's header folds its group away.

### Diff tabs

A diff tab shows one file's changes in the editor, side by side or unified as
set in the top bar, with unchanged stretches folded behind bars you can
expand. **Whole file** shows it all; **Open file** opens the file at the PR's
head in a tab of its own.

- **Threads** sit under their lines on either side. Reply, resolve and
  reopen them in place. Threads whose line no longer exists are folded into a
  count above the editor.
- **Comment**: hover a line and click the comment button in the margin, or
  select lines and use the bar beside the selection for a multi-line comment.
  Either side works.
- **Ask**: the same way, with the ask button, to ask about those lines as in
  the PRs tab's [line questions](pr-review.md#ask-about-a-line). The answer
  stays under the lines. Questions go on the new version of the file; asking
  on the old side says so.
- **Viewed** marks the file viewed, shared with the tree and the PRs tab.
  **Viewed, next →** marks it and opens the next file you haven't viewed.
- A **Must read** badge, from the verification report, says why the file
  matters and jumps to the lines it points at.
- When the [verification report](#verification-report) has something to say
  about the file, a strip above the diff gives the must-read reason and lists
  each risk concern and check finding that cites a line, with the check's
  name. Click a line number to jump there. The must-read lines are marked in
  amber on the new side of the diff, and each cited line in red; hover one to
  read why.

A **file tab** shows any file at the PR's head whole, with the PR's threads
on it. Questions work on any file; comments only on files the PR changes,
since that is all the providers accept.

### Code navigation

Diff and file tabs support go-to-definition and find references, so you can
follow a call into code the PR doesn't touch without leaving the review.

- **Go to definition**: Cmd+click a name, or put the cursor on it and press
  F12. If there is one answer, its file opens in a tab at that line. If there
  are several, a peek list shows them, best guess first: double-click one to
  open it. A file the PR changes opens as a diff, and any other file opens as
  a plain file.
- **Find references**: press Shift+F12, or pick it from the right-click menu.

For TypeScript and JavaScript, Yarvis uses the editor's own TypeScript
service. When you open a file, Yarvis loads the files it imports from the
PR's head: relative imports, aliases from the repo's `tsconfig.json`
(`paths` and `baseUrl`), and index files. It follows imports a few levels
deep, up to a fixed limit per PR, so jumps land on the real declaration.
Packages aren't loaded, not even ones committed under `node_modules`, so a
jump into a library finds nothing.

Other languages, and TypeScript imports the editor can't resolve, use a text
search over the PR's head commit. The search finds lines that look like
declarations: Python, Go, Rust, Java, Kotlin, C#, Ruby, PHP, Swift, C/C++,
and a generic fallback for everything else. Comments are skipped, and so are
minified files, source maps and build folders (`node_modules`, `dist`,
`build`, `out`, `target`, `.next`, `coverage`). Results are ranked with the
current file first, then its directory, then the files it imports, then
everything else. Python class attributes and dataclass fields come last,
because the search can't tell them from ordinary assignments. In a very large
repo the search stops early and shows what it found so far. It can't tell
overloads or same-named symbols apart, so treat its answers as good guesses,
not compiler-exact results.

Navigation works once the PR's checkout has finished. It never runs code from
the PR and doesn't need setup to have run. It reads the files committed at
the head, so dependencies that are installed but not committed aren't visible
to it.

Every open PR shares one TypeScript service in the editor. Each PR's files
and aliases stay separate, but a global declaration in one PR's loaded files
(`declare global`, a script file with no imports) can show up in another PR's
hover or completion while both are open. The peek list labels a file's folder
with a leading `/head/` (for example `/head/app`).

### Guided review

**Guided review** in the PR bar opens the
[guided review](pr-review.md#take-a-guided-review) as a tab: the tour down
the side and the current step beside it. Next, Back, a step, a flagged finding
or a covered file each open that place in a diff tab, and moving past a step
marks its files viewed.

### Verification report

**Verification** in the PR bar opens a tab where agents (Claude Code,
running on your machine against the PR's checkout) read every changed file's
diff and report: a summary, the files that must be read and why, the risk, and
checks for completeness, tests, complexity, performance, comments,
observability and code quality. Its progress shows check by check while it
runs, and **Cancel** stops it. Every file and line in the report opens the diff
there.

- **Observability** looks for errors that are swallowed, logging at the wrong
  level (errors for failures someone must look at, warnings for things that
  matter when they pile up), logging that is too noisy or missing where a
  failure would go unseen, sensitive data in logs, and a metric only where a
  new process clearly needs one.
- **Code quality** looks for code that goes against the language's or the
  codebase's own practice, weak error handling, and names that mislead.
  Complexity, comments and logging are left to their own checks.
- A report made before these two checks existed shows only the checks it had.

The report doubles as a to-do list. Once you mark a file viewed (in its diff,
the Changed files tree or the PRs tab), every must-read, risk concern and
finding in that file is struck through, and **Must read** counts how many of
its files you've viewed.

No file is left out to save room. Each changed file's diff is given to the
agents on its own, and each check is told to read every one in its area (the
tests check reads the tests and the code they cover, for example). Only a
binary file has no diff. A diff over 2 MB is cut to its first 256 KB, and the
agents are told so.

Bulk is skimmed, not read: lockfiles, minified files, `dist/` and `vendor/`,
and files the repo's `.gitattributes` marks `linguist-generated` or
`linguist-vendored`. Those marks are read at the merge-base, so a PR can't
mark its own code generated to get it skimmed. For the same reason a file
under `dist/` or `vendor/` is skimmed only if it already existed at the
merge-base: one the PR adds there is read in full. The summary agent reads the
first 200 lines of each bulk file to say what it is.

On a big PR, one agent can't hold every diff at once, and what it read early
would drop out of its context. So the diffs are split into reading groups of
about 512 KB (one huge diff is split by lines), and each check runs as one
agent per group, with their findings merged into one report.

Yarvis then counts, from the files the agents actually opened, which changed
files no check read in full. A read only counts when it shows the lines: a
read that failed, a diff with lines too long for the agent to see whole, or
only part of a diff read, doesn't. When any file is short, the report opens
with a **Not examined** section listing each one and why. Click a path to
open its diff. Nothing else in the report covers those files. Below it:

- **Generated, skimmed**, folded away: the bulk whose first page was read.
- **Not examined by** a check: source files in that check's area that it
  didn't read, though another check did.

When every file was read, the report says that at least one check read each
one.

- A report made for an older head says so, with **Re-run**.
- If a re-run fails or is cancelled, the last good report stays below the
  notice.
- Before a run, the tab names the binary files, any diffs that will be cut
  off, and the bulk the agents will only skim.
- On a large PR, or when the estimated cost is over the report's budget
  (**Settings → PR review**), you are asked first, with a rough cost estimate
  against the budget. A run that reaches its budget stops without a report,
  so raise the budget there before running a PR the estimate says is over it.

### Mutation testing

**Mutation testing** (in the PR bar's **⋯**) checks whether the PR's tests
would notice the code being wrong. Claude Code plans a handful of small,
deliberate bugs ("mutants") in the code the PR changes, such as a flipped
comparison or a dropped guard. Then Yarvis runs the PR's own tests against
each one, in a scratch copy of the checkout. A mutant the tests don't notice
is a gap in them.

It runs the PR's code, so it waits for that to be allowed:

- Until you've agreed to the PR's setup script for its current commit, and
  setup has finished, the tab says why it can't start, with **Review the
  setup script…** to open the prompt (see
  [Running the setup script](#running-the-setup-script)).
- When the repo has no setup script, the tab asks you to confirm running the
  tests without one first.

Before a pass starts, the tab says how many mutants it may try, what planning
and explaining can cost (set under **Settings → PR review**), and what the test
sandbox does: no network beyond your machine, writes only to the scratch copy
and a temp folder, and no reading your home folder beyond your toolchains. The
sandbox is a second line of defence, not a guarantee, and setup itself is not
sandboxed.

While it runs, the tab shows each phase (copying, planning, the tests as they
are, a blatant control mutant the tests must catch, each mutant, explaining
survivors) and each mutant's result as it lands. **Cancel** stops it, keeping
what it found so far.

The report leads with a verdict (strong, mixed, weak or inconclusive) and how
many mutants the tests caught. Each surviving mutant follows as a finding: its
edit as a small diff, the test that should have caught it, the assertion that
would, and the test output. Caught, unreached, equivalent and inconclusive
mutants are counted below, folded away. Everything in the report that came
from the PR, its tests or a model is shown as plain text. A path is a link to
the diff only when the PR changes that file. A pass made for an older head
says so, with **Re-run**.

### Since last review

For a re-review: what the author did since you last looked, without wading
through the whole PR again.

**Where you last reviewed** is recorded for you. Submitting a review (approve,
request changes or comment) or posting a line comment through Yarvis records
the commit you were looking at, from a review workspace or the PRs tab. Your
own reviews on GitHub, and your votes on Azure DevOps, count too: GitHub says
which commit each review was made on, and an Azure vote is matched to the push
it came after. **⋯ → Mark reviewed here** in the PR bar records the checkout's
commit by hand, for when you read the PR without leaving a review. The latest
of all of these is your last review. Recording a review, and every refresh,
keeps its commit in the review clone, so a force-push or a clean-up of the
clone doesn't lose it; removing the PR from its last workspace lets them go.

The **Since last review** tab shows:

- A summary line: how many new commits, how many files, and whether the PR was
  rebased onto a newer base, force-pushed, or had its base merged in.
- **What's changed**, an agent's summary of the re-review (see
  [What's changed](#whats-changed)).
- The files whose change differs from the one you reviewed: **Changed again**,
  **Newly changed** (the PR didn't touch it before), or **Reverted** (the PR no
  longer changes it), with the lines added and removed since. Clicking one opens
  it as a **Δ** tab.
- The new commits, which open as commit tabs, and any commits you reviewed that
  a force-push has since dropped.

Changes that came in from the base branch are left out. If the author rebased
onto a newer `main`, or merged `main` in, the files `main` changed don't show
up, and a file both changed shows only the author's part. Yarvis compares the
PR's own change then (from its merge-base to the commit you reviewed) with its
own change now, rather than the two commits directly. A **Δ** tab shows the
file as you reviewed it, moved onto today's base, beside the file now, so both
sides carry the same upstream lines and only the author's edits differ. When
upstream rewrote the very lines the PR changed, that can't be done cleanly; the
left side is then the file exactly as you reviewed it, and a note above the
diff says that some differences come from the base branch. A commit is only
"new" if it brings a change you haven't seen: a commit a rebase re-created with
the same change counts as one you've seen. On a PR with more than 500 commits
that matching is skipped, and the tab says every rewritten commit counts as
new.

When you've caught up, **Mark reviewed here** at the bottom of the tab moves
your starting point to the checkout's commit. Open **Δ** tabs keep comparing
against the review they were opened from (the tab's tooltip names its commit)
until you open the file again from the list. A commit tab whose commit a
force-push has since dropped says it is no longer in the pull request.

#### What's changed

The **What's changed** button in the **Since last review** tab answers the
questions a re-review is about: did the author deal with each of your
comments, is there anything new you need to read, and can you approve. An
agent (Claude Code, on your machine, reading only) reads what changed since
your review and your comments, then reports:

- **The verdict** at the top: **Ready to approve**, or **Needs another look**
  with the reason. It is ready only when each of your comments is addressed
  or its thread is resolved, and nothing new needs your review. A
  disagreement the author explained still holds it back until you accept the
  reason by resolving the thread; resolve it right there and the verdict
  turns ready without a re-run.
- **A summary** of two or three sentences.
- **Your comments**, grouped. **Still open** comes first (not addressed,
  partly addressed, or unclear), then **Answered with a reason**, with the
  agent's summary of the author's reply, then **Addressed or resolved**, and
  **Settled before your review** (threads you resolved before your last
  review, with nothing said since, which aren't judged again), both folded
  away. Each one shows the thread with **Reply** and **Resolve** right there,
  and its location opens the diff at that line.
- **Other changes** since your review: **Needs your review** opens each file's
  **Δ** tab, and **Minor** (formatting, comments, renames, small mechanical
  fixes, test-only tweaks) is folded away. Anything touching logic, contracts,
  data, security or behaviour counts as needing review, however small.

Your comments are the review threads you started or replied in, and your
comments on the PR itself. Yarvis asks the provider who you are to find them
(on Azure DevOps by your identity, since two people can share a display name),
and won't run if it can't tell. Only the PR author's replies count as answers;
another reviewer's or a bot's don't.

Yarvis checks the agent's answer rather than taking it on trust:

- "Addressed" or "partly" has to cite a file that changed since your review,
  at a line in or next to one of its changes. Citing the thread's own file, or
  nothing for a comment on the PR itself, counts only when the author answered
  there. Anything else shows as **Unclear**.
- So does a "disagreed" the author didn't reply to, and a comment the agent
  skipped.
- Every file that changed since your review is accounted for. One the agent
  neither listed nor cited as a fix is listed as needing review ("not
  classified by the agent").
- The agent gets every changed file's interdiff, none left out for room, and
  Yarvis counts which ones it actually read. A file it didn't read in full is
  listed as needing review ("not examined by the agent", with why), even when
  the agent called it minor or cited a fix there. A file with a version over
  2 MB has no interdiff and is listed the same way. A fix the agent cites in a
  file it never opened shows as **Unclear**.
- One agent writes the summary, so it has a limit: when the changes since
  your review are more than it can read at once (about 512 KB of interdiffs),
  **What's changed** won't run, and says so. Before a run the section names
  the files it can't read whole, and asks first when the estimated cost is
  over its budget. Auto-start never starts a run like that.
- When it changed anything, the verdict's reason is Yarvis's own count, and a
  line under the summary says what it couldn't take as given.
- **Ready to approve** never stands beside anything outstanding.

Everything the agent wrote is shown as plain text. A path is a link only when
the PR changes that file.

A summary is for one range, from your last review to the checkout's head. When
the PR has moved on since, the last summary stays in view with a note and
**Re-run**. By default the agent waits for the button. To have it start when the
tab opens on changes it hasn't summarised, turn on auto-start under
**Settings → PR review → What's changed**, where its model and spend ceiling
are set too ($1 by default).

### New commits pushed

The PR bar checks the PR on GitHub or Azure DevOps every couple of minutes
while the app is in view. When someone has pushed past the commit the checkout
is at, a **New commits pushed — Refresh** banner appears under the bar.
**Refresh** fetches the new commits and moves the checkout, showing the fetch's
progress as it goes. Your tabs stay open and show the new commits once it is
done, and the banner then offers **See what changed since you last reviewed** —
or, if more commits were pushed while it ran, another **Refresh**.

### Tabs

Description, reviewers, checks, comments, since last review and the agent tabs
stay pinned to the left of the strip, in that order, and each one opens once
per PR: opening it again brings the open tab forward. Files, diffs (**±**),
since-review files (**Δ**) and commits (**●**) open to the right of them, and
also open only once. Opening a file that is already open jumps to the line
asked for.

- Drag a tab to reorder it. Static tabs stay where they are pinned.
- Middle-click a tab, or press **Cmd+W**, to close it.
- When a workspace holds more than one PR, each tab starts with its PR's
  number (`repo#number` if the PRs come from different repos), in the PR's
  colour, and has a left edge in that colour.

### Side by side

**Side by side** (or **Cmd+\\**) moves the current tab to a second group on the
right, so two tabs show at once: a diff beside the description, or the same
file in two PRs. You can also drag a tab onto the right half of the tab area,
or onto the other group's strip. Drag the divider to resize. Closing a group's
last tab folds the split away.

The workspace remembers its open tabs, the split and which tab is showing
across restarts.

### The PR bar

The bar above the tabs is for the PR whose tab is in front, in its colour. It
has the same actions as the PRs tab's header: **Ready for review** on a draft,
**Approve** and **Request changes**, **Merge** or auto-merge when the repo
allows them, the link to a coding [workspace](workspaces.md) on the PR's
branch, refresh, open on GitHub or Azure DevOps, and copy link. Once you have
approved, in either place, **Approve** becomes a **✓ Approved** badge. It also
has:

- **Guided review** and **Verification**, which open those tabs (see
  [Guided review](#guided-review) and [Verification report](#verification-report)).
- **⋯**, with **Update checkout**, which fetches the PR's latest commits,
  **Mark reviewed here**, which records the checkout's commit as where you
  last reviewed (see [Since last review](#since-last-review)),
  **Remove from workspace**, which takes the PR and its checkout out, and
  **Mutation testing**, which opens that tab (see
  [Mutation testing](#mutation-testing)).

When the PR conflicts with its base, a red **Conflicts with <base>** banner
sits under the bar with **Resolve conflicts**, which hands the merge to a
coding agent in the PR's workspace. It works the same as on the PRs tab; see
[Resolve merge conflicts](pr-review.md#resolve-merge-conflicts).

**Unified** / **Split** in the top bar sets how every diff tab lays out.

### Review several PRs together

Paste another PR into the **Add PR** box in the top bar. It gets the next
colour, its own group in the nav, and its tabs carry its colour. A PR keeps
its colour for as long as it stays in the workspace.

### Running the setup script

Nothing from a PR runs on your machine until you say so. When the PR's repo
is registered and has a setup script, the PR's group in the nav says **Setup
hasn't run · review the script…**. That opens a prompt showing the PR's author,
its branch (with the fork's owner for a PR from a fork) and commit, and the
script exactly as it will run.

**Setup is not sandboxed.** The script, and any code from the PR it runs
(install hooks, build scripts), runs as you, with your files, your
credentials and your network. Only run it for an author you trust. The prompt
also lists a few environment variables the script won't get, such as your SSH
agent, but that is a narrow exception rather than protection.

**Run setup** runs it in the PR's checkout; **Don't run** records the answer
so you aren't asked again for that PR. If the script or the PR's head changed
after the prompt opened, the answer is refused and the prompt reloads to show
what would run now.

Until setup has run, code navigation only uses what is in the checkout, and
mutation testing stays off.

### Archive

**Archive** in the top bar (or on hover in the list), after you confirm, removes the workspace's
checkouts and moves it to **Show archived**. The clone each repo was fetched
into is kept, so the next review of that repo starts faster.

## Reference

### Keyboard shortcuts

| Keys | Does |
| --- | --- |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab on the focused side |
| Cmd+Option+→ / Cmd+Option+← | Next / previous tab, the same way |
| Cmd+W | Close the tab |
| Cmd+\ | Move the tab to the other side, splitting the view if it isn't yet |
| Option+J / Option+K | Open the next / previous changed file of the PR in front |
| F12 or Cmd+click | Go to the definition of the name under the cursor |
| Shift+F12 | Find references to it |

They work while the focus is somewhere in the workspace. While you are typing
in a box (a comment, a reply, the Add PR field), Cmd+W and Option+J / K are
left to the box. The focused side is the one you last clicked in; its strip
has an indigo underline when the view is split.

### Where things live

Each repo is cloned once, without file contents until they are needed, under
your workspaces folder in `.review-repos/`. Each PR gets its own checkout at
the PR's head under `.review/<workspace>/`. Neither is a coding workspace's
clone, so reviewing never touches your own branches. Commits you reviewed are
kept in the clone under `refs/yarvis/reviewed/`; where you last reviewed each
PR is in the database, so it is the same in every workspace and on the PRs tab.
