import { invoke } from "@tauri-apps/api/core";

/** Secrets the app manages, mirrored from the Rust `SECRET_KEYS` allowlist.
 * Non-sensitive configuration that used to ride alongside these (org URLs, an
 * account email, a chat-id allowlist) now lives in `lib/settings` instead. */
export type SecretKey =
  | "anthropic_api_key"
  | "gemini_api_key"
  | "cerebras_api_key"
  | "huggingface_api_key"
  | "github_token"
  | "azure_devops_token"
  | "jira_api_token"
  | "database_url"
  | "google_client_secret"
  // Telegram remote control. These are managed by the dedicated TelegramSection
  // rather than the generic Secrets list, so they are intentionally absent from
  // the SECRETS array below.
  | "telegram_bot_token"
  | "telegram_otp_secret";

export interface SecretMeta {
  key: SecretKey;
  label: string;
  placeholder: string;
  help: string;
}

export const SECRETS: SecretMeta[] = [
  {
    key: "database_url",
    label: "Database URL",
    placeholder: "postgres://localhost:5432/yarvis",
    help: "Local PostgreSQL connection string (with pgvector enabled).",
  },
  {
    key: "anthropic_api_key",
    label: "Anthropic API key",
    placeholder: "sk-ant-...",
    help: "Anthropic Console key for Claude chat and Agent SDK delegation.",
  },
  {
    key: "gemini_api_key",
    label: "Gemini API key",
    placeholder: "AIza...",
    help: "Google Gemini API key for chat and embeddings.",
  },
  {
    key: "cerebras_api_key",
    label: "Cerebras API key",
    placeholder: "csk-...",
    help: "Cerebras Cloud key for chat. The endpoint is fixed; no base URL to set.",
  },
  {
    key: "huggingface_api_key",
    label: "Hugging Face token",
    placeholder: "hf_...",
    help: "Hugging Face Inference token for the Voice tab's speech-to-text and text-to-speech.",
  },
  {
    key: "github_token",
    label: "GitHub token",
    placeholder: "ghp_...",
    help: "Fine-grained or classic PAT for the PR dashboard (repo + read access).",
  },
  {
    key: "azure_devops_token",
    label: "Azure DevOps token",
    placeholder: "Azure DevOps PAT",
    help: "Personal access token with Code (read) and Pull Request Threads (read & write) scopes.",
  },
  {
    key: "jira_api_token",
    label: "JIRA API token",
    placeholder: "Atlassian API token",
    help: "Create at id.atlassian.com under Security → API tokens.",
  },
  {
    key: "google_client_secret",
    label: "Google client secret",
    placeholder: "GOCSPX-...",
    help: "OAuth client secret paired with the Google client id, set below under Settings.",
  },
];

export interface SecretStatus {
  key: string;
  present: boolean;
}

export function setSecret(key: SecretKey, value: string): Promise<void> {
  return invoke("set_secret", { key, value });
}

export function deleteSecret(key: SecretKey): Promise<void> {
  return invoke("delete_secret", { key });
}

export function listSecretStatus(): Promise<SecretStatus[]> {
  return invoke<SecretStatus[]>("list_secret_status");
}

/** Restarts the sidecar so newly-stored secrets are injected into it. */
export function restartSidecar(): Promise<void> {
  return invoke("restart_sidecar");
}
