import { invoke } from "@tauri-apps/api/core";
import { ensureOk, sidecarFetch } from "./api";

/** Mirrors the sidecar's `LogLevel`. */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  seq: number;
  at: string;
  level: LogLevel;
  scope: string | null;
  message: string;
}

export interface LogPage {
  entries: LogEntry[];
  /** Every scope seen so far, for the filter. */
  scopes: string[];
}

export interface LogFilter {
  minLevel?: LogLevel;
  scope?: string;
  contains?: string;
  /** Highest `seq` already held, so a poll only fetches what is new. */
  after?: number;
  limit?: number;
}

/** The sidecar's recent log lines, newest last. */
export async function getLogs(filter: LogFilter = {}): Promise<LogPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const res = await sidecarFetch(`/api/logs?${params.toString()}`);
  await ensureOk(res, "logs");
  return res.json();
}

/**
 * Where the core writes the sidecar's output. Unlike the buffer above this
 * survives a restart and a crash, which is what a bug report wants attached.
 */
export function sidecarLogPath(): Promise<string> {
  return invoke<string>("get_sidecar_log_path");
}

/** One log line as it reads in a copied report. */
export function formatEntry(entry: LogEntry): string {
  const scope = entry.scope ? ` [${entry.scope}]` : "";
  return `${entry.at} ${entry.level.toUpperCase()}${scope} ${entry.message}`;
}
