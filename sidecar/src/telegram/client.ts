/**
 * Minimal Telegram Bot API client.
 *
 * Only the handful of methods the remote-control bot needs are wrapped:
 * long-polling for updates, sending text, and the "typing" chat action. The bot
 * token authenticates every call and is part of the URL path, so it is never
 * logged here — error messages surface only the method name and description.
 */

const API_BASE = "https://api.telegram.org";

/** A Telegram chat (private chat, group, etc.). Only the id is needed. */
export interface TelegramChatRef {
  id: number;
  type: string;
  username?: string;
  first_name?: string;
}

/** An incoming message. Non-text messages omit `text`. */
export interface TelegramMessage {
  message_id: number;
  from?: { id: number; is_bot: boolean; username?: string; first_name?: string };
  chat: TelegramChatRef;
  date: number;
  text?: string;
}

/** One update from getUpdates. We only consume `message` updates. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface BotIdentity {
  id: number;
  username?: string;
  first_name?: string;
}

/** Largest message body Telegram accepts in a single sendMessage call. */
export const TELEGRAM_MAX_MESSAGE = 4096;

/**
 * An error from the Telegram Bot API, carrying its numeric `error_code` so
 * callers can react to specific conditions (e.g. 409 Conflict from overlapping
 * getUpdates). The message never includes the request URL, which carries the
 * bot token.
 */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export class TelegramClient {
  constructor(private readonly token: string) {}

  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const data = (await res.json()) as ApiResponse<T>;
    if (!data.ok) {
      // Never include the response body verbatim — the request URL carries the
      // bot token; surface only the API's own description.
      throw new TelegramApiError(
        `telegram ${method} failed: ${data.description ?? res.status}`,
        data.error_code,
      );
    }
    return data.result as T;
  }

  /** Verifies the token and returns the bot's identity. */
  getMe(signal?: AbortSignal): Promise<BotIdentity> {
    return this.call<BotIdentity>("getMe", {}, signal);
  }

  /**
   * Long-polls for updates. `timeoutSeconds` is the server-side hold time; the
   * fetch is given a slightly longer abort budget so a hung connection can't
   * wedge the loop. `offset` confirms all updates below it as processed.
   */
  async getUpdates(
    offset: number,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    // Abort the fetch a bit after the server's long-poll window so a dead
    // connection surfaces as a retryable error instead of hanging forever.
    const fetchTimeout = AbortSignal.timeout((timeoutSeconds + 10) * 1000);
    const combined = signal ? AbortSignal.any([signal, fetchTimeout]) : fetchTimeout;
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
      combined,
    );
  }

  /** Sends a plain-text message. Splits bodies that exceed Telegram's limit. */
  async sendMessage(chatId: number, text: string, signal?: AbortSignal): Promise<void> {
    for (const chunk of splitMessage(text)) {
      await this.call("sendMessage", { chat_id: chatId, text: chunk }, signal);
    }
  }

  /** Shows the "typing…" indicator. Telegram clears it after ~5s or on send. */
  async sendTyping(chatId: number, signal?: AbortSignal): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action: "typing" }, signal);
  }

  /**
   * Deletes a message. Used to remove an `/unlock` message so the OTP code
   * doesn't linger in the chat history. Telegram only allows this within ~48h,
   * and it can fail for benign reasons, so callers should treat failure as
   * non-fatal.
   */
  async deleteMessage(chatId: number, messageId: number, signal?: AbortSignal): Promise<void> {
    await this.call("deleteMessage", { chat_id: chatId, message_id: messageId }, signal);
  }
}

/**
 * Splits a reply into Telegram-sized chunks, preferring to break on newlines so
 * a paragraph isn't cut mid-line. A single line longer than the limit is hard
 * sliced. An empty body yields one empty chunk so callers always send something.
 */
export function splitMessage(text: string, limit = TELEGRAM_MAX_MESSAGE): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    // No newline in range — fall back to a hard slice at the limit.
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
