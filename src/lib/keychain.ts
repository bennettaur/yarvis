import { invoke } from "@tauri-apps/api/core";

/** Secrets the app manages, mirrored from the Rust `SECRET_KEYS` allowlist. */
export type SecretKey =
  | "anthropic_api_key"
  | "gemini_api_key"
  | "github_token"
  | "azure_devops_token"
  | "azure_devops_org_url"
  | "database_url"
  | "google_client_id"
  | "google_client_secret"
  // Telegram remote control. These are managed by the dedicated TelegramSection
  // rather than the generic Secrets list, so they are intentionally absent from
  // the SECRETS array below.
  | "telegram_bot_token"
  | "telegram_allowed_chat_ids"
  | "telegram_otp_secret"
  | "telegram_otp_window_minutes";

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
    key: "azure_devops_org_url",
    label: "Azure DevOps org URL",
    placeholder: "https://dev.azure.com/your-org",
    help: "Organization base URL for the PR dashboard. Project is chosen per search.",
  },
  {
    key: "google_client_id",
    label: "Google client id",
    placeholder: "...apps.googleusercontent.com",
    help: "Google Cloud OAuth client (Desktop app) id for the calendar integration.",
  },
  {
    key: "google_client_secret",
    label: "Google client secret",
    placeholder: "GOCSPX-...",
    help: "OAuth client secret paired with the Google client id.",
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
