# Chat repo registration tools: design

- **Date:** 2026-10-09
- **Branch:** `add-chat-repo-tools`, based on `main` at `befb74e`
- **Status:** approved design. The open questions at the end need answers
  before implementation.

## Goal

The in-app chat assistant can set up a workspace for a repo that the user has
not added to Yarvis yet. It can also add a repo to an existing workspace.

Today the chat can only use repos that are already in Settings → Repositories.
`list_repos` (`sidecar/src/workspaces/tools.ts:211-219`) returns only registered
repos. No code adds a repo to an existing workspace: `createWorkspace`
(`sidecar/src/workspaces/service.ts:394-474`) inserts every `workspace_repos`
row at creation time.

## Chat flow

- New repo, new workspace: `register_repo` → `create_workspace_session`.
- Existing workspace: `list_workspaces` → `register_repo` (if needed) →
  `add_repo_to_workspace` → optionally `send_workspace_instruction`.

## Chat tool: `register_repo({ repo, name? })`

Lives in `buildWorkspaceTools` (`sidecar/src/workspaces/tools.ts:153`).

Input:

- `repo` is `owner/repo` or a clone URL.
- `name` is an optional display name. It defaults to the repo name, as in
  `createRepo` (`service.ts:258`).

Steps:

1. If `repo` matches `^[\w.-]+/[\w.-]+$`, build `git@github.com:owner/repo.git`.
   This is the SSH form that Settings suggests
   (`src/components/ReposSection.tsx:191`).
2. Otherwise, use `repo` as the clone URL. It must pass `assertSafeCloneUrl`
   (`service.ts:220-227`), which refuses `ext::`, `fd::` and a leading `-`.
3. Parse owner and repo with `parseGitUrl` (`service.ts:103-108`). If parsing
   fails, return the bad-input error.
4. Look for a registered repo with the same owner and repo, case-insensitive. If
   one exists, return it with `alreadyRegistered: true`. Do not run the network
   check.
5. Run `remoteExists`. If it throws, return the error and register nothing.
6. Call `createRepo` (`service.ts:250-269`).

Result: `{ id, name, owner, repo, cloneUrl, alreadyRegistered }`, plus a note
that the setup and run scripts are set in Settings → Repositories.

Rules:

- The tool has no script fields. Setup scripts run in a shell during
  provisioning (`service.ts:1477-1488`), so the chat must never set them.
- The tool does not clone. Cloning happens on the first provision
  (`ensurePrimaryClone`, `sidecar/src/workspaces/git.ts:63-71`).

## Chat tool: `add_repo_to_workspace({ workspaceId, repoId })`

Steps:

1. Call `addRepoToWorkspace(db, workspaceId, repoId)`.
2. Call `provisionWorkspace` (`service.ts:1389-1578`) with the tool's injected
   `gitRunner`, `startClaude` and `remoteControl`, as
   `create_workspace_session` does (`tools.ts:395-399`).
3. Read the workspace again with `getWorkspace`.

Provisioning skips repos that are `ready` or `removed` (`service.ts:1446`).
After the repos finish, it rewrites `AGENTS.md`, `CLAUDE.md` and the other
workspace files (`writeWorkspaceFiles`, `service.ts:1245-1321`, called at
`service.ts:1525`). The new repo's skills and agents are copied into the root
at the same time.

Result:

- The workspace status.
- The new repo's worktree path and branch.
- The new repo's provisioning error, if there is one.
- A note: a running session read `AGENTS.md` when it started, so it does not
  know about the new repo. The chat can offer `send_workspace_instruction` to
  tell it.

Add `add_repo_to_workspace` to `DESTRUCTIVE_BUILTIN_TOOLS`
(`sidecar/src/chat/destructiveTools.ts:31-57`). A spoken turn then asks before
the tool runs (`sidecar/src/chat/agent.ts:362-364`). The reason: it clones code
that an auto-mode agent will read.

## Tool descriptions

- `list_repos` (`tools.ts:212-213`): add "If the repo is not registered, call
  `register_repo` first."
- `create_workspace_session` (`tools.ts:360`): add the same sentence.
- `register_repo` and `add_repo_to_workspace` join the `workspaces` family
  through `buildWorkspaceTools`. That family loads through tool search
  (`sidecar/src/agentTools/registry.ts:40`). Write each description so that a
  request like "add the api repo to my workspace" finds it.

## Helper: `remoteExists(runner, cloneUrl)`

New in `sidecar/src/workspaces/git.ts`.

- Run `git ls-remote --exit-code <url> HEAD` through the injected `GitRunner`
  (`git.ts:25-28`). The default runner sets `GIT_TERMINAL_PROMPT=0`
  (`git.ts:45-46`), so a missing HTTPS credential fails at once.
- Use a 30-second timeout. The runner throws on a timeout
  (`sidecar/src/workspaces/exec.ts:86-88`).
- On a non-zero exit, throw an error that includes git's stderr. The existing
  `git()` helper (`git.ts:49-60`) already does this. With the stderr, the chat
  can tell "not found" from "no access".

## Service: `addRepoToWorkspace(db, workspaceId, repoId)`

New in `sidecar/src/workspaces/service.ts`. It throws an `Error` with a clear
message for each refusal. The tool catches it and returns `{ error }`.

Refuse when:

- the workspace does not exist,
- the workspace status is not `active` or `error`,
- a provision is running for the workspace (check the `provisioning` map at
  `service.ts:1176`, as `ignoreWorkspaceError` does at `service.ts:1694`),
- the repo does not exist,
- the repo is already in the workspace.

Row values:

- **Branch:** `yarvis/<slug>`, the same rule as `createWorkspace`
  (`service.ts:409`). `ensureWorktree` adds a suffix if that branch already
  exists in the repo's clone (`service.ts:1371-1374`).
- **Base:** `repo.defaultBranch ?? "main"`, as in `service.ts:442`.
  Provisioning detects the real default branch (`service.ts:1458-1459`).
- **Folder:** the lowercased display name (`repo.name`). If a repo in the
  workspace already uses that folder, use `name-owner`. Move the naming rule out
  of `createWorkspace` (`service.ts:411-416` and `443-447`) into one shared
  helper, so the two callers cannot drift.
- **Status:** `pending`. The `(workspace_id, repo_id)` unique index
  `workspace_repos_ws_repo_idx` (`sidecar/src/db/schema.ts:620`) stops a race
  that adds the same repo twice. Map that violation to the "already in the
  workspace" message.

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
  failed" (`service.ts:1526-1528`). The existing Retry in the UI re-runs only
  the failed repo.
- The agent does not restart. The kick-off session launches only while
  `pendingBrief` is set (`service.ts:1535-1549`), and a launched kick-off clears
  it (`service.ts:1619`).

## Errors

Follow `tools.ts`: return `{ error }` and do not throw (`errorMessage`,
`tools.ts:39`).

`register_repo`:

- Bad input: "use owner/repo or a clone URL".
- Unsafe transport: refused, with the `assertSafeCloneUrl` message.
- `ls-remote` failure: "repo not found or no access", with git's stderr.

`add_repo_to_workspace`:

- Each refusal in `addRepoToWorkspace` has its own message.
- A provisioning failure returns the repo's error, in the same shape as
  `create_workspace_session` (`tools.ts:403-413`).

## Tests

Use the existing real-Postgres setup and an injected `GitRunner`.

- `git.test.ts`, with the `fakeRunner` helper (`git.test.ts:32-44`):
  - `remoteExists` builds the right arguments.
  - It returns on success.
  - It throws with stderr on failure.
- `addRepoToWorkspace` (see the open question about where these tests go):
  - The happy path sets the row values, branch and folder.
  - A folder collision gives `name-owner`.
  - Each refusal gives its message.
- `tools.test.ts`, `register_repo`:
  - The shorthand builds the SSH URL.
  - A URL is used as given.
  - An unsafe URL is refused.
  - An already-registered repo skips `ls-remote`.
  - A failed `ls-remote` registers nothing.
- `tools.test.ts`, `add_repo_to_workspace` end to end:
  - Only the new repo provisions.
  - `AGENTS.md` lists the new repo.
- The confirm set contains `add_repo_to_workspace`. Update any test that lists
  tool names.

## Docs

Use Canadian spelling and Simplified Technical English.

`docs/features/assistant.md`:

- Repos item in "Set up" (line 25): the assistant can add a repo for you.
- "Starting work" (lines 66-78): add the example "start a workspace for
  `owner/repo`".
- "The activity log" list (line 172): add "repo added".
- "What it asks before doing", spoken turns (lines 232-235): add adding a repo
  to a workspace.

`docs/features/workspaces.md`:

- "Create a workspace", "By asking the assistant" (lines 76-79): the assistant
  can register a repo that is not in Settings yet.
- A new short section, "Add a repo to a workspace". It gives the status rules
  above. It says that a running agent is not told about the new repo on its
  own.

## Out of scope

- An HTTP route or a UI button to add a repo.
- Removing a repo from a workspace, or changing its branch.
- Searching GitHub by name.
- Workspace tools on the Yarvis MCP server.

## Open questions

These are places where the code does not fully agree with the design. The
design above is unchanged. Each item needs a decision.

1. **An `error` workspace re-provisions more than the new repo.** Provisioning
   retries every repo that is not `ready` or `removed` (`service.ts:1446`). In a
   workspace that is `error` because another repo failed, that repo runs again
   too. Accept and document this, or refuse `error` workspaces?
2. **A kick-off can still be owed.** `pendingBrief` stays set in two cases: a
   workspace whose first provision failed, and an `active` workspace whose
   kick-off launch failed (`service.ts:1610-1612`). In both, adding a repo can
   launch the kick-off session for the first time (`service.ts:1535-1549`). No
   running agent restarts, because the core discards a second spawn for the
   same workspace. Accept this, or refuse while `pendingBrief` is set?
3. **An interrupted provision leaves no Retry.** If the sidecar stops during the
   new repo's provision, the row stays `pending` or `provisioning` and the
   workspace stays `active`. The UI shows Retry only when the workspace is not
   `active` or a repo is `error` (`src/components/workspaces/provisionActions.ts:43-56`).
   `resumeKickOffs` resumes only workspaces with a `pendingBrief`
   (`service.ts:1656-1668`). The same state follows a narrow race: a run that
   starts between the guard and the tool's call is followed instead
   (`service.ts:1400-1401`), and its snapshot (`service.ts:1433`) does not have
   the new row. Should the UI offer Retry when any repo is not `ready`?
4. **The two folder rules differ.** `createWorkspace` adds the owner to every
   repo in a clashing pair (`service.ts:411-416`, `443-447`). The new rule adds
   it only to the repo being added, because existing folders cannot move. The
   shared helper must take the folders already in use as input. Display names
   are free text, so `name-owner` can also clash. Refuse on a second clash?
5. **A display name becomes a path segment.** `createRepo` only trims `name`
   (`service.ts:258`), and the route checks only `min(1)`
   (`sidecar/src/workspaces/routes.ts:49`). The folder rule puts the name into
   `worktreePath`, so `..` or `/` can leave the workspace root. Today a person
   types this name. With `register_repo`, the model chooses it. The shorthand
   pattern also accepts `..` as the owner or repo. Restrict `name` in
   `register_repo` (for example to `^[\w.-]+$`, and not `.` or `..`), or make
   the folder helper refuse unsafe names?
6. **The tests do not live where the design says.**
   - `service.test.ts` has no database (`service.test.ts:1-11`). The
     database-backed workspace tests are in `routes.test.ts` (for example the
     block at `routes.test.ts:1229`) and `tools.test.ts`. Put the
     `addRepoToWorkspace` tests in `routes.test.ts`, or add a database setup to
     `service.test.ts`?
   - No existing test covers the `createWorkspace` folder rule. The shared
     helper needs its own unit test in `service.test.ts`.
   - No test lists the members of `DESTRUCTIVE_BUILTIN_TOOLS`.
     `mcp/chatTools.test.ts:238-310` builds its own sets. A membership check
     needs a new file, such as `chat/destructiveTools.test.ts`.
   - The `AGENTS.md` check needs a runner that creates the worktree folder, like
     `fakeGit` (`routes.test.ts:72-83`). The `okRunner` in `tools.test.ts:31-36`
     does not create it, so the root folder may not exist.
7. **`GIT_TERMINAL_PROMPT=0` does not cover SSH.** It stops git's own
   credential prompt. SSH authentication belongs to `ssh`. With no terminal it
   usually fails, but only the 30-second timeout bounds a stall. Also, `ls-remote
   --exit-code` exits 2 for an empty repo with no `HEAD`, so an empty repo reads
   as "not found". Accept both?
8. **Azure DevOps URLs parse to owner `_git`.** `parseGitUrl` takes the last two
   path segments (`service.ts:103-108`). The "already registered" lookup by
   owner and repo can then match a different Azure repo with the same name.
   Compare the clone URL too, or use `parseRepoRemote` (`service.ts:183-213`)?
9. **The system prompt names the old flow.** `chat/agent.ts:137` tells the model
   to call `list_repos`, then `create_workspace_session`. `chat/agent.ts:157`
   lists the actions to take only when the user asks. The design changes only
   the tool descriptions. Update both lines too?
10. **More doc lines go stale.** `assistant.md:269-271` lists the workspace
    tools. `workspaces.md:88-91` says `AGENTS.md` is rewritten only on a
    re-provision such as a retry. `workspaces.md:13-19` is the page's contents
    list. Update these too?
11. **Scratch workspaces.** The rules allow adding a repo to a scratch workspace
    (no repos). Is this intended?
12. **Specialists.** The confirm set also makes a tool need an explicit grant
    for a specialist (`sidecar/src/agents/run.ts:105-108`). `register_repo` is
    not in the set, so a specialist that has the workspace tools can register a
    repo with no prompt. Is this acceptable?
