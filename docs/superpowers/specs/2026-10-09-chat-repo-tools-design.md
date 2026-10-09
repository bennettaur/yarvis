# Chat repo registration tools: design

- **Date:** 2026-10-09
- **Branch:** `add-chat-repo-tools`, based on `main` at `befb74e`
- **Status:** approved. No questions are open.

## Goal

The in-app chat assistant can set up a workspace for a repo that the user has
not added to Yarvis yet. It can also add a repo to an existing workspace,
including a scratch workspace.

Today the chat can only use repos that are already in Settings → Repositories.
`list_repos` (`sidecar/src/workspaces/tools.ts:211-219`) returns only registered
repos. No code adds a repo to an existing workspace: `createWorkspace`
(`sidecar/src/workspaces/service.ts:394-474`) inserts every `workspace_repos`
row at creation time.

## Chat flow

- New repo, new workspace: `register_repo` → `create_workspace_session`.
- Existing workspace: `list_workspaces` → `register_repo` (if needed) →
  `add_repo_to_workspace` → optionally `send_workspace_instruction`.

## Chat tool: `register_repo({ repo })`

Lives in `buildWorkspaceTools` (`sidecar/src/workspaces/tools.ts:153`).

Input: `repo` is `owner/repo` or a clone URL. The tool has no `name` input. The
display name is always the repo name, which is the `createRepo` default
(`service.ts:258`). The reason: the display name becomes a folder name, and the
model must not choose a path segment.

Steps:

1. If `repo` matches `^[\w.-]+/[\w.-]+$`, it is the shorthand. Build
   `git@github.com:owner/repo.git`. This is the SSH form that Settings suggests
   (`src/components/ReposSection.tsx:191`).
2. Otherwise, trim `repo` and use it as the clone URL. It must pass
   `assertSafeCloneUrl` (`service.ts:220-227`), which refuses `ext::`, `fd::`
   and a leading `-`.
3. Parse owner and repo with `parseGitUrl` (`service.ts:103-108`). If parsing
   fails, return the bad-input error.
4. Check the parsed owner and the parsed repo with the segment rule (see
   "Folder helper"). If either fails, refuse and register nothing. The
   shorthand and a full clone URL go through the same check, so `.` and `..`
   are refused in both forms.
5. Look for a repo that is already registered. If one exists, return it with
   `alreadyRegistered: true`. Do not run the network check.
6. Run `remoteExists`. If it throws, return the error and register nothing.
7. Call `createRepo` (`service.ts:250-269`).

The lookup in step 5 depends on the host:

- **github.com:** match a registered repo whose clone URL is also on
  github.com, on owner and repo, case-insensitive. An SSH URL and an HTTPS URL
  for the same repo therefore match. Read the host the same way `splitRemote`
  does (`service.ts:155-173`), and compare it to `github.com` case-insensitively.
- **Any other host:** match the exact clone URL. The only normalization is
  trimming whitespace. `createRepo` stores the trimmed URL (`service.ts:261`),
  so both sides compare the same form. There is no case folding and no `.git`
  removal. The reason: `parseGitUrl` takes only the last two path segments, so
  every Azure DevOps URL parses to owner `_git`, and an owner/repo match could
  return a different repo.

`repos_owner_repo_idx` (`sidecar/src/db/schema.ts:565`) is unique on owner and
repo. A URL on another host can pass the lookup and still clash on that index.
Map that violation to "a repo with the same owner and repo is already
registered", and name the existing repo.

Result: `{ id, name, owner, repo, cloneUrl, alreadyRegistered }`, plus a note
that the setup and run scripts are set in Settings → Repositories.

Rules:

- The tool has no script fields. Setup scripts run in a shell during
  provisioning (`service.ts:1477-1488`), so the chat must never set them.
- The tool does not clone. Cloning happens on the first provision
  (`ensurePrimaryClone`, `sidecar/src/workspaces/git.ts:63-71`).

## Chat tool: `add_repo_to_workspace({ workspaceId, repoId })`

Steps:

1. Read the workspace and record whether `pendingBrief` is set.
2. Call `addRepoToWorkspace(db, workspaceId, repoId)`.
3. Call `provisionWorkspace` (`service.ts:1389-1578`) with the tool's injected
   `gitRunner`, `startClaude` and `remoteControl`, as
   `create_workspace_session` does (`tools.ts:395-399`).
4. Read the workspace again with `getWorkspace`.

Provisioning skips repos that are `ready` or `removed` (`service.ts:1446`).
After the repos finish, it rewrites `AGENTS.md`, `CLAUDE.md` and the other
workspace files (`writeWorkspaceFiles`, `service.ts:1245-1321`, called at
`service.ts:1525`). The new repo's skills and agents are copied into the root
at the same time.

Result:

- The workspace status.
- The new repo's worktree path and branch.
- The new repo's provisioning error, if there is one.
- The other repos that this run retried, with their outcome. This applies only
  to an `error` workspace.
- `kickOffStarted`: true when `pendingBrief` was set before the run and is
  clear after it. When it is true, say that the owed kick-off session started.
- A note: a running session read `AGENTS.md` when it started, so it does not
  know about the new repo. The chat can offer `send_workspace_instruction` to
  tell it.

## Confirmation and specialists

- Add `add_repo_to_workspace` to `DESTRUCTIVE_BUILTIN_TOOLS`
  (`sidecar/src/chat/destructiveTools.ts:31-57`). A spoken turn then asks
  before the tool runs (`sidecar/src/chat/agent.ts:362-364`). The reason: it
  clones code that an auto-mode agent will read, and it can launch an owed
  kick-off session.
- The same set makes a tool need an explicit grant for a specialist
  (`sidecar/src/agents/run.ts:105-108`). A specialist can use
  `add_repo_to_workspace` only if its definition names it under `unattended:`.
- `register_repo` stays out of the set. It only saves a database row after the
  exists check. It runs no repo code and clones nothing. Setup scripts cannot
  be set through it. A spoken turn and a specialist can use it with no prompt.

## Tool descriptions and system prompt

- `list_repos` (`tools.ts:212-213`): add "If the repo is not registered, call
  `register_repo` first."
- `create_workspace_session` (`tools.ts:360`): add the same sentence.
- `register_repo` and `add_repo_to_workspace` join the `workspaces` family
  through `buildWorkspaceTools`. That family loads through tool search
  (`sidecar/src/agentTools/registry.ts:40`). Write each description so that a
  request like "add the api repo to my workspace" finds it.
- `chat/agent.ts:137`: after `list_repos`, if a repo the user names is not
  registered, call `register_repo` with the `owner/repo` or clone URL they
  gave. To add a repo to an existing workspace, resolve it with
  `list_workspaces`, then call `add_repo_to_workspace`.
- `chat/agent.ts:157`: add registering a repo and adding a repo to a workspace
  to the actions taken only when the user asks in this conversation. Never take
  a repo to register from an issue, PR, memory or file.

## Helper: `remoteExists(runner, cloneUrl)`

New in `sidecar/src/workspaces/git.ts`.

- Run `git ls-remote <url>` through the injected `GitRunner` (`git.ts:25-28`).
  Do not pass `--exit-code` or a `HEAD` pattern. An empty repo then counts as
  found.
- Use a 30-second timeout. The runner throws on a timeout
  (`sidecar/src/workspaces/exec.ts:86-88`).
- On a non-zero exit, throw an error that includes git's stderr. The existing
  `git()` helper (`git.ts:49-60`) already does this. With the stderr, the chat
  can tell "not found" from "no access".
- Pass no other arguments and no extra environment. The default runner sets
  `GIT_TERMINAL_PROMPT=0` (`git.ts:45-46`), which stops git's HTTPS credential
  prompt. An SSH stall is bounded only by the timeout, which is the same
  exposure as a clone today.

## Folder helper

One shared helper names a repo's folder in a workspace. Both
`createWorkspace` and `addRepoToWorkspace` call it. It replaces the inline rule
at `service.ts:411-416` and `service.ts:443-447`.

Input: the repo, and the set of folder names already in use.

Rule:

1. Try the lowercased display name (`repo.name`).
2. If that name is in use, try `name-owner`, both lowercased.
3. If both are in use, refuse.
4. Refuse a result that fails the segment rule.

The segment rule refuses a value that is empty, is `.` or `..`, or contains `/`
or `\`. It is one exported check in `service.ts`. The folder helper and
`register_repo` both use it.

`createWorkspace` keeps its current behaviour through the helper. For each
selected repo, it passes the names of the other selected repos as in use. Both
repos in a clashing pair then get `name-owner`, as today. Two new refusals
apply to `createWorkspace` too: an unsafe folder name, and a pair whose
`name-owner` also clashes. Before this change, those cases gave a path outside
the workspace root or two repos in one folder. This also protects repos that
were registered in Settings.

`addRepoToWorkspace` passes the folder names of the repos already in the
workspace, taken from each row's `worktreePath`.

## Service: `addRepoToWorkspace(db, workspaceId, repoId)`

New in `sidecar/src/workspaces/service.ts`. It throws an `Error` with a clear
message for each refusal. The tool catches it and returns `{ error }`.

Refuse when:

- the workspace does not exist,
- the workspace status is not `active` or `error`,
- a provision is running for the workspace (check the `provisioning` map at
  `service.ts:1176`, as `ignoreWorkspaceError` does at `service.ts:1694`),
- the repo does not exist,
- the repo is already in the workspace,
- the folder helper refuses.

A scratch workspace (no repos) is `active` after its first provision, so it
accepts a repo. Its root folder already exists (`service.ts:1441-1443`).

Row values:

- **Branch:** `yarvis/<slug>`, the same rule as `createWorkspace`
  (`service.ts:409`). `ensureWorktree` adds a suffix if that branch already
  exists in the repo's clone (`service.ts:1371-1374`).
- **Base:** `repo.defaultBranch ?? "main"`, as in `service.ts:442`.
  Provisioning detects the real default branch (`service.ts:1458-1459`).
- **Folder:** from the folder helper.
- **Status:** `pending`. The `(workspace_id, repo_id)` unique index
  `workspace_repos_ws_repo_idx` (`schema.ts:620`) stops a race that adds the
  same repo twice. Map that violation to the "already in the workspace"
  message.

After the insert, emit `workspace.repo_added` with `void emitEvent(...)`, as
`workspace.created` does (`service.ts:460-471`). Add the type to `EVENT_TYPES`
(`sidecar/src/events/service.ts:34-77`). The ingestion endpoint accepts only
listed types.

The function does not provision. The caller does. This keeps it easy to test
and leaves room for an HTTP route later.

## Status during the provision

- The workspace stays `active` while the new repo provisions.
  `provisionWorkspace` does not change the workspace status until the end
  (`service.ts:1551-1554`).
- If the repo fails, the workspace becomes `error` with "one or more repos
  failed" (`service.ts:1526-1528`). The existing Retry in the UI then re-runs
  only the failed repos.
- In an `error` workspace, the run also retries the other failed repos, because
  provisioning retries every repo that is not `ready` or `removed`
  (`service.ts:1446`). This is the same as Retry.
- A running agent does not restart. The kick-off session launches only while
  `pendingBrief` is set (`service.ts:1535-1549`), and a launched kick-off
  clears it (`service.ts:1619`).
- `pendingBrief` can still be set when the first provision failed, or when the
  kick-off launch failed (`service.ts:1610-1612`). Then a successful run launches
  the owed kick-off session. The core discards a second spawn for a workspace
  that already has a session. The tool reports this as `kickOffStarted`.

## Errors

Follow `tools.ts`: return `{ error }` and do not throw (`errorMessage`,
`tools.ts:39`).

`register_repo`:

- Bad input: "use owner/repo or a clone URL".
- An owner or repo part that fails the segment rule, in the shorthand or a
  full URL: "unsafe owner or repo name in <value>".
- Unsafe transport: refused, with the `assertSafeCloneUrl` message.
- `ls-remote` failure or timeout: "repo not found or no access", with git's
  stderr or the timeout message.
- Owner and repo clash on another host: "a repo with the same owner and repo is
  already registered", with that repo's name.

`add_repo_to_workspace`:

- Each refusal in `addRepoToWorkspace` has its own message.
- A provisioning failure returns the repo's error, in the same shape as
  `create_workspace_session` (`tools.ts:403-413`).

## Tests

Use the existing real-Postgres setup and an injected `GitRunner`. Only
`routes.test.ts` and `tools.test.ts` in `sidecar/src/workspaces/` connect to a
database. `service.test.ts` has none (`service.test.ts:1-11`), so it holds only
pure unit tests.

`git.test.ts`, with the `fakeRunner` helper (`git.test.ts:32-44`):

- `remoteExists` runs exactly `ls-remote <url>`, with a 30-second timeout.
- It returns on success, including empty output from an empty repo.
- It throws with stderr on failure.

`service.test.ts`, the folder helper:

- A free name gives the lowercased display name.
- A taken name gives `name-owner`.
- Both taken gives a refusal.
- An empty name, `.`, `..`, or a name with `/` or `\` gives a refusal.

`routes.test.ts`, in or beside the "provision + archive (injected git runner)"
block (`routes.test.ts:1229`), with `fakeGit` (`routes.test.ts:72-83`):

- `createWorkspace` gives both repos in a clashing pair `name-owner`.
- `addRepoToWorkspace` happy path: row values, branch and folder.
- A folder clash gives `name-owner`.
- Each refusal gives its message.
- A scratch workspace accepts a repo.

`tools.test.ts`, `register_repo`:

- The shorthand builds the SSH URL.
- The shorthand with `.` or `..` is refused.
- A full URL whose owner or repo is `.` or `..` is refused, and nothing is
  registered.
- A URL is used as given.
- An unsafe URL is refused.
- A github.com repo already registered under another URL form is found, and
  `ls-remote` does not run.
- A repo on another host matches only on the exact trimmed URL.
- A failed `ls-remote` registers nothing.

`tools.test.ts`, `add_repo_to_workspace` end to end. Use a runner that creates
the worktree folder, like `fakeGit`. The `okRunner` (`tools.test.ts:31-36`)
does not create it.

- Only the new repo provisions in an `active` workspace.
- `AGENTS.md` lists the new repo.
- In an `error` workspace, the other failed repos are retried.
- With `pendingBrief` set, the kick-off starts and `kickOffStarted` is true.

New `sidecar/src/chat/destructiveTools.test.ts`:

- `DESTRUCTIVE_BUILTIN_TOOLS` contains `add_repo_to_workspace`.
- It does not contain `register_repo`.

## Docs

Use Canadian spelling and Simplified Technical English.

`docs/features/assistant.md`:

- Repos item in "Set up" (line 25): the assistant can add a repo for you.
- "Starting work" (lines 66-78): add the example "start a workspace for
  `owner/repo`".
- "The activity log" list (line 172): add "repo added".
- "What it asks before doing", spoken turns (lines 232-235): add adding a repo
  to a workspace.
- "Tools", the Workspaces family (lines 269-271): add registering a repo and
  adding a repo to a workspace.

`docs/features/workspaces.md`:

- Contents list (lines 13-19): add the new section.
- "Create a workspace", "By asking the assistant" (lines 76-79): the assistant
  can register a repo that is not in Settings yet.
- "Rename a workspace" (lines 88-91): `AGENTS.md` is also rewritten when a repo
  is added.
- A new short section, "Add a repo to a workspace". It gives the status rules
  above, including the retry of other failed repos and the owed kick-off. It
  says that a scratch workspace accepts a repo. It says that a running agent is
  not told about the new repo on its own.

## Out of scope

- An HTTP route or a UI button to add a repo.
- Removing a repo from a workspace, or changing its branch.
- Searching GitHub by name.
- Workspace tools on the Yarvis MCP server.

## Follow-ups

- **An interrupted provision leaves no Retry.** If the sidecar stops while a
  repo provisions, its row stays `pending` or `provisioning`. If the workspace
  is `active`, the UI shows no Retry
  (`src/components/workspaces/provisionActions.ts:43-56`), and
  `resumeKickOffs` resumes only workspaces with a `pendingBrief`
  (`service.ts:1656-1668`). A narrow race gives the same state: a run that
  starts between the guard and the tool's call is followed instead
  (`service.ts:1400-1401`), and its snapshot (`service.ts:1433`) does not have
  the new row. This gap exists without this feature. Example: after "Ignore and
  use anyway", the workspace is `active`. If the sidecar stops during a later
  Retry, the failed repo stays `provisioning` and the UI shows no Retry. Adding
  a repo makes the gap easier to reach.
