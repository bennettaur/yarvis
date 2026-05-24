import { invoke } from "@tauri-apps/api/core";

/** Secrets the app manages, mirrored from the Rust `SECRET_KEYS` allowlist. */
export type SecretKey = "anthropic_api_key" | "gemini_api_key" | "database_url";

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
