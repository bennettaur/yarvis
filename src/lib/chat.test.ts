import { describe, expect, it } from "bun:test";
import { messageLabel } from "./chat";

describe("messageLabel", () => {
  it("returns the bare role for app messages", () => {
    expect(messageLabel("user")).toBe("user");
    expect(messageLabel("assistant", null)).toBe("assistant");
    expect(messageLabel("user", {})).toBe("user");
  });

  it("prefers the @username for Telegram messages", () => {
    expect(
      messageLabel("user", { source: "telegram", telegramUserId: 7, telegramUsername: "mike" }),
    ).toBe("Telegram · @mike");
  });

  it("falls back to the first name, then the id", () => {
    expect(
      messageLabel("user", { source: "telegram", telegramUserId: 7, telegramFirstName: "Mike" }),
    ).toBe("Telegram · Mike");
    expect(messageLabel("user", { source: "telegram", telegramUserId: 7 })).toBe("Telegram · 7");
  });

  it("shows a bare Telegram label when no sender info is present", () => {
    expect(messageLabel("user", { source: "telegram" })).toBe("Telegram");
  });
});
