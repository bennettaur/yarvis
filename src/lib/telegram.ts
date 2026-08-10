import { ensureOk, sidecarFetch } from "./api";

export type TelegramSecurityEventType = "unlock" | "lock" | "failed" | "lockout";

export interface TelegramSecurityEvent {
  /** Monotonic per-process sequence number, used as the poll cursor. */
  seq: number;
  /** Epoch millis, for display only. */
  ts: number;
  type: TelegramSecurityEventType;
  chatId: number;
}

/** Fetches Telegram auth events with a sequence greater than `since`. */
export async function getSecurityEvents(since: number): Promise<TelegramSecurityEvent[]> {
  const res = await sidecarFetch(`/api/telegram/security-events?since=${since}`);
  await ensureOk(res, "telegram security-events");
  const data = (await res.json()) as { events: TelegramSecurityEvent[] };
  return data.events;
}
