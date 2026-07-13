/**
 * Sidecar configuration, sourced entirely from environment variables.
 *
 * In production the Rust core generates the auth token, picks a free loopback
 * port, and injects secrets + DATABASE_URL when it spawns this process. When the
 * sidecar is run standalone (tests, local development), sensible fallbacks apply
 * and a generated token is logged so it can be used by a client.
 */

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
    mcpSecrets: parseMcpSecrets(env.YARVIS_MCP_SECRETS),
    embeddingsSecrets: parseEmbeddingsSecrets(env.YARVIS_EMBEDDINGS_SECRETS),
  };
}
