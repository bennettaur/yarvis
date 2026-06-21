import { describe, expect, it } from "bun:test";
import { OtpGate } from "./otpGate.ts";
import { generateTotp } from "./totp.ts";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const WINDOW_MS = 2 * 60 * 60_000;
const CHAT = 42;

function gate() {
  return new OtpGate({ secret: SECRET, windowMs: WINDOW_MS, maxFailures: 3, lockoutMs: 60_000 });
}

describe("OtpGate", () => {
  it("starts locked", () => {
    expect(gate().isUnlocked(CHAT, 1_000)).toBe(false);
  });

  it("opens a window for the correct code and reports the expiry", async () => {
    const g = gate();
    const now = 1_111_111_109_000;
    const code = await generateTotp(SECRET, now);
    const outcome = await g.unlock(CHAT, code, now);
    expect(outcome.result).toBe("unlocked");
    expect(g.isUnlocked(CHAT, now)).toBe(true);
    expect(g.isUnlocked(CHAT, now + WINDOW_MS + 1)).toBe(false);
    if (outcome.result === "unlocked") expect(outcome.until).toBe(now + WINDOW_MS);
  });

  it("rejects a wrong code and counts down remaining attempts", async () => {
    const g = gate();
    const now = 1_111_111_109_000;
    const first = await g.unlock(CHAT, "000000", now);
    expect(first).toEqual({ result: "bad-code", remainingAttempts: 2 });
    expect(g.isUnlocked(CHAT, now)).toBe(false);
  });

  it("locks out after the failure threshold, refusing even correct codes", async () => {
    const g = gate();
    const now = 1_111_111_109_000;
    await g.unlock(CHAT, "000000", now);
    await g.unlock(CHAT, "000000", now);
    const tripped = await g.unlock(CHAT, "000000", now);
    expect(tripped.result).toBe("locked-out");
    // A correct code during the lockout is still refused.
    const code = await generateTotp(SECRET, now);
    expect((await g.unlock(CHAT, code, now)).result).toBe("locked-out");
    // After the cooldown, the correct code works again.
    const later = now + 61_000;
    expect((await g.unlock(CHAT, await generateTotp(SECRET, later), later)).result).toBe(
      "unlocked",
    );
  });

  it("escalates the lockout duration on each successive lockout", async () => {
    const g = gate();
    const now = 1_111_111_109_000;
    // First lockout: 3 wrong codes → base lockout (60s).
    for (let i = 0; i < 3; i++) await g.unlock(CHAT, "000000", now);
    const first = await g.unlock(CHAT, "000000", now);
    expect(first).toEqual({ result: "locked-out", retryAfterMs: 60_000 });

    // After the cooldown, three more failures lock out for twice as long (120s).
    const later = now + 60_001;
    for (let i = 0; i < 2; i++) await g.unlock(CHAT, "000000", later);
    const second = await g.unlock(CHAT, "000000", later);
    expect(second).toEqual({ result: "locked-out", retryAfterMs: 120_000 });
  });

  it("resets the lockout escalation after a successful unlock", async () => {
    const g = gate();
    const now = 1_111_111_109_000;
    for (let i = 0; i < 3; i++) await g.unlock(CHAT, "000000", now);
    const after = now + 60_001;
    await g.unlock(CHAT, await generateTotp(SECRET, after), after); // success resets
    // A later lockout starts from the base duration again.
    const later = after + 1000;
    for (let i = 0; i < 2; i++) await g.unlock(CHAT, "000000", later);
    expect(await g.unlock(CHAT, "000000", later)).toEqual({
      result: "locked-out",
      retryAfterMs: 60_000,
    });
  });

  it("relocks on /lock", async () => {
    const g = gate();
    const now = 1_111_111_109_000;
    await g.unlock(CHAT, await generateTotp(SECRET, now), now);
    expect(g.isUnlocked(CHAT, now)).toBe(true);
    g.lock(CHAT);
    expect(g.isUnlocked(CHAT, now)).toBe(false);
  });

  it("keeps windows independent per chat", async () => {
    const g = gate();
    const now = 1_111_111_109_000;
    await g.unlock(CHAT, await generateTotp(SECRET, now), now);
    expect(g.isUnlocked(CHAT, now)).toBe(true);
    expect(g.isUnlocked(99, now)).toBe(false);
  });
});
