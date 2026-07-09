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
  githubToken?: string;
  // Azure DevOps personal access token + organization base URL (e.g.
  // https://dev.azure.com/your-org) for the PR dashboard. The org URL is
  // configuration rather than a secret, but rides the same Keychain blob to
  // keep the injection path uniform with the other provider credentials.
  azureDevopsToken?: string;
  azureDevopsOrgUrl?: string;
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

export interface Config {
  /** Loopback port to bind. The Rust core supplies this; defaults for standalone use. */
  port: number;
  /** Bearer token required on every non-health request. */
  token: string;
  /** Whether the token was generated here (standalone) vs supplied by the host. */
  tokenGenerated: boolean;
  /** Allowed values for the Origin header, or null to skip the check (dev). */
  allowedOrigins: string[] | null;
  /** Postgres connection string. May be undefined until the user configures it. */
  databaseUrl: string | undefined;
  /** Base directory holding managed repo clones + per-workspace worktrees. */
  workspacesRoot: string;
  /** Base command for launching Claude (default: "claude"). */
  claudeCommand: string;
  secrets: ProviderSecrets;
  /** Keyed by custom provider id from the database. */
  customProviderSecrets: Record<string, CustomProviderSecrets>;
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
    allowedOrigins: parseOrigins(env.YARVIS_ALLOWED_ORIGINS),
    databaseUrl: env.DATABASE_URL,
    workspacesRoot: env.YARVIS_WORKSPACES_ROOT ?? join(homedir(), "dev", "yarvis-workspaces"),
    claudeCommand: env.YARVIS_CLAUDE_COMMAND ?? "claude",
    secrets: {
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      geminiApiKey: env.GEMINI_API_KEY,
      githubToken: env.GITHUB_TOKEN,
      azureDevopsToken: env.AZURE_DEVOPS_TOKEN,
      azureDevopsOrgUrl: env.AZURE_DEVOPS_ORG_URL,
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    },
    customProviderSecrets: parseCustomProviderSecrets(env.YARVIS_CUSTOM_PROVIDER_SECRETS),
    embeddingsSecrets: parseEmbeddingsSecrets(env.YARVIS_EMBEDDINGS_SECRETS),
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN || undefined,
      allowedChatIds: parseAllowedChatIds(env.TELEGRAM_ALLOWED_CHAT_IDS),
      otpSecret: env.TELEGRAM_OTP_SECRET || undefined,
      otpWindowMinutes: parseOtpWindowMinutes(env.TELEGRAM_OTP_WINDOW_MINUTES),
    },
  };
}
