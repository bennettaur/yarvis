import { createSession, listSessions } from "../chat/service.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { availableProviders, type ProviderInfo, pickDefaultModel } from "../llm/providers.ts";
import { getChatState, setActiveSession, setProviderModel } from "./service.ts";

/** A parsed slash command: the bare name (no slash, lowercased) and its args. */
export interface ParsedCommand {
  name: string;
  args: string;
}

/**
 * Parses a Telegram slash command. Returns null for non-commands. Telegram
 * appends `@botname` to commands in groups (e.g. `/help@yarvis_bot`), so that
 * suffix is stripped. The command must be the first token of the message.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [head, ...rest] = trimmed.split(/\s+/);
  const name = head!.slice(1).split("@")[0]!.toLowerCase();
  if (!name) return null;
  return { name, args: rest.join(" ").trim() };
}

const HELP_TEXT = [
  "Yarvis remote control. Just send a message to chat. Commands:",
  "",
  "/new_chat — start a fresh chat session",
  "/chats — list recent sessions",
  "/switch <n> — switch to session number <n> from /chats",
  "/model — show the current provider/model and the available options",
  "/setmodel <provider> <model> — reply using a specific provider/model",
  "/whoami — show your Telegram chat id",
  "/help — show this message",
  "",
  "When OTP is enabled: /unlock <code> — unlock with your authenticator code; /lock — lock now",
].join("\n");

/** Short label for a session in the /chats list. */
function sessionLabel(title: string | null): string {
  const t = title?.trim();
  return t && t.length > 0 ? t : "(untitled)";
}

export interface CommandContext {
  config: Config;
  db: Db;
  chatId: number;
}

/**
 * Handles an access-granted command and returns the reply text. `/whoami` is
 * handled earlier in the bot, before the allowlist gate, so it is not expected
 * here. Unknown commands return a help nudge rather than silence so a typo is
 * recoverable.
 *
 * Telegram normalizes `-` to `_` poorly across clients, so `/new_chat`,
 * `/new-chat`, and `/newchat` are all accepted.
 */
export async function handleCommand(ctx: CommandContext, command: ParsedCommand): Promise<string> {
  const { config, db, chatId } = ctx;
  switch (command.name) {
    case "help":
    case "start":
      return HELP_TEXT;

    case "new_chat":
    case "new-chat":
    case "newchat": {
      const session = await createSession(db);
      await setActiveSession(db, chatId, session.id);
      return "🆕 Started a new chat.";
    }

    case "chats": {
      const sessions = await listSessions(db);
      if (sessions.length === 0) return "No chats yet. Send a message to start one.";
      const lines = sessions.slice(0, 20).map((s, i) => `${i + 1}. ${sessionLabel(s.title)}`);
      return ["Recent chats (use /switch <n>):", ...lines].join("\n");
    }

    case "switch": {
      const n = Number(command.args);
      if (!Number.isInteger(n) || n < 1) {
        return "Usage: /switch <n>, where <n> is a number from /chats.";
      }
      const sessions = await listSessions(db);
      const target = sessions[n - 1];
      if (!target) return `No chat #${n}. Run /chats to see the list.`;
      await setActiveSession(db, chatId, target.id);
      return `✅ Switched to #${n}: ${sessionLabel(target.title)}`;
    }

    case "model":
      return showModel(config, db, chatId);

    case "setmodel":
    case "set_model":
      return setModel(config, db, chatId, command.args);

    default:
      return `Unknown command: /${command.name}. Send /help for the list.`;
  }
}

/** Renders configured providers and their models for the /model output. */
function availableModelsText(providers: ProviderInfo[]): string {
  const usable = providers.filter((p) => p.available && p.models.length > 0);
  if (usable.length === 0) return "No providers are configured.";
  return [
    "Available:",
    ...usable.map((p) => `• ${p.id}: ${p.models.map((m) => m.id).join(", ")}`),
  ].join("\n");
}

/** Shows the provider/model this chat replies with (set or default). */
async function showModel(config: Config, db: Db, chatId: number): Promise<string> {
  const [state, providers] = await Promise.all([
    getChatState(db, chatId),
    availableProviders(config, db, "chat"),
  ]);
  const list = availableModelsText(providers);
  if (state?.provider && state.model) {
    return `Current: ${state.provider} / ${state.model} (set via /setmodel)\n\n${list}`;
  }
  const def = pickDefaultModel(providers);
  if (def) {
    return `Current: ${def.provider} / ${def.model} (default)\n\n${list}`;
  }
  return `No provider is configured. Add an API key in Settings first.\n\n${list}`;
}

/** Sets the provider/model for this chat after validating the provider. */
async function setModel(config: Config, db: Db, chatId: number, args: string): Promise<string> {
  // Chat-capable only: the bot has nowhere to play audio, so a speech model is
  // never a valid answer to /setmodel.
  const providers = await availableProviders(config, db, "chat");
  const [provider, model] = args.split(/\s+/).filter(Boolean);
  if (!provider || !model) {
    return `Usage: /setmodel <provider> <model>\n\n${availableModelsText(providers)}`;
  }
  const match = providers.find((p) => p.id === provider);
  if (!match || !match.available) {
    return `Unknown or unavailable provider: ${provider}\n\n${availableModelsText(providers)}`;
  }
  if (match.models.length > 0 && !match.models.some((m) => m.id === model)) {
    return `${provider} has no chat model called ${model}.\n\n${availableModelsText(providers)}`;
  }
  await setProviderModel(db, chatId, provider, model);
  return `✅ Replies will use ${provider} / ${model}.`;
}
