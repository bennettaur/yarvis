import type { TelegramMessage } from "./client.ts";
import type { ParsedCommand } from "./commands.ts";

/**
 * What the bot should do with an incoming message, decided purely from the
 * message metadata and the allowlist — no I/O — so the access boundary is
 * unit-testable in isolation.
 *
 * - `ignore`  — drop silently (not a private chat, a bot sender, or a
 *               non-allowlisted chat once an allowlist exists).
 * - `whoami`  — reply with the caller's chat id (the one pre-allowlist command,
 *               so the user can discover the id to add).
 * - `pairing` — no allowlist configured yet: tell the user how to pair.
 * - `command` — an allowlisted chat issued a slash command.
 * - `chat`    — an allowlisted chat sent a plain message for the agent.
 */
export type AccessDecision = "ignore" | "whoami" | "pairing" | "command" | "chat";

/**
 * Decides how to handle a message. The bot is a personal, single-operator tool,
 * so it only ever engages in **private** chats: group/supergroup/channel ids
 * would otherwise let everyone in that chat drive the user's assistant. Bot
 * senders are ignored to avoid loops.
 */
export function decideAccess(
  allowedChatIds: number[],
  msg: TelegramMessage,
  command: ParsedCommand | null,
): AccessDecision {
  if (msg.chat.type !== "private") return "ignore";
  if (msg.from?.is_bot) return "ignore";

  // /whoami answers before the allowlist check: it reveals only the caller's own
  // id, and it's how the user discovers the id to put on the allowlist.
  if (command?.name === "whoami") return "whoami";

  const allowed = allowedChatIds.includes(msg.chat.id);
  if (!allowed) {
    // No allowlist yet → guide the user through pairing. Allowlist set but this
    // chat isn't on it → stay silent rather than respond to strangers.
    return allowedChatIds.length === 0 ? "pairing" : "ignore";
  }

  return command ? "command" : "chat";
}
