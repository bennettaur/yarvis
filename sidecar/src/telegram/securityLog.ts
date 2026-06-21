/**
 * In-memory ring buffer of recent Telegram auth events. The bot appends to it;
 * an authenticated HTTP endpoint serves it to the desktop app, which polls and
 * raises OS notifications so the user sees unlock/lockout activity they didn't
 * initiate. It is a module singleton so the bot (a detached loop) and the Hono
 * route share one instance within the process; it resets on restart, like the
 * unlock state.
 */

export type SecurityEventType = "unlock" | "lock" | "failed" | "lockout";

export interface SecurityEvent {
  /**
   * Monotonic per-process sequence number used as the poll cursor. A sequence
   * (rather than `ts`) avoids dropping an event when two land in the same
   * millisecond across a poll boundary — exactly the rapid failed→lockout burst
   * the alerts exist to surface.
   */
  seq: number;
  /** Epoch millis, for display only. */
  ts: number;
  type: SecurityEventType;
  chatId: number;
}

const MAX_EVENTS = 100;

export class SecurityLog {
  private events: SecurityEvent[] = [];
  private nextSeq = 1;

  add(type: SecurityEventType, chatId: number, ts: number): void {
    this.events.push({ seq: this.nextSeq++, ts, type, chatId });
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
  }

  /** Events with a sequence strictly greater than `seq`, oldest first. */
  since(seq: number): SecurityEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }
}

export const securityLog = new SecurityLog();
