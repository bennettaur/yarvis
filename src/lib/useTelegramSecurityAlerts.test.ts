import { describe, expect, it } from "bun:test";
import type { TelegramSecurityEvent } from "./telegram";
import { describeSecurityEvent } from "./useTelegramSecurityAlerts";

function event(type: TelegramSecurityEvent["type"]): TelegramSecurityEvent {
  return { seq: 1, ts: 0, type, chatId: 1 };
}

describe("describeSecurityEvent", () => {
  it("produces a notification for unlock, failed, and lockout", () => {
    expect(describeSecurityEvent(event("unlock"))?.title).toBe("Telegram unlocked");
    expect(describeSecurityEvent(event("failed"))?.title).toBe("Telegram unlock failed");
    expect(describeSecurityEvent(event("lockout"))?.title).toBe("Telegram locked out");
  });

  it("does not notify for a deliberate /lock", () => {
    expect(describeSecurityEvent(event("lock"))).toBeNull();
  });
});
