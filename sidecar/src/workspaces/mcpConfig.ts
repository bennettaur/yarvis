import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Generates the `.mcp.json` that points a Yarvis-launched Claude Code session at
 * the sidecar's own MCP endpoint, so the session can read and write Yarvis
 * memory. Split out from the workspace service — like `claudeSettings.ts` — so
 * the config shape and the merge semantics are testable without a filesystem.
 */

/** Key we own in the file's server map; anything else is the user's. */
export const YARVIS_SERVER_KEY = "yarvis";

/**
 * The port and the scoped MCP token are read from the session's environment
 * (injected by the Rust core when it spawns the PTY, see `pty.rs`), never
 * written to disk: the file lives in a workspace directory the user may commit
 * or share, and the token grants access to their memory.
 */
export function yarvisServerEntry(): Record<string, unknown> {
  return {
    type: "http",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands these, not JS.
    url: "http://127.0.0.1:${YARVIS_SIDECAR_PORT}/mcp",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands these, not JS.
    headers: { Authorization: "Bearer ${YARVIS_MCP_TOKEN}" },
  };
}

/**
 * Merges our server entry into any existing `.mcp.json`. Other servers the user
 * configured are preserved, as are unrelated top-level keys; our own entry is
 * recomputed every time, so a re-provision refreshes it rather than stacking.
 */
export function buildMcpConfig(existing: Record<string, unknown> = {}): Record<string, unknown> {
  const servers =
    existing.mcpServers && typeof existing.mcpServers === "object"
      ? (existing.mcpServers as Record<string, unknown>)
      : {};

  return {
    ...existing,
    mcpServers: { ...servers, [YARVIS_SERVER_KEY]: yarvisServerEntry() },
  };
}

/**
 * (Re)writes `.mcp.json` at the workspace root. Both launch flows start Claude
 * with cwd = the workspace root, so a project-scoped file here covers them —
 * Claude Code asks the user to approve the server the first time it sees it.
 * Best-effort: a corrupt existing file is overwritten and any failure is logged,
 * never fatal to provisioning.
 */
export function writeMcpConfig(rootPath: string): void {
  try {
    const file = `${rootPath}/.mcp.json`;
    let existing: Record<string, unknown> = {};
    // Read-and-catch rather than existsSync-then-read: a missing file is the
    // normal first-provision case and a corrupt one is overwritten either way.
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[workspaces] unreadable .mcp.json at ${file}:`, e);
      }
    }

    mkdirSync(rootPath, { recursive: true });
    writeFileSync(file, `${JSON.stringify(buildMcpConfig(existing), null, 2)}\n`);
  } catch (e) {
    console.error("[workspaces] failed to write .mcp.json:", e);
  }
}
