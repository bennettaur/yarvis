import { describe, expect, it } from "bun:test";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { handleMessage, handleUnlock, isConflict } from "./bot.ts";
import { TelegramApiError, type TelegramClient, type TelegramMessage } from "./client.ts";
import { OtpGate } from "./otpGate.ts";
import { securityLog } from "./securityLog.ts";
import { generateTotp } from "./totp.ts";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

/** Records the calls the bot makes instead of hitting the Telegram API. */
class FakeClient {
  sent: { chatId: number; text: string }[] = [];
  deleted: { chatId: number; messageId: number }[] = [];
  typing = 0;
  async sendMessage(chatId: number, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }
  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    this.deleted.push({ chatId, messageId });
  }
  async sendTyping(): Promise<void> {
    this.typing++;
  }
  asClient(): TelegramClient {
    return this as unknown as TelegramClient;
  }
}

const CHAT = 555;
const NO_DB = {} as Db; // handlers under test never reach the DB

function config(): Config {
  return {
    port: 0,
    token: "t",
    tokenGenerated: false,
    allowedOrigins: null,
    databaseUrl: "postgres://localhost/unused",
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    claudeCommand: "claude",
    secrets: {},
    customProviderSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [CHAT], otpWindowMinutes: 120 },
  };
}

function msg(text: string, messageId = 1): TelegramMessage {
  return {
    message_id: messageId,
    chat: { id: CHAT, type: "private" },
    from: { id: CHAT, is_bot: false },
    date: 0,
    text,
  };
}

function gate(): OtpGate {
  return new OtpGate({ secret: SECRET, windowMs: 60_000 });
}

const signal = new AbortController().signal;

describe("handleMessage OTP gating", () => {
  it("refuses a plain message while locked and never starts an agent turn", async () => {
    const client = new FakeClient();
    await handleMessage(config(), NO_DB, client.asClient(), msg("hello"), gate(), signal);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.text).toContain("🔒 Locked");
    // No typing indicator means handleChat (the agent path) was never entered.
    expect(client.typing).toBe(0);
  });

  it("refuses a non-exempt command while locked", async () => {
    const client = new FakeClient();
    await handleMessage(
      config(),
      NO_DB,
      client.asClient(),
      msg("/setmodel gemini x"),
      gate(),
      signal,
    );
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.text).toContain("🔒 Locked");
  });

  it("allows /help while locked", async () => {
    const client = new FakeClient();
    await handleMessage(config(), NO_DB, client.asClient(), msg("/help"), gate(), signal);
    expect(client.sent[0]!.text).toContain("Yarvis remote control");
  });

  it("processes /unlock and then allows a command", async () => {
    const client = new FakeClient();
    const g = gate();
    const now = Date.now();
    await handleMessage(
      config(),
      NO_DB,
      client.asClient(),
      msg(`/unlock ${await generateTotp(SECRET, now)}`),
      g,
      signal,
    );
    expect(g.isUnlocked(CHAT, now)).toBe(true);
    expect(client.sent.at(-1)!.text).toContain("🔓 Unlocked");
  });

  it("does not gate when OTP is disabled (no gate)", async () => {
    const client = new FakeClient();
    await handleMessage(config(), NO_DB, client.asClient(), msg("/help"), null, signal);
    expect(client.sent[0]!.text).toContain("Yarvis remote control");
  });
});

describe("isConflict", () => {
  it("identifies a 409 Telegram error and nothing else", () => {
    expect(isConflict(new TelegramApiError("Conflict", 409))).toBe(true);
    expect(isConflict(new TelegramApiError("Too Many Requests", 429))).toBe(false);
    expect(isConflict(new Error("Conflict"))).toBe(false);
    expect(isConflict("Conflict")).toBe(false);
  });
});

describe("handleUnlock", () => {
  function seenSince() {
    return securityLog.since(0).length;
  }

  it("deletes the code message and logs an unlock on success", async () => {
    const client = new FakeClient();
    const g = gate();
    const before = seenSince();
    const now = Date.now();
    await handleUnlock(client.asClient(), g, msg(`/unlock x`, 42), {
      name: "unlock",
      args: await generateTotp(SECRET, now),
    });
    expect(client.deleted).toEqual([{ chatId: CHAT, messageId: 42 }]);
    expect(client.sent.at(-1)!.text).toContain("🔓 Unlocked");
    expect(seenSince()).toBe(before + 1);
  });

  it("deletes the code message and reports remaining attempts on a bad code", async () => {
    const client = new FakeClient();
    await handleUnlock(client.asClient(), gate(), msg("/unlock x", 7), {
      name: "unlock",
      args: "000000",
    });
    expect(client.deleted).toEqual([{ chatId: CHAT, messageId: 7 }]);
    expect(client.sent.at(-1)!.text).toContain("Invalid code");
  });

  it("asks for a code when none is given", async () => {
    const client = new FakeClient();
    await handleUnlock(client.asClient(), gate(), msg("/unlock", 9), { name: "unlock", args: "" });
    expect(client.sent.at(-1)!.text).toContain("Usage: /unlock");
    expect(client.deleted).toHaveLength(0);
  });
});
