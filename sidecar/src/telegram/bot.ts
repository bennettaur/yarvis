import { runAgentTurn } from "../chat/agent.ts";
import { createSession } from "../chat/service.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import type { ChatMessageMetadata } from "../db/schema.ts";
import { describeError } from "../llm/errors.ts";
import { defaultProviderModel, resolveModel } from "../llm/providers.ts";
import { decideAccess } from "./access.ts";
import { TelegramApiError, TelegramClient, type TelegramMessage } from "./client.ts";
import { handleCommand, type ParsedCommand, parseCommand } from "./commands.ts";
import { OtpGate } from "./otpGate.ts";
import { securityLog } from "./securityLog.ts";
import { getChatState, setActiveSession } from "./service.ts";

/** Server-side long-poll hold time, in seconds. */
const POLL_TIMEOUT = 30;
/** Backoff bounds for transient getUpdates failures. */
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
/**
 * A 409 Conflict means another getUpdates holds the long-poll slot. A brief
 * overlap is normal right after a sidecar restart, so retry quickly at first.
 */
const CONFLICT_FAST_RETRY_MS = 5000;
/**
 * Once a conflict persists past this many fast retries (~1 min — well beyond any
 * restart overlap or stale-connection timeout), a second instance is genuinely
 * running. Switch to a slow, quiet retry so the log isn't spammed but the bot
 * still recovers on its own if the other poller later stops.
 */
const CONFLICT_PERSIST_STREAK = 12;
const CONFLICT_SLOW_RETRY_MS = 5 * 60_000;
/** Cadence of the "typing…" refresh while a reply is generating (Telegram
 * clears the indicator after ~5s). */
const TYPING_REFRESH_MS = 4000;

/** Handle returned to the caller so the bot can be stopped (e.g. in tests). */
export interface TelegramBotHandle {
  stop(): void;
}

/**
 * Starts the Telegram remote-control bot if a token is configured. Returns null
 * (and logs why) when the bot can't run, so a missing token or database never
 * blocks sidecar startup. The loop runs detached; call `stop()` to end it.
 */
export function startTelegramBot(config: Config): TelegramBotHandle | null {
  const token = config.telegram.botToken;
  if (!token) return null;
  if (!config.databaseUrl) {
    console.warn("[telegram] bot token set but no database configured; bot disabled");
    return null;
  }

  const controller = new AbortController();
  // Detached: failures inside the loop are handled within; this top-level catch
  // only guards against an unexpected throw escaping the runner.
  runBot(config, token, controller.signal).catch((e) => {
    console.error("[telegram] bot stopped unexpectedly:", describeError(e));
  });
  return { stop: () => controller.abort() };
}

async function runBot(config: Config, token: string, signal: AbortSignal): Promise<void> {
  const client = new TelegramClient(token);
  const db = getDb(config.databaseUrl as string).db;

  let _me: Awaited<ReturnType<TelegramClient["getMe"]>>;
  try {
    _me = await client.getMe(signal);
  } catch (e) {
    console.error("[telegram] invalid bot token; bot disabled:", describeError(e));
    return;
  }

  // When an OTP secret is configured, gate every chat behind a TOTP unlock. The
  // gate's state is in-memory, so this fresh instance relocks all chats — the
  // intended "relock on restart" behavior.
  const otpGate = config.telegram.otpSecret
    ? new OtpGate({
        secret: config.telegram.otpSecret,
        windowMs: config.telegram.otpWindowMinutes * 60_000,
      })
    : null;
  if (otpGate) {
  }

  // Skip any backlog so a sidecar restart doesn't replay messages received
  // while it was down. Confirm everything up to the latest update without
  // acting on it, then start polling from there.
  let offset = await drainBacklog(client, signal);

  let backoff = MIN_BACKOFF_MS;
  let conflictStreak = 0;
  while (!signal.aborted) {
    try {
      const updates = await client.getUpdates(offset, POLL_TIMEOUT, signal);
      backoff = MIN_BACKOFF_MS;
      conflictStreak = 0;
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message?.text) {
          await handleMessage(config, db, client, update.message, otpGate, signal);
        }
      }
    } catch (e) {
      if (signal.aborted) break;
      if (isConflict(e)) {
        conflictStreak++;
        if (conflictStreak === 1) {
          console.warn(
            "[telegram] getUpdates conflict — another poller holds the slot; retrying (clears once it stops)",
          );
        }
        if (conflictStreak < CONFLICT_PERSIST_STREAK) {
          // Brief overlap (e.g. a restart): retry quickly to recover fast.
          await sleep(CONFLICT_FAST_RETRY_MS, signal);
        } else {
          // Persistent: a second instance is genuinely running. Back off to a
          // slow, quiet retry instead of spamming, but keep trying so the bot
          // recovers automatically if the other poller later exits.
          if (conflictStreak === CONFLICT_PERSIST_STREAK) {
            console.error(
              "[telegram] getUpdates still conflicting after ~1m — another Yarvis instance is likely running; backing off (restart the app if this persists)",
            );
          }
          await sleep(CONFLICT_SLOW_RETRY_MS, signal);
        }
        continue;
      }
      conflictStreak = 0;
      console.error("[telegram] poll error; backing off:", describeError(e));
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
}

/**
 * Telegram returns 409 when another getUpdates holds the long-poll slot. With a
 * single bot this is transient — typically a frozen long-poll lingering after
 * the laptop resumes — and clears once that poll times out server-side.
 */
export function isConflict(e: unknown): boolean {
  return e instanceof TelegramApiError && e.code === 409;
}

/** Returns the offset just past the latest pending update, discarding backlog. */
async function drainBacklog(client: TelegramClient, signal: AbortSignal): Promise<number> {
  try {
    // offset -1 returns only the most recent update without confirming older ones.
    const latest = await client.getUpdates(-1, 0, signal);
    const last = latest.at(-1);
    return last ? last.update_id + 1 : 0;
  } catch (e) {
    console.warn("[telegram] backlog drain failed; starting from 0:", describeError(e));
    return 0;
  }
}

/** Commands that stay available to a chat while it is OTP-locked. */
const COMMANDS_ALLOWED_WHILE_LOCKED = new Set(["help"]);

const LOCKED_PROMPT =
  "🔒 Locked. Send /unlock <code> with the current code from your authenticator to resume.";

export async function handleMessage(
  config: Config,
  db: ReturnType<typeof getDb>["db"],
  client: TelegramClient,
  msg: TelegramMessage,
  otpGate: OtpGate | null,
  signal: AbortSignal,
): Promise<void> {
  const chatId = msg.chat.id;
  const text = msg.text ?? "";
  const command = parseCommand(text);
  const now = Date.now();

  try {
    switch (decideAccess(config.telegram.allowedChatIds, msg, command)) {
      case "ignore":
        return;
      case "whoami":
        await client.sendMessage(chatId, `Your Telegram chat id is: ${chatId}`);
        return;
      case "pairing":
        await client.sendMessage(
          chatId,
          [
            "👋 Yarvis isn't paired with this chat yet.",
            `Your chat id is: ${chatId}`,
            "Add it under Settings → Telegram in the app to start chatting.",
          ].join("\n"),
        );
        return;
      case "command": {
        // OTP control commands are handled here (they must work while locked);
        // any other command is refused until the chat is unlocked.
        if (otpGate) {
          const name = command?.name;
          if (name === "unlock") {
            await handleUnlock(client, otpGate, msg, command!);
            return;
          }
          if (name === "lock") {
            otpGate.lock(chatId);
            securityLog.add("lock", chatId, now);
            await client.sendMessage(chatId, "🔒 Locked. Send /unlock <code> to resume.");
            return;
          }
          if (
            name &&
            !COMMANDS_ALLOWED_WHILE_LOCKED.has(name) &&
            !otpGate.isUnlocked(chatId, now)
          ) {
            await client.sendMessage(chatId, LOCKED_PROMPT);
            return;
          }
        }
        const reply = await handleCommand({ config, db, chatId }, command!);
        await client.sendMessage(chatId, reply);
        return;
      }
      case "chat":
        if (otpGate && !otpGate.isUnlocked(chatId, now)) {
          await client.sendMessage(chatId, LOCKED_PROMPT);
          return;
        }
        await handleChat(config, db, client, msg, signal);
        return;
    }
  } catch (e) {
    console.error("[telegram] message handling failed:", describeError(e));
    // Best-effort notify; ignore secondary send failures.
    await client.sendMessage(chatId, "⚠️ Something went wrong handling that.").catch(() => {});
  }
}

/**
 * Processes a /unlock attempt: validates the TOTP code, records the outcome for
 * the security log, and removes the message so the code doesn't linger in the
 * chat history (best-effort — Telegram only allows deletes within ~48h).
 */
export async function handleUnlock(
  client: TelegramClient,
  otpGate: OtpGate,
  msg: TelegramMessage,
  command: ParsedCommand,
): Promise<void> {
  const chatId = msg.chat.id;
  const code = command.args.trim();
  if (!code) {
    await client.sendMessage(chatId, "Usage: /unlock <code> from your authenticator app.");
    return;
  }

  const now = Date.now();
  const outcome = await otpGate.unlock(chatId, code, now);
  // Always scrub the submitted code from history, whatever the outcome.
  await client.deleteMessage(chatId, msg.message_id).catch(() => {});

  if (outcome.result === "unlocked") {
    securityLog.add("unlock", chatId, now);
    const until = new Date(outcome.until).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    await client.sendMessage(chatId, `🔓 Unlocked until ${until}.`);
  } else if (outcome.result === "bad-code") {
    securityLog.add("failed", chatId, now);
    await client.sendMessage(
      chatId,
      `❌ Invalid code. ${outcome.remainingAttempts} attempt(s) left before lockout.`,
    );
  } else {
    securityLog.add("lockout", chatId, now);
    const minutes = Math.ceil(outcome.retryAfterMs / 60_000);
    await client.sendMessage(chatId, `⛔ Too many attempts. Try again in ${minutes} min.`);
  }
}

/** Runs the agent for a plain message and sends the reply as one message. */
async function handleChat(
  config: Config,
  db: ReturnType<typeof getDb>["db"],
  client: TelegramClient,
  msg: TelegramMessage,
  signal: AbortSignal,
): Promise<void> {
  const chatId = msg.chat.id;
  const text = msg.text ?? "";
  // Record who sent this so the in-app chat history shows the Telegram origin
  // and the sender's id rather than a bare "user".
  const userMetadata: ChatMessageMetadata = {
    source: "telegram",
    telegramUserId: msg.from?.id,
    telegramUsername: msg.from?.username ?? undefined,
    telegramFirstName: msg.from?.first_name ?? undefined,
  };
  const state = await getChatState(db, chatId);

  // Prefer the provider/model the chat chose via /setmodel; otherwise fall back
  // to the configured default (the first available provider).
  let provider = state?.provider ?? undefined;
  let chatModelId = state?.model ?? undefined;
  if (!provider || !chatModelId) {
    const def = await defaultProviderModel(config, db);
    if (!def) {
      await client.sendMessage(
        chatId,
        "No LLM provider is configured. Add an API key in Settings first.",
      );
      return;
    }
    provider = def.provider;
    chatModelId = def.model;
  }

  let model: Awaited<ReturnType<typeof resolveModel>>;
  try {
    model = await resolveModel(config, db, provider, chatModelId);
  } catch (e) {
    await client.sendMessage(
      chatId,
      `⚠️ Model unavailable (${provider} / ${chatModelId}): ${describeError(e)}. Try /setmodel.`,
    );
    return;
  }

  // Reuse the chat the user was last talking to; create one on first contact.
  let sessionId = state?.activeSessionId ?? null;
  if (!sessionId) {
    const session = await createSession(db);
    await setActiveSession(db, chatId, session.id);
    sessionId = session.id;
  }

  // Keep the "typing…" indicator alive for the whole generation.
  await client.sendTyping(chatId).catch(() => {});
  const typing = setInterval(() => {
    client.sendTyping(chatId).catch(() => {});
  }, TYPING_REFRESH_MS);

  let full = "";
  let attentionReason: string | undefined;
  let errorMessage: string | undefined;
  try {
    for await (const event of runAgentTurn({
      config,
      db,
      model,
      sessionId,
      message: text,
      userMetadata,
      signal,
    })) {
      if (event.type === "done") full = event.text;
      else if (event.type === "attention") attentionReason = event.reason;
      else if (event.type === "error") errorMessage = event.message;
    }
  } finally {
    clearInterval(typing);
  }

  if (errorMessage) {
    await client.sendMessage(chatId, `⚠️ ${errorMessage}`);
    return;
  }
  let out = full.trim() || "(no response)";
  if (attentionReason) out += `\n\n🔔 ${attentionReason}`;
  await client.sendMessage(chatId, out);
}

/** Promise sleep that resolves early if the bot is asked to stop. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
