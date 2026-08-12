/**
 * Sidecar configuration, sourced entirely from environment variables.
 *
 * In production the Rust core generates the auth token, picks a free loopback
 * port, and injects secrets + DATABASE_URL when it spawns this process. When the
 * sidecar is run standalone (tests, local development), sensible fallbacks apply
 * and a generated token is logged so it can be used by a client.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_BYTES = 32;

function randomToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ProviderSecrets {
  anthropicApiKey?: string;
  geminiApiKey?: string;
  cerebrasApiKey?: string;
  githubToken?: string;
  // Azure DevOps personal access token + organization base URL (e.g.
  // https://dev.azure.com/your-org) for the PR dashboard. The org URL is
  // configuration rather than a secret, but rides the same Keychain blob to
  // keep the injection path uniform with the other provider credentials.
  azureDevopsToken?: string;
  azureDevopsOrgUrl?: string;
  // JIRA Cloud credentials for the Issues integration. `jiraBaseUrl` is the
  // Atlassian site (e.g. https://your-org.atlassian.net) and, like the Azure
  // org URL, is configuration rather than a secret but rides the same Keychain
  // blob. JIRA Cloud REST auth is HTTP Basic with `email:apiToken`, so both the
  // account email and the API token are needed alongside the base URL.
  jiraBaseUrl?: string;
  jiraEmail?: string;
  jiraApiToken?: string;
  // Google Cloud OAuth app credentials for the calendar integration. Created by
  // the user in Google Cloud Console (Desktop app client) and injected by the
  // Rust core from the Keychain, like the other secrets.
  googleClientId?: string;
  googleClientSecret?: string;
  // AWS Bedrock relies on the standard AWS credential chain (env vars / SSO),
  // so no explicit key is read here.
}

/**
 * Secret bundle for a single user-configured provider. The structural fields
 * (name, baseURL, apiKind, models, headerNames) live in Postgres; this is
 * just the matching credentials, pulled from the macOS Keychain and injected
 * by the Rust core via the YARVIS_CUSTOM_PROVIDER_SECRETS env var.
 */
export interface CustomProviderSecrets {
  apiKey?: string;
  headers: Record<string, string>;
}

/**
 * Secret bundle for a single configured MCP server. Like a custom provider, the
 * structural fields (name, transport, url/command, header names) live in
 * Postgres; this is just the matching credentials, pulled from the macOS
 * Keychain and injected by the Rust core via the YARVIS_MCP_SECRETS env var,
 * keyed by the server's database id.
 *
 * `headers` are auth header values for HTTP transports; `env` are sensitive
 * environment variables for stdio (subprocess) transports.
 */
export interface McpServerSecrets {
  headers: Record<string, string>;
  env: Record<string, string>;
}

/**
 * Telegram remote-control settings. The bot lets the user chat with Yarvis (and
 * issue control commands) from Telegram. Absent a bot token the bot stays off.
 * Access is locked to `allowedChatIds`; an empty list means "not yet paired" —
 * the bot then answers only identity commands so the user can learn their id.
 */
export interface TelegramConfig {
  botToken?: string;
  allowedChatIds: number[];
  /**
   * Optional second factor. When `otpSecret` is set, an allowlisted chat must
   * submit a TOTP code (`/unlock`) to open a window of `otpWindowMinutes` before
   * the bot will act on its messages. Absent a secret, OTP is off.
   */
  otpSecret?: string;
  otpWindowMinutes: number;
}

/**
 * What this process is, as opposed to what it serves. Several Yarvis instances
 * can run side by side (see `src-tauri/src/instance.rs`), and these two values
 * decide how this one behaves at startup — nothing that handles a request reads
 * them, which is why they are separate from [`Config`].
 */
export interface InstanceConfig {
  /** Name of the instance this sidecar belongs to. */
  name: string;
  /**
   * Whether this process owns the recurring background work — the Telegram bot,
   * the workspace poller, resuming interrupted kick-offs, and the stale-guide
   * sweep. Two instances sharing a database must not all run these: the bot's
   * long poll rejects a second consumer of the same token, and a kick-off
   * resumed twice launches two agent sessions in one workspace.
   */
  backgroundWorkers: boolean;
}

export interface Config {
  /** Loopback port to bind. The Rust core supplies this; defaults for standalone use. */
  port: number;
  /** Bearer token required on every non-health request. */
  token: string;
  /** Whether the token was generated here (standalone) vs supplied by the host. */
  tokenGenerated: boolean;
  /**
   * A scoped token authorizing only the attention-ingest endpoint. Injected into
   * Yarvis-launched Claude Code session shells (via the Rust core), so a session's
   * hooks can POST an attention item without holding the full-access bearer above.
   */
  attentionToken: string;
  /**
   * A scoped token authorizing only the MCP server endpoint. Injected into
   * Yarvis-launched Claude Code session shells (via the Rust core) and shown in
   * Settings for outside clients, so a tool can call the Yarvis memory tools
   * without holding the full-access bearer above.
   */
  mcpToken: string;
  /** Allowed values for the Origin header, or null to skip the check (dev). */
  allowedOrigins: string[] | null;
  /** Postgres connection string. May be undefined until the user configures it. */
  databaseUrl: string | undefined;
  /** Base directory holding managed repo clones + per-workspace worktrees. */
  workspacesRoot: string;
  secrets: ProviderSecrets;
  /** Keyed by custom provider id from the database. */
  customProviderSecrets: Record<string, CustomProviderSecrets>;
  /** Keyed by MCP server id from the database. */
  mcpSecrets: Record<string, McpServerSecrets>;
  /**
   * Credentials for the active embeddings provider. Same shape as a custom
   * provider's secrets (the embeddings proxy may need an API key and/or custom
   * headers; a local Ollama server needs neither). Injected via the
   * YARVIS_EMBEDDINGS_SECRETS env var.
   */
  embeddingsSecrets: CustomProviderSecrets;
  telegram: TelegramConfig;
}

/** Parses one `{ apiKey?, headers }` secret bundle from untrusted JSON. */
function parseSecretEntry(entry: unknown): CustomProviderSecrets {
  if (!entry || typeof entry !== "object") return { headers: {} };
  const obj = entry as Record<string, unknown>;
  const headers: Record<string, string> =
    obj.headers && typeof obj.headers === "object"
      ? Object.fromEntries(
          Object.entries(obj.headers as Record<string, unknown>).filter(
            (kv): kv is [string, string] => typeof kv[1] === "string",
          ),
        )
      : {};
  return {
    apiKey: typeof obj.apiKey === "string" ? obj.apiKey : undefined,
    headers,
  };
}

function parseCustomProviderSecrets(
  raw: string | undefined,
): Record<string, CustomProviderSecrets> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Log only the error name — a JSON.parse message can echo a fragment of the
    // offending input, which here is secret material.
    console.warn(
      "[config] YARVIS_CUSTOM_PROVIDER_SECRETS is not valid JSON:",
      e instanceof Error ? e.name : "parse error",
    );
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, CustomProviderSecrets> = {};
  for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    out[id] = parseSecretEntry(entry);
  }
  return out;
}

/** Parses a single `{ headers, env }` MCP secret bundle from untrusted JSON. */
function parseMcpSecretEntry(entry: unknown): McpServerSecrets {
  const empty: McpServerSecrets = { headers: {}, env: {} };
  if (!entry || typeof entry !== "object") return empty;
  const obj = entry as Record<string, unknown>;
  const stringMap = (value: unknown): Record<string, string> =>
    value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(
            (kv): kv is [string, string] => typeof kv[1] === "string",
          ),
        )
      : {};
  return { headers: stringMap(obj.headers), env: stringMap(obj.env) };
}

function parseMcpSecrets(raw: string | undefined): Record<string, McpServerSecrets> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Log only the error name — a JSON.parse message can echo a fragment of the
    // offending input, which here is secret material.
    console.warn(
      "[config] YARVIS_MCP_SECRETS is not valid JSON:",
      e instanceof Error ? e.name : "parse error",
    );
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, McpServerSecrets> = {};
  for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    out[id] = parseMcpSecretEntry(entry);
  }
  return out;
}

/** Parses the single `{ apiKey?, headers }` bundle for the embeddings provider. */
function parseEmbeddingsSecrets(raw: string | undefined): CustomProviderSecrets {
  if (!raw) return { headers: {} };
  try {
    return parseSecretEntry(JSON.parse(raw));
  } catch (e) {
    // Log only the error name; the parse message can echo secret material.
    console.warn(
      "[config] YARVIS_EMBEDDINGS_SECRETS is not valid JSON:",
      e instanceof Error ? e.name : "parse error",
    );
    return { headers: {} };
  }
}

/**
 * Parses the comma-separated Telegram chat-id allowlist. Non-numeric or
 * non-integer entries are dropped rather than throwing, so a malformed entry
 * can't take the whole list — and thus the bot's access control — down with it.
 *
 * Ids are parsed as JS numbers, exact only up to 2^53. The bot serves private
 * chats, whose ids (the user's id) sit comfortably within that range; very large
 * supergroup/channel ids are not supported (and the bot ignores non-private
 * chats anyway).
 */
export function parseAllowedChatIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n));
}

/** Default OTP re-auth window when none is configured (2 hours). */
const DEFAULT_OTP_WINDOW_MINUTES = 120;

/**
 * Parses the OTP window in minutes, clamped to a sane range. A malformed or
 * out-of-range value falls back to the default rather than disabling the gate or
 * leaving it open forever.
 */
export function parseOtpWindowMinutes(raw: string | undefined): number {
  const n = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_OTP_WINDOW_MINUTES;
  // Cap at a week so a fat-fingered value can't effectively disable re-auth.
  return Math.min(Math.floor(n), 7 * 24 * 60);
}

/** Instance name used when none is supplied; matches `instance::PRIMARY`. */
const PRIMARY_INSTANCE = "main";

export function parseInstanceName(raw: string | undefined): string {
  const name = raw?.trim();
  return name ? name : PRIMARY_INSTANCE;
}

/**
 * Parses the background-worker switch, using the same `1`/`true`/`0`/`false`
 * vocabulary as the Rust core's `parse_flag`.
 *
 * An absent switch falls back to the instance name rather than to "on". The core
 * always sets both variables, so this only decides a standalone run
 * (`sidecar:dev`, tests) — which, unnamed, is the primary and keeps running the
 * workers as it always has. Falling back to the name matters when the switch
 * goes missing some other way: defaulting to "on" would put a second poller and
 * a second Telegram long-poll on the primary's data, which is the exact
 * duplication this switch exists to prevent, and it would do it silently.
 */
export function parseBackgroundWorkers(raw: string | undefined, instanceName: string): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === "1" || value === "true") return true;
  if (value) return false;
  return instanceName === PRIMARY_INSTANCE;
}

function parseOrigins(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const origins = raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : null;
}

export function loadConfig(): Config {
  const env = process.env;

  const suppliedToken = env.YARVIS_SIDECAR_TOKEN;
  const token = suppliedToken ?? randomToken();

  return {
    port: env.YARVIS_SIDECAR_PORT ? Number(env.YARVIS_SIDECAR_PORT) : 8765,
    token,
    tokenGenerated: suppliedToken === undefined,
    attentionToken: env.YARVIS_ATTENTION_TOKEN ?? randomToken(),
    mcpToken: env.YARVIS_MCP_TOKEN ?? randomToken(),
    allowedOrigins: parseOrigins(env.YARVIS_ALLOWED_ORIGINS),
    databaseUrl: env.DATABASE_URL,
    workspacesRoot: env.YARVIS_WORKSPACES_ROOT ?? join(homedir(), "dev", "yarvis-workspaces"),
    secrets: {
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      geminiApiKey: env.GEMINI_API_KEY,
      cerebrasApiKey: env.CEREBRAS_API_KEY,
      githubToken: env.GITHUB_TOKEN,
      azureDevopsToken: env.AZURE_DEVOPS_TOKEN,
      azureDevopsOrgUrl: env.AZURE_DEVOPS_ORG_URL,
      jiraBaseUrl: env.JIRA_BASE_URL,
      jiraEmail: env.JIRA_EMAIL,
      jiraApiToken: env.JIRA_API_TOKEN,
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    },
    customProviderSecrets: parseCustomProviderSecrets(env.YARVIS_CUSTOM_PROVIDER_SECRETS),
    mcpSecrets: parseMcpSecrets(env.YARVIS_MCP_SECRETS),
    embeddingsSecrets: parseEmbeddingsSecrets(env.YARVIS_EMBEDDINGS_SECRETS),
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN || undefined,
      allowedChatIds: parseAllowedChatIds(env.TELEGRAM_ALLOWED_CHAT_IDS),
      otpSecret: env.TELEGRAM_OTP_SECRET || undefined,
      otpWindowMinutes: parseOtpWindowMinutes(env.TELEGRAM_OTP_WINDOW_MINUTES),
    },
  };
}

export function loadInstanceConfig(): InstanceConfig {
  const name = parseInstanceName(process.env.YARVIS_INSTANCE);
  return {
    name,
    backgroundWorkers: parseBackgroundWorkers(process.env.YARVIS_BACKGROUND_WORKERS, name),
  };
}
