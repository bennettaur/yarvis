import { readFileSync, writeFileSync } from "node:fs";
import { CHANNEL_RELAY_ARG } from "../channel/relay.ts";
import { CHANNEL_SERVER_NAME } from "../channel/send.ts";
import { MCP_SERVER_NAME, WORKSPACE_HEADER } from "../mcpServer/server.ts";

/**
 * Generates the `.mcp.json` that points a Yarvis-launched Claude Code session at
 * the sidecar's own MCP endpoint, so the session can read and write Yarvis
 * memory and work through the workspace's review comments. Split out from the
 * workspace service — like `claudeSettings.ts` — so the config shape and the
 * merge semantics are testable without a filesystem.
 */

/**
 * The port and the scoped MCP token are read from the session's environment
 * (injected by the Rust core when it spawns the PTY, see `pty.rs`), never
 * written to disk: the token grants read and write access to the user's memory,
 * and a file is a far easier thing to copy out of than a process environment.
 * The workspace id is no secret, so it is written as-is: that way a session
 * started from any shell in the workspace still reaches its review comments.
 */
function yarvisServerEntry(workspaceId: string): Record<string, unknown> {
  return {
    type: "http",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands these, not JS.
    url: "http://127.0.0.1:${YARVIS_SIDECAR_PORT}/mcp",
    headers: {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands these, not JS.
      Authorization: "Bearer ${YARVIS_MCP_TOKEN}",
      [WORKSPACE_HEADER]: workspaceId,
      // Tells `ask_user` which terminal a question comes from. The empty default
      // keeps a shell that isn't one of Yarvis's PTYs from failing to expand.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands these, not JS.
      "X-Yarvis-Session-Key": "${YARVIS_SESSION_KEY:-}",
    },
  };
}

/** How Claude Code starts the channel relay: a program and its arguments. */
export interface RelayCommand {
  command: string;
  args: string[];
}

/**
 * The relay is this same sidecar run with `CHANNEL_RELAY_ARG`. A packaged build
 * is one compiled binary, whose bundled entry lives under Bun's virtual
 * `/$bunfs/` root; in development it is Bun running the entry file.
 */
export function currentRelayCommand(): RelayCommand {
  const compiled = Bun.main.startsWith("/$bunfs/");
  return {
    command: process.execPath,
    args: compiled ? [CHANNEL_RELAY_ARG] : [Bun.main, CHANNEL_RELAY_ARG],
  };
}

/**
 * The channel relay's entry (see `channel/relay.ts`). Its environment is listed
 * rather than inherited because Claude Code doesn't promise to pass its own
 * environment to a stdio server. The values are the same per-PTY ones the
 * session hooks use, expanded by Claude Code at launch, so nothing secret is
 * written to disk.
 */
function channelRelayEntry(relay: RelayCommand): Record<string, unknown> {
  return {
    command: relay.command,
    args: relay.args,
    env: {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands these, not JS.
      YARVIS_SIDECAR_PORT: "${YARVIS_SIDECAR_PORT:-}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands these, not JS.
      YARVIS_ATTENTION_TOKEN: "${YARVIS_ATTENTION_TOKEN:-}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands these, not JS.
      YARVIS_SESSION_KEY: "${YARVIS_SESSION_KEY:-}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands these, not JS.
      YARVIS_SESSION_TOKEN: "${YARVIS_SESSION_TOKEN:-}",
      // The relay checks the command the session was launched with for the
      // channel flag, and this override wins over the stored one.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands these, not JS.
      YARVIS_CLAUDE_COMMAND: "${YARVIS_CLAUDE_COMMAND:-}",
    },
  };
}

/**
 * Merges our server entries into any existing `.mcp.json`. Other servers the
 * user configured are preserved, as are unrelated top-level keys; our own
 * entries are recomputed every time, so a re-provision refreshes them rather
 * than stacking.
 */
export function buildMcpConfig(
  workspaceId: string,
  existing: Record<string, unknown> = {},
  relay: RelayCommand = currentRelayCommand(),
): Record<string, unknown> {
  const servers =
    existing.mcpServers && typeof existing.mcpServers === "object"
      ? (existing.mcpServers as Record<string, unknown>)
      : {};

  return {
    ...existing,
    mcpServers: {
      ...servers,
      [MCP_SERVER_NAME]: yarvisServerEntry(workspaceId),
      [CHANNEL_SERVER_NAME]: channelRelayEntry(relay),
    },
  };
}

/**
 * (Re)writes `.mcp.json` at the workspace root. Both launch flows start Claude
 * with cwd = the workspace root, so a project-scoped file here covers them —
 * Claude Code asks the user to approve the server the first time it sees it.
 * Best-effort: a corrupt existing file is overwritten and any failure is logged,
 * never fatal to provisioning.
 */
export function writeMcpConfig(rootPath: string, workspaceId: string): void {
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

    writeFileSync(file, `${JSON.stringify(buildMcpConfig(workspaceId, existing), null, 2)}\n`);
  } catch (e) {
    console.error("[workspaces] failed to write .mcp.json:", e);
  }
}
