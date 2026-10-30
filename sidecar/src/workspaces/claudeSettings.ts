import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SESSION_KEY_HEADER, SESSION_TOKEN_HEADER } from "./agentSessions.ts";
import {
  ensureBranchRefDirs,
  isOurSandboxEntry,
  resolveAdminName,
  type SandboxRepo,
  sandboxAllowWrite,
  sandboxDenyWrite,
} from "./sandboxPaths.ts";

/**
 * Generates the `.claude/settings.json` hook config that makes a Yarvis-launched
 * Claude Code session register itself with its workspace, signal the app when it
 * needs the user, and let the app answer its permission prompts. Split out from the
 * workspace service so the hook↔ingest contract and the merge semantics are unit
 * testable without touching the filesystem.
 */

/** Marks our hook commands so re-provision can replace them without duplicating. */
const INGEST_MARKERS = [
  "/ingest/attention",
  "/ingest/permission",
  "/ingest/agent-session",
  "/ingest/activity",
];

/**
 * Seconds Claude Code lets the permission hook run: a day, so a prompt waits in
 * the app for as long as the user is away. The sidecar's hold
 * (`PERMISSION_HOLD_MS`) ends a little before, so its own "no decision" reply
 * arrives before Claude Code kills the hook.
 */
export const PERMISSION_HOOK_TIMEOUT_S = 86_400;

export type AttentionHookKind = "idle" | "completed";

/**
 * Characters allowed in the values baked into the hook commands. Every value
 * lands in a shell string — the workspace id inside single quotes or, in the
 * session hook, a double-quoted URL; the fallback key inside the *default word*
 * of a `${VAR:-word}` expansion, which the shell still scans for command
 * substitution even within double quotes. Callers pass ids the app
 * generated, so this is an assertion of that invariant rather than a filter.
 */
const SHELL_SAFE = /^[A-Za-z0-9:_./-]+$/;

/**
 * The shell command a Claude Code hook runs to raise an attention item. It
 * consumes the hook's stdin (so the hook never blocks), then posts a minimal
 * body to the sidecar's attention-ingest endpoint. The sidecar port + scoped
 * token come from the session's environment (injected by the Rust core when it
 * spawns the PTY), so no secret is written to disk.
 *
 * The session key is read from `YARVIS_SESSION_KEY` — the id of the PTY the
 * session is actually running in — so a Claude run started by hand in one of the
 * workspace's terminal tabs flags *that* tab rather than the workspace's pinned
 * Claude session. `fallbackSessionKey` covers a session launched outside a
 * Yarvis PTY, where the variable is unset.
 *
 * Throws on a value that isn't `SHELL_SAFE`. The expanded env value is not
 * rescanned by the shell, so it cannot inject a command — but it is spliced into
 * the JSON body unescaped, so a session key containing a quote would produce a
 * body the ingest route rejects. Core-generated PTY ids never contain one.
 */
export function attentionHookCommand(
  workspaceId: string,
  fallbackSessionKey: string,
  kind: AttentionHookKind,
): string {
  assertShellSafe(workspaceId, fallbackSessionKey);
  // Single-quoted JSON either side of a double-quoted env expansion: the shell
  // concatenates the three segments into one argument.
  const body =
    `'{"workspaceId":${JSON.stringify(workspaceId)},"sessionKey":"'` +
    `"\${YARVIS_SESSION_KEY:-${fallbackSessionKey}}"` +
    `'","kind":${JSON.stringify(kind)}}'`;
  return (
    `cat >/dev/null 2>&1; ` +
    `curl -sf -m 5 -X POST "http://127.0.0.1:\${YARVIS_SIDECAR_PORT}/ingest/attention" ` +
    `-H "Authorization: Bearer \${YARVIS_ATTENTION_TOKEN}" ` +
    `-H "Content-Type: application/json" ` +
    `-d ${body} >/dev/null 2>&1 || true`
  );
}

function assertShellSafe(...values: string[]): void {
  for (const value of values) {
    if (!SHELL_SAFE.test(value)) {
      throw new Error(`hook command: refusing to embed unsafe value ${JSON.stringify(value)}`);
    }
  }
}

/**
 * The shell command a `PermissionRequest` hook runs so the user can answer the
 * prompt from the app. It forwards Claude Code's stdin (the tool and its input)
 * to the sidecar and prints whatever decision comes back, which Claude Code
 * reads as the hook's output. The session's identity rides in headers because
 * the body is Claude Code's own JSON: its PTY's key, and the PTY's
 * `YARVIS_SESSION_TOKEN`, so a process in one terminal can't put a prompt in
 * front of the user under another terminal's name.
 *
 * Every failure prints nothing: outside a Yarvis terminal, with the app closed,
 * or past the hold, Claude Code shows its normal dialog as if no hook ran.
 * Outside a Yarvis terminal the variables are unset, and curl would read the
 * bare `127.0.0.1:` as port 80 and print whatever answers there as a decision,
 * so the command stops before curl instead.
 */
export function permissionHookCommand(workspaceId: string): string {
  assertShellSafe(workspaceId);
  // curl gives up a little before Claude Code would kill the hook, so a stalled
  // sidecar still ends in the empty "no decision" output rather than a kill.
  return (
    `{ [ -n "\${YARVIS_SIDECAR_PORT}" ] && [ -n "\${YARVIS_ATTENTION_TOKEN}" ] && ` +
    `[ -n "\${YARVIS_SESSION_KEY}" ] && [ -n "\${YARVIS_SESSION_TOKEN}" ]; } || { cat >/dev/null; exit 0; }; ` +
    `curl -sf -m ${PERMISSION_HOOK_TIMEOUT_S - 5} -X POST "http://127.0.0.1:\${YARVIS_SIDECAR_PORT}/ingest/permission" ` +
    `-H "Authorization: Bearer \${YARVIS_ATTENTION_TOKEN}" ` +
    `-H "Content-Type: application/json" ` +
    `-H 'X-Yarvis-Workspace-Id: ${workspaceId}' ` +
    `-H "${SESSION_KEY_HEADER}: \${YARVIS_SESSION_KEY}" ` +
    `-H "${SESSION_TOKEN_HEADER}: \${YARVIS_SESSION_TOKEN}" ` +
    `--data-binary @- 2>/dev/null || true`
  );
}

/**
 * The shell command that tells the sidecar a session has moved past its held
 * permission prompts, so the app stops offering ones the user already answered
 * in the terminal. Claude Code leaves the permission hook running after that,
 * so its connection can't say so. It runs on PostToolUse, where the call that
 * ran was approved, and on Stop and UserPromptSubmit, where the turn is over.
 *
 * It sends the same session headers as the permission hook and prints nothing,
 * since UserPromptSubmit's output would be added to Claude's context.
 */
export function permissionSettledHookCommand(workspaceId: string): string {
  assertShellSafe(workspaceId);
  return (
    `{ [ -n "\${YARVIS_SIDECAR_PORT}" ] && [ -n "\${YARVIS_ATTENTION_TOKEN}" ] && ` +
    `[ -n "\${YARVIS_SESSION_KEY}" ] && [ -n "\${YARVIS_SESSION_TOKEN}" ]; } || { cat >/dev/null; exit 0; }; ` +
    `curl -sf -m 5 -X POST "http://127.0.0.1:\${YARVIS_SIDECAR_PORT}/ingest/permission/settled" ` +
    `-H "Authorization: Bearer \${YARVIS_ATTENTION_TOKEN}" ` +
    `-H "Content-Type: application/json" ` +
    `-H 'X-Yarvis-Workspace-Id: ${workspaceId}' ` +
    `-H "${SESSION_KEY_HEADER}: \${YARVIS_SESSION_KEY}" ` +
    `-H "${SESSION_TOKEN_HEADER}: \${YARVIS_SESSION_TOKEN}" ` +
    `--data-binary @- >/dev/null 2>&1 || true`
  );
}

/**
 * The shell command the SessionStart and SessionEnd hooks run to register the
 * session with its workspace (see `agentSessions.ts`). Claude Code's hook input
 * goes to the sidecar unchanged as the body, since it already carries the
 * session id and the start source or end reason. Three values ride alongside:
 *
 * - `$PPID`, the Claude process itself: Claude runs the command through a
 *   shell, so the shell's parent is Claude.
 * - `YARVIS_SESSION_KEY`, the PTY the session runs in. Without it the session
 *   isn't in a Yarvis PTY (a terminal outside the app, or a headless run with
 *   no Yarvis environment), there is no prompt to deliver to, and nothing is
 *   registered. The hook's stdin is still drained so Claude never blocks
 *   writing it.
 * - `YARVIS_SESSION_TOKEN`, which proves the request comes from that PTY.
 *
 * Throws on a workspace id that isn't `SHELL_SAFE`: it lands inside a
 * double-quoted URL, where a `$` or backtick would be run by the shell.
 */
export function agentSessionHookCommand(workspaceId: string): string {
  if (!SHELL_SAFE.test(workspaceId)) {
    throw new Error(
      `agent session hook: refusing to embed unsafe value ${JSON.stringify(workspaceId)}`,
    );
  }
  return (
    `if [ -n "\${YARVIS_SESSION_KEY}" ] && [ -n "\${YARVIS_SESSION_TOKEN}" ]; then ` +
    `curl -sf -m 5 -X POST "http://127.0.0.1:\${YARVIS_SIDECAR_PORT}/ingest/agent-session?workspaceId=${workspaceId}&pid=\${PPID}" ` +
    `-H "Authorization: Bearer \${YARVIS_ATTENTION_TOKEN}" ` +
    `-H "${SESSION_KEY_HEADER}: \${YARVIS_SESSION_KEY}" ` +
    `-H "${SESSION_TOKEN_HEADER}: \${YARVIS_SESSION_TOKEN}" ` +
    `-H "Content-Type: application/json" ` +
    `--data-binary @- >/dev/null 2>&1; ` +
    `else cat >/dev/null 2>&1; fi; true`
  );
}

/**
 * The shell command that reports what the session is doing to the Agent Field
 * page (`activity/routes.ts`). Claude Code's hook input is forwarded unchanged,
 * with the same session headers as the permission hooks. It prints nothing and
 * runs async, so it never holds Claude up or adds to its context; outside a
 * Yarvis terminal it drains stdin and does nothing.
 */
export function activityHookCommand(workspaceId: string): string {
  assertShellSafe(workspaceId);
  return (
    `{ [ -n "\${YARVIS_SIDECAR_PORT}" ] && [ -n "\${YARVIS_ATTENTION_TOKEN}" ] && ` +
    `[ -n "\${YARVIS_SESSION_KEY}" ] && [ -n "\${YARVIS_SESSION_TOKEN}" ]; } || { cat >/dev/null; exit 0; }; ` +
    `curl -sf -m 5 -X POST "http://127.0.0.1:\${YARVIS_SIDECAR_PORT}/ingest/activity?workspaceId=${workspaceId}" ` +
    `-H "Authorization: Bearer \${YARVIS_ATTENTION_TOKEN}" ` +
    `-H "Content-Type: application/json" ` +
    `-H "${SESSION_KEY_HEADER}: \${YARVIS_SESSION_KEY}" ` +
    `-H "${SESSION_TOKEN_HEADER}: \${YARVIS_SESSION_TOKEN}" ` +
    `--data-binary @- >/dev/null 2>&1 || true`
  );
}

interface HookEntry {
  matcher?: string;
  hooks: { type: "command"; command: string; timeout?: number; async?: boolean }[];
}

/** True if an existing hook entry is one we wrote (so re-provision replaces it). */
function isOurEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const hooks = (entry as HookEntry).hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some(
      (h) =>
        typeof h?.command === "string" &&
        INGEST_MARKERS.some((marker) => h.command.includes(marker)),
    )
  );
}

/**
 * Removes the `paths` an earlier version wrote under `settings[key]`, and the key
 * itself once nothing else is left in it — a `skills: { enabled: false }` the
 * user set by hand is a real toggle and has to survive.
 */
function dropPathsKey(settings: Record<string, unknown>, key: string): void {
  const value = settings[key];
  if (!value || typeof value !== "object" || !("paths" in value)) return;
  const { paths: _paths, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length === 0) delete settings[key];
  else settings[key] = rest;
}

/** Our entries replace any we wrote before; everything else in the list is the user's. */
function replaceOurEntries(existingEntries: unknown, ourEntries: string[]): unknown[] {
  const usersOwn = (Array.isArray(existingEntries) ? existingEntries : []).filter(
    (entry) => !isOurSandboxEntry(entry),
  );
  return [...usersOwn, ...ourEntries];
}

/**
 * The settings' `sandbox` key with this workspace's clone paths in it (see
 * `sandboxPaths.ts`), or undefined when there is nothing to write. Entries are
 * recognised by shape, so a repo that left the workspace, including its last
 * one, takes its paths with it.
 */
function sandboxWithClonePaths(
  existing: Record<string, unknown>,
  repos: readonly SandboxRepo[],
): Record<string, unknown> | undefined {
  const sandbox =
    existing.sandbox && typeof existing.sandbox === "object" && !Array.isArray(existing.sandbox)
      ? (existing.sandbox as Record<string, unknown>)
      : undefined;
  if (!sandbox && repos.length === 0) return undefined;
  const filesystem =
    sandbox?.filesystem &&
    typeof sandbox.filesystem === "object" &&
    !Array.isArray(sandbox.filesystem)
      ? { ...(sandbox.filesystem as Record<string, unknown>) }
      : {};
  for (const [key, ours] of [
    ["allowWrite", sandboxAllowWrite(repos)],
    ["denyWrite", sandboxDenyWrite(repos)],
  ] as const) {
    const entries = replaceOurEntries(filesystem[key], ours);
    if (entries.length > 0 || key in filesystem) filesystem[key] = entries;
  }
  return { ...sandbox, filesystem };
}

/**
 * Merges our hooks into any existing settings: the three attention hooks, which
 * include the permission hook, the hooks that settle held permission prompts,
 * the SessionStart/SessionEnd pair that registers the session, and the
 * activity hooks that feed the Agent Field page. Unrelated
 * top-level keys and the user's own hooks for these events are preserved — our
 * entry is *appended* alongside them, not substituted for the array. Idempotent:
 * a prior Yarvis entry for an event is dropped before ours is re-added, so
 * re-provisioning never stacks duplicates.
 *
 * Also lets the sandbox commit to each repo's clone, while keeping its git
 * config, hooks and shared refs out of reach (`sandboxPaths.ts`), and strips the `skills.paths`/`agents.paths` an earlier version wrote to
 * register each repo's `.claude` dirs. Claude Code ignores those keys, so the
 * repos' skills and agents are copied into the workspace root instead (see
 * `claudeAssets.ts`); left behind, the paths would only mislead a reader.
 */
export function buildClaudeSettings(
  workspaceId: string,
  existing: Record<string, unknown> = {},
  repos: readonly SandboxRepo[] = [],
): Record<string, unknown> {
  const fallbackSessionKey = `ws-claude:${workspaceId}`;
  const command = (kind: AttentionHookKind) => ({
    type: "command" as const,
    command: attentionHookCommand(workspaceId, fallbackSessionKey, kind),
  });
  const registration = { type: "command" as const, command: agentSessionHookCommand(workspaceId) };
  // Async, so the post that runs after every tool call never holds Claude up.
  const settled = {
    type: "command" as const,
    command: permissionSettledHookCommand(workspaceId),
    async: true,
  };
  const activity = {
    type: "command" as const,
    command: activityHookCommand(workspaceId),
    async: true,
  };

  const existingHooks =
    existing.hooks && typeof existing.hooks === "object"
      ? (existing.hooks as Record<string, unknown>)
      : {};

  const withOurEntries = (event: string, ...entries: HookEntry[]): HookEntry[] => {
    const prior = Array.isArray(existingHooks[event]) ? (existingHooks[event] as HookEntry[]) : [];
    return [...prior.filter((e) => !isOurEntry(e)), ...entries];
  };

  const settings: Record<string, unknown> = {
    ...existing,
    hooks: {
      ...existingHooks,
      PermissionRequest: withOurEntries("PermissionRequest", {
        hooks: [
          {
            type: "command",
            command: permissionHookCommand(workspaceId),
            timeout: PERMISSION_HOOK_TIMEOUT_S,
          },
        ],
      }),
      Notification: withOurEntries(
        "Notification",
        { matcher: "idle_prompt", hooks: [command("idle")] },
        { hooks: [activity] },
      ),
      Stop: withOurEntries("Stop", { hooks: [command("completed"), settled, activity] }),
      PostToolUse: withOurEntries("PostToolUse", { hooks: [settled] }),
      UserPromptSubmit: withOurEntries("UserPromptSubmit", { hooks: [settled, activity] }),
      SessionStart: withOurEntries("SessionStart", { hooks: [registration, activity] }),
      SessionEnd: withOurEntries("SessionEnd", { hooks: [registration] }),
      PreToolUse: withOurEntries("PreToolUse", { hooks: [activity] }),
      PostToolUseFailure: withOurEntries("PostToolUseFailure", { hooks: [activity] }),
      SubagentStop: withOurEntries("SubagentStop", { hooks: [activity] }),
      PreCompact: withOurEntries("PreCompact", { hooks: [activity] }),
    },
  };

  const sandbox = sandboxWithClonePaths(existing, repos);
  if (sandbox) settings.sandbox = sandbox;

  for (const key of ["skills", "agents"]) dropPathsKey(settings, key);

  return settings;
}

/** What `writeClaudeSettings` needs from a workspace. */
export interface WorkspaceForSettings {
  id: string;
  rootPath: string;
  repos: readonly {
    status: string;
    branch: string;
    worktreePath: string;
    repo: { primaryClonePath: string };
  }[];
}

/**
 * The workspace's repos as the sandbox needs them. A worktree's admin
 * directory is looked up in its clone, since git may have suffixed the name.
 */
function sandboxReposOf(detail: WorkspaceForSettings): SandboxRepo[] {
  return detail.repos
    .filter((wr) => wr.status !== "removed")
    .map((wr) => ({
      clonePath: wr.repo.primaryClonePath,
      branch: wr.branch,
      adminName: resolveAdminName(wr.repo.primaryClonePath, wr.worktreePath),
    }));
}

/**
 * (Re)writes `.claude/settings.json` at the workspace root so a Claude Code
 * session launched there registers itself with Yarvis and signals when it
 * needs the user (blocked on a permission, idle waiting for input, or
 * finished), and so its sandbox can commit to the workspace's branches. Both
 * launch flows start Claude with cwd = the workspace root, so a project
 * settings file here covers them. Best-effort: a corrupt existing file is
 * overwritten and any failure is logged, never fatal to provisioning.
 */
export function writeClaudeSettings(detail: WorkspaceForSettings): void {
  try {
    const dir = `${detail.rootPath}/.claude`;
    const file = `${dir}/settings.json`;
    let existing: Record<string, unknown> = {};
    // Read-and-catch rather than existsSync-then-read: a separate existence check
    // is a time-of-check/time-of-use race, and a missing OR corrupt file is handled
    // identically here — start from empty and overwrite.
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
    } catch (e) {
      // A missing file is the normal first-provision case; anything else (a
      // corrupt/unreadable settings.json we're about to overwrite) is worth a log.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[workspaces] unreadable .claude/settings.json at ${file}:`, e);
      }
    }

    const repos = sandboxReposOf(detail);
    for (const repo of repos) ensureBranchRefDirs(repo);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify(buildClaudeSettings(detail.id, existing, repos), null, 2)}\n`,
    );
  } catch (e) {
    console.error("[workspaces] failed to write .claude/settings.json:", e);
  }
}
