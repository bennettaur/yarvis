export interface ActivityRow {
  id: string;
  at: number;
  durationMs: number;
  instance: string;
  tool: string;
  ok: boolean;
  bytes: number;
}
export const INDEX_KEY: string;
export function entryKey(id: string): string;
export const MAX_RESULT_CHARS: number;
export const MAX_LOG_BYTES: number;
export const TOOL_FOR_COMMAND: Record<string, string>;
export function describeResult(reply: { ok: boolean; data?: unknown; error?: string }): {
  result: string;
  resultTruncated: boolean;
};
export function storedBytes(value: unknown): number;
export function nextIndex(
  index: ActivityRow[],
  row: ActivityRow,
): { index: ActivityRow[]; dropped: string[] };
export function recordActivity(entry: unknown): Promise<void>;
export function loadEntry(id: string): Promise<unknown>;
export function clearActivity(): Promise<void>;
