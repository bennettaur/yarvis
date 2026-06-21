import { verifyTotp } from "./totp.ts";

/**
 * Per-chat OTP unlock gate. When OTP is enabled, a Telegram chat must submit a
 * valid TOTP code to open a time-boxed window during which messages are
 * processed; outside the window the bot refuses to act.
 *
 * State is in-memory and per process, so a sidecar restart relocks every chat
 * (the chosen "relock on restart" behavior). Brute force is bounded by a lockout
 * after a handful of failures, since a code travels over a channel an attacker
 * who has hijacked the Telegram account could spam.
 */

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_LOCKOUT_MS = 5 * 60_000;
/** Caps the escalating-lockout doubling so it can't overflow (32× the base). */
const MAX_LOCKOUT_SHIFT = 5;

export type UnlockOutcome =
  | { result: "unlocked"; until: number }
  | { result: "bad-code"; remainingAttempts: number }
  | { result: "locked-out"; retryAfterMs: number };

export interface OtpGateOptions {
  secret: string;
  windowMs: number;
  maxFailures?: number;
  lockoutMs?: number;
}

export class OtpGate {
  private readonly secret: string;
  private readonly windowMs: number;
  private readonly maxFailures: number;
  private readonly lockoutMs: number;
  private readonly unlockedUntilByChat = new Map<number, number>();
  private readonly failuresByChat = new Map<number, number>();
  private readonly lockedUntilByChat = new Map<number, number>();
  // How many times a chat has been locked out without a successful unlock since,
  // so each successive lockout lasts longer (a flat cap otherwise lets a
  // persistent attacker grind at a constant rate forever).
  private readonly lockoutCountByChat = new Map<number, number>();

  constructor(opts: OtpGateOptions) {
    this.secret = opts.secret;
    this.windowMs = opts.windowMs;
    this.maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.lockoutMs = opts.lockoutMs ?? DEFAULT_LOCKOUT_MS;
  }

  /** Whether the chat currently has an open, unexpired window. */
  isUnlocked(chatId: number, now: number): boolean {
    const until = this.unlockedUntilByChat.get(chatId);
    return until !== undefined && until > now;
  }

  /** Epoch-millis the chat's window expires, or null when locked. */
  unlockedUntil(chatId: number, now: number): number | null {
    const until = this.unlockedUntilByChat.get(chatId);
    return until !== undefined && until > now ? until : null;
  }

  /**
   * Attempts to open a window with a submitted code. A lockout short-circuits
   * before any crypto so brute force can't get cheaper by racing. A correct code
   * clears the failure counter and opens the window; a wrong one increments it
   * and trips the lockout at the threshold.
   */
  async unlock(chatId: number, code: string, now: number): Promise<UnlockOutcome> {
    const lockedUntil = this.lockedUntilByChat.get(chatId);
    if (lockedUntil !== undefined && lockedUntil > now) {
      return { result: "locked-out", retryAfterMs: lockedUntil - now };
    }

    if (await verifyTotp(this.secret, code, now)) {
      const until = now + this.windowMs;
      this.unlockedUntilByChat.set(chatId, until);
      this.failuresByChat.delete(chatId);
      this.lockedUntilByChat.delete(chatId);
      this.lockoutCountByChat.delete(chatId);
      return { result: "unlocked", until };
    }

    const failures = (this.failuresByChat.get(chatId) ?? 0) + 1;
    if (failures >= this.maxFailures) {
      this.failuresByChat.delete(chatId);
      // Each successive lockout (without a successful unlock resetting it) lasts
      // twice as long, so a persistent grinder is pushed toward infeasibility
      // rather than a constant rate.
      const priorLockouts = this.lockoutCountByChat.get(chatId) ?? 0;
      const retryAfterMs = this.lockoutMs * 2 ** Math.min(priorLockouts, MAX_LOCKOUT_SHIFT);
      this.lockedUntilByChat.set(chatId, now + retryAfterMs);
      this.lockoutCountByChat.set(chatId, priorLockouts + 1);
      return { result: "locked-out", retryAfterMs };
    }
    this.failuresByChat.set(chatId, failures);
    return { result: "bad-code", remainingAttempts: this.maxFailures - failures };
  }

  /** Closes the chat's window immediately (used by /lock). */
  lock(chatId: number): void {
    this.unlockedUntilByChat.delete(chatId);
  }
}
