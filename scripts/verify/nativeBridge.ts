/**
 * The rules that keep the frontend's privileged calls in the files `tier.ts`
 * marks high risk, so the rest of `src/` can count as low risk.
 * `nativeBridge.test.ts` applies them to `src/` in CI. They guard against
 * mistakes, not a hostile author: obfuscated code can get past any static
 * check, and only trusted authors' PRs can auto-merge.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PRIVILEGED_FRONTEND_IMPORTERS } from "./tier.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

const PRIVILEGED = "src/lib/privilegedCommands.ts";
/** Holds the sidecar's bearer token, which unlocks every sidecar route. */
const API = "src/lib/api.ts";

/**
 * Commands that write a secret, switch the secret store, set the agent's launch
 * command, type into a shell or hand over the sidecar token, each with the one
 * file that may call it.
 */
export const PRIVILEGED_COMMANDS: Record<string, string> = {
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
  pty_write: PRIVILEGED,
  get_sidecar_info: API,
};

/**
 * Every other command the Rust core registers, each judged safe to call from
 * any file: status reads, alarms, the clipboard, terminal housekeeping and
 * plain settings. The Jira and Azure DevOps URLs are host-checked where the
 * sidecar uses them, so changing one can't send a token elsewhere.
 * `pty_attach` opens a plain shell with no input, and `pty_start_claude`
 * launches the configured agent, whose command only `set_agent` decides.
 */
export const ORDINARY_COMMANDS = [
  "get_secret_status",
  "list_secret_status",
  "list_custom_provider_secret_status",
  "list_mcp_secret_status",
  "get_embeddings_secret_status",
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
  "pty_attach",
  "pty_start_claude",
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

/**
 * Sidecar writes that decide what runs or where a credential goes: an MCP
 * server's command, which tools ask before running, a scheduled job's prompt
 * and directory, and a custom provider's URL, which receives its key. Matched
 * on the path a call names, with `${...}` standing for an id.
 */
export const PRIVILEGED_ROUTES: RegExp[] = [
  /^\/api\/mcp\/servers(\/\$\{[^}]+\})?$/,
  /^\/api\/mcp\/tools\/(?!search$)[^/]+$/,
  /^\/api\/jobs\/agent-jobs(\/\$\{[^}]+\})?$/,
  /^\/api\/custom-providers(\/\$\{[^}]+\})?$/,
];

/**
 * A sidecar call with a literal path and a write method, in the two shapes the
 * frontend uses: `sidecarFetch(path, { method })` and `jobsRequest(path, method)`.
 */
const SIDECAR_WRITE =
  /\b(?:sidecarFetch|jobsRequest)(?:<[^(]*>)?\(\s*(["'`])(\/api\/[^"'`]*)\1\s*,\s*(?:\{[^}]*?\bmethod:\s*["'](\w+)["']|["'](\w+)["'])/g;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH"]);

const PRIVILEGED_IMPORT = /from\s+["'](?:\.\.?\/)+(?:lib\/)?privilegedCommands["']/;

/** Tauri plugins, each with the one file that wraps it. */
const PLUGIN_OWNERS: Record<string, string> = {
  "@tauri-apps/plugin-opener": "src/lib/url.ts",
  "@tauri-apps/plugin-notification": "src/lib/notify.ts",
};

/** The command names in `generate_handler!`, without their module paths. */
export function registeredCommands(): string[] {
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
// The closing `"` must end the argument, so `"set_" + "secret"` doesn't read as `set_`.
const LITERAL_CALL = /\binvoke(?:<[^(]*>)?\(\s*"([a-z_]+)"\s*[,)]/g;

export function frontendSources(dir = join(REPO_ROOT, "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    // `src/test/` holds the test preload and stubs, which never ship in the app.
    if (entry.isDirectory()) return entry.name === "test" ? [] : frontendSources(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

export interface Source {
  /** Repo-relative path. */
  path: string;
  text: string;
}

export function readFrontendSources(): Source[] {
  return frontendSources().map((path) => ({
    path: relative(REPO_ROOT, path),
    text: readFileSync(path, "utf8"),
  }));
}

/** Every way `sources` break the rules, one line each. Empty means none. */
export function bridgeViolations(sources: Source[]): string[] {
  const violations: string[] = [];
  for (const { path, text } of sources) {
    // Any other route to core (another import form, the barrel, a dynamic
    // import, a re-export) adds a module mention without adding an import line.
    const mentions = text.match(TAURI_API_MODULE)?.length ?? 0;
    const imports = text.split(CORE_IMPORT).length - 1;
    if (/__TAURI/.test(text) || mentions !== imports) {
      violations.push(`${path} reaches Tauri other than through the plain invoke import`);
    }

    // Anything but a literal name, like `invoke(name)` or passing `invoke`
    // around, would hide which command runs.
    if (text.includes(CORE_IMPORT)) {
      const uses = text.match(/\binvoke\b/g)?.length ?? 0;
      const literalCalls = [...text.matchAll(LITERAL_CALL)].length;
      const importLine = 1;
      if (uses !== literalCalls + importLine) {
        violations.push(`${path} uses invoke other than with a literal command name`);
      }
    }

    for (const [, command] of text.matchAll(LITERAL_CALL)) {
      const owner = PRIVILEGED_COMMANDS[command];
      if (owner && owner !== path)
        violations.push(`${path} calls ${command}, which belongs in ${owner}`);
    }

    for (const [, , route, objectMethod, argMethod] of text.matchAll(SIDECAR_WRITE)) {
      const method = (objectMethod ?? argMethod).toUpperCase();
      if (
        path !== PRIVILEGED &&
        WRITE_METHODS.has(method) &&
        PRIVILEGED_ROUTES.some((r) => r.test(route))
      ) {
        violations.push(`${path} writes ${method} ${route}, which belongs in ${PRIVILEGED}`);
      }
    }

    // An importer chooses the values a privileged call runs with, so it has to
    // be on the high-risk list too.
    if (PRIVILEGED_IMPORT.test(text) && !PRIVILEGED_FRONTEND_IMPORTERS.includes(path)) {
      violations.push(
        `${path} imports privilegedCommands but isn't in PRIVILEGED_FRONTEND_IMPORTERS`,
      );
    }

    if (path !== API && /\bsidecarInfo\b/.test(text)) {
      violations.push(`${path} reads the sidecar token, which only ${API} may`);
    }

    for (const [, plugin] of text.matchAll(/["'](@tauri-apps\/plugin-[^"']+)["']/g)) {
      if (PLUGIN_OWNERS[plugin] !== path) {
        violations.push(
          `${path} imports ${plugin}, which only ${PLUGIN_OWNERS[plugin] ?? "no file"} may`,
        );
      }
    }
  }
  return violations;
}
