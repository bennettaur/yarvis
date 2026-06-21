import { describe, expect, it } from "bun:test";
import { decideAccess } from "./access.ts";
import type { TelegramMessage } from "./client.ts";
import { parseCommand } from "./commands.ts";

/** Builds a private-chat text message from the given chat id and text. */
function privateMsg(chatId: number, text: string, isBot = false): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: chatId, type: "private" },
    from: { id: chatId, is_bot: isBot },
    date: 0,
    text,
  };
}

function decide(allowed: number[], msg: TelegramMessage) {
  return decideAccess(allowed, msg, parseCommand(msg.text ?? ""));
}

describe("decideAccess", () => {
  it("ignores non-private chats even if the chat id is allowlisted", () => {
    const groupMsg: TelegramMessage = {
      message_id: 1,
      chat: { id: 42, type: "group" },
      from: { id: 999, is_bot: false },
      date: 0,
      text: "hello",
    };
    expect(decideAccess([42], groupMsg, null)).toBe("ignore");
  });

  it("ignores messages from bot senders", () => {
    expect(decide([42], privateMsg(42, "hello", true))).toBe("ignore");
  });

  it("answers /whoami even when not on the allowlist", () => {
    expect(decide([], privateMsg(7, "/whoami"))).toBe("whoami");
    expect(decide([42], privateMsg(7, "/whoami"))).toBe("whoami");
  });

  it("offers pairing when no allowlist is configured", () => {
    expect(decide([], privateMsg(7, "hello"))).toBe("pairing");
  });

  it("stays silent to non-allowlisted chats once an allowlist exists", () => {
    expect(decide([42], privateMsg(7, "hello"))).toBe("ignore");
    expect(decide([42], privateMsg(7, "/new_chat"))).toBe("ignore");
  });

  it("routes allowlisted commands and plain messages distinctly", () => {
    expect(decide([42], privateMsg(42, "/new_chat"))).toBe("command");
    expect(decide([42], privateMsg(42, "hello there"))).toBe("chat");
  });
});
