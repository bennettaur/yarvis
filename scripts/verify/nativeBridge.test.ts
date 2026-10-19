/**
 * Keeps the frontend's privileged Tauri commands in the files `tier.ts` marks
 * high risk, so the rest of `src/` can count as low risk. These checks guard
 * against mistakes, not a hostile author: obfuscated code can get past any
 * static check, and only trusted authors' PRs can auto-merge.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PRIVILEGED_FRONTEND_FILES } from "./tier.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

const PRIVILEGED = "src/lib/privilegedCommands.ts";
const PTY = "src/lib/pty.ts";

/**
 * Commands that write a secret, switch the secret store, set the agent's launch
 * command, or type into or launch a shell, each with the one file that may call it.
 */
const PRIVILEGED_COMMANDS: Record<string, string> = {
  set_secret: PRIVILEGED,
  delete_secret: PRIVILEGED,
  set_mcp_secret: PRIVILEGED,
  delete_mcp_secret: PRIVILEGED,
  delete_mcp_all_secrets: PRIVILEGED,
  set_custom_provider_secret: PRIVILEGED,
  delete_custom_provider_secret: PRIVILEGED,
  delete_custom_provider_all_secrets: PRIVILEGED,
  set_embeddings_secret: PRIVILEGED,
  delete_embeddings_secret: PRIVILEGED,
  set_secret_backend: PRIVILEGED,
  set_agent: PRIVILEGED,
  pty_attach: PTY,
  pty_write: PTY,
  pty_start_claude: PTY,
};

/**
 * Every other command the Rust core registers, each judged safe to call from
 * any file: status reads, alarms, the clipboard, terminal housekeeping and
 * plain settings. The Jira and Azure DevOps URLs are host-checked where the
 * sidecar uses them, so changing one can't send a token elsewhere.
 */
const ORDINARY_COMMANDS = [
  "get_secret_status",
  "list_secret_status",
  "list_custom_provider_secret_status",
  "list_mcp_secret_status",
  "get_embeddings_secret_status",
  "get_sidecar_info",
  "restart_sidecar",
  "get_sidecar_log_path",
  "list_alarms",
  "create_alarm",
  "cancel_alarm",
  "acknowledge_alarm",
  "snooze_alarm",
  "clipboard_history",
  "clipboard_clear_history",
  "clipboard_write",
  "pty_resize",
  "pty_kill",
  "pty_exists",
  "pty_is_busy",
  "get_agent_config",
  "focus_main_window",
  "get_settings",
  "set_max_pty_sessions",
  "set_azure_devops_org_url",
  "set_jira_base_url",
  "set_jira_email",
  "set_google_client_id",
  "set_telegram_otp_window_minutes",
  "set_color_theme",
  "set_terminal_font_size",
];

/** Tauri plugins, each with the one file that wraps it. */
const PLUGIN_OWNERS: Record<string, string> = {
  "@tauri-apps/plugin-opener": "src/lib/url.ts",
  "@tauri-apps/plugin-notification": "src/lib/notify.ts",
};

/** The command names in `generate_handler!`, without their module paths. */
function registeredCommands(): string[] {
  const lib = readFileSync(join(REPO_ROOT, "src-tauri/src/lib.rs"), "utf8");
  const handler = lib.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? "";
  return handler
    .split(",")
    .map((entry) => entry.trim().split("::").pop() ?? "")
    .filter(Boolean);
}

const CORE_IMPORT = 'import { invoke } from "@tauri-apps/api/core";';
/**
 * Any import of `@tauri-apps/api` except its event module, which only listens.
 * Catches the bare `@tauri-apps/api` barrel too, which re-exports core.
 */
const TAURI_API_MODULE = /["']@tauri-apps\/api(?!\/event["'])(?:\/[^"']*)?["']/g;
/** A call whose command is a string literal, with or without a type argument. */
const LITERAL_CALL = /\binvoke(?:<[^(]*>)?\(\s*"([a-z_]+)"/g;

function frontendSources(dir = join(REPO_ROOT, "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    // `src/test/` holds the test preload and stubs, which never ship in the app.
    if (entry.isDirectory()) return entry.name === "test" ? [] : frontendSources(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

const sources = frontendSources().map((path) => ({
  path: relative(REPO_ROOT, path),
  text: readFileSync(path, "utf8"),
}));

describe("the frontend's native bridge", () => {
  it("reaches Tauri only through the plain invoke import", () => {
    // Any other route to core (another import form, the barrel, a dynamic
    // import, a re-export) adds a module mention without adding an import line.
    const offenders = sources.filter(({ text }) => {
      if (/__TAURI/.test(text)) return true;
      const mentions = text.match(TAURI_API_MODULE)?.length ?? 0;
      const imports = text.split(CORE_IMPORT).length - 1;
      return mentions !== imports;
    });
    expect(offenders.map((s) => s.path)).toEqual([]);
  });

  it("names every command as a string literal", () => {
    // Anything else, like `invoke(name)` or passing `invoke` around, would hide which command runs.
    const offenders = sources
      .filter(({ text }) => text.includes(CORE_IMPORT))
      .filter(({ text }) => {
        const uses = text.match(/\binvoke\b/g)?.length ?? 0;
        const literalCalls = [...text.matchAll(LITERAL_CALL)].length;
        const importLine = 1;
        return uses !== literalCalls + importLine;
      });
    expect(offenders.map((s) => s.path)).toEqual([]);
  });

  it("calls each privileged command only from its own high-risk file", () => {
    const misplaced = sources.flatMap(({ path, text }) =>
      [...text.matchAll(LITERAL_CALL)]
        .map((match) => match[1])
        .filter((command) => PRIVILEGED_COMMANDS[command] && PRIVILEGED_COMMANDS[command] !== path)
        .map((command) => `${command} in ${path}`),
    );
    expect(misplaced).toEqual([]);
  });

  it("classifies every command the Rust core registers", () => {
    // A new command must be put on one list or the other on purpose.
    const classified = [...Object.keys(PRIVILEGED_COMMANDS), ...ORDINARY_COMMANDS];
    // Guards the parse itself: finding no commands would pass the check below.
    expect(registeredCommands()).toContain("set_secret");
    expect(registeredCommands().filter((command) => !classified.includes(command))).toEqual([]);
    expect(ORDINARY_COMMANDS.filter((command) => PRIVILEGED_COMMANDS[command])).toEqual([]);
  });

  it("imports each Tauri plugin only from the file that wraps it", () => {
    const misplaced = sources.flatMap(({ path, text }) =>
      [...text.matchAll(/["'](@tauri-apps\/plugin-[^"']+)["']/g)]
        .map((match) => match[1])
        .filter((plugin) => PLUGIN_OWNERS[plugin] !== path)
        .map((plugin) => `${plugin} in ${path}`),
    );
    expect(misplaced).toEqual([]);
  });

  it("marks every file allowed a privileged command as high risk", () => {
    const owners = [...new Set(Object.values(PRIVILEGED_COMMANDS))].sort();
    expect([...PRIVILEGED_FRONTEND_FILES].sort()).toEqual(owners);
  });
});
