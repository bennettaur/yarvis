import { invoke } from "@tauri-apps/api/core";

/** Secrets the app manages, mirrored from the Rust `SECRET_KEYS` allowlist. */
export type SecretKey =
  | "anthropic_api_key"
  | "gemini_api_key"
  | "github_token"
  | "database_url"
  | "google_client_id"
  | "google_client_secret";

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
