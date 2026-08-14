import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ensureOk, sidecarFetch } from "./api";

/**
 * The clipboard book: snippets saved for good, plus the in-memory history of
 * what has passed through the system clipboard.
 *
 * The two halves come from different processes. Entries are rows the sidecar
 * owns (`sidecar/src/clipboard/`, mirrored by `ClipboardEntry` below); history
 * and the clipboard itself belong to the Rust core, which never persists it.
 */

export interface ClipboardEntry {
  id: string;
  label: string;
  content: string;
  tags: string[];
  pinned: boolean;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateClipboardEntryInput {
  label: string;
  content: string;
  tags?: string[];
  pinned?: boolean;
}

export type UpdateClipboardEntryInput = Partial<CreateClipboardEntryInput>;

/** One clip the Rust core saw on the clipboard. Ids last for the app's run. */
export interface ClipboardHistoryItem {
  id: string;
  text: string;
  capturedAtMs: number;
}

/**
 * A save refused because the text looks like a credential. Distinct from a
 * generic failure so the palette can explain the refusal instead of reading like
 * something broke.
 */
export class CredentialRejectedError extends Error {
  /** The pattern that matched, e.g. "github-token". */
  readonly kind: string;

  constructor(message: string, kind: string) {
    super(message);
    this.name = "CredentialRejectedError";
    this.kind = kind;
  }
}

/**
 * Converts the sidecar's 422 refusal into a `CredentialRejectedError`, or
 * returns null when the response is something else for the caller to handle.
 */
async function credentialRefusal(res: Response): Promise<CredentialRejectedError | null> {
  if (res.status !== 422) return null;
  const body = (await res.json().catch(() => null)) as {
    error?: string;
    secret?: { kind?: string; reason?: string };
  } | null;
  const reason = body?.secret?.reason;
  return new CredentialRejectedError(
    reason ? `That looks like a credential — it ${reason}.` : (body?.error ?? "refused"),
    body?.secret?.kind ?? "unknown",
  );
}

export async function listClipboardEntries(query = ""): Promise<ClipboardEntry[]> {
  const trimmed = query.trim();
  const qs = trimmed ? `?query=${encodeURIComponent(trimmed)}` : "";
  const res = await sidecarFetch(`/api/clipboard/entries${qs}`);
  await ensureOk(res, "list clipboard entries");
  return res.json();
}

export async function createClipboardEntry(
  input: CreateClipboardEntryInput,
): Promise<ClipboardEntry> {
  const res = await sidecarFetch("/api/clipboard/entries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const refusal = await credentialRefusal(res);
  if (refusal) throw refusal;
  await ensureOk(res, "save clipboard entry");
  return res.json();
}

export async function updateClipboardEntry(
  id: string,
  patch: UpdateClipboardEntryInput,
): Promise<ClipboardEntry> {
  const res = await sidecarFetch(`/api/clipboard/entries/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const refusal = await credentialRefusal(res);
  if (refusal) throw refusal;
  await ensureOk(res, "update clipboard entry");
  return res.json();
}

export async function deleteClipboardEntry(id: string): Promise<ClipboardEntry> {
  const res = await sidecarFetch(`/api/clipboard/entries/${id}`, { method: "DELETE" });
  await ensureOk(res, "delete clipboard entry");
  return res.json();
}

/** Records a copy so the entry rises in the palette's ordering. */
export async function markClipboardEntryUsed(id: string): Promise<ClipboardEntry> {
  const res = await sidecarFetch(`/api/clipboard/entries/${id}/used`, { method: "POST" });
  await ensureOk(res, "record clipboard use");
  return res.json();
}

/**
 * Screens clipboard history against the sidecar's credential patterns, returning
 * a reason per flagged item id. The detection lives in the sidecar so the
 * palette and the save path share one pattern list.
 */
export async function scanClipboardTexts(
  items: ClipboardHistoryItem[],
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const res = await sidecarFetch("/api/clipboard/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: items.map((i) => ({ id: i.id, text: i.text })) }),
  });
  await ensureOk(res, "screen clipboard history");
  const body = (await res.json()) as { flagged: Array<{ id: string; reason: string }> };
  return new Map(body.flagged.map((f) => [f.id, f.reason]));
}

/** Puts text on the system clipboard. */
export const writeClipboard = (text: string): Promise<void> => invoke("clipboard_write", { text });

/**
 * Strips control and formatting characters from a file path bound for the
 * clipboard. Git allows every byte but NUL and `/` in a path component, so a
 * hostile branch can name a file with an embedded newline or a right-to-left
 * override (see AGENTS.md on outside-influenced data). Those survive the
 * clipboard intact and make the pasted text read as something other than what
 * was on screen, which matters most where these paths are pasted: a shell, or a
 * prompt. Strip rather than refuse — a path carrying control characters is not
 * one anyone can open by hand either way.
 */
export const clipboardSafePath = (path: string): string => path.replace(/[\p{Cc}\p{Cf}]/gu, "");

/** The clips the Rust core has seen this run, newest first. */
export const readClipboardHistory = (): Promise<ClipboardHistoryItem[]> =>
  invoke("clipboard_history");

/** Forgets every recorded clip. The system clipboard itself is left alone. */
export const clearClipboardHistory = (): Promise<void> => invoke("clipboard_clear_history");

/** Subscribe to the global-shortcut summon for the clipboard palette. */
export const onClipboardSummon = (cb: () => void): Promise<UnlistenFn> =>
  listen("clipboard-summon", () => cb());
