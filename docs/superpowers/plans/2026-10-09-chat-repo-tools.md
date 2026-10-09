# Chat Repo Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the in-app chat assistant register a repo that is not in Yarvis yet (`register_repo`) and add a registered repo to an existing workspace (`add_repo_to_workspace`).

**Architecture:** Two new chat tools in `sidecar/src/workspaces/tools.ts` sit on three new sidecar pieces: a shared folder helper and segment rule in `workspaces/service.ts` (which `createWorkspace` also adopts), a `remoteExists` git helper in `workspaces/git.ts`, and an `addRepoToWorkspace` service function that inserts a `pending` row and leaves provisioning to the caller. The existing `provisionWorkspace` does the clone, worktree, setup script and `AGENTS.md` rewrite unchanged.

**Tech Stack:** Bun, TypeScript, Hono sidecar, Drizzle ORM on Postgres + pgvector, AI SDK `tool()` with Zod schemas, `bun test`, Biome.

**Spec:** `docs/superpowers/specs/2026-10-09-chat-repo-tools-design.md`

## Global Constraints

- Canadian spelling in prose (docs, comments that read as prose, commit bodies); American spelling in code identifiers.
- Docs use ASD-STE100 Simplified Technical English: short sentences, active voice, one instruction per sentence.
- Comments explain *why*, not *what* (repo `AGENTS.md`, last convention).
- `register_repo` has no `name` input and no script fields. It never clones.
- `remoteExists` runs exactly `git ls-remote <url>` with a 30-second timeout, no other arguments and no extra environment.
- The segment rule refuses a value that is empty, is `.` or `..`, or contains `/` or `\`.
- Tools return `{ error }` and do not throw. Service functions throw `Error`.
- Tool factories must not touch the database at construction time: `builtinToolMetadata()` builds them with `db: undefined` (`sidecar/src/chat/builtinTools.ts:72-100`).
- No schema change and no migration.
- Commit from inside the worktree with `mise exec -- git commit`. Never `--no-verify`. Never amend. End each commit message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Out of scope: an HTTP route or UI button for adding a repo, removing a repo, changing a repo's branch, GitHub name search, workspace tools on the MCP server, the interrupted-provision Retry gap.

## Review Focus

The spec's tests do not pin these five. Each one has a test in the task that owns the code.

1. **Shorthand with a trailing `.git`** (`acme/widget.git`). A person expects `git@github.com:acme/widget.git`, not `…widget.git.git` and a repo named `widget.git`. Strip one trailing `.git` from the shorthand before building the URL (Task 4). Confirm this with the user; the spec is silent.
2. **Credentials in a pasted URL.** `https://user:ghp_x@host/o/r.git` that fails `ls-remote` must not echo `ghp_x` back to the model. Pass the error through the existing `errorText` (`service.ts:908-911`) and `sanitizeIssueText`, as the sync tool does (Task 4).
3. **Timeout.** A remote that hangs makes the runner throw "command timed out" (`exec.ts:86-88`), not a non-zero exit. The tool must return "repo not found or no access" and register nothing (Task 4).
4. **The same repo added twice at once.** Two concurrent `addRepoToWorkspace` calls both pass the "already in the workspace" read. The unique index must turn the loser into the same "already in this workspace" message, not a raw Postgres error (Task 3).
5. **The new repo fails to provision.** `add_repo_to_workspace` must return `error`, the workspace status `error`, a `failures` list naming the repo, and `kickOffStarted: false` (Task 5).

---

## Prerequisites (once per machine)

Run from the worktree root, `/Users/rwong/dev/yarvis-workspaces/add-workspace-mcp/yarvis`.

```bash
mise exec -- bun install
# Test database (skip if it exists): Postgres with pgvector.
createdb yarvis_test
psql -d yarvis_test -c 'CREATE EXTENSION IF NOT EXISTS vector;'
DATABASE_URL=postgres://localhost:5432/yarvis_test mise exec -- bun run --cwd sidecar db:migrate
```

`TEST_DATABASE_URL` defaults to `postgres://localhost:5432/yarvis_test` (`docs/development.md:67-74`). Tests truncate tables, so never point it at the real `yarvis` database. Pure test files (`git.test.ts`, `service.test.ts`, `chat/destructiveTools.test.ts`) need no database.

Single-file test command shape (the `test` script is `bun test`, run in `sidecar/` so its `bunfig.toml` preload applies):

```bash
TEST_DATABASE_URL=postgres://localhost:5432/yarvis_test \
  mise exec -- bun run --cwd sidecar test src/workspaces/<file>.test.ts -t "<name pattern>"
```

## File map

| File | Responsibility | Tasks |
| --- | --- | --- |
| `sidecar/src/workspaces/service.ts` | Segment rule, folder helper, `createWorkspace` refactor, `addRepoToWorkspace`, `isUniqueViolation`, `findRegisteredRepo`, export `errorText` | 1, 3, 4 |
| `sidecar/src/workspaces/service.test.ts` | Pure unit tests for the segment rule and folder helper | 1 |
| `sidecar/src/workspaces/routes.test.ts` | DB tests for `createWorkspace` folders and `addRepoToWorkspace` | 1, 3 |
| `sidecar/src/events/service.ts` | `workspace.repo_added` in `EVENT_TYPES` | 3 |
| `sidecar/src/workspaces/git.ts` | `remoteExists` | 2 |
| `sidecar/src/workspaces/git.test.ts` | `remoteExists` tests | 2 |
| `sidecar/src/workspaces/tools.ts` | `register_repo`, `add_repo_to_workspace`, description edits | 4, 5 |
| `sidecar/src/workspaces/tools.test.ts` | Tool tests | 4, 5 |
| `sidecar/src/chat/destructiveTools.ts` | Add `add_repo_to_workspace` | 5 |
| `sidecar/src/chat/destructiveTools.test.ts` (new) | Confirm-set membership | 5 |
| `sidecar/src/chat/agent.ts` | System prompt lines 137 and 157 | 6 |
| `sidecar/src/chat/agent.test.ts` | System prompt test | 6 |
| `docs/features/assistant.md`, `docs/features/workspaces.md` | User docs | 7 |

## Order and parallel groups

No two tasks in one group touch the same file.

- **Group A (parallel):** Task 1 (folder helper), Task 2 (`remoteExists`), Task 6 (system prompt), Task 7 (docs).
- **Group B:** Task 3 (`addRepoToWorkspace`). Needs Task 1. Shares `service.ts` and `routes.test.ts` with Task 1.
- **Group C:** Task 4 (`register_repo`). Needs Tasks 1, 2 and 3. Shares `service.ts` with Task 3.
- **Group D:** Task 5 (`add_repo_to_workspace`). Needs Tasks 3 and 4. Shares `tools.ts` and `tools.test.ts` with Task 4.
- **Group E:** Task 8 (full verification). Needs all.

The `workspace.repo_added` event type is folded into Task 3, because Task 3 is its only producer and its test needs it.

---

### Task 1: Segment rule, folder helper, and `createWorkspace` refactor

**Files:**
- Modify: `sidecar/src/workspaces/service.ts` (add helpers after `primaryClonePath`, `service.ts:245-248`; replace the folder rule in `createWorkspace`, `service.ts:411-416` and `443-447`)
- Test: `sidecar/src/workspaces/service.test.ts` (imports at `:3-9`; new `describe` blocks at the end)
- Test: `sidecar/src/workspaces/routes.test.ts` (imports at `:30-44`; new `describe` after "provision + archive (injected git runner)", which starts at `:1229`)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export function isSafePathSegment(value: string): boolean`
  - `export function workspaceRepoFolder(repo: Pick<Repo, "name" | "owner">, inUse: ReadonlySet<string>): string` — throws `Error` when both names are in use or the result fails the segment rule.

- [ ] **Step 1: Write the failing unit tests**

Add `isSafePathSegment` and `workspaceRepoFolder` to the import list in `service.test.ts:3-9`, then append:

```ts
describe("isSafePathSegment", () => {
  it("accepts a plain folder name", () => {
    expect(isSafePathSegment("widget")).toBe(true);
  });

  it("refuses empty, dot and dot-dot", () => {
    for (const bad of ["", ".", ".."]) expect(isSafePathSegment(bad)).toBe(false);
  });

  it("refuses a slash or a backslash", () => {
    for (const bad of ["a/b", "a\\b", "/", "\\"]) expect(isSafePathSegment(bad)).toBe(false);
  });
});

describe("workspaceRepoFolder", () => {
  const repo = { name: "Widget", owner: "Acme" };

  it("uses the lowercased display name when free", () => {
    expect(workspaceRepoFolder(repo, new Set())).toBe("widget");
  });

  it("falls back to name-owner when the name is taken", () => {
    expect(workspaceRepoFolder(repo, new Set(["widget"]))).toBe("widget-acme");
  });

  it("refuses when both names are taken", () => {
    expect(() => workspaceRepoFolder(repo, new Set(["widget", "widget-acme"]))).toThrow(
      "both in use",
    );
  });

  it("refuses an unsafe folder name", () => {
    for (const name of ["..", ".", "a/b", "a\\b"]) {
      expect(() => workspaceRepoFolder({ name, owner: "acme" }, new Set())).toThrow(
        "unsafe folder name",
      );
    }
  });
});
```

- [ ] **Step 2: Write the failing `createWorkspace` tests**

In `routes.test.ts`, add `createRepo` to the `./service.ts` import (`:30-44`). Append a new block after the "provision + archive (injected git runner)" block:

```ts
describe("createWorkspace repo folders", () => {
  it("gives both repos in a clashing pair name-owner", async () => {
    const db = getDb(url).db;
    const a = await createRepo(db, config, { cloneUrl: "git@github.com:acme/widget.git" });
    const b = await createRepo(db, config, { cloneUrl: "git@github.com:other/widget.git" });
    const ws = await createWorkspace(db, config, { name: "pair", repoIds: [a.id, b.id] });
    const detail = await getWorkspace(db, ws.id);
    const folders = detail!.repos.map((wr) => basename(wr.worktreePath)).sort();
    expect(folders).toEqual(["widget-acme", "widget-other"]);
  });

  it("refuses a pair whose name-owner also clashes", async () => {
    const db = getDb(url).db;
    // Same owner, same display name: both would land in "api-acme".
    const a = await createRepo(db, config, { cloneUrl: "git@github.com:acme/api.git" });
    const b = await createRepo(db, config, {
      cloneUrl: "git@github.com:acme/api-v2.git",
      name: "api",
    });
    await expect(
      createWorkspace(db, config, { name: "clash", repoIds: [a.id, b.id] }),
    ).rejects.toThrow("both in use");
  });

  it("refuses a display name that is not a safe folder", async () => {
    const db = getDb(url).db;
    const repo = await createRepo(db, config, {
      cloneUrl: "git@github.com:acme/widget.git",
      name: "..",
    });
    await expect(
      createWorkspace(db, config, { name: "escape", repoIds: [repo.id] }),
    ).rejects.toThrow("unsafe folder name");
  });
});
```

- [ ] **Step 3: Run the tests and see them fail**

```bash
mise exec -- bun run --cwd sidecar test src/workspaces/service.test.ts
TEST_DATABASE_URL=postgres://localhost:5432/yarvis_test \
  mise exec -- bun run --cwd sidecar test src/workspaces/routes.test.ts -t "createWorkspace repo folders"
```

Expected: `service.test.ts` fails with an export error for `isSafePathSegment`. The second and third `routes.test.ts` cases fail (no refusal today). The first passes already, which pins the current behaviour.

- [ ] **Step 4: Implement the helpers**

In `service.ts`, after `primaryClonePath` (`:245-248`):

```ts
/**
 * Whether a value can be one path segment under a workspace root. A display
 * name or a parsed owner/repo ends up in a worktree path, so anything that
 * could climb out of the root or split into two segments is refused.
 */
export function isSafePathSegment(value: string): boolean {
  return value !== "" && value !== "." && value !== ".." && !/[/\\]/.test(value);
}

/**
 * The folder a repo's worktree gets inside a workspace. `inUse` holds folders
 * a sibling already has or claims; existing folders cannot move, so only the
 * repo being placed falls back to `name-owner`, and a second clash is refused
 * rather than putting two repos in one folder.
 */
export function workspaceRepoFolder(
  repo: Pick<Repo, "name" | "owner">,
  inUse: ReadonlySet<string>,
): string {
  const plain = repo.name.toLowerCase();
  const withOwner = `${plain}-${repo.owner.toLowerCase()}`;
  const folder = !inUse.has(plain) ? plain : !inUse.has(withOwner) ? withOwner : null;
  if (folder === null) {
    throw new Error(`folders "${plain}" and "${withOwner}" are both in use in this workspace`);
  }
  if (!isSafePathSegment(folder)) {
    throw new Error(`unsafe folder name for ${repo.owner}/${repo.name}: "${folder}"`);
  }
  return folder;
}
```

- [ ] **Step 5: Use the helper in `createWorkspace`**

Replace the `nameCounts` block (`service.ts:411-416`) with a folder map computed before the transaction. Each repo sees the other repos' names as in use, which keeps today's "both get name-owner" result. It also sees the folders already chosen, so two repos can never share one:

```ts
  // Distinct subfolder per repo. Each repo treats its siblings' names, and the
  // folders already handed out, as taken.
  const folders = new Map<string, string>();
  for (const repo of selected) {
    const inUse = new Set<string>(folders.values());
    for (const other of selected) {
      if (other.id !== repo.id) inUse.add(other.name.toLowerCase());
    }
    folders.set(repo.id, workspaceRepoFolder(repo, inUse));
  }
```

Replace the `worktreePath` expression (`service.ts:443-447`) with:

```ts
            worktreePath: `${rootPath}/${folders.get(repo.id)}`,
```

- [ ] **Step 6: Run the tests and see them pass**

Run the two commands from Step 3. Expected: all pass. Then run the whole `routes.test.ts` and `tools.test.ts` to catch a folder regression:

```bash
TEST_DATABASE_URL=postgres://localhost:5432/yarvis_test \
  mise exec -- bun run --cwd sidecar test src/workspaces/routes.test.ts src/workspaces/tools.test.ts
```

Expected: 0 fail.

- [ ] **Step 7: Commit**

```bash
git add sidecar/src/workspaces/service.ts sidecar/src/workspaces/service.test.ts sidecar/src/workspaces/routes.test.ts
mise exec -- git commit -m "refactor: share the workspace repo folder rule" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `remoteExists`

**Files:**
- Modify: `sidecar/src/workspaces/git.ts` (constant beside `NETWORK_TIMEOUT_MS`, `git.ts:31`; function after `ensurePrimaryClone`, `git.ts:63-71`)
- Test: `sidecar/src/workspaces/git.test.ts` (import list `:7-29`; new `describe` after `fetchBranch`, `:319-325`)

**Interfaces:**
- Consumes: the private `git()` helper (`git.ts:49-60`).
- Produces: `export async function remoteExists(runner: GitRunner, cloneUrl: string): Promise<void>` — resolves when the remote answers, throws `Error` with git's stderr otherwise. The caller must run `assertSafeCloneUrl` first.

- [ ] **Step 1: Write the failing tests**

Add `remoteExists` to the import list, then:

```ts
describe("remoteExists", () => {
  it("runs exactly ls-remote <url> with a 30-second timeout", async () => {
    const calls: { args: string[]; timeoutMs?: number }[] = [];
    const runner: GitRunner = async (args, opts) => {
      calls.push({ args, timeoutMs: opts.timeoutMs });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await remoteExists(runner, "git@github.com:acme/widget.git");
    expect(calls).toEqual([
      { args: ["ls-remote", "git@github.com:acme/widget.git"], timeoutMs: 30_000 },
    ]);
  });

  it("resolves for an empty repo with no refs", async () => {
    const { runner } = fakeRunner(() => ({ stdout: "" }));
    await expect(remoteExists(runner, "https://github.com/acme/empty.git")).resolves.toBeUndefined();
  });

  it("throws with git's stderr on failure", async () => {
    const { runner } = fakeRunner(() => ({
      exitCode: 128,
      stderr: "ERROR: Repository not found.",
    }));
    await expect(remoteExists(runner, "git@github.com:acme/nope.git")).rejects.toThrow(
      "Repository not found",
    );
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

```bash
mise exec -- bun run --cwd sidecar test src/workspaces/git.test.ts -t remoteExists
```

Expected: FAIL, `remoteExists` is not exported.

- [ ] **Step 3: Implement**

Beside `NETWORK_TIMEOUT_MS` (`git.ts:31`):

```ts
/** A reachability check answers in seconds or not at all; an SSH prompt with
 *  no terminal to answer it would otherwise hold the chat turn for minutes. */
const REMOTE_CHECK_TIMEOUT_MS = 30 * 1000;
```

After `ensurePrimaryClone`:

```ts
/**
 * Resolves when the remote answers `ls-remote`, so a repo can be registered
 * only once it is known to exist and be reachable. No `--exit-code` or ref
 * pattern: an empty repo has no HEAD yet and still counts as found. Throws
 * with git's stderr, which is what tells "not found" from "no access". The
 * URL must already have passed `assertSafeCloneUrl`.
 */
export async function remoteExists(runner: GitRunner, cloneUrl: string): Promise<void> {
  await git(runner, ["ls-remote", cloneUrl], undefined, REMOTE_CHECK_TIMEOUT_MS);
}
```

- [ ] **Step 4: Run the tests and see them pass**

Same command as Step 2. Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/workspaces/git.ts sidecar/src/workspaces/git.test.ts
mise exec -- git commit -m "feat: add a remote reachability check for repo registration" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `addRepoToWorkspace` and the `workspace.repo_added` event

**Files:**
- Modify: `sidecar/src/events/service.ts:60` (add the type after `"workspace.created"`)
- Modify: `sidecar/src/workspaces/service.ts` (import `basename` at `:8`; add `isUniqueViolation` near `assertSafeCloneUrl`, `:215-227`; add `addRepoToWorkspace` after `createWorkspace`, `:474`)
- Test: `sidecar/src/workspaces/routes.test.ts` (new `describe` after Task 1's block)

**Interfaces:**
- Consumes: `workspaceRepoFolder` (Task 1); `getWorkspace` (`service.ts:556`); `getRepo` (`service.ts:275`); the `provisioning` map (`service.ts:1176`).
- Produces:
  - `export function isUniqueViolation(error: unknown): boolean`
  - `export async function addRepoToWorkspace(db: Db, workspaceId: string, repoId: string): Promise<WorkspaceRepo>` — throws `Error` with these messages: `"workspace not found"`, `"cannot add a repo to a workspace that is <status>"`, `"provisioning is still running for this workspace"`, `"repo not found"`, `"<repo name> is already in this workspace"`, or a folder-helper message.
  - Event type `"workspace.repo_added"` with payload `{ workspaceId, name, repo: "<owner>/<display name>" }`.

- [ ] **Step 1: Write the failing tests**

In `routes.test.ts`, add `addRepoToWorkspace` to the `./service.ts` import and `import { listEvents } from "../events/service.ts";`. Append:

```ts
/** The event is fire-and-forget (`void emitEvent`), so poll briefly for it. */
async function repoAddedEvents(workspaceId: string) {
  for (let i = 0; i < 40; i++) {
    const rows = await listEvents(getDb(url).db, { type: "workspace.repo_added" });
    const hits = rows.filter(
      (r) => (r.payload as { workspaceId?: string }).workspaceId === workspaceId,
    );
    if (hits.length) return hits;
    await Bun.sleep(25);
  }
  return [];
}

/** A provisioned, active workspace holding the given repos. */
async function activeWith(name: string, cloneUrls: string[]) {
  const db = getDb(url).db;
  const ids = [];
  for (const cloneUrl of cloneUrls) ids.push((await createRepo(db, config, { cloneUrl })).id);
  const ws = await createWorkspace(db, config, { name, repoIds: ids });
  await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });
  return ws;
}

describe("addRepoToWorkspace", () => {
  it("adds a pending row on the workspace branch", async () => {
    const db = getDb(url).db;
    const ws = await activeWith("feature", ["git@github.com:acme/widget.git"]);
    const repo = await createRepo(db, config, { cloneUrl: "git@github.com:acme/gadget.git" });

    const row = await addRepoToWorkspace(db, ws.id, repo.id);

    expect(row).toMatchObject({
      workspaceId: ws.id,
      repoId: repo.id,
      status: "pending",
      branch: `yarvis/${ws.slug}`,
      baseBranch: "main",
      existingBranch: false,
      worktreePath: `${ws.rootPath}/gadget`,
    });
    const events = await repoAddedEvents(ws.id);
    expect(events[0]?.payload).toMatchObject({ workspaceId: ws.id, repo: "acme/gadget" });
  });

  it("uses name-owner when the folder is taken", async () => {
    const db = getDb(url).db;
    const ws = await activeWith("clash", ["git@github.com:acme/widget.git"]);
    const repo = await createRepo(db, config, { cloneUrl: "git@github.com:other/widget.git" });
    const row = await addRepoToWorkspace(db, ws.id, repo.id);
    expect(basename(row.worktreePath)).toBe("widget-other");
  });

  it("refuses when both folder names are taken", async () => {
    const db = getDb(url).db;
    const ws = await activeWith("full", ["git@github.com:acme/widget.git"]);
    const squatter = await createRepo(db, config, {
      cloneUrl: "git@github.com:zeta/thing.git",
      name: "widget-other",
    });
    await addRepoToWorkspace(db, ws.id, squatter.id);
    const repo = await createRepo(db, config, { cloneUrl: "git@github.com:other/widget.git" });
    await expect(addRepoToWorkspace(db, ws.id, repo.id)).rejects.toThrow("both in use");
  });

  it("accepts a repo in a scratch workspace", async () => {
    const db = getDb(url).db;
    const ws = await activeWith("scratch", []);
    const repo = await createRepo(db, config, { cloneUrl: "git@github.com:acme/widget.git" });
    const row = await addRepoToWorkspace(db, ws.id, repo.id);
    expect(row.worktreePath).toBe(`${ws.rootPath}/widget`);
  });

  it("refuses an unknown workspace", async () => {
    const db = getDb(url).db;
    const repo = await createRepo(db, config, { cloneUrl: "git@github.com:acme/widget.git" });
    await expect(
      addRepoToWorkspace(db, "00000000-0000-0000-0000-000000000000", repo.id),
    ).rejects.toThrow("workspace not found");
  });

  it("refuses a workspace that is not active or error", async () => {
    const db = getDb(url).db;
    const repo = await createRepo(db, config, { cloneUrl: "git@github.com:acme/widget.git" });
    const ws = await createWorkspace(db, config, { name: "creating", repoIds: [] });
    await expect(addRepoToWorkspace(db, ws.id, repo.id)).rejects.toThrow(
      "workspace that is creating",
    );
  });

  it("refuses while a provision is running", async () => {
    const db = getDb(url).db;
    const first = await createRepo(db, config, { cloneUrl: "git@github.com:acme/widget.git" });
    const ws = await createWorkspace(db, config, { name: "busy", repoIds: [first.id] });
    const failGit: GitRunner = async (args, opts) =>
      args[0] === "worktree" && args[1] === "add"
        ? { stdout: "", stderr: "boom", exitCode: 1 }
        : fakeGit(args, opts);
    await provisionWorkspace(db, ws.id, () => {}, { runner: failGit }); // -> error

    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const slowGit: GitRunner = async (args, opts) => {
      if (args[0] === "worktree" && args[1] === "add") await gate;
      return fakeGit(args, opts);
    };
    const retry = provisionWorkspace(db, ws.id, () => {}, { runner: slowGit });
    await Bun.sleep(50);

    const repo = await createRepo(db, config, { cloneUrl: "git@github.com:acme/gadget.git" });
    await expect(addRepoToWorkspace(db, ws.id, repo.id)).rejects.toThrow(
      "provisioning is still running",
    );
    release();
    await retry;
  });

  it("refuses an unknown repo", async () => {
    const db = getDb(url).db;
    const ws = await activeWith("norepo", []);
    await expect(
      addRepoToWorkspace(db, ws.id, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow("repo not found");
  });

  it("refuses a repo already in the workspace", async () => {
    const db = getDb(url).db;
    const ws = await activeWith("dupe", ["git@github.com:acme/widget.git"]);
    const detail = await getWorkspace(db, ws.id);
    await expect(addRepoToWorkspace(db, ws.id, detail!.repos[0]!.repoId)).rejects.toThrow(
      "already in this workspace",
    );
  });

  // Review Focus: both calls pass the read; the unique index decides.
  it("turns a concurrent double add into the same refusal", async () => {
    const db = getDb(url).db;
    const ws = await activeWith("race", []);
    const repo = await createRepo(db, config, { cloneUrl: "git@github.com:acme/widget.git" });
    const results = await Promise.allSettled([
      addRepoToWorkspace(db, ws.id, repo.id),
      addRepoToWorkspace(db, ws.id, repo.id),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain(
      "already in this workspace",
    );
  });
});
```

The race test passes whichever way the two calls interleave: the loser fails either on the pre-check or on the unique index, and both give the same message.

- [ ] **Step 2: Run the tests and see them fail**

```bash
TEST_DATABASE_URL=postgres://localhost:5432/yarvis_test \
  mise exec -- bun run --cwd sidecar test src/workspaces/routes.test.ts -t "addRepoToWorkspace"
```

Expected: FAIL, `addRepoToWorkspace` is not exported.

- [ ] **Step 3: Add the event type**

In `sidecar/src/events/service.ts`, after `"workspace.created",` (`:60`):

```ts
  "workspace.repo_added",
```

- [ ] **Step 4: Implement `isUniqueViolation` and `addRepoToWorkspace`**

In `service.ts`, change `import { relative } from "node:path";` (`:8`) to `import { basename, relative } from "node:path";`. Near `assertSafeCloneUrl`:

```ts
/**
 * Whether a thrown value is Postgres's unique-violation. Drizzle wraps the
 * driver error, so the code is on a `cause` rather than on what is caught.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth++) {
    if (typeof current === "object" && (current as { code?: unknown }).code === "23505") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
```

(This copies `jobs/routes.ts:44-52`. Leave that one alone; moving it is outside this change.)

After `createWorkspace`:

```ts
/**
 * Adds a registered repo to an existing workspace as a `pending` row. Does not
 * provision: the caller runs `provisionWorkspace`, which skips the repos that
 * are already ready and rewrites the workspace files. Refused mid-provision
 * because a run in flight works from a snapshot taken before this row existed.
 */
export async function addRepoToWorkspace(
  db: Db,
  workspaceId: string,
  repoId: string,
): Promise<WorkspaceRepo> {
  const detail = await getWorkspace(db, workspaceId);
  if (!detail) throw new Error("workspace not found");
  if (detail.status !== "active" && detail.status !== "error") {
    throw new Error(`cannot add a repo to a workspace that is ${detail.status}`);
  }
  if (provisioning.has(workspaceId)) {
    throw new Error("provisioning is still running for this workspace");
  }
  const repo = await getRepo(db, repoId);
  if (!repo) throw new Error("repo not found");
  const alreadyIn = `${repo.name} is already in this workspace`;
  if (detail.repos.some((wr) => wr.repoId === repoId)) throw new Error(alreadyIn);

  const inUse = new Set(detail.repos.map((wr) => basename(wr.worktreePath)));
  const folder = workspaceRepoFolder(repo, inUse);

  let row: WorkspaceRepo | undefined;
  try {
    [row] = await db
      .insert(workspaceRepos)
      .values({
        workspaceId,
        repoId,
        branch: `yarvis/${detail.slug}`,
        baseBranch: repo.defaultBranch ?? "main",
        worktreePath: `${detail.rootPath}/${folder}`,
      })
      .returning();
  } catch (e) {
    if (isUniqueViolation(e)) throw new Error(alreadyIn);
    throw e;
  }

  void emitEvent(db, {
    type: "workspace.repo_added",
    source: "workspaces",
    payload: { workspaceId, name: detail.name, repo: `${repo.owner}/${repo.name}` },
  });
  return row!;
}
```

`provisioning` is declared at `service.ts:1176`, below this function. That is fine: it is a module-level `const` read at call time, not at load time.

- [ ] **Step 5: Run the tests and see them pass**

Same command as Step 2. Expected: 10 pass.

- [ ] **Step 6: Commit**

```bash
git add sidecar/src/events/service.ts sidecar/src/workspaces/service.ts sidecar/src/workspaces/routes.test.ts
mise exec -- git commit -m "feat: add a repo to an existing workspace" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `register_repo` tool

**Files:**
- Modify: `sidecar/src/workspaces/service.ts` (add `findRegisteredRepo` after `listRepos`, `:271-273`; export `errorText`, `:908`)
- Modify: `sidecar/src/workspaces/tools.ts` (imports `:25-37`; `list_repos` description `:212-213`; new tool after `list_repos`, `:219`; `create_workspace_session` description `:360`)
- Test: `sidecar/src/workspaces/tools.test.ts` (imports `:15-17`; new `describe` after the main block)

**Interfaces:**
- Consumes: `isSafePathSegment` (Task 1), `remoteExists` (Task 2), `isUniqueViolation` (Task 3), `assertSafeCloneUrl`, `parseGitUrl`, `createRepo`.
- Produces:
  - `export async function findRegisteredRepo(db: Db, cloneUrl: string): Promise<Repo | null>`
  - `export function errorText(e: unknown): string` (was private)
  - Tool `register_repo({ repo: string })` returning `{ id, name, owner, repo, cloneUrl, alreadyRegistered, note }` or `{ error }`.

- [ ] **Step 1: Write the failing tests**

In `tools.test.ts`, change the `./service.ts` import (`:16`) to also bring in `listRepos`. Append:

```ts
/** Records every git call, and answers ls-remote as told. */
function remoteRunner(lsRemote: () => Promise<{ stdout: string; stderr: string; exitCode: number }>) {
  const calls: string[][] = [];
  const runner: GitRunner = async (args, runOpts) => {
    calls.push(args);
    if (args[0] === "ls-remote") return lsRemote();
    return okRunner(args, runOpts);
  };
  return { runner, calls };
}
const reachable = async () => ({ stdout: "", stderr: "", exitCode: 0 });

type RegisterResult = {
  error?: string;
  id?: string;
  cloneUrl?: string;
  alreadyRegistered?: boolean;
  note?: string;
};

describe("register_repo", () => {
  const register = (runner: GitRunner, repo: string) =>
    buildWorkspaceTools(db, config, { gitRunner: runner }).register_repo.execute!(
      { repo },
      opts,
    ) as Promise<RegisterResult>;

  it("builds the SSH URL from owner/repo", async () => {
    const { runner, calls } = remoteRunner(reachable);
    const result = await register(runner, "acme/widget");
    expect(result).toMatchObject({
      cloneUrl: "git@github.com:acme/widget.git",
      alreadyRegistered: false,
    });
    expect(result.note).toContain("Settings");
    expect(calls).toContainEqual(["ls-remote", "git@github.com:acme/widget.git"]);
  });

  // Review Focus: one trailing .git in the shorthand is not part of the name.
  it("drops a trailing .git from the shorthand", async () => {
    const { runner } = remoteRunner(reachable);
    const result = await register(runner, "acme/widget.git");
    expect(result.cloneUrl).toBe("git@github.com:acme/widget.git");
  });

  it("refuses . or .. in the shorthand", async () => {
    const { runner, calls } = remoteRunner(reachable);
    for (const bad of ["../widget", "acme/..", "./x"]) {
      const result = await register(runner, bad);
      expect(result.error).toContain("unsafe owner or repo name");
    }
    expect(calls).toHaveLength(0);
    expect(await listRepos(db)).toHaveLength(0);
  });

  it("refuses a full URL whose owner or repo is . or ..", async () => {
    const { runner, calls } = remoteRunner(reachable);
    for (const bad of ["git@evil.example:../widget.git", "https://evil.example/acme/.."]) {
      const result = await register(runner, bad);
      expect(result.error).toContain("unsafe owner or repo name");
    }
    expect(calls).toHaveLength(0);
    expect(await listRepos(db)).toHaveLength(0);
  });

  it("uses a clone URL as given", async () => {
    const { runner } = remoteRunner(reachable);
    const result = await register(runner, "  https://gitlab.example/team/tool.git ");
    expect(result.cloneUrl).toBe("https://gitlab.example/team/tool.git");
  });

  it("refuses an unsafe transport", async () => {
    const { runner, calls } = remoteRunner(reachable);
    const result = await register(runner, "ext::sh -c touch% /tmp/pwned");
    expect(result.error).toContain("unsupported clone URL transport");
    expect(calls).toHaveLength(0);
  });

  it("finds a github.com repo under another URL form", async () => {
    const existing = await createRepo(db, config, { cloneUrl: "git@github.com:Acme/Widget.git" });
    const { runner, calls } = remoteRunner(reachable);
    const result = await register(runner, "https://github.com/acme/widget");
    expect(result).toMatchObject({ id: existing.id, alreadyRegistered: true });
    expect(calls).toHaveLength(0);
  });

  it("matches another host only on the exact trimmed URL", async () => {
    await createRepo(db, config, { cloneUrl: "https://gitlab.example/team/tool.git" });
    const { runner } = remoteRunner(reachable);
    const same = await register(runner, " https://gitlab.example/team/tool.git ");
    expect(same.alreadyRegistered).toBe(true);
    // The same owner/repo under another URL is not a lookup match; the unique
    // index (exact owner and repo) still refuses it, by name.
    const other = await register(runner, "https://gitlab.example/team/tool");
    expect(other.error).toContain("already registered: tool");
    expect(await listRepos(db)).toHaveLength(1);
  });

  it("registers nothing when ls-remote fails", async () => {
    const { runner } = remoteRunner(async () => ({
      stdout: "",
      stderr: "ERROR: Repository not found.",
      exitCode: 128,
    }));
    const result = await register(runner, "acme/nope");
    expect(result.error).toContain("repo not found or no access");
    expect(result.error).toContain("Repository not found");
    expect(await listRepos(db)).toHaveLength(0);
  });

  // Review Focus: a timeout throws rather than exiting non-zero.
  it("registers nothing when ls-remote times out", async () => {
    const { runner } = remoteRunner(async () => {
      throw new Error("command timed out after 30000ms: git ls-remote x");
    });
    const result = await register(runner, "acme/slow");
    expect(result.error).toContain("repo not found or no access");
    expect(await listRepos(db)).toHaveLength(0);
  });

  // Review Focus: a pasted URL's credentials must not reach the model.
  it("strips credentials from the git error", async () => {
    const { runner } = remoteRunner(async () => ({
      stdout: "",
      stderr: "fatal: Authentication failed for 'https://user:ghp_secret@github.com/acme/x.git/'",
      exitCode: 128,
    }));
    const result = await register(runner, "https://user:ghp_secret@github.com/acme/x.git");
    expect(result.error).not.toContain("ghp_secret");
  });

  it("is named in the list_repos and create_workspace_session descriptions", () => {
    const tools = buildWorkspaceTools(db, config, { gitRunner: okRunner });
    expect(tools.list_repos.description).toContain("register_repo");
    expect(tools.create_workspace_session.description).toContain("register_repo");
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

```bash
TEST_DATABASE_URL=postgres://localhost:5432/yarvis_test \
  mise exec -- bun run --cwd sidecar test src/workspaces/tools.test.ts -t "register_repo"
```

Expected: FAIL, `register_repo` is undefined on the tool set.

- [ ] **Step 3: Implement `findRegisteredRepo` and export `errorText`**

In `service.ts`, change `function errorText(` (`:908`) to `export function errorText(`. After `listRepos` (`:271-273`):

```ts
/** Whether a clone URL points at github.com, read the way `splitRemote` reads hosts. */
function isGitHubCloneUrl(url: string): boolean {
  return splitRemote(url)?.host.toLowerCase() === "github.com";
}

/**
 * The registered repo a clone URL names, if any. On github.com an SSH and an
 * HTTPS URL for one repo are the same repo, so owner/repo decides,
 * case-insensitively. Elsewhere only the exact (trimmed) URL does:
 * `parseGitUrl` reads the last two path segments, so every Azure DevOps URL
 * parses to owner `_git`, and owner/repo would match the wrong repo.
 */
export async function findRegisteredRepo(db: Db, cloneUrl: string): Promise<Repo | null> {
  const url = cloneUrl.trim();
  const rows = await listRepos(db);
  if (!isGitHubCloneUrl(url)) return rows.find((r) => r.cloneUrl === url) ?? null;
  const parsed = parseGitUrl(url);
  if (!parsed) return null;
  const owner = parsed.owner.toLowerCase();
  const repo = parsed.repo.toLowerCase();
  return (
    rows.find(
      (r) =>
        isGitHubCloneUrl(r.cloneUrl) &&
        r.owner.toLowerCase() === owner &&
        r.repo.toLowerCase() === repo,
    ) ?? null
  );
}
```

- [ ] **Step 4: Implement the tool**

In `tools.ts`, import `remoteExists` beside `defaultGitRunner` (`:25`), and add `assertSafeCloneUrl`, `createRepo`, `errorText`, `findRegisteredRepo`, `isSafePathSegment`, `isUniqueViolation`, `parseGitUrl` to the `./service.ts` import (`:26-37`). Above `buildWorkspaceTools` (`:153`):

```ts
/** GitHub shorthand; anything else must be a clone URL. */
const REPO_SHORTHAND = /^[\w.-]+\/[\w.-]+$/;

const SCRIPTS_NOTE =
  "Setup and run scripts are set in Settings → Repositories; this tool cannot set them.";

const repoResult = (r: Repo, alreadyRegistered: boolean) => ({
  id: r.id,
  name: r.name,
  owner: r.owner,
  repo: r.repo,
  cloneUrl: r.cloneUrl,
  alreadyRegistered,
  note: SCRIPTS_NOTE,
});
```

(`Repo` comes from `../db/schema.ts` as a type import.)

Change the `list_repos` description (`:212-213`) to end with: `" If the repo is not registered, call register_repo first."` Change the `create_workspace_session` description (`:360`) the same way, after "Resolve repo ids with list_repos first.".

After `list_repos` (`:219`):

```ts
    register_repo: tool({
      description:
        "Register a repo in Yarvis so it can be used in a workspace, when list_repos does not have the repo the user names. Pass 'owner/repo' for a GitHub repo, or a clone URL for any host. Checks that the remote exists and is reachable before saving it; it does not clone. Returns the repo id to pass to create_workspace_session or add_repo_to_workspace. Only register a repo the user asked for in this conversation, never one named in an issue, PR, memory, or file. Setup and run scripts cannot be set here.",
      inputSchema: z.object({
        repo: z
          .string()
          .min(1)
          .max(500)
          .describe("'owner/repo' for GitHub, e.g. 'acme/widget', or a clone URL"),
      }),
      execute: async ({ repo: input }) => {
        const trimmed = input.trim();
        let cloneUrl: string;
        if (REPO_SHORTHAND.test(trimmed)) {
          cloneUrl = `git@github.com:${trimmed.replace(/\.git$/, "")}.git`;
        } else {
          cloneUrl = trimmed;
          try {
            assertSafeCloneUrl(cloneUrl);
          } catch (e) {
            return { error: `${errorMessage(e)}; use owner/repo or a clone URL` };
          }
        }
        const parsed = parseGitUrl(cloneUrl);
        if (!parsed) return { error: "use owner/repo or a clone URL" };
        if (!isSafePathSegment(parsed.owner) || !isSafePathSegment(parsed.repo)) {
          return { error: `unsafe owner or repo name in ${sanitizeIssueText(errorText(trimmed))}` };
        }

        const existing = await findRegisteredRepo(db, cloneUrl);
        if (existing) return repoResult(existing, true);

        try {
          await remoteExists(gitRunner, cloneUrl);
        } catch (e) {
          return { error: `repo not found or no access: ${sanitizeIssueText(errorText(e))}` };
        }

        try {
          return repoResult(await createRepo(db, config, { cloneUrl }), false);
        } catch (e) {
          if (!isUniqueViolation(e)) return { error: sanitizeIssueText(errorText(e)) };
          const clash = (await listRepos(db)).find(
            (r) => r.owner === parsed.owner && r.repo === parsed.repo,
          );
          return {
            error: `a repo with the same owner and repo is already registered: ${clash?.name ?? `${parsed.owner}/${parsed.repo}`}`,
          };
        }
      },
    }),
```

Note on the unique-clash lookup: `repos_owner_repo_idx` (`schema.ts:565`) compares exactly, so the clash row has the exact parsed owner and repo.

- [ ] **Step 5: Run the tests and see them pass**

Same command as Step 2. Expected: 12 pass. Then the whole file:

```bash
TEST_DATABASE_URL=postgres://localhost:5432/yarvis_test \
  mise exec -- bun run --cwd sidecar test src/workspaces/tools.test.ts
```

Expected: 0 fail.

- [ ] **Step 6: Commit**

```bash
git add sidecar/src/workspaces/service.ts sidecar/src/workspaces/tools.ts sidecar/src/workspaces/tools.test.ts
mise exec -- git commit -m "feat: let the assistant register a repo" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `add_repo_to_workspace` tool and the confirm set

**Files:**
- Modify: `sidecar/src/workspaces/tools.ts` (import `addRepoToWorkspace`; new tool after `start_workspace_session`, `:483-503`)
- Modify: `sidecar/src/chat/destructiveTools.ts:31-57` (add the name)
- Create: `sidecar/src/chat/destructiveTools.test.ts`
- Test: `sidecar/src/workspaces/tools.test.ts`

**Interfaces:**
- Consumes: `addRepoToWorkspace` (Task 3), `provisionWorkspace`, `getWorkspace`, `AGENT_KICKOFF_INSTRUCTION` (test only).
- Produces: tool `add_repo_to_workspace({ workspaceId: uuid, repoId: uuid })` returning `{ workspaceId, name, status, repo: { name, worktreePath, branch, status, error }, retried: { repo, status, error }[], kickOffStarted, note }`, or the same plus `error` and `failures: { repo, message }[]` on a provisioning failure, or `{ error, workspaceId }` on a refusal.

- [ ] **Step 1: Write the failing tool tests**

In `tools.test.ts`, add `import { mkdirSync } from "node:fs";` to the `node:fs` import (`:2`). Append:

```ts
/** okRunner, but creates the worktree folder as real git does, so the
 *  workspace root exists and AGENTS.md can be written into it. */
const dirRunner: GitRunner = async (args, runOpts) => {
  if (args[0] === "worktree" && args[1] === "add") {
    const path = args[2] === "-b" ? args[4] : args[2];
    if (path) mkdirSync(path, { recursive: true });
  }
  return okRunner(args, runOpts);
};

/** Fails only the clone of the given repo name. */
const failCloneOf =
  (name: string): GitRunner =>
  async (args, runOpts) =>
    args[0] === "clone" && (args[1] ?? "").includes(name)
      ? { stdout: "", stderr: "fatal: could not read from remote", exitCode: 128 }
      : dirRunner(args, runOpts);

type AddResult = {
  error?: string;
  status?: string;
  repo?: { name: string; worktreePath: string; branch: string; status: string };
  retried?: { repo: string; status: string }[];
  failures?: { repo: string; message: string }[];
  kickOffStarted?: boolean;
  note?: string;
};

describe("add_repo_to_workspace", () => {
  const started: StartClaudeSessionInput[] = [];
  const toolsWith = (runner: GitRunner) =>
    buildWorkspaceTools(db, config, {
      gitRunner: runner,
      startClaudeSession: async (input) => {
        started.push(input);
        return { sessionKey: `ws-claude:${input.workspaceId}` };
      },
    });
  const add = (runner: GitRunner, workspaceId: string, repoId: string) =>
    toolsWith(runner).add_repo_to_workspace.execute!(
      { workspaceId, repoId },
      opts,
    ) as Promise<AddResult>;

  beforeEach(() => {
    started.length = 0;
  });

  async function workspaceWith(cloneUrl: string, runner: GitRunner, brief?: string) {
    const repo = await createRepo(db, config, { cloneUrl });
    const created = (await toolsWith(runner).create_workspace_session.execute!(
      { name: `ws ${repo.repo}`, repoIds: [repo.id], brief, startWork: true },
      opts,
    )) as { workspaceId: string };
    return created.workspaceId;
  }

  it("provisions only the new repo and lists it in AGENTS.md", async () => {
    const workspaceId = await workspaceWith("https://github.com/acme/widget.git", dirRunner);
    const gadget = await createRepo(db, config, { cloneUrl: "https://github.com/acme/gadget.git" });
    const calls: string[][] = [];
    const recording: GitRunner = async (args, runOpts) => {
      calls.push(args);
      return dirRunner(args, runOpts);
    };

    const result = await add(recording, workspaceId, gadget.id);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("active");
    expect(result.repo).toMatchObject({ name: "gadget", status: "ready" });
    expect(result.kickOffStarted).toBe(false);
    expect(result.note).toContain("send_workspace_instruction");
    const worktreeAdds = calls.filter((a) => a[0] === "worktree" && a[1] === "add");
    expect(worktreeAdds).toHaveLength(1);
    expect(worktreeAdds[0]!.join(" ")).toContain("/gadget");
    const detail = await getWorkspace(db, workspaceId);
    const agents = readFileSync(join(detail!.rootPath, "AGENTS.md"), "utf8");
    expect(agents).toContain("acme/gadget");
  });

  it("retries the other failed repos in an error workspace", async () => {
    const workspaceId = await workspaceWith(
      "https://github.com/acme/widget.git",
      failCloneOf("widget"),
    );
    expect((await getWorkspace(db, workspaceId))?.status).toBe("error");
    const gadget = await createRepo(db, config, { cloneUrl: "https://github.com/acme/gadget.git" });

    const result = await add(dirRunner, workspaceId, gadget.id);

    expect(result.status).toBe("active");
    expect(result.retried).toEqual([expect.objectContaining({ repo: "widget", status: "ready" })]);
  });

  it("starts an owed kick-off and says so", async () => {
    const workspaceId = await workspaceWith(
      "https://github.com/acme/widget.git",
      failCloneOf("widget"),
      "Add rate limiting",
    );
    expect((await getWorkspace(db, workspaceId))?.pendingBrief).not.toBeNull();
    expect(started).toHaveLength(0);
    const gadget = await createRepo(db, config, { cloneUrl: "https://github.com/acme/gadget.git" });

    const result = await add(dirRunner, workspaceId, gadget.id);

    expect(result.kickOffStarted).toBe(true);
    expect(started).toHaveLength(1);
    expect(started[0]!.instruction).toBe(AGENT_KICKOFF_INSTRUCTION);
  });

  // Review Focus: the new repo itself fails.
  it("reports a failed provision of the new repo", async () => {
    const workspaceId = await workspaceWith("https://github.com/acme/widget.git", dirRunner);
    const gadget = await createRepo(db, config, { cloneUrl: "https://github.com/acme/gadget.git" });

    const result = await add(failCloneOf("gadget"), workspaceId, gadget.id);

    expect(result.error).toBeDefined();
    expect(result.status).toBe("error");
    expect(result.failures).toEqual([expect.objectContaining({ repo: "gadget" })]);
    expect(result.kickOffStarted).toBe(false);
  });

  it("returns a refusal as an error", async () => {
    const gadget = await createRepo(db, config, { cloneUrl: "https://github.com/acme/gadget.git" });
    const result = await add(dirRunner, "00000000-0000-0000-0000-000000000000", gadget.id);
    expect(result.error).toBe("workspace not found");
  });
});
```

- [ ] **Step 2: Write the failing confirm-set test**

Create `sidecar/src/chat/destructiveTools.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { builtinToolMetadata } from "./builtinTools.ts";
import { ALWAYS_CONFIRM_BUILTIN_TOOLS, DESTRUCTIVE_BUILTIN_TOOLS } from "./destructiveTools.ts";

describe("DESTRUCTIVE_BUILTIN_TOOLS", () => {
  // A name in the set that no tool has would confirm nothing.
  it("names tools that exist", () => {
    const names = Object.keys(builtinToolMetadata());
    expect(names).toContain("add_repo_to_workspace");
    expect(names).toContain("register_repo");
  });

  it("asks before adding a repo to a workspace", () => {
    expect(DESTRUCTIVE_BUILTIN_TOOLS.has("add_repo_to_workspace")).toBe(true);
  });

  // It only saves a row after the exists check; no repo code runs.
  it("does not ask before registering a repo", () => {
    expect(DESTRUCTIVE_BUILTIN_TOOLS.has("register_repo")).toBe(false);
    expect(ALWAYS_CONFIRM_BUILTIN_TOOLS.has("register_repo")).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests and see them fail**

```bash
TEST_DATABASE_URL=postgres://localhost:5432/yarvis_test \
  mise exec -- bun run --cwd sidecar test src/workspaces/tools.test.ts -t "add_repo_to_workspace"
mise exec -- bun run --cwd sidecar test src/chat/destructiveTools.test.ts
```

Expected: tool tests fail (tool undefined); confirm-set tests fail on `add_repo_to_workspace`.

- [ ] **Step 4: Implement the tool**

Add `addRepoToWorkspace` to the `./service.ts` import in `tools.ts`. After `start_workspace_session` (`:503`):

```ts
    add_repo_to_workspace: tool({
      description:
        "Add a registered repo to an existing workspace: cut a git worktree for it on the workspace's branch, provision it, and rewrite the workspace's AGENTS.md. Resolve the workspace with list_workspaces and the repo with list_repos; call register_repo first if the repo is not registered. A session already running in the workspace is not told about the repo, so offer to tell it with send_workspace_instruction. In a workspace whose provisioning failed this also retries its other failed repos, and a workspace still owed its kick-off session starts it once every repo is ready; report both from the result.",
      inputSchema: z.object({
        workspaceId: z.string().uuid().describe("Id of an existing workspace, from list_workspaces"),
        repoId: z.string().uuid().describe("Id of a registered repo, from list_repos or register_repo"),
      }),
      execute: async ({ workspaceId, repoId }) => {
        const before = await getWorkspace(db, workspaceId);
        const owedKickOff = Boolean(before?.pendingBrief);
        const failedBefore = new Set(
          (before?.repos ?? []).filter((r) => r.status === "error").map((r) => r.id),
        );

        let addedId: string;
        try {
          addedId = (await addRepoToWorkspace(db, workspaceId, repoId)).id;
        } catch (e) {
          return { error: errorMessage(e), workspaceId };
        }

        await provisionWorkspace(db, workspaceId, () => undefined, {
          runner: gitRunner,
          startSession: startClaude,
          remoteControl,
        });

        const after = await getWorkspace(db, workspaceId);
        if (!after) return { error: "workspace vanished after the repo was added", workspaceId };
        const added = after.repos.find((r) => r.id === addedId);
        const kickOffStarted = owedKickOff && !after.pendingBrief;
        const result = {
          workspaceId,
          name: after.name,
          status: after.status,
          repo: added
            ? {
                name: added.repo.name,
                worktreePath: added.worktreePath,
                branch: added.branch,
                status: added.status,
                error: added.error,
              }
            : null,
          retried: after.repos
            .filter((r) => failedBefore.has(r.id))
            .map((r) => ({ repo: r.repo.name, status: r.status, error: r.error })),
          kickOffStarted,
          note: kickOffStarted
            ? "The workspace's owed kick-off session started on its brief now that every repo is ready."
            : "A session already running here read AGENTS.md when it started and does not know about this repo. Offer to tell it with send_workspace_instruction.",
        };
        if (added?.status !== "ready") {
          const failures = after.repos
            .filter((r) => r.status === "error")
            .map((r) => ({ repo: r.repo.name, message: r.error ?? "unknown error" }));
          return { error: "the repo failed to provision", ...result, failures };
        }
        return result;
      },
    }),
```

- [ ] **Step 5: Add the tool to the confirm set**

In `destructiveTools.ts`, after `"start_workspace_session",` (inside the "Each launches an agent session" group, `:42-45`):

```ts
  // Clones code that an auto-mode agent will read, and can start a kick-off
  // session a failed provision still owed.
  "add_repo_to_workspace",
```

- [ ] **Step 6: Run the tests and see them pass**

Same commands as Step 3. Expected: 5 tool tests pass, 3 confirm-set tests pass. Then:

```bash
TEST_DATABASE_URL=postgres://localhost:5432/yarvis_test \
  mise exec -- bun run --cwd sidecar test src/workspaces/tools.test.ts src/agentTools src/agents src/mcp/chatTools.test.ts
```

Expected: 0 fail. `agentTools/registry.test.ts` checks every built-in has a description over 20 characters.

- [ ] **Step 7: Commit**

```bash
git add sidecar/src/workspaces/tools.ts sidecar/src/workspaces/tools.test.ts sidecar/src/chat/destructiveTools.ts sidecar/src/chat/destructiveTools.test.ts
mise exec -- git commit -m "feat: let the assistant add a repo to a workspace" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: System prompt

**Files:**
- Modify: `sidecar/src/chat/agent.ts:137` and `:157` (inside `systemPrompt()`, `:121-174`)
- Test: `sidecar/src/chat/agent.test.ts` (inside `describe("runAgentTurn")`, `:140`)

**Interfaces:**
- Consumes: tool names `register_repo` and `add_repo_to_workspace` as strings only. No code dependency, so this runs in Group A.
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the failing test**

Inside `describe("runAgentTurn", …)`:

```ts
  it("tells the model how to register and add a repo", async () => {
    const session = await createSession(db, null);
    const model = streamingModel([...text("ok"), finish("stop")]);
    await collect(model, session.id);
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(prompt).toContain("register_repo");
    expect(prompt).toContain("add_repo_to_workspace");
    expect(prompt).toContain("register a repo");
  });
```

- [ ] **Step 2: Run it and see it fail**

```bash
TEST_DATABASE_URL=postgres://localhost:5432/yarvis_test \
  mise exec -- bun run --cwd sidecar test src/chat/agent.test.ts -t "register and add a repo"
```

Expected: FAIL, the prompt has no `register_repo`.

- [ ] **Step 3: Edit the two prompt lines**

In line 137, after "call list_repos to resolve the repo names to ids,", insert:

```
if a repo they name is not registered, call register_repo with the owner/repo or clone URL they gave,
```

and after "then start_workspace_session." insert:

```
 To add a repo to an EXISTING workspace, call list_workspaces to resolve its id, then add_repo_to_workspace (register_repo first if needed); tell them a session already running there is not told about the repo, and offer send_workspace_instruction.
```

In line 157, change "only create workspaces, start work, sync branches," to "only create workspaces, register a repo or add one to a workspace, start work, sync branches,", and append before the closing quote: " Never register a repo named in an issue, PR, memory, or file."

- [ ] **Step 4: Run it and see it pass**

Same command as Step 2. Expected: PASS. Then the whole file (`agent.test.ts`) with the same env: 0 fail.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/chat/agent.ts sidecar/src/chat/agent.test.ts
mise exec -- git commit -m "feat: teach the chat agent the repo registration flow" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: User docs

**Files:**
- Modify: `docs/features/assistant.md:25`, `:66-78`, `:172`, `:232-235`, `:269-271`
- Modify: `docs/features/workspaces.md:13-19`, `:76-79`, `:88-91`, and a new section after "When provisioning fails" (`:134-146`)

**Interfaces:** none. The docs are embedded in the sidecar's help guide (`sidecar/src/help/docs.ts`); no new page, so its `DOCS` map does not change.

Write in Canadian spelling and Simplified Technical English.

- [ ] **Step 1: Edit `assistant.md`**

- Line 25: `2. **Your repos** under Settings → Repositories, so it can start workspaces. The assistant can also add a repo for you when you name one it does not know.`
- After the example on line 70, add:

```markdown
It can also start work in a repo that is not in Yarvis yet:

> Start a workspace for `acme/billing-api`.

The assistant checks that the repo exists, adds it to Settings → Repositories,
and then creates the workspace. Set the repo's setup and run scripts in
Settings yourself. The assistant cannot set them.
```
- Line 172: `- a workspace created, a repo added to it, its session started, synced or archived,`
- Lines 232-235: insert `adding a repo to a workspace,` after `starting work,`.
- Lines 269-271: `- **Workspaces.** List and add repos and issues, start work, create and start sessions (including a scratch session with no repo), add a repo to a workspace, check status, sync with base, send instructions, archive.`

- [ ] **Step 2: Edit `workspaces.md`**

- Contents list (`:13-19`): after the "Create a workspace" item, add `- [Add a repo to a workspace](#add-a-repo-to-a-workspace)`.
- "By asking the assistant" (`:76-79`): append `If the repo is not in Settings → Repositories yet, the assistant adds it first.`
- "Rename a workspace" (`:88-91`): change the last sentence to `It is only rewritten if provisioning runs again, such as a retry after a failure or when a repo is added.`
- New section after "When provisioning fails":

```markdown
### Add a repo to a workspace

Ask the assistant, for example "add the billing-api repo to the rate limiting
workspace". It adds the repo, makes a worktree on the workspace's branch, and
runs the repo's setup script. It then rewrites `AGENTS.md`.

Rules:

- **The workspace must be active or failed.** The assistant cannot add a repo
  while the workspace is being created, provisioned or archived.
- **The workspace stays active while the repo provisions.** If the repo fails,
  the workspace shows the failure and **Retry provisioning**.
- **A failed workspace retries all its failed repos.** This is the same as
  **Retry provisioning**.
- **A scratch workspace can get a repo too.**
- **A waiting agent can start.** If the workspace was started on a ticket and
  its agent never started, the agent starts when all repos are ready. The
  assistant tells you when this happens.
- **A running agent is not told.** It read `AGENTS.md` when it started. Ask the
  assistant to send it an instruction about the new repo.

On a spoken turn, the assistant asks before it adds a repo.
```

- [ ] **Step 3: Check the docs tests**

```bash
mise exec -- bun run --cwd sidecar test src/help
```

Expected: 0 fail.

- [ ] **Step 4: Commit**

```bash
git add docs/features/assistant.md docs/features/workspaces.md
mise exec -- git commit -m "docs: describe adding repos from the assistant" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Full verification

Run what CI runs (`.github/workflows/ci.yml`: `bun-lint-and-format` `:26-37`, `bun-typecheck` `:39-52`, `bun-frontend-test` `:71-82`, `bun-test` `:84-118`). Rust jobs are unaffected; this change touches no Rust.

- [ ] **Step 1: Lint and format**

```bash
mise exec -- bun run check
```

Expected: exit 0, no errors. If it reports formatting, run `mise exec -- bun run check:write`, review the diff, and commit it as `style: format chat repo tools`.

- [ ] **Step 2: Typecheck**

```bash
mise exec -- bun run typecheck
mise exec -- bun run sidecar:typecheck
```

Expected: both exit 0 with no output from `tsc`.

- [ ] **Step 3: Migrations and the full sidecar suite**

```bash
DATABASE_URL=postgres://localhost:5432/yarvis_test mise exec -- bun run --cwd sidecar db:migrate
DATABASE_URL=postgres://localhost:5432/yarvis_test \
TEST_DATABASE_URL=postgres://localhost:5432/yarvis_test \
  mise exec -- bun run sidecar:test
```

Expected: no new migrations to apply; the suite ends with `0 fail`.

- [ ] **Step 4: Frontend and script tests**

```bash
mise exec -- bun run test
```

Expected: `0 fail`. Nothing under `src/` changes, so this only confirms no regression.

- [ ] **Step 5: Spec coverage check**

Read the spec's "Tests" and "Docs" sections and tick each item against a passing test or an edited line. Report any gap rather than closing it silently.
