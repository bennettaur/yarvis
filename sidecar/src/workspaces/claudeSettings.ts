import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Generates the `.claude/settings.json` hook config that makes a Yarvis-launched
 * Claude Code session signal the app when it needs the user. Split out from the
 * workspace service so the hook↔ingest contract and the merge semantics are unit
 * testable without touching the filesystem.
 */

/** Marks our hook commands so re-provision can replace them without duplicating. */
const INGEST_MARKER = "/ingest/attention";

export type AttentionHookKind = "permission" | "idle" | "completed";

/**
 * Characters allowed in the values baked into the hook command. Both land in a
 * shell string — the workspace id inside single quotes, the fallback key inside
 * the *default word* of a `${VAR:-word}` expansion, which the shell still scans
 * for command substitution even within double quotes. Callers pass ids the app
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
  for (const value of [workspaceId, fallbackSessionKey]) {
    if (!SHELL_SAFE.test(value)) {
      throw new Error(`attention hook: refusing to embed unsafe value ${JSON.stringify(value)}`);
    }
  }
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

interface HookEntry {
  matcher?: string;
  hooks: { type: "command"; command: string }[];
}

/** True if an existing hook entry is one we wrote (so re-provision replaces it). */
function isOurEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const hooks = (entry as HookEntry).hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some((h) => typeof h?.command === "string" && h.command.includes(INGEST_MARKER))
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

/**
 * Merges our three attention hooks into any existing settings. Unrelated
 * top-level keys and the user's own hooks for these events are preserved — our
 * entry is *appended* alongside them, not substituted for the array. Idempotent:
 * a prior Yarvis entry for an event is dropped before ours is re-added, so
 * re-provisioning never stacks duplicates.
 *
 * Also strips the `skills.paths`/`agents.paths` an earlier version wrote to
 * register each repo's `.claude` dirs. Claude Code ignores those keys, so the
 * repos' skills and agents are copied into the workspace root instead (see
 * `claudeAssets.ts`); left behind, the paths would only mislead a reader.
 */
export function buildClaudeSettings(
  workspaceId: string,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  const fallbackSessionKey = `ws-claude:${workspaceId}`;
  const command = (kind: AttentionHookKind) => ({
    type: "command" as const,
    command: attentionHookCommand(workspaceId, fallbackSessionKey, kind),
  });

  const existingHooks =
    existing.hooks && typeof existing.hooks === "object"
      ? (existing.hooks as Record<string, unknown>)
      : {};

  const withOurEntry = (event: string, entry: HookEntry): HookEntry[] => {
    const prior = Array.isArray(existingHooks[event]) ? (existingHooks[event] as HookEntry[]) : [];
    return [...prior.filter((e) => !isOurEntry(e)), entry];
  };

  const settings: Record<string, unknown> = {
    ...existing,
    hooks: {
      ...existingHooks,
      PermissionRequest: withOurEntry("PermissionRequest", { hooks: [command("permission")] }),
      Notification: withOurEntry("Notification", {
        matcher: "idle_prompt",
        hooks: [command("idle")],
      }),
      Stop: withOurEntry("Stop", { hooks: [command("completed")] }),
    },
  };

  for (const key of ["skills", "agents"]) dropPathsKey(settings, key);

  return settings;
}

/**
 * (Re)writes `.claude/settings.json` at the workspace root so a Claude Code
 * session launched there signals Yarvis when it needs the user (blocked on a
 * permission, idle waiting for input, or finished). Both launch flows start
 * Claude with cwd = the workspace root, so a project settings file here covers
 * them. Best-effort: a corrupt existing file is overwritten and any failure is
 * logged, never fatal to provisioning.
 */
export function writeClaudeSettings(rootPath: string, workspaceId: string): void {
  try {
    const dir = `${rootPath}/.claude`;
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

    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(buildClaudeSettings(workspaceId, existing), null, 2)}\n`);
  } catch (e) {
    console.error("[workspaces] failed to write .claude/settings.json:", e);
  }
}
