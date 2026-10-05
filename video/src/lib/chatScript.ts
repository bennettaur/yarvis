import type { ChatMessageMetadata, ThreadMessage, ToolActivity } from "../../../src/lib/chat";
import { FPS, typingFrames } from "./timing";

export interface ScriptTool {
  name: string;
  /** Frames after the message is sent that the call starts. */
  at: number;
  /** Frames the call stays pending before it settles. */
  runs?: number;
  status?: ToolActivity["status"];
  durationMs?: number;
  server?: string;
}

export interface ScriptTurn {
  /** Frame the user starts typing this message into the composer. */
  typeAt: number;
  user: string;
  /** Typing speed. A spoken turn skips the composer and is sent at `typeAt`. */
  typeCps?: number;
  metadata?: ChatMessageMetadata;
  tools?: ScriptTool[];
  /** Frames after the message is sent that the reply starts streaming. */
  replyAt: number;
  reply: string;
  /** Characters per second the reply streams at. */
  replyCps?: number;
}

export interface ChatFrame {
  messages: ThreadMessage[];
  streaming: string;
  activity: ToolActivity[];
  busy: boolean;
  /** What is in the composer right now. */
  draft: string;
}

const SEND_PAUSE = 8;

/** The frame a turn's message leaves the composer. */
export function sentAt(turn: ScriptTurn) {
  if (turn.metadata?.source === "voice") return turn.typeAt;
  return turn.typeAt + typingFrames(turn.user, turn.typeCps) + SEND_PAUSE;
}

/** The frame a turn's reply has finished streaming. */
export function doneAt(turn: ScriptTurn) {
  const cps = turn.replyCps ?? 110;
  return sentAt(turn) + turn.replyAt + Math.ceil((turn.reply.length / cps) * FPS);
}

function toolsAt(turn: ScriptTurn, sinceSend: number): ToolActivity[] {
  return (turn.tools ?? [])
    .map((tool, i) => ({ tool, i }))
    .filter(({ tool }) => sinceSend >= tool.at)
    .map(({ tool, i }) => {
      const settled = sinceSend >= tool.at + (tool.runs ?? 10);
      return {
        id: `${turn.typeAt}-${i}`,
        name: tool.name,
        server: tool.server,
        status: settled ? (tool.status ?? "ok") : "pending",
        durationMs: settled ? (tool.durationMs ?? 140 + ((i * 97) % 600)) : undefined,
      };
    });
}

/** Streams in whole words, so half-typed markdown markers don't flash on screen. */
function streamedText(reply: string, chars: number) {
  if (chars >= reply.length) return reply;
  const cut = reply.lastIndexOf(" ", chars);
  if (cut <= 0) return "";
  let text = reply.slice(0, cut);
  // Close an emphasis the cut left open, so it renders bold rather than as asterisks.
  if ((text.match(/\*\*/g) ?? []).length % 2 === 1) text += "**";
  else if ((text.replace(/\*\*/g, "").match(/\*/g) ?? []).length % 2 === 1) text += "*";
  return text;
}

/**
 * The props `ChatMessages` would be holding at `frame` if the scripted
 * conversation were happening live: typed drafts, tool calls landing, the
 * reply streaming, then the finished turn folding into the thread.
 */
export function chatAt(turns: ScriptTurn[], frame: number): ChatFrame {
  const messages: ThreadMessage[] = [];
  let streaming = "";
  let activity: ToolActivity[] = [];
  let busy = false;
  let draft = "";

  for (const turn of turns) {
    if (frame < turn.typeAt) break;
    const sent = sentAt(turn);
    if (frame < sent) {
      draft = turn.user.slice(0, Math.floor(((frame - turn.typeAt) / FPS) * (turn.typeCps ?? 28)));
      break;
    }
    messages.push({
      id: `u-${turn.typeAt}`,
      role: "user",
      content: turn.user,
      metadata: turn.metadata,
    });
    const sinceSend = frame - sent;
    if (frame >= doneAt(turn)) {
      messages.push({ role: "assistant", content: turn.reply, activity: toolsAt(turn, Infinity) });
      continue;
    }
    busy = true;
    activity = toolsAt(turn, sinceSend);
    if (sinceSend >= turn.replyAt) {
      const chars = Math.floor(((sinceSend - turn.replyAt) / FPS) * (turn.replyCps ?? 110));
      streaming = streamedText(turn.reply, chars);
    }
    break;
  }

  return { messages, streaming, activity, busy, draft };
}
